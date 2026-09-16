import * as vscode from 'vscode';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import { Root, ReadEvent, Session, summary, TraceStore, VIEW_SCHEME, resolveFile, hash } from './core';

export interface FileNode { rootId: string; relativePath: string; directory: boolean; name: string }

export class CoverageView implements vscode.TreeDataProvider<FileNode>, vscode.FileDecorationProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly decorated = new vscode.EventEmitter<vscode.Uri[]>();
    readonly onDidChangeTreeData = this.changed.event;
    readonly onDidChangeFileDecorations = this.decorated.event;
    readonly tree: vscode.TreeView<FileNode>;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly materialized = new Map<string, FileNode>();
    private selectedId: string | undefined;
    private index = new Map<string, ReadEvent[]>();
    enabled: boolean;

    constructor(private readonly context: vscode.ExtensionContext, private readonly store: TraceStore, private readonly roots: readonly Root[]) {
        this.enabled = context.workspaceState.get('fileColorsEnabled', true);
        this.tree = vscode.window.createTreeView('agentContextTrace.readCoverage', { treeDataProvider: this, showCollapseAll: true });
        this.disposables.push(this.tree, this.changed, this.decorated, vscode.window.registerFileDecorationProvider(this));
        for (const root of roots) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root.directory, '**/*'));
            this.disposables.push(watcher, watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()));
        }
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('files.exclude')) { this.refresh(); } }));
    }

    restoreSelection(): void {
        const previous = this.context.workspaceState.get<string>('selectedSessionId');
        this.selectedId = previous && this.store.get(previous) ? previous : undefined;
        this.refresh();
    }
    selected(): Session | undefined { return this.selectedId ? this.store.get(this.selectedId) : undefined; }
    async selectSession(id: string | undefined): Promise<void> {
        if (id && !this.store.get(id)) { throw new Error('Tracker session not found.'); }
        await this.context.workspaceState.update('selectedSessionId', id);
        this.selectedId = id;
        this.refresh();
    }
    async toggle(): Promise<void> {
        const enabled = !this.enabled;
        await this.context.workspaceState.update('fileColorsEnabled', enabled);
        this.enabled = enabled;
        this.refresh();
    }

    uri(node: FileNode): vscode.Uri {
        return vscode.Uri.from({ scheme: VIEW_SCHEME, authority: node.rootId, path: `/${node.relativePath}` });
    }
    private key(node: Pick<FileNode, 'rootId' | 'relativePath'>): string { return JSON.stringify([node.rootId, node.relativePath]); }
    private events(node: FileNode): ReadEvent[] { return this.index.get(this.key(node)) ?? []; }
    private root(node: FileNode): Root {
        const root = this.roots.find(candidate => candidate.id === node.rootId);
        if (!root) { throw new Error('Workspace root is unavailable.'); }
        return root;
    }

    refresh(): void {
        const session = this.selected();
        this.index.clear();
        for (const event of session?.events ?? []) {
            const key = this.key(event);
            const events = this.index.get(key) ?? [];
            events.push(event);
            this.index.set(key, events);
        }
        this.tree.description = `${session?.label ?? 'No session selected'} | Colors ${this.enabled ? 'on' : 'off'}`;
        this.tree.message = 'Instrumented reads only';
        this.tree.badge = { value: this.index.size, tooltip: 'Files with recorded reads in the selected tracker session' };
        void vscode.commands.executeCommand('setContext', 'agentContextTrace.fileColorsEnabled', this.enabled);
        this.decorated.fire([...this.materialized.values()].map(node => this.uri(node)));
        this.changed.fire();
    }

    getParent(node: FileNode): FileNode | undefined {
        if (!node.relativePath) { return; }
        const root = this.root(node);
        const parent = path.posix.dirname(node.relativePath);
        return { rootId: root.id, relativePath: parent === '.' ? '' : parent, directory: true,
            name: parent === '.' ? root.name : path.posix.basename(parent) };
    }

    async getChildren(node?: FileNode): Promise<FileNode[]> {
        if (!node) { return this.roots.map(root => ({ rootId: root.id, relativePath: '', name: root.name, directory: true })); }
        if (!node.directory) { return []; }
        const root = this.root(node);
        const uri = vscode.Uri.file(path.join(root.directory, node.relativePath));
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const names = new Set(entries.map(([name]) => name));
        const excludes = vscode.workspace.getConfiguration('files', uri).get<Record<string, boolean | { when: string }>>('exclude', {});
        const children: FileNode[] = [];
        for (const [name, type] of entries) {
            if (name === '.git' || type & vscode.FileType.SymbolicLink) { continue; }
            const relativePath = node.relativePath ? `${node.relativePath}/${name}` : name;
            const hidden = Object.entries(excludes).some(([pattern, condition]) => {
                if (!condition || !minimatch(relativePath, pattern, { dot: true })) { return false; }
                return condition === true || names.has(condition.when.replace('$(basename)', path.parse(name).name));
            });
            if (hidden) { continue; }
            children.push({ rootId: root.id, relativePath, name, directory: !!(type & vscode.FileType.Directory) });
        }
        return children.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
    }

    getTreeItem(node: FileNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.name, node.directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = this.key(node);
        item.resourceUri = this.uri(node);
        item.iconPath = node.directory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        this.materialized.set(item.resourceUri.toString(), node);
        const events = node.directory ? [] : this.events(node);
        item.contextValue = events.length ? 'recordedFile' : 'workspaceFile';
        const label = events.length ? `${events.length} recorded reads` : 'No recorded read in this session';
        item.tooltip = node.directory ? node.name : `${node.name}: ${label}${events.length ? `; last ${events.at(-1)?.at}. Historical ranges, not necessarily the current revision.` : ''}`;
        item.accessibilityInformation = { label: `${node.name}${node.directory ? ', folder' : `, ${label}`}` };
        if (!node.directory) { item.command = { command: 'agentContextTrace.openFile', title: 'Open File', arguments: [node] }; }
        return item;
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!this.enabled || uri.scheme !== VIEW_SCHEME) { return; }
        const node = this.materialized.get(uri.toString());
        if (!node || node.directory || !this.events(node).length) { return; }
        return { badge: 'R', tooltip: 'Recorded instrumented read in the selected session', color: new vscode.ThemeColor('agentContextTrace.readFileForeground'), propagate: false };
    }

    async openFile(node: FileNode): Promise<void> {
        const root = this.root(node);
        const resolved = await resolveFile(path.join(root.directory, node.relativePath), this.roots);
        await vscode.window.showTextDocument(vscode.Uri.file(resolved.filePath), { preview: true });
    }

    async showDetails(node: FileNode): Promise<void> {
        const events = this.events(node);
        const metrics = summary(events);
        const selected = await vscode.window.showQuickPick(events.map(event => ({
            label: `Lines ${event.startLine}-${event.endLine}`, description: event.at,
            detail: `Revision ${event.snapshotHash.slice(0, 8)}${event.isDirty ? ' (unsaved buffer)' : ''}`, event
        })), { title: `${node.name} | ${metrics.unique} revision-scoped unique lines | ${metrics.repeated} repeated` });
        if (!selected) { return; }
        const root = this.root(node);
        const resolved = await resolveFile(path.join(root.directory, node.relativePath), this.roots);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.filePath));
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