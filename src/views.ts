import * as vscode from 'vscode';
import * as path from 'node:path';
import { Root, ReadEvent, Session, summary, TraceStore, resolveFile, hash } from './core';
import { HistoryRead, HistorySession, historyStatus, HistoryEntry, groupHistory } from './history';

export interface HistoryPickerItem extends vscode.QuickPickItem {
    file: string;
    action: 'select' | 'folder' | 'file' | 'separator';
}

export function historyPickerItems(entries: readonly HistoryEntry[]): HistoryPickerItem[] {
    const groups = groupHistory(entries);
    const items: HistoryPickerItem[] = [];
    for (const [label, sessions] of [['This Repository', groups.repository], ['Other Sessions', groups.other]] as const) {
        if (!sessions.length) { continue; }
        items.push({ label, kind: vscode.QuickPickItemKind.Separator, action: 'separator', file: '' });
        items.push(...sessions.map(entry => ({ label: entry.label, description: new Date(entry.updatedAt).toLocaleString(),
            detail: `Workspace: ${entry.workspace} | local history (best effort)`, file: entry.file, action: 'select' as const })));
    }
    items.push(
        { label: 'Open History', kind: vscode.QuickPickItemKind.Separator, action: 'separator', file: '' },
        { label: 'Browse a chat history folder...', detail: 'Choose a chatSessions folder from another workspace or VS Code profile.', action: 'folder', file: '' },
        { label: 'Open a chat JSON or JSONL file...', detail: 'Read one explicitly selected history file.', action: 'file', file: '' }
    );
    return items;
}

export class CoverageView implements vscode.TreeDataProvider<'toggle'>, vscode.FileDecorationProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly decorated = new vscode.EventEmitter<vscode.Uri[]>();
    readonly onDidChangeTreeData = this.changed.event;
    readonly onDidChangeFileDecorations = this.decorated.event;
    readonly tree: vscode.TreeView<'toggle'>;
    private readonly disposables: vscode.Disposable[] = [];
    private selectedId: string | undefined;
    private history: HistorySession | undefined;
    private index = new Map<string, (ReadEvent | HistoryRead)[]>();
    private fileUris = new Map<string, vscode.Uri>();
    enabled: boolean;

    constructor(private readonly context: vscode.ExtensionContext, private readonly store: TraceStore, private readonly roots: readonly Root[]) {
        this.enabled = context.workspaceState.get('fileColorsEnabled', true);
        this.tree = vscode.window.createTreeView('agentContextTrace.readCoverage', { treeDataProvider: this, manageCheckboxStateManually: true });
        this.disposables.push(this.tree, this.changed, this.decorated, vscode.window.registerFileDecorationProvider(this));
        this.disposables.push(this.tree.onDidChangeCheckboxState(async event => {
            const state = event.items.find(([item]) => item === 'toggle')?.[1];
            if (state === undefined) { return; }
            try { await this.setColorsEnabled(state === vscode.TreeItemCheckboxState.Checked); }
            catch {
                this.refresh();
                void vscode.window.showErrorMessage('Could not save the read-color preference. Please try again.');
            }
        }));
    }

    restoreSelection(): void {
        const previous = this.context.workspaceState.get<string>('selectedSessionId');
        this.selectedId = previous && this.store.get(previous) ? previous : undefined;
        this.refresh();
    }
    selected(): Session | HistorySession | undefined {
        return this.history ? structuredClone(this.history) : this.selectedId ? this.store.get(this.selectedId) : undefined;
    }
    showHistory(session: HistorySession): void {
        this.selectedId = undefined;
        this.history = structuredClone(session);
        this.refresh();
    }
    clearHistory(): void { this.history = undefined; this.refresh(); }
    async selectSession(id: string | undefined): Promise<void> {
        if (id && !this.store.get(id)) { throw new Error('Tracker session not found.'); }
        await this.context.workspaceState.update('selectedSessionId', id);
        this.history = undefined;
        this.selectedId = id;
        this.refresh();
    }
    async toggle(): Promise<void> {
        await this.setColorsEnabled(!this.enabled);
    }

    private async setColorsEnabled(enabled: boolean): Promise<void> {
        await this.context.workspaceState.update('fileColorsEnabled', enabled);
        this.enabled = enabled;
        this.refresh();
    }

    private fileKey(uri: vscode.Uri): string {
        return process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
    }

    refresh(): void {
        const session = this.selected();
        const affectedFiles = new Map(this.fileUris);
        this.fileUris.clear();
        this.index.clear();
        for (const event of session?.events ?? []) {
            const root = this.roots.find(candidate => candidate.id === event.rootId);
            if (root) {
                const uri = vscode.Uri.file(path.join(root.directory, event.relativePath));
                const key = this.fileKey(uri);
                const events = this.index.get(key) ?? [];
                events.push(event);
                this.index.set(key, events);
                this.fileUris.set(key, uri);
                affectedFiles.set(key, uri);
            }
        }
        this.tree.description = `${session?.label ?? 'No session selected'} | Colors ${this.enabled ? 'on' : 'off'}`;
        this.tree.message = session?.coverage === 'copilot-history-read-metadata' ? historyStatus(session) : 'Instrumented reads only';
        this.tree.badge = { value: this.index.size, tooltip: 'Files with recorded reads in the selected tracker session' };
        void vscode.commands.executeCommand('setContext', 'agentContextTrace.fileColorsEnabled', this.enabled);
        this.decorated.fire([...affectedFiles.values()]);
        this.changed.fire();
    }

    getChildren(element?: 'toggle'): 'toggle'[] { return element ? [] : ['toggle']; }

    getTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem('Toggle Read Colors', vscode.TreeItemCollapsibleState.None);
        item.id = 'toggle-read-colors';
        item.description = this.enabled ? 'On' : 'Off';
        item.checkboxState = this.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        item.tooltip = 'Show or hide recorded-read colors in Explorer. History refresh and recording continue.';
        item.accessibilityInformation = { label: `Toggle Read Colors, ${this.enabled ? 'On' : 'Off'}` };
        item.command = { command: 'agentContextTrace.toggleFileColors', title: 'Toggle Read Colors' };
        return item;
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!this.enabled || uri.scheme !== 'file' || !this.fileUris.has(this.fileKey(uri))) { return; }
        return { badge: 'R', tooltip: this.history ? 'Read recorded in selected Copilot chat history (best effort)' : 'Recorded instrumented read in the selected session', color: new vscode.ThemeColor('agentContextTrace.readFileForeground'), propagate: false };
    }

    async showDetails(uri?: vscode.Uri): Promise<void> {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        const events = target instanceof vscode.Uri && target.scheme === 'file' ? this.index.get(this.fileKey(target)) ?? [] : [];
        if (!target || !events.length) {
            void vscode.window.showInformationMessage('No recorded reads for this file in the selected session.');
            return;
        }
        const name = path.basename(target.fsPath);
        const metrics = summary(events.filter((event): event is ReadEvent => 'snapshotHash' in event));
        const selected = await vscode.window.showQuickPick(events.map(event => ({
            label: event.startLine !== undefined ? `Lines ${event.startLine}-${event.endLine}` : 'Recorded file read (range unavailable)', description: event.at,
            detail: 'snapshotHash' in event ? `Revision ${event.snapshotHash.slice(0, 8)}${event.isDirty ? ' (unsaved buffer)' : ''}` : 'Copilot history; revision unavailable', event
        })), { title: this.history ? `${name} | ${events.length} historical reads` : `${name} | ${metrics.unique} revision-scoped unique lines | ${metrics.repeated} repeated` });
        if (!selected) { return; }
        const resolved = await resolveFile(target.fsPath, this.roots);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.filePath));
        if (!('snapshotHash' in selected.event)) {
            await vscode.window.showTextDocument(document);
            void vscode.window.showInformationMessage('This chat history has no source revision. Historical lines were not highlighted.');
            return;
        }
        if (hash(document.getText()) !== selected.event.snapshotHash) {
            await vscode.window.showTextDocument(document);
            void vscode.window.showWarningMessage('The file has changed since this read. Historical line ranges were not highlighted.');
            return;
        }
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(selected.event.startLine - 1, 0,
            selected.event.endLine - 1, document.lineAt(selected.event.endLine - 1).text.length) });
    }
    dispose(): void { for (const disposable of this.disposables) { disposable.dispose(); } }
}