import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { FSWatcher, watch } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import { hash, ReadInput, Root, resolveFile, sliceRead, TOOL_NAME, TraceStore, validateInput } from './core';
import { CoverageView, historyPickerItems } from './views';
import { HistorySession, listHistory, readHistory } from './history';

let running: Runtime | undefined;

export class Runtime {
    readonly store: TraceStore;
    readonly view: CoverageView;
    readonly status: vscode.StatusBarItem;
    readonly tool: vscode.LanguageModelTool<ReadInput>;
    private historyFile: string | undefined;
    private historyGeneration = 0;
    private historyWatcher: FSWatcher | undefined;
    private historyTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly context: vscode.ExtensionContext, readonly roots: Root[], directory: string) {
        this.store = new TraceStore(directory, () => this.refresh());
        this.view = new CoverageView(context, this.store, roots);
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
        this.status.command = 'agentContextTrace.selectCopilotSession';
        this.status.tooltip = 'Choose an existing Copilot chat or use optional tracker sessions. Display selection does not change recording.';
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
        context.subscriptions.push({ dispose: () => this.disconnectHistory() });
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
        register('selectCopilotSession', () => this.chooseCopilotSession());
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
            if (selected) {
                await this.context.workspaceState.update('copilotHistoryFile', undefined);
                this.disconnectHistory();
                await this.view.selectSession(selected.id);
                this.refresh();
            }
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
        register('refresh', () => this.historyFile ? this.refreshCopilotHistory() : this.view.refresh());
        register('showDetails', (uri?: vscode.Uri) => this.view.showDetails(uri));
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
            if (session.coverage === 'copilot-history-read-metadata') {
                await this.context.workspaceState.update('copilotHistoryFile', undefined);
                this.disconnectHistory();
                await this.view.selectSession(undefined);
                this.refresh();
                void vscode.window.showInformationMessage('Disconnected from chat history. The Copilot chat was not changed or deleted.');
                return;
            }
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
        const historyFile = this.context.workspaceState.get<string>('copilotHistoryFile');
        if (historyFile && this.context.workspaceState.get('copilotHistoryConsent', false)) {
            try { await this.selectCopilotFile(historyFile); }
            catch { void vscode.window.showWarningMessage('Previously selected Copilot history is unavailable. Choose a chat session again.'); }
        }
    }

    async start(label: string): Promise<string> {
        this.guard();
        const session = await this.store.start(label, this.roots.map(root => root.id));
        await this.context.workspaceState.update('copilotHistoryFile', undefined);
        this.disconnectHistory();
        await this.view.selectSession(session.id);
        return session.id;
    }

    private disconnectHistory(): void {
        this.historyGeneration++;
        this.historyFile = undefined;
        this.historyWatcher?.close();
        this.historyWatcher = undefined;
        if (this.historyTimer) { clearTimeout(this.historyTimer); this.historyTimer = undefined; }
    }

    private async historyFolders(): Promise<string[]> {
        const stores = new Set<string>();
        if (this.context.storageUri) { stores.add(path.dirname(path.dirname(this.context.storageUri.fsPath))); }
        const product = vscode.env.appName.includes('Insiders') ? 'Code - Insiders' : 'Code';
        const base = process.platform === 'win32' ? process.env.APPDATA
            : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
            : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
        if (base) { stores.add(path.join(base, product, 'User', 'workspaceStorage')); }
        const folders: string[] = this.context.storageUri ? [path.join(path.dirname(this.context.storageUri.fsPath), 'chatSessions')] : [];
        for (const store of stores) {
            const workspaces = await fs.readdir(store, { withFileTypes: true }).catch(() => []);
            for (const workspace of workspaces.filter(entry => entry.isDirectory()).slice(0, 200)) {
                folders.push(path.join(store, workspace.name, 'chatSessions'));
            }
        }
        const custom = this.context.workspaceState.get<string>('copilotHistoryFolder');
        if (custom) { folders.push(custom); }
        return folders;
    }

    private async chooseCopilotSession(): Promise<void> {
        this.guard();
        if (!this.context.workspaceState.get('copilotHistoryConsent', false)) {
            const approved = await vscode.window.showWarningMessage('Read local Copilot chat history? This version-dependent adapter reads chat files from this and the default VS Code profile. They can contain prompts and source content. Only file-read metadata is displayed; original chats are never modified or copied. It is not a supported Copilot API.',
                { modal: true }, 'Read Local History');
            if (approved !== 'Read Local History') { return; }
            await this.context.workspaceState.update('copilotHistoryConsent', true);
        }
        const entries = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading local Copilot chats' },
            async () => listHistory(await this.historyFolders(), this.roots,
                this.context.storageUri ? path.join(path.dirname(this.context.storageUri.fsPath), 'chatSessions') : undefined));
        const picked = await vscode.window.showQuickPick(historyPickerItems(entries), {
            title: 'Choose Existing Copilot Chat Session',
            placeHolder: !entries.length ? 'No local chats found. Choose a history folder or file.'
                : entries.some(entry => entry.repositoryMatch) ? 'This repository first, then other sessions; newest first in each group'
                : 'No chats matched this repository. Other sessions are listed newest first.',
            matchOnDetail: true
        });
        if (!picked || picked.action === 'separator') { return; }
        if (picked.action === 'folder') {
            const selected = await vscode.window.showOpenDialog({ title: 'Select Copilot chatSessions Folder', canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
            if (selected?.[0]?.scheme === 'file') {
                await this.context.workspaceState.update('copilotHistoryFolder', selected[0].fsPath);
                await this.chooseCopilotSession();
            }
            return;
        }
        let file = picked.file;
        if (picked.action === 'file') {
            const selected = await vscode.window.showOpenDialog({ title: 'Select Copilot Chat History', canSelectMany: false, filters: { 'Chat history': ['json', 'jsonl'] } });
            if (selected?.[0]?.scheme !== 'file') { return; }
            file = selected[0].fsPath;
        }
        await this.selectCopilotFile(file);
    }

    private filterHistory(session: HistorySession): HistorySession {
        const patterns = vscode.workspace.getConfiguration('agentContextTrace').get<string[]>('excludeGlobs', []);
        session.events = session.events.filter(event => !patterns.some(pattern => minimatch(event.relativePath, pattern, { dot: true, nocase: process.platform === 'win32' })));
        return session;
    }

    async selectCopilotFile(file: string): Promise<void> {
        this.guard();
        const generation = ++this.historyGeneration;
        const session = this.filterHistory(await readHistory(file, this.roots));
        if (generation !== this.historyGeneration) { return; }
        await this.context.workspaceState.update('copilotHistoryFile', file);
        if (generation !== this.historyGeneration) { return; }
        this.disconnectHistory();
        this.historyFile = file;
        this.view.showHistory(session);
        const schedule = () => {
            if (this.historyTimer) { clearTimeout(this.historyTimer); }
            this.historyTimer = setTimeout(() => {
                this.historyTimer = undefined;
                void this.refreshCopilotHistory().catch((error: unknown) => {
                    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                        this.view.clearHistory();
                        this.view.tree.message = 'Selected chat history file is unavailable';
                    } else { this.view.tree.message = 'History update unavailable; showing last loaded snapshot'; }
                });
            }, 400);
        };
        this.historyWatcher = watch(path.dirname(file), (_event, name) => {
            if (!name || name.toString() === path.basename(file)) { schedule(); }
        });
        this.historyWatcher.on('error', () => {
            this.view.tree.message = 'History watcher unavailable; use Refresh Repository';
        });
        this.refresh();
        await this.refreshCopilotHistory();
    }

    async refreshCopilotHistory(): Promise<void> {
        if (!this.historyFile) { return; }
        const generation = ++this.historyGeneration;
        const session = this.filterHistory(await readHistory(this.historyFile, this.roots));
        if (generation === this.historyGeneration) { this.view.showHistory(session); this.refresh(); }
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
        this.status.text = current ? `$(record) Trace: ${current.state} | ${current.label}`
            : this.view.selected()?.coverage === 'copilot-history-read-metadata' ? '$(history) Trace: Copilot history' : '$(eye) Trace: choose chat';
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