import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import type { Runtime } from '../extension';
import { TOOL_NAME } from '../core';
import type { HistorySession } from '../history';
import { extractHistory } from '../history';
import { historyPickerItems } from '../views';

function workItemCalls() {
    const tool = { kind: 'toolInvocationSerialized', toolId: 'mcp_azuredevops_m_wit_work_item',
        source: { type: 'mcp', serverLabel: 'Azure DevOps' }, isComplete: true, isConfirmed: { type: 1 } };
    const get = { ...tool, toolCallId: 'ado-get', toolSpecificData: { rawInput: { action: 'get', project: 'Sample Project', id: 1042,
        fields: ['System.Title', 'System.State', 'System.Description', 'System.AssignedTo'] } },
        resultDetails: { output: [{ isText: true, type: 'embed', value: JSON.stringify({ id: 1042, rev: 7,
            fields: { 'System.Title': 'Sample: improve session diagnostics', 'System.State': 'Active', 'System.Description': 'PRIVATE_BODY' },
            url: 'https://dev.azure.com/example/Sample%20Project/_apis/wit/workitems/1042?token=PRIVATE_TOKEN' }) }] } };
    const comments = { ...tool, toolCallId: 'ado-comments', toolSpecificData: { rawInput: { action: 'list_comments', project: 'Sample Project', workItemId: 1042 } },
        resultDetails: { output: [{ isText: true, value: JSON.stringify({ totalCount: 9, comments: [
            { id: 21, workItemId: 1042, text: 'PRIVATE_COMMENT' }, { id: 22, workItemId: 1042, text: 'PRIVATE_COMMENT' }] }) }] } };
    const missing = { ...tool, toolCallId: 'ado-missing', toolSpecificData: { rawInput: { action: 'get', project: 'Sample Project', id: 1043 } } };
    const failed = { ...missing, toolCallId: 'ado-failed', resultDetails: { isError: true } };
    return [get, comments, missing, failed, get];
}

function resourceCalls() {
    const tool = { kind: 'toolInvocationSerialized', source: { type: 'mcp', serverLabel: 'Azure DevOps' }, isComplete: true, isConfirmed: { type: 1 } };
    const repo = { ...tool, toolId: 'mcp_azuredevops_m_repo_file', toolCallId: 'repo-content',
        toolSpecificData: { rawInput: { action: 'get_content', project: 'Sample Project', repositoryId: 'Sample Repo', path: '/src/checkout.ts', version: 'main', versionType: 'Branch' } },
        resultDetails: { output: [{ isText: true, value: JSON.stringify({ path: '/src/checkout.ts', commitId: 'c0ffee123', startLine: 11, endLine: 12,
            content: 'export const sample = "SAMPLE_SOURCE_ONLY";\n// <img src=x onerror=alert(1)>',
            webUrl: 'https://dev.azure.com/example/Sample%20Project/_git/SampleRepo?path=%2Fsrc%2Fcheckout.ts&token=PRIVATE_TOKEN' }) }] } };
    const wiki = { ...tool, toolId: 'mcp_azuredevops_2_wiki', toolCallId: 'wiki-content',
        toolSpecificData: { rawInput: { action: 'get_page', project: 'Sample Project', wikiIdentifier: 'Sample Wiki', path: '/Getting-started' } },
        resultDetails: { output: [{ isText: true, value: JSON.stringify({ path: '/Getting-started', content: '# Getting started\n\n## Prerequisites\nSAMPLE_WIKI_ONLY\n\n## Run locally\nUse the development profile.',
            remoteUrl: 'https://dev.azure.com/example/Sample%20Project/_wiki/wikis/SampleWiki/42/Getting-started' }) }] } };
    const missing = { ...repo, toolCallId: 'repo-missing', resultDetails: {} };
    const metadata = { ...wiki, toolCallId: 'wiki-metadata', resultDetails: { output: [{ isText: true, value: JSON.stringify({ path: '/Getting-started', id: 42 }) }] } };
    return [repo, wiki, missing, metadata, repo];
}

function searchLogCalls() {
    const tool = { kind: 'toolInvocationSerialized', source: { type: 'mcp', serverLabel: 'Azure DevOps' }, isComplete: true, isConfirmed: { type: 1 } };
    const search = { ...tool, toolId: 'mcp_azuredevops_3_search_code', toolCallId: 'code-search', toolSpecificData: { rawInput: {
        searchText: 'Sample: checkout', project: ['Sample Project'], repository: ['Sample Repo'], path: ['/src'], branch: ['main'], skip: 0, top: 5 } },
        resultDetails: { output: [{ isText: true, value: JSON.stringify({ count: 50, infoCode: 0, results: [
            { path: '/src/checkout.ts', repository: { name: 'Sample Repo' }, project: { name: 'Sample Project' },
                matches: { content: [{ line: 12, charOffset: 40, length: 8 }] }, versions: [{ branchName: 'main', changeId: 'sample-sha' }] },
            { path: '/src/cart.ts', repository: { name: 'Sample Repo' }, snippet: 'SAMPLE_SNIPPET_ONLY <img src=x onerror=alert(1)>', matches: { content: [{ line: 8 }] } }
        ] }) }] } };
    const empty = { ...search, toolCallId: 'empty-search', resultDetails: { output: [{ isText: true, value: '{"count":0,"results":[]}' }] } };
    const log = { ...tool, toolId: 'mcp_azuredevops_m_pipelines_build_log', toolCallId: 'build-log', toolSpecificData: { rawInput: {
        action: 'get_content', project: 'Sample Project', buildId: 2048, logId: 17, startLine: 101, endLine: 220 } },
        resultDetails: { output: [{ isText: true, value: JSON.stringify(['SAMPLE_LOG_ONLY: build started', '<script>not executable</script>']) }] } };
    const bounded = { ...log, toolCallId: 'bounded-log', resultDetails: { output: [{ isText: true, value: JSON.stringify({ buildId: 2048,
        logId: 17, startLine: 101, endLine: 102, lines: ['SAMPLE_LOG_ONLY: compile', 'SAMPLE_LOG_ONLY: complete'],
        webUrl: 'https://dev.azure.com/example/Sample%20Project/_build/results?buildId=2048&token=PRIVATE_TOKEN' }) }] } };
    const failed = { ...log, toolCallId: 'failed-log', resultDetails: { isError: true } };
    const list = { ...log, toolCallId: 'list-logs', toolSpecificData: { rawInput: { action: 'list', project: 'Sample Project', buildId: 2048 } } };
    return [search, empty, log, bounded, failed, list, search];
}

export async function run(): Promise<void> {
    const extension = vscode.extensions.getExtension<Runtime>('davidle-ms.agent-context-trace');
    assert.ok(extension, 'Development extension is installed');
    const runtime = await extension.activate();
    assert.ok(runtime, 'Extension activated in a trusted local test workspace');
    const typescript = vscode.workspace.getConfiguration('typescript');
    const previousValidation = typescript.inspect<boolean>('validate.enable')?.globalValue;
    await typescript.update('validate.enable', false, vscode.ConfigurationTarget.Global);
    assert.ok(vscode.lm.tools.some(tool => tool.name === TOOL_NAME), 'Tool registered with the host');
    const roots = runtime.roots;
    assert.equal(roots.length, 2);
    const root = roots[0]!;
    const otherRoot = roots[1]!;
    const filePath = path.join(root.directory, 'source.ts');
    const sourceUri = vscode.Uri.file(filePath);
    const neutralUri = vscode.Uri.file(path.join(root.directory, 'neutral.ts'));
    const otherUri = vscode.Uri.file(path.join(otherRoot.directory, 'source.ts'));
    assert.equal(extension.packageJSON.contributes.views.explorer[0].type, 'webview', 'Heatmap replaces the controls-only tree');
    if (process.env.ACT_TEST_PHASE === 'restore') {
        const previous = runtime.store.list().find(session => session.label === 'Host test');
        assert.ok(previous, 'Session JSON restored independently of test-mode workspace state');
        await runtime.view.selectSession(previous.id);
        assert.equal(runtime.view.enabled, true, 'VS Code extension-test mode intentionally resets workspace state');
        assert.equal(runtime.view.selected()?.events.length, 3, 'Session metadata restored');
        assert.equal(runtime.store.current(), undefined, 'Historical session not automatically recording');
        assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
        const restoredDocument = await vscode.workspace.openTextDocument(sourceUri);
        assert.deepEqual(runtime.view.editorHighlights(restoredDocument).verified, [{ startLine: 1, endLine: 1, readCount: 1 }], 'Only the matching saved revision is highlighted after reload');
        assert.match(runtime.view.provideFileDecoration(sourceUri)!.tooltip!, /3 recorded reads/, 'File total restored without inflating per-line counts across revisions');
        const selected = runtime.view.selected()!;
        await runtime.store.delete(selected.id);
        assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined, 'Deletion removes markers');
        console.log('PASS: session JSON restore, no auto-recording, deletion; workspace preference tested in normal development hosts');
        await typescript.update('validate.enable', previousValidation, vscode.ConfigurationTarget.Global);
        return;
    }
    const historyFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'act-existing-chat-'));
    try {
        const sourceFile = filePath;
        const file = path.join(historyFolder, 'existing-chat.jsonl');
        const read = { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: 'history-read', isComplete: true,
            isConfirmed: { type: 1 }, pastTenseMessage: { value: `Read [file](${pathToFileURL(sourceFile)})` } };
        const initial = JSON.stringify({ kind: 0, v: { sessionId: 'existing-chat', customTitle: 'Existing Copilot Chat',
            creationDate: Date.now(), requests: [{ response: [] }] } }) + '\n';
        const waitForReads = (count: number) => new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Selected history watcher did not refresh.')); }, 10000);
            const subscription = runtime.view.onDidChange(() => {
                if (runtime.view.selected()?.events.length === count) { clearTimeout(timeout); subscription.dispose(); resolve(); }
            });
        });
        await fs.writeFile(file, initial);
        await runtime.selectCopilotFile(file);
        assert.equal(runtime.store.list().length, 0, 'Selecting existing chat creates no tracker session');
        assert.equal(runtime.store.current(), undefined);
        assert.equal(runtime.view.selected()?.label, 'Existing Copilot Chat');
        assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(sourceFile)), undefined);
        assert.match(runtime.view.statusMessage, /no completed supported file reads saved yet/);
        const firstRead = waitForReads(1);
        const firstAppend = JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [read] }) + '\n';
        await fs.appendFile(file, firstAppend);
        await firstRead;
        assert.match(runtime.view.statusMessage, /1 recorded read in this repository/);
        assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(sourceFile))?.badge, 'R');
        assert.equal(runtime.view.selected()?.events[0]?.startLine, undefined, 'Missing historical range is not fabricated');
        assert.deepEqual(runtime.view.editorHighlights(await vscode.workspace.openTextDocument(sourceUri)), { verified: [], unverified: [] }, 'File-only history never highlights the whole file');
        await runtime.view.toggle();
        assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined);
        const updated = waitForReads(2);
        const append = JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ ...read, toolCallId: 'second-read',
            pastTenseMessage: { value: `Read [file](${neutralUri.toString()})` } }] }) + '\n';
        await fs.appendFile(file, append);
        await updated;
        assert.match(runtime.view.statusMessage, /2 recorded reads in this repository/);
        assert.equal(runtime.view.enabled, false, 'History refresh does not turn colors on');
        await runtime.view.toggle();
        assert.equal(runtime.view.provideFileDecoration(neutralUri)?.badge, 'R');
        assert.equal(await fs.readFile(file, 'utf8'), initial + firstAppend + append, 'Extension never edits Copilot chat history');
        const workItemUpdate = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { listener.dispose(); reject(new Error('MCP history watcher did not refresh')); }, 10000);
            const listener = runtime.view.onDidChange(() => {
                const selected = runtime.view.selected();
                if (selected?.coverage === 'copilot-history-read-metadata' && selected.workItems?.length === 4 && selected.resources?.length === 9) {
                    clearTimeout(timeout); listener.dispose(); resolve();
                }
            });
        });
        const mcpAppend = JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [...workItemCalls(), ...resourceCalls(), ...searchLogCalls()] }) + '\n';
        await fs.appendFile(file, mcpAppend);
        await workItemUpdate;
        assert.equal(runtime.view.selected()?.events.length, 2, 'MCP history never creates file coverage');
        assert.equal(await fs.readFile(file, 'utf8'), initial + firstAppend + append + mcpAppend, 'MCP extraction leaves source history unchanged');
        assert.equal(runtime.store.list().length, 0);
        console.log('PASS: existing Copilot chat selection, no tracker session, file-only history colors, selected history watcher, toggle, read-only source');
    } finally { await fs.rm(historyFolder, { recursive: true, force: true }); }
    const sessionId = await runtime.start('Host test');
    const realUri = vscode.Uri.file(filePath);
    const invalidated: string[] = [];
    const decorationChanges = runtime.view.onDidChangeFileDecorations(uris => invalidated.push(...uris.map(uri => uri.toString())));
    const token = new vscode.CancellationTokenSource();
    const invoke = (overrides = {}) => runtime.read({ input: { sessionId, filePath, startLine: 2, endLine: 3, ...overrides }, toolInvocationToken: undefined }, token.token);
    assert.equal(runtime.view.enabled, true);
    assert.equal(runtime.store.get(sessionId)?.events.length, 0, 'Showing coverage controls does not create reads');
    const result = await invoke();
    assert.ok((result.content[0] as vscode.LanguageModelTextPart).value.endsWith('2: second\n3: third'));
    const readDocument = await vscode.workspace.openTextDocument(sourceUri);
    assert.deepEqual(runtime.view.editorHighlights(readDocument), { verified: [{ startLine: 2, endLine: 3, readCount: 1 }], unverified: [] });
    assert.deepEqual(runtime.view.editorHighlights(await vscode.workspace.openTextDocument(otherUri)), { verified: [], unverified: [] }, 'Highlights are isolated by workspace root');
    assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
    assert.equal(runtime.view.provideFileDecoration(neutralUri), undefined);
    assert.equal(runtime.view.provideFileDecoration(otherUri), undefined, 'Multi-root identity is isolated');
    assert.equal(runtime.view.provideFileDecoration(realUri)?.color?.id, 'agentContextTrace.readFileForeground', 'Explorer filename gets the read color');
    assert.ok(invalidated.includes(realUri.toString()), 'Recording invalidates the real Explorer URI');
    assert.equal(runtime.view.provideFileDecoration(neutralUri), undefined, 'Unrecorded Explorer file is neutral');
    assert.equal(runtime.view.provideFileDecoration(otherUri), undefined, 'Same-named Explorer file in another root is neutral');
    assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(root.directory)), undefined, 'Explorer folders are neutral');
    assert.equal(runtime.view.provideFileDecoration(realUri.with({ scheme: 'git' })), undefined, 'Other URI schemes are untouched');
    if (process.platform === 'win32') {
        assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(filePath.toUpperCase()))?.badge, 'R', 'Windows path casing is ignored');
    }
    assert.equal(runtime.view.provideFileDecoration(sourceUri.with({ scheme: 'agent-context-trace' })), undefined, 'Removed duplicate-tree scheme is not decorated');
    await assert.rejects(invoke({ filePath: path.join(root.directory, '.env') }));
    const configuration = vscode.workspace.getConfiguration('agentContextTrace');
    await configuration.update('excludeGlobs', ['**/source.ts'], vscode.ConfigurationTarget.Global);
    await assert.rejects(invoke(), /excluded/);
    await configuration.update('excludeGlobs', [], vscode.ConfigurationTarget.Global);
    await runtime.view.toggle();
    assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined);
    assert.equal(runtime.view.provideFileDecoration(realUri), undefined, 'Toggle hides Explorer filename color too');
    assert.deepEqual(runtime.view.editorHighlights(readDocument), { verified: [], unverified: [] }, 'Eye toggle also hides in-editor highlights');
    await invoke({ startLine: 1, endLine: 1 });
    assert.equal(runtime.store.get(sessionId)?.events.length, 2, 'Recording continues with colors off');
    await runtime.view.toggle();
    assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
    assert.deepEqual(runtime.view.editorHighlights(readDocument).verified, [{ startLine: 1, endLine: 3, readCount: 1 }], 'Adjacent equal-frequency reads merge into a single section');
    assert.equal(runtime.view.provideFileDecoration(sourceUri)?.color?.id, 'agentContextTrace.readFileRepeatForeground');
    const document = await vscode.workspace.openTextDocument(filePath);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), 'dirty ');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.deepEqual(runtime.view.editorHighlights(document).verified, [], 'Editing clears stale verified ranges');
    await invoke({ startLine: 1, endLine: 1 });
    assert.equal(runtime.store.get(sessionId)?.events.at(-1)?.isDirty, true);
    await document.save();
    assert.deepEqual(runtime.view.editorHighlights(document).verified, [{ startLine: 1, endLine: 1, readCount: 1 }], 'Read against dirty buffer matches saved unchanged text');
    token.cancel();
    await assert.rejects(invoke());
    token.dispose();
    assert.equal(runtime.store.get(sessionId)?.events.length, 3, 'Denied and cancelled calls do not create read markers');
    await runtime.store.setState(sessionId, 'paused');
    const fresh = new vscode.CancellationTokenSource();
    await assert.rejects(runtime.read({ input: { sessionId, filePath, startLine: 1, endLine: 1 }, toolInvocationToken: undefined }, fresh.token));
    fresh.dispose();
    await runtime.store.setState(sessionId, 'stopped');
    const second = await runtime.start('Empty history');
    assert.deepEqual(runtime.view.editorHighlights(document), { verified: [], unverified: [] }, 'Changing the displayed session clears editor highlights');
    assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined, 'New selected session clears old colors');
    assert.equal(runtime.view.provideFileDecoration(realUri), undefined, 'New session clears Explorer filename color');
    await runtime.store.setState(second, 'stopped');
    await runtime.view.selectSession(sessionId);
    assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
    const sourceEditor = await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(3, 0, 3, 0) });
    await vscode.commands.executeCommand('revealInExplorer', neutralUri);
    await vscode.commands.executeCommand('agentContextTrace.readCoverage.focus');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.ACT_CDP_PORT}`);
    try {
        const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'));
        assert.ok(page, 'Native VS Code workbench renderer is reachable');
        const section = page.locator('.pane').filter({ has: page.getByText('Agent Read Coverage', { exact: true }) }).first();
        await section.waitFor({ state: 'visible' });
        const coverageFrameName = await page.locator('iframe.webview').getAttribute('name');
        assert.ok(coverageFrameName);
        const heatmap = page.frameLocator(`iframe[name="${coverageFrameName}"]`).frameLocator('#active-frame');
        const canvas = heatmap.locator('#heatmap');
        await canvas.waitFor({ state: 'visible' });
        assert.match(await heatmap.locator('#filename').textContent() ?? '', /repo-one.*source.ts/);
        assert.equal(await canvas.evaluate(() => globalThis.document.documentElement.scrollWidth <= window.innerWidth), true, 'Compact heatmap has no horizontal overflow');
        const verifyHeatmapSpacing = async () => {
            const spacing = await canvas.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                const scale = globalThis.document.getElementById('scale')!.getBoundingClientRect();
                const content = globalThis.document.getElementById('content')!.getBoundingClientRect();
                const readout = globalThis.document.getElementById('position')!.getBoundingClientRect();
                const labels = Array.from(globalThis.document.querySelectorAll('.line-label')).map(label => label.getBoundingClientRect());
                return { height: bounds.height, above: bounds.top - scale.bottom,
                    below: parseFloat(getComputedStyle(globalThis.document.getElementById('map')!).marginBottom),
                    readoutVisible: readout.top >= content.bottom && readout.bottom <= window.innerHeight && readout.height >= 32,
                    labelsSeparated: labels.every((label, index) => index === 0 || label.top >= labels[index - 1]!.bottom) };
            });
            assert.ok(spacing.height >= 320, 'Heatmap stays at least 320px tall even in a short section');
            assert.ok(spacing.above >= 20 && spacing.below >= 20, 'Heatmap has readable space above and below');
            assert.ok(spacing.readoutVisible, 'Hover counter stays visible below the scrolling map, including short sections');
            assert.ok(spacing.labelsSeparated, 'Line labels do not collide in compact or expanded views');
        };
        await verifyHeatmapSpacing();
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'file-heatmap-compact.png') });
        const sectionBounds = await section.boundingBox();
        assert.ok(sectionBounds);
        const sash = await page.locator('.monaco-sash.horizontal').evaluateAll((elements, bounds) => elements
            .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 100 && rect.x >= bounds.x - 4
                && rect.x < bounds.x + bounds.width && Math.abs(rect.y - bounds.y) < 8)
            .map(rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }))[0], sectionBounds);
        assert.ok(sash, 'Native divider above Agent Read Coverage is available');
        await page.mouse.move(sash.x, sash.y);
        await page.mouse.down();
        await page.mouse.move(sash.x, sash.y - 300, { steps: 12 });
        await page.mouse.up();
        const expandedMap = await canvas.boundingBox();
        assert.ok(expandedMap && expandedMap.height > 150, 'Native divider gives the heatmap useful vertical space');
        await heatmap.getByRole('tab', { name: 'Work Items', exact: true }).click();
        await heatmap.locator('#work-empty').filter({ hasText: 'available for saved Copilot chats' }).waitFor();
        const workSession = extractHistory({ sessionId: 'ado-preview', customTitle: 'Synthetic Azure DevOps preview',
            requests: [{ timestamp: '2026-09-17T01:00:00Z', response: workItemCalls() }] }, roots);
        runtime.view.showHistory(workSession);
        await heatmap.locator('#work-summary').filter({ hasText: '4 recorded calls | 2 returned item responses' }).waitFor();
        assert.equal(await heatmap.locator('.work-entry').count(), 4, 'Calls are deduplicated by ID');
        const workRead = heatmap.locator('.work-entry').filter({ hasText: 'Sample: improve session diagnostics' });
        await workRead.locator('summary').click();
        await workRead.getByText('Returned fields', { exact: true }).waitFor();
        const returnedFields = await workRead.locator('dt').filter({ hasText: /^Returned fields$/ }).locator('+ dd').textContent();
        assert.match(returnedFields ?? '', /System.Description/);
        assert.equal(returnedFields?.includes('System.AssignedTo'), false, 'Requested-only fields are not presented as returned');
        assert.equal(await workRead.locator('a').getAttribute('href'), 'https://dev.azure.com/example/Sample%20Project/_workitems/edit/1042');
        const commentRead = heatmap.locator('.work-entry').filter({ hasText: 'list_comments |' });
        await commentRead.locator('summary').click();
        assert.equal(await commentRead.locator('dt').filter({ hasText: 'Returned comments (this response)' }).locator('+ dd').textContent(), '2');
        assert.equal(await commentRead.locator('dt').filter({ hasText: 'Comment IDs' }).locator('+ dd').textContent(), '21, 22');
        assert.equal((await heatmap.locator('#work-items').textContent())?.includes('PRIVATE_'), false, 'Response bodies and query secrets never enter the UI');
        assert.equal(await heatmap.locator('.work-outcome').filter({ hasText: 'Response metadata unavailable' }).count(), 1);
        assert.equal(await heatmap.locator('.work-outcome').filter({ hasText: 'Failed call' }).count(), 1);
        await commentRead.locator('summary').click();
        await workRead.locator('summary').click();
        await heatmap.locator('#work-items').evaluate(element => { element.scrollTop = 0; });
        assert.equal(await heatmap.locator('#work-items').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Work-item metadata fits a narrow sidebar');
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-work-items.png') });
        await section.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-work-items-overview.png') });
        await workRead.locator('summary').click();
        await heatmap.locator('#work-items').evaluate(element => { element.scrollTop = 0; });
        await section.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-work-item-details.png') });
        await heatmap.locator('#work-filter').fill('1043');
        assert.equal(await heatmap.locator('.work-entry').count(), 2);
        await heatmap.locator('#work-filter').fill('not found');
        await heatmap.locator('#work-empty').filter({ hasText: 'No matching work items' }).waitFor();
        await heatmap.locator('#work-filter').fill('');
        const unsafeTitle = structuredClone(workSession);
        unsafeTitle.workItems![0]!.title = '<img src=x onerror=alert(1)>';
        runtime.view.showHistory(unsafeTitle);
        await heatmap.locator('summary').filter({ hasText: '<img src=x onerror=alert(1)>' }).waitFor();
        assert.equal(await heatmap.locator('#work-list img').count(), 0, 'Titles are text, never HTML');
        runtime.view.showHistory(workSession);
        const manyItems = { ...workSession, id: 'copilot:many-workitems', workItems: Array.from({ length: 51 }, (_, index) => ({
            ...workSession.workItems![0]!, callId: `many-${index}`, itemId: 2000 + index
        })) };
        runtime.view.showHistory(manyItems);
        await heatmap.locator('#work-summary').filter({ hasText: '51 recorded calls' }).waitFor();
        assert.equal(await heatmap.locator('.work-entry').count(), 50);
        await heatmap.locator('#work-more').click();
        assert.equal(await heatmap.locator('.work-entry').count(), 51, 'Additional calls are paged into the view');
        runtime.view.showHistory(workSession);
        await heatmap.locator('#work-summary').filter({ hasText: '4 recorded calls' }).waitFor();
        await runtime.view.toggle();
        assert.equal(await heatmap.locator('.work-entry').count(), 4, 'Eye toggle does not hide work-item evidence');
        await runtime.view.toggle();
        runtime.view.showHistory({ ...workSession, id: 'copilot:empty-workitems', workItems: [] });
        await heatmap.locator('#work-empty').filter({ hasText: 'No supported Azure DevOps' }).waitFor();
        assert.equal(await heatmap.locator('.work-entry').count(), 0, 'Session switching clears external metadata');
        const resourceSession = extractHistory({ sessionId: 'ado-resources', customTitle: 'Synthetic repository and wiki preview',
            requests: [{ timestamp: '2026-09-17T02:00:00Z', response: resourceCalls() }] }, roots);
        runtime.view.showHistory(resourceSession);
        await heatmap.getByRole('tab', { name: /^Repository Files/ }).click();
        await heatmap.locator('#repository-summary').filter({ hasText: '2 recorded calls' }).waitFor();
        const repositoryEntry = heatmap.locator('#repository-list .work-entry').first();
        await repositoryEntry.locator('summary').click();
        const detailValue = (label: string) => repositoryEntry.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('+ dd').textContent();
        assert.equal(await detailValue('Requested repository'), 'Sample Repo');
        assert.equal(await detailValue('Requested version'), 'Branch: main');
        assert.equal(await detailValue('Returned revision'), 'c0ffee123');
        assert.equal(await detailValue('Explicit source range'), '11-12');
        assert.equal(await heatmap.locator('#repository-list .work-entry').nth(1).getByRole('link', { name: 'View read lines' }).count(), 0,
            'Unavailable responses do not offer a read-lines link');
        const sourceBeforeReadView = document.getText();
        await repositoryEntry.getByRole('link', { name: 'View read lines', exact: true }).click();
        const readPanel = page.frameLocator(`iframe.webview:not([name="${coverageFrameName}"])`).frameLocator('#active-frame');
        await readPanel.getByRole('heading', { name: 'Recorded Source Lines' }).waitFor();
        assert.deepEqual(await readPanel.locator('.line-number').allTextContents(), ['11', '12']);
        assert.equal(await readPanel.locator('.read-line.recorded').count(), 2);
        assert.match(await readPanel.locator('code').first().textContent() ?? '', /SAMPLE_SOURCE_ONLY/);
        assert.equal(await readPanel.locator('img, script, input, textarea, [contenteditable="true"]').count(), 0,
            'Read-lines window displays source as escaped, read-only text with no executable scripts');
        const readLineColor = await readPanel.locator('.recorded').first().evaluate(element =>
            getComputedStyle(element).backgroundColor.match(/[\d.]+/g)!.map(Number));
        assert.deepEqual(readLineColor.slice(0, 3), [232, 179, 90]);
        assert.ok(Math.abs(readLineColor[3]! - 24 / 255) < 0.01, 'Returned lines use the existing amber highlight opacity');
        assert.match(await readPanel.locator('#evidence').textContent() ?? '', /not the current repository file/);
        assert.equal(document.getText(), sourceBeforeReadView, 'Opening repository read lines does not alter the local file');
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'repository-read-lines-attachment-check.png') });
        const attachmentText = Array.from({ length: 31 }, (_, index) => `Sample README line ${index + 1}`).join('\n');
        const unknownRangeSession = extractHistory({ sessionId: 'ado-resources', customTitle: 'Synthetic saved text attachment', requests: [{ response: [{
            kind: 'toolInvocationSerialized', toolId: 'mcp_azuredevops_3_repo_file', toolCallId: 'repo-content',
            source: { type: 'mcp', serverLabel: 'AzureDevOps.Mcp' }, isComplete: true, isConfirmed: { type: 1 },
            toolSpecificData: { rawInput: { action: 'get_content', repositoryId: 'Sample Repo', project: 'Sample Project', path: '/README.md' } },
            resultDetails: { isError: false, output: [{ type: 'embed', isText: false, asResource: true, mimeType: 'text/plain',
                uri: { scheme: 'mcp-resource', path: '/synthetic-output' }, value: Buffer.from(attachmentText).toString('base64') }] }
        }] }] }, roots);
        runtime.view.showHistory(unknownRangeSession);
        await repositoryEntry.locator('summary').filter({ hasText: '/README.md' }).waitFor();
        assert.match(await repositoryEntry.locator('.work-outcome').textContent() ?? '', /Text response/);
        assert.equal((await repositoryEntry.textContent())?.includes('Sample README line'), false, 'Saved attachment text remains hidden until requested');
        await repositoryEntry.getByRole('link', { name: 'View read lines', exact: true }).click();
        await readPanel.getByRole('heading', { name: 'Saved Response Lines' }).waitFor();
        assert.deepEqual(await readPanel.locator('.line-number').allTextContents(), Array.from({ length: 31 }, (_, index) => String(index + 1)));
        assert.equal(await readPanel.locator('code').last().textContent(), 'Sample README line 31');
        assert.equal(await readPanel.locator('.read-line.recorded').count(), 0);
        assert.match(await readPanel.locator('#evidence').textContent() ?? '', /not source-file line numbers/);
        assert.equal(await page.locator('iframe.webview').count(), 2, 'Read-lines requests reuse one panel');
        runtime.view.showHistory({ ...resourceSession, id: 'copilot:resource-panel-cleared' });
        await page.locator(`iframe.webview:not([name="${coverageFrameName}"])`).waitFor({ state: 'detached' });
        runtime.view.showHistory(resourceSession);
        await heatmap.locator('#repository-summary').filter({ hasText: '2 recorded calls' }).waitFor();
        await repositoryEntry.locator('summary').click();
        console.log('PASS: repository read-lines link opens an escaped read-only window, accurate amber line numbering, unknown-range labels, panel reuse, and session cleanup');
        assert.equal((await heatmap.locator('#repository-panel').textContent())?.includes('SAMPLE_SOURCE_ONLY'), false, 'Source is not sent before preview request');
        assert.equal((await repositoryEntry.getByRole('link', { name: 'Open in Azure DevOps', exact: true }).getAttribute('href'))?.includes('PRIVATE_TOKEN'), false);
        await repositoryEntry.getByRole('button', { name: 'Show returned text', exact: true }).click();
        await repositoryEntry.locator('pre').filter({ hasText: 'SAMPLE_SOURCE_ONLY' }).waitFor();
        assert.equal(await repositoryEntry.locator('img').count(), 0, 'Returned content is text, never executed HTML');
        await repositoryEntry.getByRole('button', { name: 'Hide returned text', exact: true }).click();
        assert.equal(await repositoryEntry.locator('pre').textContent(), '', 'Hidden preview content is cleared');
        await heatmap.locator('#repository-panel').evaluate(element => { element.scrollTop = 0; });
        await section.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-repository-files.png') });
        await heatmap.locator('#repository-filter').fill('does-not-exist');
        await heatmap.locator('#repository-empty').filter({ hasText: 'No matching resources' }).waitFor();
        await heatmap.locator('#repository-filter').fill('checkout');
        assert.equal(await heatmap.locator('#repository-list .work-entry').count(), 2);
        await heatmap.getByRole('tab', { name: /^Wiki Pages/ }).click();
        await heatmap.locator('#wiki-summary').filter({ hasText: '2 recorded calls' }).waitFor();
        const wikiEntry = heatmap.locator('#wiki-list .work-entry').first();
        await wikiEntry.getByRole('heading', { name: 'Getting started', exact: true }).waitFor();
        assert.match(await wikiEntry.locator('.wiki-context').textContent() ?? '', /Sample Wiki.*Getting-started/);
        assert.equal(await wikiEntry.locator('.wiki-technical').getAttribute('open'), null);
        assert.equal(await wikiEntry.getByText('Server / tool', { exact: true }).isVisible(), false, 'Diagnostic fields are collapsed initially');
        assert.match(await wikiEntry.locator('dt').filter({ hasText: /^Returned sections$/ }).locator('+ dd').textContent() ?? '', /Prerequisites[\s\S]*Run locally/);
        assert.equal(await wikiEntry.getByText('Explicit source range', { exact: true }).count(), 0, 'Unavailable fields are omitted');
        await wikiEntry.getByText('Technical details', { exact: true }).click();
        await wikiEntry.getByText('Server / tool', { exact: true }).waitFor();
        await wikiEntry.getByText('Technical details', { exact: true }).click();
        const metadataEntry = heatmap.locator('#wiki-list .work-entry').nth(1);
        assert.equal(await metadataEntry.getByRole('button', { name: 'Show returned text' }).count(), 0);
        await wikiEntry.getByRole('button', { name: 'Show returned text', exact: true }).click();
        await wikiEntry.locator('pre').filter({ hasText: 'SAMPLE_WIKI_ONLY' }).waitFor();
        await wikiEntry.getByRole('button', { name: 'Hide returned text', exact: true }).click();
        await heatmap.locator('#wiki-panel').evaluate(element => { element.scrollTop = 0; });
        assert.equal(await heatmap.locator('#wiki-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await section.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-wiki-compact.png') });
        await heatmap.locator('#wiki-filter').fill('Prerequisites');
        assert.equal(await heatmap.locator('#wiki-list .work-entry').count(), 1, 'Wiki heading search uses returned sections');
        await runtime.view.toggle();
        assert.equal(await heatmap.locator('#wiki-list .work-entry').count(), 1, 'Eye toggle does not hide external reads');
        await runtime.view.toggle();
        const missingWikiSession = extractHistory({ sessionId: 'wiki-missing-compact', customTitle: 'Synthetic wiki overview', requests: [{
            timestamp: '2026-09-17T01:33:07Z', response: [{ kind: 'toolInvocationSerialized', toolId: 'mcp_azuredevops_3_wiki', toolCallId: 'missing-wiki',
                source: { type: 'mcp', serverLabel: 'AzureDevOps.Mcp' }, isComplete: true, isConfirmed: { type: 1 },
                toolSpecificData: { rawInput: { action: 'get_page', project: 'Engineering', wikiIdentifier: 'Engineering.wiki', path: '/Engineering/Architecture' } } }]
        }] }, roots);
        runtime.view.showHistory(missingWikiSession);
        await wikiEntry.getByRole('heading', { name: 'Architecture', exact: true }).waitFor();
        await wikiEntry.getByText('Response details unavailable', { exact: true }).waitFor();
        assert.equal(await wikiEntry.locator('.wiki-context').textContent(), 'Engineering.wiki | /Engineering/Architecture');
        assert.equal(await wikiEntry.locator('dd').filter({ hasText: /^(Unavailable|Not supplied)$/ }).count(), 0);
        assert.equal(await wikiEntry.getByText('Returned sections', { exact: true }).count(), 0);
        assert.equal(await wikiEntry.locator('.resource-show').count(), 0);
        assert.equal(await wikiEntry.getByText('Request time', { exact: true }).isVisible(), false);
        await section.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-wiki-unavailable-compact.png') });
        await wikiEntry.getByText('Technical details', { exact: true }).focus();
        await wikiEntry.getByText('Technical details', { exact: true }).press('Enter');
        await wikiEntry.getByText('Request time', { exact: true }).waitFor();
        runtime.view.refresh();
        assert.equal(await wikiEntry.locator('.wiki-technical').getAttribute('open'), '', 'Refreshing keeps technical details expanded');
        runtime.view.showHistory({ ...resourceSession, id: 'copilot:empty-resources', resources: [] });
        await heatmap.locator('#wiki-empty').filter({ hasText: 'No supported calls' }).waitFor();
        assert.equal(await heatmap.locator('#wiki-list').textContent(), '');
        assert.equal(await heatmap.locator('#repository-list').textContent(), '');
        assert.equal(await heatmap.locator('#wiki-filter').inputValue(), '');
        assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined, 'Remote content never marks a local file');
        await heatmap.locator('#wiki-tab').focus();
        await heatmap.locator('#wiki-tab').press('ArrowLeft');
        assert.equal(await heatmap.locator('#repository-tab').getAttribute('aria-selected'), 'true');
        await heatmap.locator('#repository-tab').press('Home');
        assert.equal(await heatmap.locator('#file-tab').getAttribute('aria-selected'), 'true');
        console.log('PASS: repository/wiki tabs, revision provenance, on-demand plain-text previews, Markdown headings, keyboard tabs, filtering, and session isolation');
        const searchLogs = extractHistory({ sessionId: 'search-log-preview', customTitle: 'Synthetic code search and pipeline log preview',
            requests: [{ timestamp: '2026-09-17T10:00:00Z', response: searchLogCalls() }] }, roots);
        const timelineSession: HistorySession = {
            ...workSession,
            id: 'copilot:evidence-timeline',
            label: 'Synthetic evidence timeline',
            events: [
                { id: 'timeline-local-source', rootId: root.id, relativePath: 'source.ts', startLine: 2, endLine: 3, at: '2026-09-17T00:00:00.100Z' },
                { id: 'timeline-local-neutral', rootId: root.id, relativePath: 'neutral.ts', at: '2026-09-17T00:00:00.800Z' }
            ],
            workItems: structuredClone(workSession.workItems),
            resources: [...resourceSession.resources!, ...searchLogs.resources!]
        };
        timelineSession.workItems![0]!.title = '<img src=x onerror=alert(1)>';
        await vscode.window.showTextDocument(neutralUri);
        runtime.view.showHistory(timelineSession);
        await heatmap.getByRole('tab', { name: /^Timeline/ }).click();
        await heatmap.locator('#timeline-summary').filter({ hasText: '15 evidence events | oldest to newest' }).waitFor();
        const timelineEntries = heatmap.locator('#timeline-list .timeline-entry');
        assert.equal(await timelineEntries.count(), 15);
        const localGroup = heatmap.locator('#timeline-list > .timeline-group[data-kind="local"]');
        await localGroup.locator(':scope > summary .timeline-title').filter({ hasText: '2 consecutive events' }).waitFor();
        assert.equal(await localGroup.getAttribute('open'), null, 'Same-second local reads start collapsed');
        assert.equal(await localGroup.getByRole('button', { name: 'Open source.ts' }).isVisible(), false);
        assert.match(await timelineEntries.first().locator('.timeline-kind').textContent() ?? '', /Local file/);
        assert.match(await timelineEntries.last().locator('.timeline-kind').textContent() ?? '', /Pipeline log/);
        const markerColors = await heatmap.locator('#timeline-list').evaluate(element => {
            const color = (selector: string) => getComputedStyle(element.querySelector(selector)!).borderColor;
            return { local: color('.timeline-group[data-kind="local"] > summary .timeline-marker'),
                work: color('.timeline-group[data-kind="work-item"] > summary .timeline-marker') };
        });
        assert.notEqual(markerColors.local, markerColors.work, 'Evidence types use distinct marker colors');
        assert.equal(await heatmap.locator('.timeline-group[data-kind="work-item"] > summary .timeline-marker[data-outcome="failed"]').count(), 1,
            'A grouped failure remains visible in the group marker shape');
        assert.equal(await heatmap.locator('#timeline-panel img, #timeline-panel script').count(), 0, 'Timeline labels are rendered as text only');
        assert.equal((await heatmap.locator('#timeline-panel').textContent())?.includes('SAMPLE_SOURCE_ONLY'), false, 'Saved response bodies do not enter the timeline payload');
        assert.equal((await heatmap.locator('#timeline-panel').textContent())?.includes('PRIVATE_BODY'), false);
        await heatmap.locator('#timeline-kind').selectOption('repository');
        assert.equal(await timelineEntries.count(), 2);
        await heatmap.locator('#timeline-filter').fill('checkout.ts');
        assert.equal(await timelineEntries.count(), 2, 'Path filtering retains each matching call outcome');
        await heatmap.locator('#timeline-filter').fill('c0ffee123');
        assert.equal(await timelineEntries.count(), 1);
        await heatmap.locator('#timeline-filter').fill('');
        await heatmap.locator('#timeline-list > .timeline-group[data-kind="repository"] > summary').click();
        await timelineEntries.first().getByRole('button', { name: 'View details' }).click();
        assert.equal(await heatmap.locator('#repository-tab').getAttribute('aria-selected'), 'true');
        assert.equal(await heatmap.locator('#repository-list > .work-entry').first().getAttribute('open'), '');
        await heatmap.getByRole('tab', { name: /^Timeline/ }).click();
        await heatmap.locator('#timeline-kind').selectOption('local');
        await localGroup.locator(':scope > summary').click();
        assert.equal(await localGroup.getByRole('button', { name: 'Open source.ts' }).isVisible(), true);
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'agent-evidence-timeline.png') });
        await timelineEntries.getByRole('button', { name: 'Open source.ts' }).click();
        await heatmap.locator('#filename').filter({ hasText: 'source.ts' }).waitFor();
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), sourceUri.toString());
        console.log('PASS: evidence timeline ordering, aggregation, text safety, filtering, local opening, and ADO detail navigation');
        runtime.view.showHistory(searchLogs);
        await heatmap.getByRole('tab', { name: /^Code Searches/ }).click();
        await heatmap.locator('#search-summary').filter({ hasText: '2 recorded calls' }).waitFor();
        const searchEntry = heatmap.locator('#search-list > .work-entry').first();
        await searchEntry.locator(':scope > summary').click();
        const searchValue = (name: string) => searchEntry.locator('dt').filter({ hasText: new RegExp(`^${name}$`) }).locator('+ dd').textContent();
        assert.equal(await searchValue('Repository scope'), 'Sample Repo');
        assert.equal(await searchValue('Path scope'), '/src');
        assert.equal(await searchValue('Returned matches \\(this response\\)'), '2');
        assert.equal(await searchValue('Server-reported count'), '50');
        assert.match(await searchValue('Evidence') ?? '', /not full-file reads/);
        assert.equal(await searchEntry.locator('.search-match').count(), 2);
        await searchEntry.locator('.search-match').first().locator('summary').click();
        await searchEntry.getByText(/Match lines: 12/).waitFor();
        assert.equal((await heatmap.locator('#search-panel').textContent())?.includes('SAMPLE_SNIPPET_ONLY'), false);
        await searchEntry.getByRole('button', { name: 'Show saved snippets', exact: true }).click();
        await searchEntry.locator('pre').filter({ hasText: 'SAMPLE_SNIPPET_ONLY' }).waitFor();
        assert.equal(await searchEntry.locator('img, script').count(), 0, 'Snippet markup is rendered as text only');
        assert.match(await searchEntry.locator('.search-match').first().textContent() ?? '', /Match lines: 12/);
        await searchEntry.getByRole('button', { name: 'Hide saved snippets', exact: true }).click();
        assert.equal(await searchEntry.locator('pre').textContent(), '');
        const emptySearch = heatmap.locator('#search-list > .work-entry').nth(1);
        await emptySearch.locator(':scope > summary').click();
        assert.equal(await emptySearch.locator('dt').filter({ hasText: /^Returned matches/ }).locator('+ dd').textContent(), '0');
        assert.equal(await emptySearch.locator('.resource-show').count(), 0);
        await emptySearch.locator(':scope > summary').click();
        await heatmap.locator('#search-panel').evaluate(element => { element.scrollTop = 0; });
        await section.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-code-searches.png') });
        await heatmap.locator('#search-filter').fill('cart.ts');
        assert.equal(await heatmap.locator('#search-list > .work-entry').count(), 1);
        await heatmap.locator('#search-filter').fill('not found');
        await heatmap.locator('#search-empty').filter({ hasText: 'No matching resources' }).waitFor();
        await heatmap.getByRole('tab', { name: /^Pipeline Logs/ }).click();
        await heatmap.locator('#logs-summary').filter({ hasText: '3 recorded calls' }).waitFor();
        const logEntry = heatmap.locator('#logs-list > .work-entry').first();
        await logEntry.locator(':scope > summary').click();
        const logValue = (name: string) => logEntry.locator('dt').filter({ hasText: new RegExp(`^${name}$`) }).locator('+ dd').textContent();
        assert.equal(await logValue('Build ID'), '2048'); assert.equal(await logValue('Log ID'), '17');
        assert.match(await logValue('Requested log lines') ?? '', /101.*220/);
        assert.match(await logValue('Returned log range') ?? '', /Not supplied/);
        assert.equal(await logValue('Lines in returned text'), '2');
        assert.equal((await heatmap.locator('#logs-panel').textContent())?.includes('SAMPLE_LOG_ONLY'), false);
        await logEntry.getByRole('button', { name: 'Show returned log text', exact: true }).click();
        await logEntry.locator('pre').filter({ hasText: 'SAMPLE_LOG_ONLY' }).waitFor();
        assert.equal(await logEntry.locator('script').count(), 0);
        await logEntry.getByRole('button', { name: 'Hide returned log text', exact: true }).click();
        assert.equal(await logEntry.locator('pre').textContent(), '');
        const returnedLog = heatmap.locator('#logs-list > .work-entry').nth(1);
        await returnedLog.locator(':scope > summary').click();
        assert.equal(await returnedLog.locator('dt').filter({ hasText: /^Returned log range$/ }).locator('+ dd').textContent(), '101-102');
        assert.equal(await returnedLog.locator('a').getAttribute('href'), 'https://dev.azure.com/example/Sample%20Project/_build/results?buildId=2048');
        assert.equal(await heatmap.locator('#logs-list > .work-entry').nth(2).locator('.resource-show').count(), 0);
        await returnedLog.locator(':scope > summary').click();
        await heatmap.locator('#logs-panel').evaluate(element => { element.scrollTop = 0; });
        assert.equal(await heatmap.locator('#logs-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await section.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'azure-devops-pipeline-logs.png') });
        await heatmap.locator('#logs-filter').fill('2048');
        assert.equal(await heatmap.locator('#logs-list > .work-entry').count(), 3);
        const manyLogs = { ...searchLogs, id: 'copilot:many-logs', resources: Array.from({ length: 51 }, (_, index) => ({
            ...searchLogs.resources!.find(item => item.kind === 'logs')!, callId: `log-page-${index}` })) };
        runtime.view.showHistory(manyLogs);
        await heatmap.locator('#logs-summary').filter({ hasText: '51 recorded calls' }).waitFor();
        assert.equal(await heatmap.locator('#logs-list > .work-entry').count(), 50);
        await heatmap.locator('#logs-more').click();
        assert.equal(await heatmap.locator('#logs-list > .work-entry').count(), 51);
        runtime.view.showHistory({ ...searchLogs, id: 'copilot:empty-search-logs', resources: [] });
        await heatmap.locator('#logs-empty').filter({ hasText: 'No supported calls' }).waitFor();
        assert.equal(await heatmap.locator('#search-list').textContent(), '');
        assert.equal(await heatmap.locator('#logs-list').textContent(), '');
        assert.equal(await heatmap.locator('#search-filter').inputValue(), '');
        assert.equal(await heatmap.locator('#logs-filter').inputValue(), '');
        assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined);
        await heatmap.locator('#logs-tab').focus(); await heatmap.locator('#logs-tab').press('ArrowLeft');
        assert.equal(await heatmap.locator('#search-tab').getAttribute('aria-selected'), 'true');
        await heatmap.locator('#search-tab').press('Home');
        assert.equal(await heatmap.locator('#file-tab').getAttribute('aria-selected'), 'true');
        console.log('PASS: code-search scopes/matches/snippets, zero results, pipeline-log IDs/portions, opt-in escaped previews, filtering, pagination, keyboard tabs, and session isolation');
        await runtime.view.selectSession(sessionId);
        await heatmap.getByRole('tab', { name: 'File Heatmap', exact: true }).click();
        await canvas.waitFor({ state: 'visible' });
        console.log('PASS: Azure DevOps work-item tab, returned fields and comment page metadata, filtering, safe text, sanitized links, deduplication, and session isolation');
        await page.waitForFunction(() => {
            const pane = Array.from(globalThis.document.querySelectorAll('.pane')).find(element => element.textContent?.includes('Agent Read Coverage'));
            return pane && pane.querySelectorAll('.monaco-list-row').length === 0;
        });
        assert.equal(await section.getByText('repo-one', { exact: true }).count(), 0, 'No duplicate repository root');
        assert.equal(await section.getByText('source.ts', { exact: true }).count(), 0, 'No duplicate file listing');
        await page.waitForFunction(() => {
            const target = Array.from(globalThis.document.querySelectorAll('.explorer-folders-view .label-name')).find(element => element.textContent === 'source.ts');
            return target && getComputedStyle(target).color === 'rgb(218, 160, 68)';
        });
        await page.waitForFunction(() => Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => getComputedStyle(element).borderLeftColor === 'rgb(232, 179, 90)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        const verifiedMarks = await page.locator('.monaco-editor .view-overlays .cdr').evaluateAll(elements => elements
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(232, 179, 90)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0)
            .map(element => ({ top: (element as HTMLElement).offsetTop, height: (element as HTMLElement).offsetHeight,
                background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderLeftColor })));
        assert.equal(verifiedMarks.length, 1, 'Only the single matching read line is shaded');
        assert.equal(verifiedMarks[0]?.top, 0, 'Decoration is on the first recorded line, not the cursor line');
        assert.ok(verifiedMarks[0]!.height > 0);
        assert.ok(!extension.packageJSON.contributes.colors.some((color: { id: string }) => color.id.startsWith('agentContextTrace.unverifiedSection')), 'Recorded reads use one theme palette');
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-colors-on.png') });
        await vscode.commands.executeCommand('agentContextTrace.toggleFileColors');
        await page.waitForFunction(() => {
            const target = Array.from(globalThis.document.querySelectorAll('.explorer-folders-view .label-name')).find(element => element.textContent === 'source.ts');
            return target && getComputedStyle(target).color !== 'rgb(218, 160, 68)';
        });
        await page.waitForFunction(() => !Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => ['rgb(232, 179, 90)', 'rgb(218, 160, 68)', 'rgb(204, 144, 46)', 'rgb(191, 132, 28)'].includes(getComputedStyle(element).borderLeftColor) && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-colors-off.png') });
        assert.equal(runtime.view.enabled, false);
        await runtime.view.toggle();
        runtime.view.showHistory({ id: 'copilot:range-preview', label: 'Historical ranges', createdAt: '', coverage: 'copilot-history-read-metadata',
            recognizedCalls: 1, unmappedCalls: 0, events: [{ id: 'history-range', rootId: root.id, relativePath: 'source.ts', startLine: 2, endLine: 3 }] });
        assert.deepEqual(runtime.view.editorHighlights(document), { verified: [], unverified: [{ startLine: 2, endLine: 3, readCount: 1 }] });
        await page.waitForFunction(() => Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(232, 179, 90)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0).length === 2);
        const historicalMarks = await page.locator('.monaco-editor .view-overlays .cdr').evaluateAll(elements => elements
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(232, 179, 90)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0)
            .map(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderLeftColor })));
        assert.equal(historicalMarks.length, 2);
        for (const mark of historicalMarks) {
            assert.equal(mark.background, verifiedMarks[0]!.background, 'History and verified reads have identical shading');
            assert.equal(mark.border, verifiedMarks[0]!.border, 'History and verified reads have identical borders');
        }
        assert.match(runtime.view.statusMessage, /Local Copilot history: 1 recorded read in this repository/);
        await heatmap.locator('#status').filter({ hasText: /Local Copilot history: 1 recorded read in this repository/ }).waitFor();
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-sections-history.png') });
        const frequencySession: HistorySession = {
            id: 'copilot:frequency-preview', label: 'Session read frequency', createdAt: '', coverage: 'copilot-history-read-metadata',
            recognizedCalls: 8, unmappedCalls: 0, events: [1, 2, 3, 3, 4, 4, 4, 4].map((startLine, index) => ({
                id: `frequency-${index}`, rootId: root.id, relativePath: 'source.ts', startLine, endLine: 4
            }))
        };
        for (const [count, suffix, expectedColor] of [[1, '', 'rgb(232, 179, 90)'], [2, 'Repeat', 'rgb(218, 160, 68)'],
            [4, 'Frequent', 'rgb(204, 144, 46)'], [8, 'Intense', 'rgb(191, 132, 28)']] as const) {
            runtime.view.showHistory({ ...frequencySession, events: frequencySession.events.slice(0, count) });
            assert.equal(runtime.view.provideFileDecoration(sourceUri)?.color?.id, `agentContextTrace.readFile${suffix}Foreground`);
            assert.match(runtime.view.provideFileDecoration(sourceUri)!.tooltip!, new RegExp(`${count} recorded read`));
            await page.waitForFunction(color => {
                const filename = Array.from(globalThis.document.querySelectorAll('.explorer-folders-view .label-name'))
                    .find(element => element.textContent === 'source.ts');
                return filename && getComputedStyle(filename).color === color;
            }, expectedColor);
        }
        assert.deepEqual(runtime.view.editorHighlights(document).unverified, [
            { startLine: 1, endLine: 1, readCount: 1 }, { startLine: 2, endLine: 2, readCount: 2 },
            { startLine: 3, endLine: 3, readCount: 4 }, { startLine: 4, endLine: 4, readCount: 8 }
        ]);
        const beforeRefresh = runtime.view.editorHighlights(document);
        runtime.view.refresh();
        runtime.view.showHistory({ ...frequencySession, events: [...frequencySession.events, frequencySession.events[0]!] });
        assert.deepEqual(runtime.view.editorHighlights(document), beforeRefresh, 'Refreshes and repeated event IDs do not inflate read frequency');
        assert.match(runtime.view.provideFileDecoration(sourceUri)!.tooltip!, /8 recorded reads/);
        runtime.view.showHistory(frequencySession);
        await page.waitForFunction(() => {
            const colors = new Set(Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
                .filter(element => parseFloat(getComputedStyle(element).borderLeftWidth) > 0).map(element => getComputedStyle(element).borderLeftColor));
            return ['rgb(232, 179, 90)', 'rgb(218, 160, 68)', 'rgb(204, 144, 46)', 'rgb(191, 132, 28)'].every(color => colors.has(color));
        });
        const frequencyMarks = await page.locator('.monaco-editor .view-overlays .cdr').evaluateAll(elements => elements
            .filter(element => ['rgb(232, 179, 90)', 'rgb(218, 160, 68)', 'rgb(204, 144, 46)', 'rgb(191, 132, 28)'].includes(getComputedStyle(element).borderLeftColor)
                && parseFloat(getComputedStyle(element).borderLeftWidth) > 0)
            .map(element => ({ lineTop: (element.parentElement as HTMLElement).offsetTop, color: getComputedStyle(element).borderLeftColor,
                channels: getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number),
                alpha: Number(getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.[3]) })).sort((left, right) => left.lineTop - right.lineTop));
        assert.equal(frequencyMarks.length, 4, 'Exactly four recorded lines have frequency highlights');
        assert.deepEqual(frequencyMarks.map(mark => mark.color), ['rgb(232, 179, 90)', 'rgb(218, 160, 68)', 'rgb(204, 144, 46)', 'rgb(191, 132, 28)']);
        for (const mark of frequencyMarks) {
            assert.deepEqual(mark.channels, [232, 179, 90], 'All frequency tiers use amber backgrounds');
        }
        for (let index = 1; index < frequencyMarks.length; index++) {
            assert.ok(frequencyMarks[index]!.lineTop > frequencyMarks[index - 1]!.lineTop);
            assert.ok(frequencyMarks[index]!.alpha > frequencyMarks[index - 1]!.alpha, 'Repeated-read backgrounds have progressively stronger amber shading');
        }
        assert.equal(await page.locator('.monaco-editor .view-lines span').evaluateAll(elements => elements
            .filter(element => /^"Read \d+ times?"$/.test(getComputedStyle(element, '::after').content)).length), 0, 'No inline count labels are added');
        const textColors = () => page.locator('.monaco-editor .view-lines .view-line span').evaluateAll(elements => elements
            .filter(element => element.children.length === 0 && !!element.textContent)
            .map(element => ({ text: element.textContent, color: getComputedStyle(element).color })));
        const shadedTextColors = await textColors();
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-frequency-amber.png') });
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-frequency-shades.png') });
        await canvas.evaluate(element => new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Amber heatmap pixels did not update')), 5000);
            const check = () => {
                const map = element as HTMLCanvasElement;
                const pixel = map.getContext('2d')!.getImageData(1, Math.floor(map.height * 0.7), 1, 1).data;
                if (pixel[0] === 191 && pixel[1] === 132 && pixel[2] === 28) { clearTimeout(timeout); resolve(); }
                else { requestAnimationFrame(check); }
            };
            check();
        }));
        const heatPixels = await canvas.evaluate(element => {
            const map = element as HTMLCanvasElement;
            return [0.1, 0.3, 0.5, 0.7].map(fraction => Array.from(map.getContext('2d')!
                .getImageData(1, Math.floor(map.height * fraction), 1, 1).data));
        });
        assert.deepEqual(heatPixels.map(pixel => pixel.slice(0, 3)), [[232, 179, 90], [218, 160, 68], [204, 144, 46], [191, 132, 28]],
            'Rendered heatmap pixels match the four editor amber tiers');
        const verifyHoverMarker = async (fraction: number) => {
            const marker = await heatmap.locator('#pointer').evaluate(element => {
                const bounds = element.getBoundingClientRect();
                const map = globalThis.document.getElementById('heatmap')!.getBoundingClientRect();
                const style = getComputedStyle(element);
                return { hidden: (element as HTMLElement).hidden, width: bounds.width, mapWidth: map.width,
                    center: bounds.top + bounds.height / 2 - map.top, mapHeight: map.height,
                    height: parseFloat(style.height), outline: style.boxShadow, pointerEvents: style.pointerEvents };
            });
            assert.equal(marker.hidden, false, 'Hover marker is visible');
            assert.ok(Math.abs(marker.width - marker.mapWidth) < 1, 'Hover line spans the heatmap width');
            assert.ok(Math.abs(marker.center - fraction * marker.mapHeight) < 2, 'Hover line follows the actual pointer height, not a rounded source-line midpoint');
            assert.ok(marker.height >= 1.5 && marker.outline !== 'none', 'Hover marker has a contrasting outlined stroke');
            assert.equal(marker.pointerEvents, 'none', 'Marker cannot intercept mouse movement');
        };
        const hoverHeatmap = async (fraction: number) => {
            await canvas.evaluate((element, target) => {
                const content = globalThis.document.getElementById('content')!;
                const bounds = element.getBoundingClientRect(), viewport = content.getBoundingClientRect();
                content.scrollTop += bounds.top + target * bounds.height - viewport.top - viewport.height / 2;
            }, fraction);
            const bounds = await canvas.boundingBox();
            assert.ok(bounds);
            const contentBounds = await heatmap.locator('#content').boundingBox();
            assert.ok(contentBounds && bounds.y + fraction * bounds.height >= contentBounds.y
                && bounds.y + fraction * bounds.height < contentBounds.y + contentBounds.height, 'Target point is visible in the scrolled map');
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + fraction * bounds.height);
        };
        for (const fraction of [0.04, 0.16, 0.37, 0.78, 0.96]) {
            await hoverHeatmap(fraction);
            await verifyHoverMarker(fraction);
            await heatmap.locator('#position').filter({ hasText: `Line ${Math.floor(fraction * document.lineCount) + 1} / ${document.lineCount}` }).waitFor();
        }
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'file-heatmap-hover-marker.png') });
        await canvas.evaluate(element => {
            element.addEventListener('pointerleave', () => {
                (element as HTMLElement).dataset.markerHiddenOnLeave = String(globalThis.document.getElementById('pointer')!.hidden);
            }, { once: true });
        });
        await heatmap.locator('#position').hover();
        await heatmap.locator('#heatmap[data-marker-hidden-on-leave="true"]').waitFor();
        const fourthLine = page.locator('.monaco-editor .view-lines .view-line').getByText('fourth', { exact: true }).first();
        await fourthLine.hover({ position: { x: 4, y: 6 } });
        await page.getByText(/Lines 4-4: 8 recorded reads in this session/).waitFor();
        await page.keyboard.press('Escape');
        const heatmapUri = vscode.Uri.file(path.join(root.directory, 'heatmap-preview.ts'));
        const heatmapSource = Array.from({ length: 240 }, (_, index) => `const value${index + 1} = ${index + 1};`).join('\n');
        await fs.writeFile(heatmapUri.fsPath, heatmapSource);
        const longDocument = await vscode.workspace.openTextDocument(heatmapUri);
        const longEditor = await vscode.window.showTextDocument(longDocument, { preview: false });
        const longSession: HistorySession = { ...frequencySession, id: 'copilot:long-heatmap', label: 'Heatmap navigation',
            events: [1, 61, 121, 121, 181, 181, 181, 181].map((startLine, index) => ({ id: `long-${index}`,
                rootId: root.id, relativePath: 'heatmap-preview.ts', startLine, endLine: 240 })) };
        runtime.view.showHistory(longSession);
        await heatmap.locator('#filename').filter({ hasText: 'heatmap-preview.ts' }).waitFor();
        await heatmap.locator('.line-label').filter({ hasText: /^181$/ }).waitFor();
        await verifyHeatmapSpacing();
        const boundaryLabels = await heatmap.locator('.line-label').evaluateAll(elements => elements.map(element => ({
            line: element.textContent, offset: Number((element as HTMLElement).dataset.offset),
            top: parseFloat((element as HTMLElement).style.top)
        })));
        assert.deepEqual(boundaryLabels.map(label => label.line), ['1', '61', '121', '181', '240'], 'Numbered guides identify recorded range boundaries');
        for (const label of boundaryLabels) {
            assert.ok(Math.abs(label.top - label.offset / 240 * 100) < 0.01, 'Numbered guides align to source ranges');
        }
        const guidePixels = await canvas.evaluate(element => {
            const map = element as HTMLCanvasElement;
            const context = map.getContext('2d')!;
            return [0.25, 0.5, 0.75].map(fraction => {
                const row = Math.floor(map.height * fraction);
                return [0.25, 0.75].map(horizontal => {
                    const column = Math.floor(map.width * horizontal);
                    return { boundary: Array.from(context.getImageData(column, row, 1, 1).data),
                        inside: Array.from(context.getImageData(column, row + 2, 1, 1).data) };
                });
            });
        });
        for (const guide of guidePixels) {
            for (const sample of guide) { assert.notDeepEqual(sample.boundary, sample.inside, 'Horizontal guides span the heatmap'); }
        }
        const selectionBefore = longEditor.selection;
        const waitForLine = (line: number) => new Promise<void>((resolve, reject) => {
            const containsLine = () => longEditor.visibleRanges.some(range => range.start.line <= line - 1 && range.end.line >= line - 1);
            if (containsLine()) { resolve(); return; }
            const timeout = setTimeout(() => { listener.dispose(); reject(new Error(`Heatmap did not reveal line ${line}`)); }, 5000);
            const listener = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
                if (event.textEditor === longEditor && containsLine()) { clearTimeout(timeout); listener.dispose(); resolve(); }
            });
        });
        for (const [line, count] of [[240, 8], [1, 1], [61, 2], [121, 4], [181, 8]] as const) {
            const revealed = waitForLine(line);
            await hoverHeatmap((line - 0.5) / 240);
            await heatmap.locator('#position').filter({ hasText: `Line ${line} / 240 | ${count} recorded reads` }).waitFor();
            await revealed;
            await verifyHoverMarker((line - 0.5) / 240);
            assert.ok(longEditor.selection.isEqual(selectionBefore), 'Hover scrolls without moving the editor cursor');
        }
        assert.equal(longDocument.getText(), heatmapSource, 'Heatmap navigation does not edit source');
        assert.equal(runtime.view.selected()?.events.length, 8, 'Heatmap navigation never records reads');
        assert.match(await heatmap.locator('#position').textContent() ?? '', /Historical range; file may have changed/);
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'file-heatmap-hover.png') });
        const beforeEditorHover = longEditor.visibleRanges.map(range => [range.start.line, range.end.line]);
        for (const [line, count] of [[180, 4], [181, 8], [182, 8]] as const) {
            await page.locator('.monaco-editor .view-lines .view-line').getByText(`value${line}`, { exact: true }).first().hover();
            await heatmap.locator('#position').filter({ hasText: `Line ${line} / 240 | ${count} recorded reads` }).waitFor();
            await verifyHoverMarker((line - 0.5) / 240);
            assert.ok(longEditor.selection.isEqual(selectionBefore), 'Editor hover updates the counter without moving the cursor');
            assert.deepEqual(longEditor.visibleRanges.map(range => [range.start.line, range.end.line]), beforeEditorHover,
                'Editor hover does not navigate or scroll the source');
            await page.keyboard.press('Escape');
        }
        await heatmap.locator('#position').hover();
        await vscode.commands.executeCommand('vscode.executeHoverProvider', heatmapUri, new vscode.Position(179, 0));
        await heatmap.locator('#position').filter({ hasText: 'Line 180 / 240' }).waitFor();
        await verifyHoverMarker(179.5 / 240);
        await vscode.commands.executeCommand('vscode.executeHoverProvider', otherUri, new vscode.Position(0, 0));
        assert.match(await heatmap.locator('#position').textContent() ?? '', /Line 180 \/ 240/,
            'Hover requests for another file cannot overwrite the active-file counter');
        assert.equal(longDocument.getText(), heatmapSource);
        assert.equal(runtime.view.selected()?.events.length, 8, 'Editor hover does not record reads');
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'file-heatmap-editor-hover.png') });
        console.log('PASS: live line counter from source-editor hover, unchanged selection and viewport, no synthetic reads, and active-file isolation');
        const markerBeforeKeyboard = await heatmap.locator('#pointer').evaluate(element => (element as HTMLElement).style.top);
        await canvas.focus();
        const topRevealed = waitForLine(1);
        await canvas.press('Home');
        await topRevealed;
        assert.equal(await heatmap.locator('#pointer').evaluate(element => (element as HTMLElement).style.top), markerBeforeKeyboard,
            'Keyboard navigation does not reposition the last mouse-hover marker');
        await canvas.press('Enter');
        await page.waitForFunction(() => !!globalThis.document.querySelector('.monaco-editor.focused'));
        assert.equal(longEditor.selection.active.line, 0, 'Keyboard commit focuses the mapped editor line');
        const committedSelection = longEditor.selection;
        await hoverHeatmap(0.625);
        await verifyHoverMarker(0.625);
        assert.ok(longEditor.selection.isEqual(committedSelection), 'Mouse marker follows hover independently of the committed cursor position');
        await runtime.view.toggle();
        await heatmap.locator('#empty').filter({ hasText: 'Read colors off' }).waitFor();
        assert.equal(await canvas.isVisible(), false, 'Eye toggle also hides the heatmap');
        await runtime.view.toggle();
        await canvas.waitFor({ state: 'visible' });
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(otherUri));
        await heatmap.locator('#filename').filter({ hasText: 'repo-two' }).waitFor();
        await heatmap.locator('#empty').filter({ hasText: 'No displayable read ranges' }).waitFor();
        await vscode.window.showTextDocument(longDocument);
        await heatmap.locator('#filename').filter({ hasText: 'heatmap-preview.ts' }).waitFor();
        const heatmapEdit = new vscode.WorkspaceEdit();
        heatmapEdit.insert(heatmapUri, new vscode.Position(0, 0), ' ');
        await vscode.workspace.applyEdit(heatmapEdit);
        await heatmap.locator('#empty').filter({ hasText: 'No displayable read ranges' }).waitFor();
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await vscode.window.showTextDocument(document, { viewColumn: sourceEditor.viewColumn, preview: false });
        runtime.view.showHistory(frequencySession);
        await heatmap.locator('#filename').filter({ hasText: 'repo-one/source.ts' }).waitFor();
        await canvas.waitFor({ state: 'visible' });
        await fs.unlink(heatmapUri.fsPath);
        console.log('PASS: heatmap amber pixels, top/middle/bottom hover alignment, cursor preservation, keyboard navigation, file switching, edits, and eye toggle');
        await section.locator('.pane-header').hover();
        await runtime.view.toggle();
        assert.deepEqual(runtime.view.editorHighlights(document), { verified: [], unverified: [] });
        await page.waitForFunction(() => !Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => ['rgb(232, 179, 90)', 'rgb(218, 160, 68)', 'rgb(204, 144, 46)', 'rgb(191, 132, 28)'].includes(getComputedStyle(element).borderLeftColor)
                && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        assert.deepEqual(await textColors(), shadedTextColors, 'Highlighting leaves syntax foreground colors unchanged');
        await runtime.view.toggle();
        assert.deepEqual(runtime.view.editorHighlights(document), beforeRefresh, 'Re-enabling restores the same counts');
        const missingRange = { ...frequencySession, events: [...frequencySession.events, { id: 'no-range', rootId: root.id, relativePath: 'source.ts' }] };
        runtime.view.showHistory(missingRange);
        assert.match(runtime.view.provideFileDecoration(sourceUri)!.tooltip!, /9 recorded reads/);
        assert.deepEqual(runtime.view.editorHighlights(document), beforeRefresh, 'File-only reads affect the file total but no section counts');
        console.log('PASS: four amber filename and vertical-edge tiers, amber backgrounds, unchanged syntax colors, no inline labels, exact-count hover, and toggling');
        const priorUnverified = configuration.inspect<boolean>('showUnverifiedHistoryRanges')?.globalValue;
        try {
            await configuration.update('showUnverifiedHistoryRanges', false, vscode.ConfigurationTarget.Global);
            assert.deepEqual(runtime.view.editorHighlights(document).unverified, []);
            await configuration.update('showUnverifiedHistoryRanges', true, vscode.ConfigurationTarget.Global);
            const changed = new vscode.WorkspaceEdit();
            changed.insert(sourceUri, new vscode.Position(0, 0), 'edit ');
            assert.equal(await vscode.workspace.applyEdit(changed), true);
            assert.deepEqual(runtime.view.editorHighlights(document).unverified, [], 'Editing invalidates unverified history guides');
            await page.waitForFunction(() => !Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
                .some(element => ['rgb(232, 179, 90)', 'rgb(218, 160, 68)', 'rgb(204, 144, 46)', 'rgb(191, 132, 28)'].includes(getComputedStyle(element).borderLeftColor)
                    && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
            const undoEdit = new vscode.WorkspaceEdit();
            undoEdit.delete(sourceUri, new vscode.Range(0, 0, 0, 5));
            await vscode.workspace.applyEdit(undoEdit);
            await document.save();
            assert.deepEqual(runtime.view.editorHighlights(document).unverified, [], 'History guides do not silently reappear after observed edits');
        } finally { await configuration.update('showUnverifiedHistoryRanges', priorUnverified, vscode.ConfigurationTarget.Global); }
        await runtime.view.selectSession(sessionId);
        assert.deepEqual(runtime.view.editorHighlights(document).verified, [{ startLine: 1, endLine: 1, readCount: 1 }], 'Switching sessions restores its own count, not the previously selected history totals');
        const split = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        assert.notEqual(split, sourceEditor);
        await page.waitForFunction(() => Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(232, 179, 90)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0).length >= 2);
        await runtime.view.toggle();
        await page.waitForFunction(() => !Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => getComputedStyle(element).borderLeftColor === 'rgb(232, 179, 90)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        console.log('PASS: same amber frequency scale for tracker and historical reads, missing ranges, file edits, split editors, session changes, and eye toggle');
        const details = vscode.commands.executeCommand('agentContextTrace.showDetails', sourceUri);
        const detailPicker = page.locator('.quick-input-widget');
        await detailPicker.getByText('Lines 2-3', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await details;
        assert.ok(extension.packageJSON.contributes.menus['explorer/context'].some((item: { command: string }) => item.command === 'agentContextTrace.showDetails'));
        console.log('PASS: coverage section has no duplicate files or folders; Explorer colors, toggle command, and read details remain available');
        const pickerItems = historyPickerItems([
            { file: 'other-old', label: 'Other older chat', workspace: 'another-repo', repositoryMatch: false, updatedAt: '2026-09-10T12:00:00.000Z' },
            { file: 'repo-old', label: 'Repository older chat', workspace: 'repo-one', repositoryMatch: true, updatedAt: '2026-09-01T12:00:00.000Z' },
            { file: 'other-new', label: 'Other newest chat', workspace: 'another-repo', repositoryMatch: false, updatedAt: '2026-09-16T12:00:00.000Z' },
            { file: 'repo-new', label: 'Repository newest chat', workspace: 'repo-one', repositoryMatch: true, updatedAt: '2026-09-02T12:00:00.000Z' }
        ]);
        assert.deepEqual(pickerItems.filter(item => item.action === 'select').map(item => item.file), ['repo-new', 'repo-old', 'other-new', 'other-old']);
        assert.deepEqual(pickerItems.filter(item => item.kind === vscode.QuickPickItemKind.Separator).map(item => item.label), ['This Repository', 'Other Sessions', 'Open History']);
        assert.deepEqual(historyPickerItems([]).map(item => item.action), ['separator', 'folder', 'file']);
        const choice = vscode.window.showQuickPick(pickerItems, { title: 'Choose Existing Copilot Chat Session', matchOnDetail: true });
        const picker = page.locator('.quick-input-widget');
        await picker.getByText('Repository newest chat', { exact: true }).waitFor();
        await picker.getByText('This Repository', { exact: true }).waitFor();
        await picker.getByText('Other Sessions', { exact: true }).waitFor();
        const displayedChats = await picker.locator('.label-name').allTextContents();
        assert.deepEqual(displayedChats.filter(text => text.endsWith('chat')), ['Repository newest chat', 'Repository older chat', 'Other newest chat', 'Other older chat']);
        const workbench = vscode.workspace.getConfiguration('workbench');
        const previousColors = workbench.inspect<Record<string, unknown>>('colorCustomizations')?.globalValue;
        try {
            await workbench.update('colorCustomizations', { ...previousColors, 'pickerGroup.border': '#8594A6' }, vscode.ConfigurationTarget.Global);
            await page.waitForFunction(() => {
                const border = Array.from(globalThis.document.querySelectorAll('.quick-input-widget .quick-input-list-separator-border'))
                    .find(element => element.textContent?.includes('Other newest chat'));
                return border && getComputedStyle(border).borderTopColor === 'rgb(133, 148, 166)' && getComputedStyle(border).borderTopWidth !== '0px';
            });
            const divider = picker.locator('.quick-input-list-separator-border').filter({ hasText: 'Other newest chat' });
            const boundary = await divider.boundingBox();
            const lastRepositoryChat = await picker.getByText('Repository older chat', { exact: true }).boundingBox();
            const firstOtherChat = await picker.getByText('Other newest chat', { exact: true }).boundingBox();
            assert.ok(boundary && lastRepositoryChat && firstOtherChat);
            assert.ok(boundary.y >= lastRepositoryChat.y + lastRepositoryChat.height && boundary.y <= firstOtherChat.y,
                'Real border lies between the last repository chat and first other chat');
            assert.ok(boundary.width > 500, 'Divider spans the session row, not just its heading');
            await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'chat-session-groups.png') });
            await picker.getByText('Other newest chat', { exact: true }).click();
            assert.equal((await choice)?.file, 'other-new', 'Lower-group chat remains selectable');
            console.log('PASS: full-width horizontal group border uses pickerGroup.border between the two session groups');
        } finally {
            await workbench.update('colorCustomizations', previousColors, vscode.ConfigurationTarget.Global);
        }
        console.log('PASS: native chat picker groups repository sessions first and remaining sessions newest first');
    } finally { await browser.close(); }
    decorationChanges.dispose();
    console.log('PASS: registered tool, numbered read, built-in Explorer filename text colors and toggle, neutral files, multi-root scope, exclusions, dirty buffers, cancellation, session selection');
    await typescript.update('validate.enable', previousValidation, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.quit');
}