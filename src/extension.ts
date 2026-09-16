import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import { hash, ReadInput, Root, resolveFile, sliceRead, TOOL_NAME, TraceStore, validateInput } from './core';
import { CoverageView, FileNode } from './views';

let running: Runtime | undefined;

export class Runtime {
    readonly store: TraceStore;
    readonly view: CoverageView;
    readonly status: vscode.StatusBarItem;
    readonly tool: vscode.LanguageModelTool<ReadInput>;

    constructor(private readonly context: vscode.ExtensionContext, readonly roots: Root[], directory: string) {
        this.store = new TraceStore(directory, () => this.refresh());
        this.view = new CoverageView(context, this.store, roots);
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
        this.status.command = 'agentContextTrace.selectSession';
        this.status.tooltip = 'Instrumented-tool coverage only. Displayed history does not control recording.';
        this.tool = {
            prepareInvocation: options => {
                const input = validateInput(options.input);
                this.guard();
                const session = this.store.requireRecording(input.sessionId);
                const message = new vscode.MarkdownString();
                message.appendText(`Read ${input.filePath}, lines ${input.startLine}-${input.endLine}, and return source to Copilot? Record path/range metadata locally in '${session.label}'. This custom tool does not inherit Copilot content exclusions.`);
                return { invocationMessage: 'Reading workspace lines with Context Trace', confirmationMessages: { title: 'Read and trace workspace file', message } };
            },
            invoke: (options, token) => this.read(options, token)
        };
        context.subscriptions.push(this.view, this.status);
    }

    guard(): void {
        if (!vscode.workspace.isTrusted || vscode.env.remoteName || !vscode.workspace.workspaceFolders?.length
            || vscode.workspace.workspaceFolders.some(folder => folder.uri.scheme !== 'file')) {
            throw new Error('Agent Context Trace requires a trusted local workspace.');
        }
    }

    async initialize(): Promise<void> {
        const skipped = await this.store.load();
        if (skipped) { void vscode.window.showWarningMessage(`Context Trace skipped ${skipped} invalid or excess history files. Originals were left untouched.`); }
        this.view.restoreSelection();
        const register = (name: string, action: (...args: any[]) => unknown) => {
            this.context.subscriptions.push(vscode.commands.registerCommand(`agentContextTrace.${name}`, async (...args: any[]) => {
                try { return await action(...args); }
                catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Context Trace operation failed.'); }
            }));
        };
        register('start', async () => {
            const label = await vscode.window.showInputBox({ title: 'Start Tracker Session', prompt: 'Session name', value: 'Context trace',
                validateInput: value => !value.trim() || value.trim().length > 80 ? 'Use 1-80 characters.' : undefined });
            if (!label) { return; }
            await this.start(label);
            await this.copyReference();
        });
        register('selectSession', async () => {
            const selected = await vscode.window.showQuickPick(this.store.list().map(session => ({ label: session.label,
                description: `${session.state}${session.owner !== this.store.owner && session.state !== 'stopped' ? ' (other window or interrupted)' : ''}`,
                detail: `${session.createdAt} | ${session.events.length} recorded reads`, id: session.id })), { title: 'Displayed Tracker Session' });
            if (selected) { await this.view.selectSession(selected.id); }
        });
        register('pauseResume', async () => {
            const current = this.store.current();
            if (!current) { throw new Error('No tracker session is active in this window.'); }
            await this.store.setState(current.id, current.state === 'paused' ? 'recording' : 'paused');
        });
        register('stop', async () => {
            const current = this.store.current();
            if (current) { await this.store.setState(current.id, 'stopped'); }
        });
        register('copyReference', () => this.copyReference());
        register('toggleFileColors', () => this.view.toggle());
        register('refresh', () => this.view.refresh());
        register('openFile', (node: FileNode) => this.view.openFile(node));
        register('showDetails', (node: FileNode) => this.view.showDetails(node));
        register('export', async () => {
            const session = this.view.selected();
            if (!session) { throw new Error('Select a tracker session first.'); }
            const mode = await vscode.window.showQuickPick(['Redact file paths and label', 'Include relative paths and label'], { title: 'Export Metadata (No Source Content)' });
            if (!mode) { return; }
            if (mode.startsWith('Redact')) {
                session.label = 'Redacted';
                const files = new Map<string, string>();
                for (const event of session.events) {
                    const key = `${event.rootId}/${event.relativePath}`;
                    if (!files.has(key)) { files.set(key, `file-${files.size + 1}`); }
                    event.relativePath = files.get(key)!;
                }
            }
            const target = await vscode.window.showSaveDialog({ title: 'Export Tracker Session Metadata', filters: { JSON: ['json'] }, saveLabel: 'Export' });
            if (target) { await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(session, null, 2))); }
        });
        register('delete', async () => {
            const session = this.view.selected();
            if (!session) { return; }
            if (await vscode.window.showWarningMessage(`Delete metadata for '${session.label}'?`, { modal: true }, 'Delete') !== 'Delete') { return; }
            await this.store.delete(session.id);
            await this.view.selectSession(undefined);
        });
        this.context.subscriptions.push(vscode.lm.registerTool(TOOL_NAME, this.tool));
        this.context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.view.refresh();
            void vscode.window.showWarningMessage('Workspace roots changed. Reload the window before using Context Trace with the new roots.');
        }));
        this.refresh();
    }

    async start(label: string): Promise<string> {
        this.guard();
        const session = await this.store.start(label, this.roots.map(root => root.id));
        await this.view.selectSession(session.id);
        return session.id;
    }

    private async copyReference(): Promise<void> {
        const current = this.store.current();
        if (!current) { throw new Error('Start a tracker session first.'); }
        await vscode.env.clipboard.writeText(`Use #agentContextRead for workspace file reads with sessionId "${current.id}". Specify absolute filePath and inclusive startLine/endLine. Do not bypass its exclusions using other tools.`);
        void vscode.window.showInformationMessage('Tracker tool reference copied.');
    }

    private refresh(): void {
        this.view.refresh();
        const current = this.store.current();
        this.status.text = current ? `$(record) Trace: ${current.state} | ${current.label}` : '$(eye) Trace: off';
        this.status.show();
    }

    async read(options: vscode.LanguageModelToolInvocationOptions<ReadInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        this.guard();
        const input = validateInput(options.input);
        const session = this.store.requireRecording(input.sessionId);
        const checkCancelled = () => { if (token.isCancellationRequested) { throw new vscode.CancellationError(); } };
        checkCancelled();
        const resolved = await resolveFile(input.filePath, this.roots);
        const isExcluded = (relative: string) => vscode.workspace.getConfiguration('agentContextTrace').get<string[]>('excludeGlobs', [])
            .some(pattern => minimatch(relative, pattern, { dot: true, nocase: process.platform === 'win32' }));
        const lexical = path.relative(resolved.root.directory, input.filePath).split(path.sep).join('/');
        if (isExcluded(lexical) || isExcluded(resolved.relativePath)) { throw new Error('File is excluded by Context Trace settings.'); }
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolved.filePath));
        if (!folder) { throw new Error('File is no longer in this workspace.'); }
        checkCancelled();
        let document: vscode.TextDocument;
        try { document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.filePath)); }
        catch { throw new Error('Unable to open requested workspace text file.'); }
        const snapshot = document.getText();
        const isDirty = document.isDirty;
        const sliced = sliceRead(snapshot, input);
        const output = `Instrumented read; tracker ${session.id}; ${resolved.relativePath}; lines ${input.startLine}-${sliced.endLine}${sliced.endLine < input.endLine ? ' (end clamped to EOF)' : ''}.\n${sliced.output}`;
        if (options.tokenizationOptions && await options.tokenizationOptions.countTokens(output, token) > options.tokenizationOptions.tokenBudget) {
            throw new Error('Read exceeds the response token budget. Request fewer lines.');
        }
        await resolveFile(resolved.filePath, this.roots);
        checkCancelled();
        await this.store.record(session.id, session.generation, { id: randomUUID(), rootId: resolved.root.id, relativePath: resolved.relativePath,
            startLine: input.startLine, endLine: sliced.endLine, requestedEndLine: input.endLine, snapshotHash: sliced.snapshotHash,
            isDirty, at: new Date().toISOString() }, () => token.isCancellationRequested);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<Runtime | undefined> {
    if (!context.storageUri || !vscode.workspace.isTrusted || vscode.env.remoteName
        || !vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFolders.some(folder => folder.uri.scheme !== 'file')) { return; }
    const roots = await Promise.all(vscode.workspace.workspaceFolders.map(async folder => {
        const directory = await fs.realpath(folder.uri.fsPath);
        return { directory, id: hash(process.platform === 'win32' ? directory.toLowerCase() : directory), name: folder.name };
    }));
    roots.sort((left, right) => right.directory.length - left.directory.length);
    running = new Runtime(context, roots, path.join(context.storageUri.fsPath, 'sessions'));
    await running.initialize();
    return context.extensionMode === vscode.ExtensionMode.Test ? running : undefined;
}

export async function deactivate(): Promise<void> { await running?.store.flush(); }