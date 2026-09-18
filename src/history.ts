import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, ParseError } from 'jsonc-parser';
import { excluded, isWithin, Root } from './core';
import { extractWorkItemActivity, WorkItemActivity } from './work-items';
import { extractResourceActivity, ResourceActivity } from './resource-history';
import { ChangeActivity, ChangePreview, readChangeActivity, readChangePreview } from './change-history';
import { CommandActivity, CommandPreview, extractCommandActivity, extractCommandPreview } from './command-history';

export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_READS = 10000;
const sessionFile = /^[a-zA-Z0-9-]+\.jsonl?$/;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

export interface HistoryRead {
    id: string;
    rootId: string;
    relativePath: string;
    startLine?: number;
    endLine?: number;
    at?: string;
}
export interface HistorySession {
    id: string;
    label: string;
    createdAt: string;
    coverage: 'copilot-history-read-metadata';
    events: HistoryRead[];
    recognizedCalls: number;
    unmappedCalls: number;
    workItems?: WorkItemActivity[];
    resources?: ResourceActivity[];
    changes?: ChangeActivity[];
    commands?: CommandActivity[];
}
export interface HistoryEntry { file: string; label: string; updatedAt: string; workspace: string; repositoryMatch: boolean }

export function groupHistory(entries: readonly HistoryEntry[]): { repository: HistoryEntry[]; other: HistoryEntry[] } {
    const recent = [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.file.localeCompare(right.file));
    return {
        repository: recent.filter(entry => entry.repositoryMatch).slice(0, 100),
        other: recent.filter(entry => !entry.repositoryMatch).slice(0, 100)
    };
}

async function readWorkspaceMetadata(file: string): Promise<JsonObject | undefined> {
    const handle = await fs.open(file, 'r').catch(() => undefined);
    if (!handle) { return; }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_HEADER_BYTES) { return; }
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) { break; }
            offset += bytesRead;
        }
        const errors: ParseError[] = [];
        const metadata: unknown = parse(buffer.subarray(0, offset).toString('utf8'), errors, { allowTrailingComma: true });
        if (!errors.length && object(metadata)) { return metadata; }
    } catch { return; } finally { await handle.close(); }
}

function localFilePath(value: unknown): string | undefined {
    if (typeof value !== 'string') { return; }
    try {
        const uri = new URL(value);
        if (uri.protocol !== 'file:' || uri.hostname) { return; }
        const directory = fileURLToPath(uri);
        return /^[\\/]{2}/.test(directory) ? undefined : directory;
    } catch { return; }
}

async function workspaceAssociation(folder: string): Promise<{ directories: string[]; label: string }> {
    const metadata = await readWorkspaceMetadata(path.join(path.dirname(folder), 'workspace.json'));
    const directory = localFilePath(metadata?.folder);
    if (directory) { return { directories: [directory], label: path.basename(directory) || directory }; }
    const workspaceFile = localFilePath(metadata?.workspace);
    if (workspaceFile) {
        const workspace = await readWorkspaceMetadata(workspaceFile);
        const directories: string[] = [];
        if (Array.isArray(workspace?.folders)) {
            for (const entry of workspace.folders) {
                if (!object(entry)) { continue; }
                const candidate = typeof entry.path === 'string' && !/^[\\/]{2}/.test(entry.path)
                    ? path.resolve(path.dirname(workspaceFile), entry.path) : localFilePath(entry.uri);
                if (candidate) { directories.push(candidate); }
            }
        }
        return { directories, label: path.basename(workspaceFile) };
    }
    return { directories: [], label: 'Unknown workspace' };
}

export function historyStatus(session: HistorySession): string {
    const count = session.events.length;
    if (count) {
        return `Local Copilot history: ${count} recorded read${count === 1 ? '' : 's'} in this repository (best effort)`;
    }
    if (session.recognizedCalls) {
        return `Local Copilot history: ${session.recognizedCalls} read entries found, but none map to included files in this repository. Check the open folder, read metadata, and exclusions.`;
    }
    if (session.workItems?.length) {
        return 'No supported local file reads saved. Azure DevOps activity is available in Work Items.';
    }
    if (session.resources?.length) { return 'No supported local file reads saved. See the Azure DevOps activity tabs for external context.'; }
    if (session.changes?.length) { return 'No supported local file reads saved. Correlated edit activity is available in Changes.'; }
    if (session.commands?.length) { return 'No supported local file reads saved. Recorded terminal commands are available in Command Timeline.'; }
    return 'Local Copilot history: no completed supported file reads saved yet. Continue the chat or select another session; colors update when history is saved.';
}

export function replayHistory(text: string, jsonl: boolean): JsonObject {
    if (Buffer.byteLength(text) > MAX_HISTORY_BYTES) { throw new Error('Chat history exceeds the 32 MiB preview limit.'); }
    if (!jsonl) {
        const parsed: unknown = JSON.parse(text);
        if (!object(parsed)) { throw new Error('Unsupported chat history format.'); }
        return parsed;
    }
    let snapshot: JsonObject | undefined;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!.trim();
        if (!line) { continue; }
        let row: unknown;
        try { row = JSON.parse(line); }
        catch {
            if (index === lines.length - 1 && snapshot) { break; }
            throw new Error('Invalid complete chat history record.');
        }
        if (!object(row)) { throw new Error('Unsupported chat history record.'); }
        if (row.kind === 0 && object(row.v)) { snapshot = row.v; continue; }
        if (!snapshot || ![1, 2].includes(Number(row.kind)) || !Array.isArray(row.k) || !row.k.length || row.k.length > 32) {
            throw new Error('Unsupported chat history update.');
        }
        const keys = row.k as unknown[];
        if (keys.some(key => !(typeof key === 'string' || (Number.isSafeInteger(key) && Number(key) >= 0 && Number(key) <= 100000))
            || ['__proto__', 'constructor', 'prototype'].includes(String(key)))) { throw new Error('Invalid chat update path.'); }
        let target: Record<string, unknown> = snapshot;
        for (const key of keys.slice(0, -1)) {
            if (!Object.hasOwn(target, String(key)) || !target[String(key)] || typeof target[String(key)] !== 'object') {
                throw new Error('Chat update target is missing.');
            }
            target = target[String(key)] as Record<string, unknown>;
        }
        const key = String(keys.at(-1));
        if (row.kind === 1) { target[key] = row.v; }
        else {
            if (!Object.hasOwn(target, key) || !Array.isArray(target[key]) || !Array.isArray(row.v)) { throw new Error('Invalid chat array update.'); }
            for (const item of row.v) { (target[key] as unknown[]).push(item); }
        }
    }
    if (!snapshot) { throw new Error('No chat snapshot found.'); }
    return snapshot;
}

function date(value: unknown): string | undefined {
    if (typeof value !== 'number' && typeof value !== 'string') { return; }
    const time = new Date(value);
    if (Number.isFinite(time.getTime())) { return time.toISOString(); }
    return;
}
function title(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 120) : fallback;
}

export function extractHistory(snapshot: JsonObject, roots: readonly Root[]): HistorySession {
    if (typeof snapshot.sessionId !== 'string' || !snapshot.sessionId || !Array.isArray(snapshot.requests)) {
        throw new Error('Unsupported Copilot chat session.');
    }
    const session: HistorySession = { id: `copilot:${snapshot.sessionId}`, label: title(snapshot.customTitle, `Chat ${snapshot.sessionId.slice(0, 8)}`),
        createdAt: date(snapshot.creationDate) ?? '', coverage: 'copilot-history-read-metadata', events: [], recognizedCalls: 0, unmappedCalls: 0,
        workItems: extractWorkItemActivity(snapshot), resources: extractResourceActivity(snapshot), commands: extractCommandActivity(snapshot, roots) };
    const calls = new Map<string, { tool: JsonObject; at?: string }>();
    for (const request of snapshot.requests) {
        if (!object(request) || !Array.isArray(request.response)) { continue; }
        for (const tool of request.response) {
            if (object(tool) && tool.kind === 'toolInvocationSerialized' && tool.toolId === 'copilot_readFile' && typeof tool.toolCallId === 'string') {
                calls.set(tool.toolCallId, { tool, at: date(request.timestamp) });
            }
        }
    }
    for (const [id, { tool, at }] of calls) {
        if (tool.isComplete !== true || !object(tool.isConfirmed) || tool.isConfirmed.type !== 1 || tool.isError === true || tool.isCancelled === true) { continue; }
        session.recognizedCalls++;
        const message = object(tool.pastTenseMessage) ? tool.pastTenseMessage : tool.invocationMessage;
        if (!object(message) || typeof message.value !== 'string') { session.unmappedCalls++; continue; }
        const files = new Map<string, HistoryRead>();
        const links = [...message.value.matchAll(/\]\((file:\/\/[^\s)]+)\)/g)];
        const statedRange = links.length === 1 ? /,\s*lines (\d+) to (\d+)\s*$/i.exec(message.value) : null;
        for (const match of links) {
            try {
                const uri = new URL(match[1]!);
                if (uri.hostname && uri.hostname !== 'localhost') { continue; }
                const range = statedRange ?? /^#L(\d+)(?:-L?(\d+))?$/.exec(uri.hash);
                const filePath = fileURLToPath(uri);
                const root = roots.find(candidate => isWithin(candidate.directory, filePath));
                if (!root) { continue; }
                const relativePath = path.relative(root.directory, filePath).split(path.sep).join('/');
                if (!relativePath || excluded(relativePath)) { continue; }
                const read: HistoryRead = { id, rootId: root.id, relativePath, at };
                if (range) {
                    const startLine = Number(range[1]);
                    const endLine = Number(range[2] ?? range[1]);
                    if (Number.isSafeInteger(startLine) && startLine > 0 && Number.isSafeInteger(endLine) && endLine >= startLine) {
                        read.startLine = startLine; read.endLine = endLine;
                    }
                }
                files.set(`${root.id}/${relativePath}`, read);
            } catch { continue; }
        }
        if (!files.size) { session.unmappedCalls++; }
        session.events.push(...files.values());
        if (session.events.length > MAX_READS) { throw new Error('Chat has more than 10,000 supported file reads.'); }
    }
    return session;
}

async function readHistorySnapshot(file: string): Promise<JsonObject> {
    if (!sessionFile.test(path.basename(file))) { throw new Error('Select a JSON or JSONL chat session file.'); }
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) { throw new Error('Chat history must be a file no larger than 32 MiB.'); }
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) { break; }
            offset += bytesRead;
        }
        return replayHistory(buffer.subarray(0, offset).toString('utf8'), file.endsWith('.jsonl'));
    } finally { await handle.close(); }
}

export async function readHistory(file: string, roots: readonly Root[]): Promise<HistorySession> {
    const snapshot = await readHistorySnapshot(file);
    const session = extractHistory(snapshot, roots);
    session.changes = await readChangeActivity(file, snapshot, roots);
    return session;
}

export async function readHistoryChangePreview(file: string, roots: readonly Root[], key: string): Promise<ChangePreview | undefined> {
    return readChangePreview(file, await readHistorySnapshot(file), roots, key);
}

export async function readHistoryCommandPreview(file: string, callId: string): Promise<CommandPreview | undefined> {
    return extractCommandPreview(await readHistorySnapshot(file), callId);
}

export async function listHistory(folders: readonly string[], roots: readonly Root[] = [], currentHistoryFolder?: string): Promise<HistoryEntry[]> {
    const canonicalPaths = new Map<string, Promise<string>>();
    const canonical = (directory: string): Promise<string> => {
        const normalized = path.resolve(directory);
        let result = canonicalPaths.get(normalized);
        if (!result) {
            result = fs.realpath(normalized).catch(() => normalized)
                .then(value => process.platform === 'win32' ? value.toLowerCase() : value);
            canonicalPaths.set(normalized, result);
        }
        return result;
    };
    const currentRoots = new Set(await Promise.all(roots.map(root => canonical(root.directory))));
    const currentFolder = currentHistoryFolder ? await canonical(currentHistoryFolder) : undefined;
    const candidates: HistoryEntry[] = [];
    for (const folder of new Set(folders)) {
        let entries: import('node:fs').Dirent[];
        try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { continue; }
        const association = await workspaceAssociation(folder);
        const directories = await Promise.all(association.directories.map(directory => canonical(directory)));
        const isCurrent = currentFolder !== undefined && await canonical(folder) === currentFolder;
        const repositoryMatch = isCurrent || directories.some(directory => currentRoots.has(directory));
        const workspace = isCurrent && association.label === 'Unknown workspace' ? 'Current workspace' : association.label;
        for (const entry of entries) {
            if (!entry.isFile() || !sessionFile.test(entry.name)) { continue; }
            const file = path.join(folder, entry.name);
            const stat = await fs.stat(file).catch(() => undefined);
            if (!stat || stat.size > MAX_HISTORY_BYTES) { continue; }
            candidates.push({ file, label: `Chat ${entry.name.slice(0, 8)}`, updatedAt: stat.mtime.toISOString(), workspace, repositoryMatch });
        }
    }
    const grouped = groupHistory(candidates);
    const recent = [...grouped.repository, ...grouped.other];
    for (const entry of recent) {
        const handle = await fs.open(entry.file, 'r').catch(() => undefined);
        if (!handle) { continue; }
        try {
            const buffer = Buffer.alloc(MAX_HEADER_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            const end = entry.file.endsWith('.jsonl') ? text.indexOf('\n') : text.length;
            if (end < 0) { continue; }
            const record: unknown = JSON.parse(text.slice(0, end));
            const snapshot = object(record) && record.kind === 0 ? record.v : record;
            if (object(snapshot)) { entry.label = title(snapshot.customTitle, entry.label); }
        } catch { continue; } finally { await handle.close(); }
    }
    return recent;
}