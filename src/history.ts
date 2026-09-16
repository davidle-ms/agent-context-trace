import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { excluded, isWithin, Root } from './core';

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
}
export interface HistoryEntry { file: string; label: string; updatedAt: string; workspace: string }

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
        createdAt: date(snapshot.creationDate) ?? '', coverage: 'copilot-history-read-metadata', events: [], recognizedCalls: 0, unmappedCalls: 0 };
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
        for (const match of message.value.matchAll(/\]\((file:\/\/[^\s)]+)\)/g)) {
            try {
                const uri = new URL(match[1]!);
                if (uri.hostname && uri.hostname !== 'localhost') { continue; }
                const range = /^#L(\d+)(?:-L?(\d+))?$/.exec(uri.hash);
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

export async function readHistory(file: string, roots: readonly Root[]): Promise<HistorySession> {
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
        return extractHistory(replayHistory(buffer.subarray(0, offset).toString('utf8'), file.endsWith('.jsonl')), roots);
    } finally { await handle.close(); }
}

export async function listHistory(folders: readonly string[]): Promise<HistoryEntry[]> {
    const candidates: HistoryEntry[] = [];
    for (const folder of new Set(folders)) {
        let entries: import('node:fs').Dirent[];
        try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (!entry.isFile() || !sessionFile.test(entry.name)) { continue; }
            const file = path.join(folder, entry.name);
            const stat = await fs.stat(file).catch(() => undefined);
            if (!stat || stat.size > MAX_HISTORY_BYTES) { continue; }
            candidates.push({ file, label: `Chat ${entry.name.slice(0, 8)}`, updatedAt: stat.mtime.toISOString(), workspace: path.basename(path.dirname(folder)) });
        }
    }
    const recent = candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 100);
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