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
import { historyPickerItems } from '../views';

export async function run(): Promise<void> {
    const extension = vscode.extensions.getExtension<Runtime>('davidle-ms.agent-context-trace');
    assert.ok(extension, 'Development extension is installed');
    const runtime = await extension.activate();
    assert.ok(runtime, 'Extension activated in a trusted local test workspace');
    assert.ok(vscode.lm.tools.some(tool => tool.name === TOOL_NAME), 'Tool registered with the host');
    const roots = runtime.roots;
    assert.equal(roots.length, 2);
    const root = roots[0]!;
    const otherRoot = roots[1]!;
    const filePath = path.join(root.directory, 'source.ts');
    const sourceUri = vscode.Uri.file(filePath);
    const neutralUri = vscode.Uri.file(path.join(root.directory, 'neutral.ts'));
    const otherUri = vscode.Uri.file(path.join(otherRoot.directory, 'source.ts'));
    assert.deepEqual(runtime.view.getChildren(), [], 'Coverage controls never enumerate workspace directories');
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
        assert.deepEqual(runtime.view.editorHighlights(await vscode.workspace.openTextDocument(sourceUri)), { verified: [], unverified: [] }, 'File-only history never highlights the whole file');
        await runtime.view.toggle();
        assert.equal(runtime.view.provideFileDecoration(sourceUri), undefined);
        const updated = waitForReads(2);
        const append = JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ ...read, toolCallId: 'second-read',
            pastTenseMessage: { value: `Read [file](${neutralUri.toString()})` } }] }) + '\n';
        await fs.appendFile(file, append);
        await updated;
        assert.match(String(runtime.view.tree.message), /2 recorded reads in this repository/);
        assert.equal(runtime.view.enabled, false, 'History refresh does not turn colors on');
        await runtime.view.toggle();
        assert.equal(runtime.view.provideFileDecoration(neutralUri)?.badge, 'R');
        assert.deepEqual(runtime.view.getChildren(), [], 'Historical reads never create duplicate file entries');
        assert.equal(await fs.readFile(file, 'utf8'), initial + firstAppend + append, 'Extension never edits Copilot chat history');
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
        await page.waitForFunction(() => {
            const pane = Array.from(globalThis.document.querySelectorAll('.pane')).find(element => element.textContent?.includes('Agent Read Coverage'));
            return pane && pane.querySelectorAll('.monaco-list-row').length === 0;
        });
        assert.equal(await section.getByText('repo-one', { exact: true }).count(), 0, 'No duplicate repository root');
        assert.equal(await section.getByText('source.ts', { exact: true }).count(), 0, 'No duplicate file listing');
        await page.waitForFunction(() => {
            const target = Array.from(globalThis.document.querySelectorAll('.explorer-folders-view .label-name')).find(element => element.textContent === 'source.ts');
            return target && getComputedStyle(target).color === 'rgb(92, 168, 240)';
        });
        await page.waitForFunction(() => Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => getComputedStyle(element).borderLeftColor === 'rgb(112, 187, 255)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        const verifiedMarks = await page.locator('.monaco-editor .view-overlays .cdr').evaluateAll(elements => elements
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(112, 187, 255)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0)
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
            return target && getComputedStyle(target).color !== 'rgb(92, 168, 240)';
        });
        await page.waitForFunction(() => !Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => ['rgb(112, 187, 255)', 'rgb(92, 168, 240)', 'rgb(76, 149, 223)', 'rgb(65, 138, 215)'].includes(getComputedStyle(element).borderLeftColor) && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-colors-off.png') });
        assert.equal(runtime.view.enabled, false);
        await runtime.view.toggle();
        runtime.view.showHistory({ id: 'copilot:range-preview', label: 'Historical ranges', createdAt: '', coverage: 'copilot-history-read-metadata',
            recognizedCalls: 1, unmappedCalls: 0, events: [{ id: 'history-range', rootId: root.id, relativePath: 'source.ts', startLine: 2, endLine: 3 }] });
        assert.deepEqual(runtime.view.editorHighlights(document), { verified: [], unverified: [{ startLine: 2, endLine: 3, readCount: 1 }] });
        await page.waitForFunction(() => Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(112, 187, 255)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0).length === 2);
        const historicalMarks = await page.locator('.monaco-editor .view-overlays .cdr').evaluateAll(elements => elements
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(112, 187, 255)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0)
            .map(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderLeftColor })));
        assert.equal(historicalMarks.length, 2);
        for (const mark of historicalMarks) {
            assert.equal(mark.background, verifiedMarks[0]!.background, 'History and verified reads have identical shading');
            assert.equal(mark.border, verifiedMarks[0]!.border, 'History and verified reads have identical borders');
        }
        assert.doesNotMatch(String(runtime.view.tree.message), /amber/i);
        await section.getByText(/Local Copilot history: 1 recorded read in this repository/).waitFor();
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-sections-history.png') });
        const frequencySession: HistorySession = {
            id: 'copilot:frequency-preview', label: 'Session read frequency', createdAt: '', coverage: 'copilot-history-read-metadata',
            recognizedCalls: 8, unmappedCalls: 0, events: [1, 2, 3, 3, 4, 4, 4, 4].map((startLine, index) => ({
                id: `frequency-${index}`, rootId: root.id, relativePath: 'source.ts', startLine, endLine: 4
            }))
        };
        for (const [count, suffix] of [[1, ''], [2, 'Repeat'], [4, 'Frequent'], [8, 'Intense']] as const) {
            runtime.view.showHistory({ ...frequencySession, events: frequencySession.events.slice(0, count) });
            assert.equal(runtime.view.provideFileDecoration(sourceUri)?.color?.id, `agentContextTrace.readFile${suffix}Foreground`);
            assert.match(runtime.view.provideFileDecoration(sourceUri)!.tooltip!, new RegExp(`${count} recorded read`));
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
            return ['rgb(112, 187, 255)', 'rgb(92, 168, 240)', 'rgb(76, 149, 223)', 'rgb(65, 138, 215)'].every(color => colors.has(color));
        });
        const frequencyMarks = await page.locator('.monaco-editor .view-overlays .cdr').evaluateAll(elements => elements
            .filter(element => ['rgb(112, 187, 255)', 'rgb(92, 168, 240)', 'rgb(76, 149, 223)', 'rgb(65, 138, 215)'].includes(getComputedStyle(element).borderLeftColor)
                && parseFloat(getComputedStyle(element).borderLeftWidth) > 0)
            .map(element => ({ lineTop: (element.parentElement as HTMLElement).offsetTop, color: getComputedStyle(element).borderLeftColor,
                channels: getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number),
                alpha: Number(getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.[3]) })).sort((left, right) => left.lineTop - right.lineTop));
        assert.equal(frequencyMarks.length, 4, 'Exactly four recorded lines have frequency highlights');
        assert.deepEqual(frequencyMarks.map(mark => mark.color), ['rgb(112, 187, 255)', 'rgb(92, 168, 240)', 'rgb(76, 149, 223)', 'rgb(65, 138, 215)']);
        for (const mark of frequencyMarks) {
            assert.equal(mark.channels?.length, 3);
            assert.equal(mark.channels![0], mark.channels![1], 'Read backgrounds are neutral, not blue');
            assert.equal(mark.channels![1], mark.channels![2]);
        }
        for (let index = 1; index < frequencyMarks.length; index++) {
            assert.ok(frequencyMarks[index]!.lineTop > frequencyMarks[index - 1]!.lineTop);
            assert.ok(frequencyMarks[index]!.alpha > frequencyMarks[index - 1]!.alpha, 'Repeated-read backgrounds have progressively stronger neutral shading');
        }
        await section.getByText(/Gray shading: 1 \/ 2-3 \/ 4-7 \/ 8\+ reads/).waitFor();
        assert.equal(await page.locator('.monaco-editor .view-lines span').evaluateAll(elements => elements
            .filter(element => /^"Read \d+ times?"$/.test(getComputedStyle(element, '::after').content)).length), 0, 'No inline count labels are added');
        const textColors = () => page.locator('.monaco-editor .view-lines .view-line span').evaluateAll(elements => elements
            .filter(element => element.children.length === 0 && !!element.textContent)
            .map(element => ({ text: element.textContent, color: getComputedStyle(element).color })));
        const shadedTextColors = await textColors();
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-frequency-gray.png') });
        await page.screenshot({ path: path.join(process.env.ACT_SCREENSHOTS!, 'read-frequency-shades.png') });
        const fourthLine = page.locator('.monaco-editor .view-lines .view-line').getByText('fourth', { exact: true }).first();
        await fourthLine.hover({ position: { x: 4, y: 6 } });
        await page.getByText(/Lines 4-4: 8 recorded reads in this session/).waitFor();
        await page.keyboard.press('Escape');
        await section.hover();
        await runtime.view.toggle();
        assert.deepEqual(runtime.view.editorHighlights(document), { verified: [], unverified: [] });
        await page.waitForFunction(() => !Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => ['rgb(112, 187, 255)', 'rgb(92, 168, 240)', 'rgb(76, 149, 223)', 'rgb(65, 138, 215)'].includes(getComputedStyle(element).borderLeftColor)
                && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        assert.deepEqual(await textColors(), shadedTextColors, 'Highlighting leaves syntax foreground colors unchanged');
        await runtime.view.toggle();
        assert.deepEqual(runtime.view.editorHighlights(document), beforeRefresh, 'Re-enabling restores the same counts');
        const missingRange = { ...frequencySession, events: [...frequencySession.events, { id: 'no-range', rootId: root.id, relativePath: 'source.ts' }] };
        runtime.view.showHistory(missingRange);
        assert.match(runtime.view.provideFileDecoration(sourceUri)!.tooltip!, /9 recorded reads/);
        assert.deepEqual(runtime.view.editorHighlights(document), beforeRefresh, 'File-only reads affect the file total but no section counts');
        console.log('PASS: four neutral-gray background tiers with blue edges, unchanged syntax colors, no inline labels, exact-count hover, and toggling');
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
                .some(element => ['rgb(112, 187, 255)', 'rgb(92, 168, 240)', 'rgb(76, 149, 223)', 'rgb(65, 138, 215)'].includes(getComputedStyle(element).borderLeftColor)
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
            .filter(element => getComputedStyle(element).borderLeftColor === 'rgb(112, 187, 255)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0).length >= 2);
        await runtime.view.toggle();
        await page.waitForFunction(() => !Array.from(globalThis.document.querySelectorAll('.monaco-editor .view-overlays .cdr'))
            .some(element => getComputedStyle(element).borderLeftColor === 'rgb(112, 187, 255)' && parseFloat(getComputedStyle(element).borderLeftWidth) > 0));
        console.log('PASS: same blue frequency scale for tracker and historical reads, missing ranges, file edits, split editors, session changes, and eye toggle');
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
    await vscode.commands.executeCommand('workbench.action.quit');
}