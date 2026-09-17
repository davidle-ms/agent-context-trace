import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { excluded, hash, isWithin, parseSession, ReadEvent, resolveFile, sliceRead, summary, TraceStore, validateInput, readHighlightRanges, readFrequency } from '../core';
import { pathToFileURL } from 'node:url';
import { extractHistory, replayHistory, readHistory, listHistory, historyStatus, groupHistory, HistoryEntry } from '../history';
import { extractWorkItemActivity, workItemLink, redactWorkItemActivity } from '../work-items';
import { extractResourceActivity, resourceLink, resourceMetadata, redactResourceActivity } from '../resource-history';
import { repositoryReadLines, repositoryReadLinesHtml } from '../read-lines';

const input = { sessionId: randomUUID(), filePath: '/workspace/source.ts', startLine: 1, endLine: 3 };
const event = (startLine = 1, endLine = 10): ReadEvent => ({ id: randomUUID(), rootId: hash('root'), relativePath: 'source.ts',
    startLine, endLine, requestedEndLine: endLine, snapshotHash: hash('snapshot'), isDirty: false, at: new Date().toISOString() });

test('work-item reads preserve returned metadata, not requested-field assumptions or response bodies', () => {
    const tool = { kind: 'toolInvocationSerialized', toolId: 'mcp_azuredevops_m_wit_work_item', toolCallId: 'ado-read',
        source: { type: 'mcp', serverLabel: 'Azure DevOps' }, isComplete: true, isConfirmed: { type: 1 },
        toolSpecificData: { rawInput: { action: 'get', project: 'Demo', id: 123, fields: ['System.Title', 'System.Description', 'System.State'] } },
        resultDetails: { output: [{ type: 'embed', isText: true, value: JSON.stringify({ id: 123, rev: 2,
            fields: { 'System.Title': 'Example item', 'System.Description': 'PRIVATE_BODY' },
            url: 'https://dev.azure.com/example/Demo/_apis/wit/workitems/123?secret=PRIVATE_QUERY' }) }] } };
    const snapshot = { sessionId: 'mcp-chat', requests: [{ timestamp: 1000, response: [tool, tool] }] };
    const activity = extractWorkItemActivity(snapshot);
    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.title, 'Example item');
    assert.deepEqual(activity[0]?.returnedFields, ['System.Title', 'System.Description']);
    assert.equal(activity[0]?.url, 'https://dev.azure.com/example/Demo/_workitems/edit/123');
    assert.equal(activity[0]?.revision, 2);
    assert.equal(activity[0]?.outcome, 'returned');
    assert.equal(JSON.stringify(activity).includes('PRIVATE_'), false);
    assert.deepEqual(extractHistory(snapshot, []).events, [], 'Remote items never become local file coverage');
    for (const [extra, expected] of [[{ resultDetails: {} }, 'unavailable'], [{ isError: true }, 'failed'],
        [{ isCancelled: true }, 'cancelled'], [{ isComplete: false }, 'pending']] as const) {
        const entry = extractWorkItemActivity({ requests: [{ response: [{ ...tool, ...extra }] }] })[0]!;
        assert.equal(entry.outcome, expected);
        assert.deepEqual(entry.returnedFields, []);
    }
    assert.deepEqual(extractWorkItemActivity({ requests: [{ response: [{ ...tool, toolId: 'mcp_azuredevops_m_wit_work_item_write' }] }] }), []);
    assert.deepEqual(extractWorkItemActivity({ requests: [{ response: [{ ...tool, source: { type: 'extension' } }] }] }), []);
    assert.equal(workItemLink('https://evil.example/_workitems/edit/123', 123), undefined);
    assert.equal(workItemLink('https://dev.azure.com/example/_workitems/edit/124', 123), undefined);
    assert.equal(workItemLink('javascript:alert(1)', 123), undefined);
});

test('work-item batches and comments retain only evidence for each requested item and exports redact metadata', () => {
    const call = (action: string, args: object, result: unknown) => ({ kind: 'toolInvocationSerialized', toolId: 'mcp_azuredevops_2_wit_work_item',
        toolCallId: action, source: { type: 'mcp' }, isComplete: true, isConfirmed: { type: 1 },
        resultDetails: { input: JSON.stringify({ action, project: 'Demo', ...args }),
            output: [{ isText: true, value: JSON.stringify(result) }] } });
    const snapshot = { requests: [{ response: [call('get_batch', { ids: [12, 13, 12] }, [{ id: 12, fields: { 'System.Title': 'Batch item' } }]),
        call('list_comments', { workItemId: 12 }, { totalCount: 100, comments: [{ id: 4, workItemId: 12, text: 'PRIVATE_COMMENT' }] })] }] };
    const entries = extractWorkItemActivity(snapshot);
    assert.deepEqual(entries.map(entry => entry.outcome), ['returned', 'unavailable', 'returned']);
    assert.deepEqual(entries[2]?.commentIds, [4]);
    assert.equal(entries[2]?.returnedComments, 1, 'Only the returned comment page is counted');
    assert.equal(JSON.stringify(entries).includes('PRIVATE_COMMENT'), false);
    const exported = { label: 'Redacted', workItems: entries };
    redactWorkItemActivity(exported);
    assert.deepEqual(exported, { label: 'Redacted' });
    const mismatch = call('list_comments', { workItemId: 12 }, { comments: [{ id: 3, workItemId: 99, text: 'wrong' }] });
    assert.equal(extractWorkItemActivity({ requests: [{ response: [mismatch] }] })[0]?.outcome, 'unavailable');
});

test('repository and wiki reads distinguish requests, content evidence, ranges, and missing responses', () => {
    const call = (kind: string, input: object, value: unknown) => ({ kind: 'toolInvocationSerialized', toolId: `mcp_azuredevops_m_${kind}`,
        toolCallId: kind, source: { type: 'mcp' }, isConfirmed: { type: 1 }, isComplete: true,
        toolSpecificData: { rawInput: input }, resultDetails: { output: [{ isText: true, value: JSON.stringify(value) }] } });
    const repo = call('repo_file', { action: 'get_content', repositoryId: 'Demo', path: '/src/main.ts', version: 'main', versionType: 'Branch' },
        { path: '/src/main.ts', content: 'PRIVATE_SOURCE\nnext', commitId: 'abc123', startLine: 7, endLine: 8 });
    const wiki = call('wiki', { action: 'get_page', wikiIdentifier: 'Docs', path: '/Setup' }, { path: '/Setup', title: 'Setup', content: '# Setup\nPRIVATE_BODY',
        sections: [{ title: 'Setup', startLine: 1, endLine: 2 }] });
    const snapshot = { sessionId: 'resource-test', requests: [{ timestamp: 1000, response: [repo, wiki, repo] }] };
    const entries = extractResourceActivity(snapshot);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.requestedVersion, 'main');
    assert.equal(entries[0]?.returnedRevision, 'abc123');
    assert.deepEqual(entries[0]?.range, { startLine: 7, endLine: 8 });
    assert.equal(entries[1]?.title, 'Setup');
    assert.deepEqual(entries[1]?.sections, [{ title: 'Setup', startLine: 1, endLine: 2 }]);
    assert.equal(JSON.stringify(resourceMetadata(entries)).includes('PRIVATE_'), false, 'Bodies are withheld from initial view messages');
    const exported = { resources: structuredClone(entries) };
    redactResourceActivity(exported, false);
    assert.equal(JSON.stringify(exported).includes('PRIVATE_'), false, 'Even unredacted metadata exports omit response bodies');
    redactResourceActivity(exported, true);
    assert.deepEqual(exported, {});
    assert.deepEqual(extractHistory(snapshot, []).events, [], 'Remote files do not become local coverage');
    for (const extra of [{ isError: true }, { isCancelled: true }, { isComplete: false }, { isConfirmed: undefined }, { resultDetails: {} }]) {
        const entry = extractResourceActivity({ requests: [{ response: [{ ...repo, ...extra }] }] })[0]!;
        assert.equal(entry.preview, undefined);
        assert.equal(entry.evidence, 'none');
    }
    const raw = { ...repo, resultDetails: { output: [{ isText: true, value: 'unstructured response' }] } };
    const unstructured = extractResourceActivity({ requests: [{ response: [raw] }] })[0]!;
    assert.equal(unstructured.evidence, 'text-response');
    assert.equal(unstructured.range, undefined);
    assert.equal(unstructured.returnedRevision, undefined);
    const search = { ...wiki, toolId: 'mcp_azuredevops_m_search_wiki' };
    assert.deepEqual(extractResourceActivity({ requests: [{ response: [search] }] }), []);
    const mismatch = call('repo_file', { action: 'get_content', path: '/requested' }, { path: '/different', content: 'bad attribution' });
    assert.equal(extractResourceActivity({ requests: [{ response: [mismatch] }] })[0]?.outcome, 'unavailable');
    const secret = call('repo_file', { action: 'get_content', path: '/.env' }, { path: '/.env', content: 'SECRET' });
    assert.equal(extractResourceActivity({ requests: [{ response: [secret] }] })[0]?.preview, undefined);
    const huge = call('wiki', { action: 'get_page', path: '/Large' }, { path: '/Large', content: 'x'.repeat(20000) });
    const limited = extractResourceActivity({ requests: [{ response: [huge] }] })[0]!;
    assert.equal(limited.preview?.length, 16384);
    assert.equal(limited.previewTruncated, true);
    const markdown = call('wiki', { action: 'get_page', path: '/Guide' }, { path: '/Guide', content: '# Guide\n## Setup\n```text\n# Not a section\n```\nDetails\n-------\n' });
    const parsedMarkdown = extractResourceActivity({ requests: [{ response: [markdown] }] })[0]!;
    assert.equal(parsedMarkdown.title, 'Guide');
    assert.deepEqual(parsedMarkdown.sections.map(section => section.title), ['Guide', 'Setup', 'Details']);
    assert.equal(parsedMarkdown.sectionSource, 'returned Markdown headings');
    assert.equal(parsedMarkdown.range, undefined, 'Heading parsing does not invent source-line provenance');
    const budgeted = extractResourceActivity({ requests: [{ response: Array.from({ length: 34 }, (_, index) => ({ ...huge, toolCallId: `large-${index}` })) }] });
    assert.equal(budgeted.reduce((total, entry) => total + (entry.preview?.length ?? 0), 0), 512 * 1024);
    assert.equal(budgeted.at(-1)?.previewUnavailable, 'Session preview limit reached');
    const metadataOnly = call('wiki', { action: 'get_page', path: '/Home', includeContent: false }, { path: '/Home', id: 3 });
    assert.equal(extractResourceActivity({ requests: [{ response: [metadataOnly] }] })[0]?.evidence, 'metadata');
    assert.equal(resourceLink('https://dev.azure.com/org/project/_git/repo?path=%2Fsrc%2Fmain.ts&token=SECRET', 'repository'),
        'https://dev.azure.com/org/project/_git/repo?path=%2Fsrc%2Fmain.ts');
    assert.equal(resourceLink('https://evil.example/_wiki/wikis/docs/1', 'wiki'), undefined);
    assert.equal(resourceLink('javascript:alert(1)', 'repository'), undefined);
    assert.equal(resourceLink('https://user:secret@dev.azure.com/org/project/_git/repo', 'repository'), undefined);
    assert.equal(resourceLink('https://dev.azure.com.evil.example/org/_git/repo', 'repository'), undefined);
});

test('repository read-line view uses explicit matching ranges, escapes source, and labels unknown mapping', () => {
    const activity = extractResourceActivity({ requests: [{ response: [{ kind: 'toolInvocationSerialized', toolId: 'mcp_azuredevops_m_repo_file',
        toolCallId: 'read-lines', source: { type: 'mcp' }, isComplete: true, isConfirmed: { type: 1 },
        toolSpecificData: { rawInput: { action: 'get_content', path: '/sample.ts' } },
        resultDetails: { output: [{ isText: true, value: JSON.stringify({ path: '/sample.ts', startLine: 11, endLine: 12,
            content: '<img src=x onerror=alert(1)>\r\nsecond', commitId: 'abc123' }) }] }
    }] }] })[0]!;
    const model = repositoryReadLines(activity);
    assert.equal(model.mapped, true);
    assert.deepEqual(model.lines.map(line => line.number), [11, 12]);
    const html = repositoryReadLinesHtml(activity, '<script>session</script>');
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('recorded'));
    for (const partial of [{ range: undefined }, { responseLines: 3 }, { evidence: 'text-response' as const }]) {
        const unknown = repositoryReadLines({ ...activity, ...partial });
        assert.equal(unknown.mapped, false);
        assert.deepEqual(unknown.lines.map(line => line.number), [1, 2]);
        assert.match(unknown.note, /not source-file line numbers/);
    }
    const truncated = repositoryReadLines({ ...activity, preview: 'partial', previewTruncated: true });
    assert.deepEqual(truncated.lines.map(line => line.number), [11]);
    assert.match(truncated.note, /final displayed line may be partial/);
    const unavailable = repositoryReadLines({ ...activity, preview: undefined, previewUnavailable: 'Withheld' });
    assert.deepEqual(unavailable.lines, []);
    assert.match(unavailable.note, /Withheld/);
});

test('chat JSONL reconstructs snapshots, replacements, appends, and partial final writes', () => {
    const lines = [
        { kind: 0, v: { sessionId: 'existing', requests: [] } },
        { kind: 2, k: ['requests'], v: [{ response: [] }] },
        { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocationSerialized', isComplete: false }] },
        { kind: 1, k: ['requests', 0, 'response', 0, 'isComplete'], v: true }
    ].map(value => JSON.stringify(value)).join('\n');
    const snapshot = replayHistory(`${lines}\n{"kind":`, true);
    assert.deepEqual(snapshot.requests, [{ response: [{ kind: 'toolInvocationSerialized', isComplete: true }] }]);
    assert.throws(() => replayHistory(`${lines}\n{"kind":\n`, true), /Invalid complete/);
    assert.throws(() => replayHistory(`${lines}\n${JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: true })}`, true), /Invalid chat update path/);
    assert.throws(() => replayHistory(`${lines}\n${JSON.stringify({ kind: 3, k: ['requests'], v: [] })}`, true), /Unsupported/);
});

test('historical reads are explicit tool evidence, never attachment/search guesses or fake revisions', () => {
    const directory = path.resolve('fixture');
    const root = { id: hash('history-root'), directory, name: 'fixture' };
    const uri = pathToFileURL(path.join(directory, 'source.ts')).toString();
    const tool = { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: 'read-1',
        isConfirmed: { type: 1 }, isComplete: true, pastTenseMessage: { value: `Read [file](${uri}#L2-L5)` } };
    const session = extractHistory({ sessionId: 'existing', customTitle: 'My Copilot Chat', creationDate: 1000, requests: [{
        timestamp: 1000, response: [tool, tool, { ...tool, toolCallId: 'search', toolId: 'copilot_findTextInFiles' },
            { ...tool, toolCallId: 'denied', isConfirmed: { type: 2 } }, { ...tool, toolCallId: 'pending', isComplete: false },
            { ...tool, toolCallId: 'unknown-range', pastTenseMessage: { value: `Read [file](${uri})` } },
            { ...tool, toolCallId: 'secret', pastTenseMessage: { value: `Read [file](${pathToFileURL(path.join(directory, '.env'))})` } }]
    }] }, [root]);
    assert.equal(session.label, 'My Copilot Chat');
    assert.equal(session.coverage, 'copilot-history-read-metadata');
    assert.equal(session.events.length, 2);
    assert.equal(session.events[0]?.startLine, 2);
    assert.equal(session.events[1]?.startLine, undefined);
    assert.equal('snapshotHash' in session.events[0]!, false);
    assert.equal(session.unmappedCalls, 1);
});

test('history listing and parsing are read-only and work without a tracker session', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'act-history-'));
    try {
        const file = path.join(folder, 'existing-chat.jsonl');
        const original = JSON.stringify({ kind: 0, v: { sessionId: 'existing-chat', customTitle: 'Existing chat', requests: [] } }) + '\n';
        await fs.writeFile(file, original);
        assert.equal((await listHistory([folder]))[0]?.label, 'Existing chat');
        assert.equal((await readHistory(file, [])).id, 'copilot:existing-chat');
        assert.equal(await fs.readFile(file, 'utf8'), original);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('ranges return numbered CRLF lines, clamp EOF, preserve final empty lines', () => {
    assert.equal(sliceRead('first\r\nsecond', input).output, '1: first\n2: second');
    assert.equal(sliceRead('first\n', input).endLine, 2);
    assert.equal(sliceRead('', input).output, '1: ');
    assert.throws(() => sliceRead('first', { ...input, startLine: 2 }), /past/);
});
test('rejects invalid parameters and oversized or binary output', () => {
    for (const parameters of [{ ...input, startLine: 0 }, { ...input, endLine: 501 }, { ...input, endLine: 0 },
        { ...input, startLine: 1.5 }, { ...input, extra: true }]) { assert.throws(() => validateInput(parameters)); }
    assert.deepEqual(validateInput(input), input);
    assert.throws(() => sliceRead('x'.repeat(32000), input), /too large/);
    assert.throws(() => sliceRead('binary\0', input), /supported text/);
});
test('revision-aware interval union counts repetition without mutating inputs', () => {
    const events = [event(5, 15), event(1, 10)];
    assert.deepEqual(summary(events), { volume: 21, unique: 15, repeated: 6 });
    assert.equal(events[0]?.startLine, 5);
    assert.equal(summary([...events, { ...event(), snapshotHash: hash('edited') }]).unique, 25);
});
test('containment and exclusions reject sibling prefixes and secret paths', () => {
    const root = path.resolve('workspace');
    assert.equal(isWithin(root, `${root}-sibling/file`), false);
    assert.equal(isWithin(root, path.join(root, 'src', 'file')), true);
    for (const name of ['.env', 'src/.env.prod', '.git/config', '.npmrc', 'key.pem', '.ssh/id_ed25519', 'node_modules/index.js']) {
        assert.equal(excluded(name), true, name);
    }
    assert.equal(excluded('src/core.ts'), false);
});
test('canonical file resolution blocks external files, junction escape, directories, and secrets', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'act-policy-'));
    try {
        const directory = path.join(temporary, 'workspace');
        const outside = path.join(temporary, 'outside');
        await fs.mkdir(directory); await fs.mkdir(outside);
        await fs.writeFile(path.join(directory, 'safe.txt'), 'safe');
        await fs.writeFile(path.join(directory, '.env'), 'secret');
        await fs.writeFile(path.join(outside, 'external.txt'), 'outside');
        await fs.symlink(outside, path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        const roots = [{ id: hash('root'), directory: await fs.realpath(directory), name: 'workspace' }];
        assert.equal((await resolveFile(path.join(directory, 'safe.txt'), roots)).relativePath, 'safe.txt');
        for (const candidate of [outside, directory, path.join(directory, '.env'), path.join(directory, 'escape', 'external.txt')]) {
            await assert.rejects(resolveFile(candidate, roots));
        }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('sessions serialize calls, reject stale generations, and restore metadata only', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'act-store-'));
    try {
        const store = new TraceStore(directory);
        await store.load();
        const session = await store.start('Test', [hash('root')]);
        await assert.rejects(store.start('Duplicate', [hash('root')]));
        await Promise.all([store.record(session.id, 0, event(), () => false), store.record(session.id, 0, event(5, 15), () => false)]);
        assert.equal(store.get(session.id)?.events.length, 2);
        await store.setState(session.id, 'paused');
        await store.setState(session.id, 'recording');
        await assert.rejects(store.record(session.id, 0, event(), () => false));
        await assert.rejects(store.record(session.id, 2, event(), () => true));
        const restored = new TraceStore(directory);
        assert.equal(await restored.load(), 0);
        assert.throws(() => restored.requireRecording(session.id));
        await assert.rejects(restored.delete(session.id));
        const persisted = JSON.parse(await fs.readFile(path.join(directory, `${session.id}.json`), 'utf8'));
        assert.deepEqual(Object.keys(persisted.events[0]).sort(), Object.keys(event()).sort());
        assert.throws(() => parseSession({ ...persisted, schemaVersion: 2 }));
        assert.throws(() => parseSession({ ...persisted, events: [{ ...event(), relativePath: '../secret' }] }));
        await store.setState(session.id, 'stopped');
        await store.delete(session.id);
        assert.equal(store.list().length, 0);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('failed persistence never updates in-memory read history; corrupt metadata is isolated', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'act-failure-'));
    try {
        await fs.writeFile(path.join(directory, 'broken.json'), '{');
        const store = new TraceStore(directory);
        assert.equal(await store.load(), 1);
        const session = await store.start('Read', [hash('root')]);
        await fs.rm(directory, { recursive: true, force: true });
        await assert.rejects(store.record(session.id, 0, event(), () => false));
        assert.equal(store.get(session.id)?.events.length, 0);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('chat status distinguishes unsaved read evidence from unmapped entries and updates to a live count', () => {
    const session = extractHistory({ sessionId: 'status-test', requests: [] }, []);
    assert.match(historyStatus(session), /no completed supported file reads saved yet/);
    session.recognizedCalls = 2;
    assert.match(historyStatus(session), /2 read entries found, but none map/);
    session.events = [{ id: 'read-1', rootId: hash('root'), relativePath: 'source.ts' }];
    assert.match(historyStatus(session), /1 recorded read in this repository/);
    session.events.push({ id: 'read-2', rootId: hash('root'), relativePath: 'other.ts' });
    assert.match(historyStatus(session), /2 recorded reads in this repository/);
});

test('repository chats precede newer remaining chats with independent recent-first limits', () => {
    const entries: HistoryEntry[] = Array.from({ length: 105 }, (_, index) => ({ file: `other-${index}`, label: 'Other chat', workspace: 'other',
        updatedAt: new Date(200000 + index * 1000).toISOString(), repositoryMatch: false }));
    const oldRepo = { file: 'repo-old', label: 'Repository chat', workspace: 'repo', updatedAt: new Date(1000).toISOString(), repositoryMatch: true };
    const newRepo = { ...oldRepo, file: 'repo-new', updatedAt: new Date(2000).toISOString() };
    entries.push(oldRepo, newRepo);
    const original = [...entries];
    const result = groupHistory(entries);
    assert.deepEqual(result.repository.map(entry => entry.file), ['repo-new', 'repo-old']);
    assert.equal(result.other.length, 100);
    assert.equal(result.other[0]?.file, 'other-104');
    assert.deepEqual(entries, original, 'Grouping does not mutate input');
    assert.deepEqual(groupHistory([]), { repository: [], other: [] });
});

test('chat listing associates saved single and multi-root workspaces without title or path-prefix guesses', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'act-chat-groups-'));
    try {
        const repo = path.join(temporary, 'repo with spaces');
        await fs.mkdir(repo);
        const roots = [{ id: hash('root'), directory: repo, name: 'repo with spaces' }];
        const folders: string[] = [];
        const fixture = async (name: string, metadata?: unknown): Promise<string> => {
            const folder = path.join(temporary, 'storage', name, 'chatSessions');
            await fs.mkdir(folder, { recursive: true });
            if (metadata) { await fs.writeFile(path.join(path.dirname(folder), 'workspace.json'), JSON.stringify(metadata)); }
            await fs.writeFile(path.join(folder, `${name}.jsonl`), JSON.stringify({ kind: 0, v: { customTitle: 'Identical title', sessionId: name, requests: [] } }) + '\n');
            folders.push(folder);
            return folder;
        };
        const single = await fixture('single', { folder: pathToFileURL(repo + path.sep).toString() });
        const multiFile = path.join(temporary, 'project.code-workspace');
        await fs.writeFile(multiFile, '// VS Code workspace with comments and trailing commas\n{"folders":[{"path":"repo with spaces"},],}');
        await fixture('multi', { workspace: pathToFileURL(multiFile).toString() });
        const uriFile = path.join(temporary, 'uri.code-workspace');
        await fs.writeFile(uriFile, JSON.stringify({ folders: [{ uri: pathToFileURL(repo).toString() }] }));
        await fixture('uri', { workspace: pathToFileURL(uriFile).toString() });
        await fixture('sibling', { folder: pathToFileURL(repo + '-other').toString() });
        await fixture('parent', { folder: pathToFileURL(temporary).toString() });
        await fixture('remote', { folder: 'vscode-remote://ssh-remote+server/repo' });
        const missing = await fixture('missing');
        const corrupt = await fixture('corrupt');
        await fs.writeFile(path.join(path.dirname(corrupt), 'workspace.json'), '{bad');
        if (process.platform === 'win32') { await fixture('casing', { folder: pathToFileURL(repo.toUpperCase()).toString() }); }
        const entries = await listHistory(folders, roots);
        const matched = entries.filter(entry => entry.repositoryMatch).map(entry => path.basename(entry.file, '.jsonl')).sort();
        assert.deepEqual(matched, process.platform === 'win32' ? ['casing', 'multi', 'single', 'uri'] : ['multi', 'single', 'uri']);
        assert.equal(entries.find(entry => entry.file === path.join(single, 'single.jsonl'))?.workspace, 'repo with spaces');
        assert.equal(entries.find(entry => entry.file === path.join(corrupt, 'corrupt.jsonl'))?.workspace, 'Unknown workspace');
        const fallback = await listHistory([missing], roots, missing);
        assert.equal(fallback[0]?.repositoryMatch, true, 'Current profile storage maps even when workspace.json is absent');
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('history preserves stated line sections instead of treating navigation anchors as read ranges', () => {
    const directory = path.resolve('fixture');
    const root = { id: hash('history-root'), directory, name: 'fixture' };
    const uri = pathToFileURL(path.join(directory, 'source.ts')).toString();
    const messages = [
        `Read [file](${uri}#105-105), lines 105 to 181`,
        `Read [file](${uri}#105-105)`,
        `Read [file](${uri}#L5-L8)`,
        `Read [file](${uri}), lines 10 to 5`,
        `Read [file](${uri}), lines 0 to 5`,
        `Read [file](${uri}) and [file](${uri}), lines 2 to 3`
    ];
    const session = extractHistory({ sessionId: 'line-ranges', requests: [{ response: messages.map((value, index) => ({
        kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: `read-${index}`, isComplete: true,
        isConfirmed: { type: 1 }, pastTenseMessage: { value }
    })) }] }, [root]);
    assert.deepEqual(session.events.map(event => [event.startLine, event.endLine]), [
        [105, 181], [undefined, undefined], [5, 8], [undefined, undefined], [undefined, undefined], [undefined, undefined]
    ]);
});

test('editor highlights merge known ranges and distinguish missing or stale source revisions', () => {
    const events = [
        { startLine: 2, endLine: 4, snapshotHash: 'current' },
        { startLine: 4, endLine: 6, snapshotHash: 'current' },
        { startLine: 8, endLine: 8, snapshotHash: 'current' },
        { startLine: 1, endLine: 5, snapshotHash: 'old' },
        { startLine: 9, endLine: 10 }, {}, { startLine: 0, endLine: 1 },
        { startLine: 3, endLine: 20 }, { startLine: 5, endLine: 2 }, { startLine: 1.5, endLine: 2 }
    ];
    const before = structuredClone(events);
    assert.deepEqual(readHighlightRanges(events, 'current', 10, true), {
        verified: [{ startLine: 2, endLine: 3, readCount: 1 }, { startLine: 4, endLine: 4, readCount: 2 },
            { startLine: 5, endLine: 6, readCount: 1 }, { startLine: 8, endLine: 8, readCount: 1 }],
        unverified: [{ startLine: 9, endLine: 10, readCount: 1 }]
    });
    assert.deepEqual(readHighlightRanges(events, 'changed', 10, false), { verified: [], unverified: [] });
    assert.deepEqual(events, before);
});

test('frequency ranges count distinct reads at inclusive overlaps and merge only equal counts', () => {
    const first = { id: 'first', startLine: 1, endLine: 10 };
    const events = [first, { id: 'second', startLine: 5, endLine: 15 }, first, { id: 'third', startLine: 16, endLine: 20 },
        { id: 'missing' }, { id: 'stale', startLine: 1, endLine: 20, snapshotHash: 'old' }];
    assert.deepEqual(readHighlightRanges(events, 'current', 20, true), { verified: [], unverified: [
        { startLine: 1, endLine: 4, readCount: 1 }, { startLine: 5, endLine: 10, readCount: 2 }, { startLine: 11, endLine: 20, readCount: 1 }
    ] });
    const repeated = Array.from({ length: 10 }, (_, index) => ({ id: `read-${index}`, startLine: 2, endLine: 2, snapshotHash: 'current' }));
    assert.deepEqual(readHighlightRanges(repeated, 'current', 2, false).verified, [{ startLine: 2, endLine: 2, readCount: 10 }]);
    assert.deepEqual(readHighlightRanges([{ startLine: 1, endLine: 1000000000 }], 'current', 1000000000, true).unverified,
        [{ startLine: 1, endLine: 1000000000, readCount: 1 }], 'Large spans use interval boundaries, not per-line arrays');
    assert.deepEqual([1, 2, 3, 4, 7, 8, 100].map(readFrequency), ['single', 'repeat', 'repeat', 'frequent', 'frequent', 'intense', 'intense']);
});