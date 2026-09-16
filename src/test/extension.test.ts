import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import type { Runtime } from '../extension';
import { TOOL_NAME } from '../core';

export async function run(): Promise<void> {
    const extension = vscode.extensions.getExtension<Runtime>('davidle-ms.agent-context-trace');
    assert.ok(extension, 'Development extension is installed');
    const runtime = await extension.activate();
    assert.ok(runtime, 'Extension activated in a trusted local test workspace');
    assert.ok(vscode.lm.tools.some(tool => tool.name === TOOL_NAME), 'Tool registered with the host');
    const roots = await runtime.view.getChildren();
    assert.equal(roots.length, 2);
    const children = await runtime.view.getChildren(roots[0]);
    const source = children.find(node => node.name === 'source.ts')!;
    const neutral = children.find(node => node.name === 'neutral.ts')!;
    const other = (await runtime.view.getChildren(roots[1])).find(node => node.name === 'source.ts')!;
    assert.ok(source && neutral && other);
    runtime.view.getTreeItem(source);
    runtime.view.getTreeItem(neutral);
    runtime.view.getTreeItem(other);
    const sourceUri = runtime.view.uri(source);
    if (process.env.ACT_TEST_PHASE === 'restore') {
        const previous = runtime.store.list().find(session => session.label === 'Host test');
        assert.ok(previous, 'Session JSON restored independently of test-mode workspace state');
        await runtime.view.selectSession(previous.id);
        assert.equal(runtime.view.enabled, true, 'VS Code extension-test mode intentionally resets workspace state');
        assert.equal(runtime.view.selected()?.events.length, 3, 'Session metadata restored');
        assert.equal(runtime.store.current(), undefined, 'Historical session not automatically recording');
        assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
        const selected = runtime.view.selected()!;
        await runtime.store.delete(selected.id);
        assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined, 'Deletion removes markers');
        console.log('PASS: session JSON restore, no auto-recording, deletion; workspace preference tested in normal development hosts');
        return;
    }
    const historyFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'act-existing-chat-'));
    try {
        const root = runtime.roots.find(candidate => candidate.id === source.rootId)!;
        const sourceFile = path.join(root.directory, source.relativePath);
        const file = path.join(historyFolder, 'existing-chat.jsonl');
        const read = { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: 'history-read', isComplete: true,
            isConfirmed: { type: 1 }, pastTenseMessage: { value: `Read [file](${pathToFileURL(sourceFile)})` } };
        const initial = JSON.stringify({ kind: 0, v: { sessionId: 'existing-chat', customTitle: 'Existing Copilot Chat',
            creationDate: Date.now(), requests: [{ response: [] }] } }) + '\n';
        const waitForReads = (count: number) => new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Selected history watcher did not refresh.')); }, 10000);
            const subscription = runtime.view.onDidChangeTreeData(() => {
                if (runtime.view.selected()?.events.length === count) { clearTimeout(timeout); subscription.dispose(); resolve(); }
            });
        });
        await fs.writeFile(file, initial);
        await runtime.selectCopilotFile(file);
        assert.equal(runtime.store.list().length, 0, 'Selecting existing chat creates no tracker session');
        assert.equal(runtime.store.current(), undefined);
        assert.equal(runtime.view.selected()?.label, 'Existing Copilot Chat');
        assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(sourceFile)), undefined);
        assert.match(String(runtime.view.tree.message), /no completed supported file reads saved yet/);
        const firstRead = waitForReads(1);
        const firstAppend = JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [read] }) + '\n';
        await fs.appendFile(file, firstAppend);
        await firstRead;
        assert.match(String(runtime.view.tree.message), /1 recorded read in this repository/);
        assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(sourceFile))?.badge, 'R');
        assert.equal(runtime.view.selected()?.events[0]?.startLine, undefined, 'Missing historical range is not fabricated');
        await runtime.view.toggle();
        assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined);
        const updated = waitForReads(2);
        const append = JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ ...read, toolCallId: 'second-read',
            pastTenseMessage: { value: `Read [file](${pathToFileURL(path.join(root.directory, neutral.relativePath))})` } }] }) + '\n';
        await fs.appendFile(file, append);
        await updated;
        assert.match(String(runtime.view.tree.message), /2 recorded reads in this repository/);
        assert.equal(runtime.view.enabled, false, 'History refresh does not turn colors on');
        await runtime.view.toggle();
        assert.equal(runtime.view.provideFileDecoration(runtime.view.uri(neutral))?.badge, 'R');
        assert.equal(await fs.readFile(file, 'utf8'), initial + firstAppend + append, 'Extension never edits Copilot chat history');
        assert.equal(runtime.store.list().length, 0);
        console.log('PASS: existing Copilot chat selection, no tracker session, file-only history colors, selected history watcher, toggle, read-only source');
    } finally { await fs.rm(historyFolder, { recursive: true, force: true }); }
    const sessionId = await runtime.start('Host test');
    const root = runtime.roots.find(candidate => candidate.id === source.rootId)!;
    const filePath = path.join(root.directory, source.relativePath);
    const realUri = vscode.Uri.file(filePath);
    const neutralUri = vscode.Uri.file(path.join(root.directory, neutral.relativePath));
    const otherRoot = runtime.roots.find(candidate => candidate.id === other.rootId)!;
    const invalidated: string[] = [];
    const decorationChanges = runtime.view.onDidChangeFileDecorations(uris => invalidated.push(...uris.map(uri => uri.toString())));
    const token = new vscode.CancellationTokenSource();
    const invoke = (overrides = {}) => runtime.read({ input: { sessionId, filePath, startLine: 2, endLine: 3, ...overrides }, toolInvocationToken: undefined }, token.token);
    assert.equal(runtime.view.enabled, true);
    assert.equal(runtime.store.get(sessionId)?.events.length, 0, 'Tree enumeration does not create reads');
    const result = await invoke();
    assert.ok((result.content[0] as vscode.LanguageModelTextPart).value.endsWith('2: second\n3: third'));
    assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
    assert.equal(runtime.view.provideFileDecoration(runtime.view.uri(neutral)), undefined);
    assert.equal(runtime.view.provideFileDecoration(runtime.view.uri(other)), undefined, 'Multi-root identity is isolated');
    assert.equal(runtime.view.provideFileDecoration(realUri)?.color?.id, 'agentContextTrace.readFileForeground', 'Explorer filename gets the read color');
    assert.ok(invalidated.includes(realUri.toString()), 'Recording invalidates the real Explorer URI');
    assert.equal(runtime.view.provideFileDecoration(neutralUri), undefined, 'Unrecorded Explorer file is neutral');
    assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(path.join(otherRoot.directory, other.relativePath))), undefined, 'Same-named Explorer file in another root is neutral');
    assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(root.directory)), undefined, 'Explorer folders are neutral');
    assert.equal(runtime.view.provideFileDecoration(realUri.with({ scheme: 'git' })), undefined, 'Other URI schemes are untouched');
    if (process.platform === 'win32') {
        assert.equal(runtime.view.provideFileDecoration(vscode.Uri.file(filePath.toUpperCase()))?.badge, 'R', 'Windows path casing is ignored');
    }
    assert.equal(runtime.view.provideFileDecoration(runtime.view.uri(roots[0]!)), undefined, 'Folders are neutral');
    await assert.rejects(invoke({ filePath: path.join(root.directory, '.env') }));
    const configuration = vscode.workspace.getConfiguration('agentContextTrace');
    await configuration.update('excludeGlobs', ['**/source.ts'], vscode.ConfigurationTarget.Global);
    await assert.rejects(invoke(), /excluded/);
    await configuration.update('excludeGlobs', [], vscode.ConfigurationTarget.Global);
    await runtime.view.toggle();
    assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined);
    assert.equal(runtime.view.provideFileDecoration(realUri), undefined, 'Toggle hides Explorer filename color too');
    await invoke({ startLine: 1, endLine: 1 });
    assert.equal(runtime.store.get(sessionId)?.events.length, 2, 'Recording continues with colors off');
    await runtime.view.toggle();
    assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
    const document = await vscode.workspace.openTextDocument(filePath);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), 'dirty ');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await invoke({ startLine: 1, endLine: 1 });
    assert.equal(runtime.store.get(sessionId)?.events.at(-1)?.isDirty, true);
    await document.save();
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
    assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined, 'New selected session clears old colors');
    assert.equal(runtime.view.provideFileDecoration(realUri), undefined, 'New session clears Explorer filename color');
    await runtime.store.setState(second, 'stopped');
    await runtime.view.selectSession(sessionId);
    assert.equal(runtime.view.provideFileDecoration(sourceUri)?.badge, 'R');
    await vscode.commands.executeCommand('revealInExplorer', neutralUri);
    await vscode.commands.executeCommand('agentContextTrace.readCoverage.focus');
    await runtime.view.tree.reveal(source, { select: false, focus: false, expand: true });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.ACT_CDP_PORT}`);
    try {
        const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'));
        assert.ok(page, 'Native VS Code workbench renderer is reachable');
        const section = page.locator('.pane').filter({ has: page.getByText('Agent Read Coverage', { exact: true }) }).first();
        await section.waitFor({ state: 'visible' });
        const label = section.locator('.monaco-icon-label').filter({ hasText: 'source.ts' }).first();
        await label.waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
            const pane = Array.from(globalThis.document.querySelectorAll('.pane')).find(element => element.textContent?.includes('Agent Read Coverage'));
            const target = Array.from(pane?.querySelectorAll('.label-name') ?? []).find(element => element.textContent === 'source.ts');
            return target && getComputedStyle(target).color === 'rgb(112, 187, 255)';
        });
        await page.waitForFunction(() => {
            const target = Array.from(globalThis.document.querySelectorAll('.explorer-folders-view .label-name')).find(element => element.textContent === 'source.ts');
            return target && getComputedStyle(target).color === 'rgb(112, 187, 255)';
        });
        const colored = await label.evaluate(element => getComputedStyle(element.querySelector('.label-name') ?? element).color);
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-colors-on.png') });
        await runtime.view.toggle();
        await page.waitForFunction(previous => {
            const panes = Array.from(globalThis.document.querySelectorAll('.pane'));
            const pane = panes.find(element => element.textContent?.includes('Agent Read Coverage'));
            const target = Array.from(pane?.querySelectorAll('.label-name') ?? []).find(element => element.textContent === 'source.ts');
            return target && getComputedStyle(target).color !== previous;
        }, colored);
        await page.waitForFunction(() => {
            const target = Array.from(globalThis.document.querySelectorAll('.explorer-folders-view .label-name')).find(element => element.textContent === 'source.ts');
            return target && getComputedStyle(target).color !== 'rgb(112, 187, 255)';
        });
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-colors-off.png') });
        assert.equal(runtime.view.enabled, false);
    } finally { await browser.close(); }
    decorationChanges.dispose();
    console.log('PASS: registered tool, numbered read, built-in Explorer filename text colors and toggle, neutral files, multi-root scope, exclusions, dirty buffers, cancellation, session selection');
    await vscode.commands.executeCommand('workbench.action.quit');
}