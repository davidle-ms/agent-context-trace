import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { excluded, isWithin, Root } from './core';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_BLOBS_BYTES = 16 * 1024 * 1024;
const MAX_OPERATIONS = 5000;
const MAX_EDITS = 10000;
const MAX_TEXT_PREVIEW = 8192;

export interface ChangeHunk {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    addedLines: number;
    removedLines: number;
}

export interface ChangeHunkPreview extends ChangeHunk {
    removedText: string;
    addedText: string;
    previewTruncated: boolean;
}

export interface ChangeActivity {
    key: string;
    requestId: string;
    rootId: string;
    relativePath: string;
    at?: string;
    epoch: number;
    attribution: 'chat-edit-session';
    hunks: ChangeHunk[];
}

export interface ChangePreview {
    key: string;
    hunks: ChangeHunkPreview[];
}

function activityKey(epoch: number, requestId: string, identity: { rootId: string; relativePath: string }): string {
    return `${epoch}:${requestId}:${identity.rootId}/${identity.relativePath}`;
}

function date(value: unknown): string | undefined {
    if (typeof value !== 'number' && typeof value !== 'string') { return; }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function requestTimes(snapshot: JsonObject): Map<string, string | undefined> {
    const times = new Map<string, string | undefined>();
    if (!Array.isArray(snapshot.requests)) { return times; }
    for (const request of snapshot.requests) {
        if (object(request) && typeof request.requestId === 'string') { times.set(request.requestId, date(request.timestamp)); }
    }
    return times;
}

function fileIdentity(value: unknown, roots: readonly Root[]): { key: string; rootId: string; relativePath: string } | undefined {
    let filePath: string;
    try {
        if (typeof value === 'string') {
            const uri = new URL(value);
            if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost')) { return; }
            filePath = fileURLToPath(uri);
        } else if (object(value) && value.scheme === 'file' && typeof value.fsPath === 'string' && !/^[\\/]{2}/.test(value.fsPath)) {
            filePath = value.fsPath;
        } else { return; }
        const root = roots.find(candidate => isWithin(candidate.directory, filePath));
        if (!root) { return; }
        const relativePath = path.relative(root.directory, filePath).split(path.sep).join('/');
        if (!relativePath || excluded(relativePath)) { return; }
        return { key: `${root.id}\0${relativePath}`, rootId: root.id, relativePath };
    } catch { return; }
}

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index++) { if (text[index] === '\n') { starts.push(index + 1); } }
    return starts;
}

function offsetAt(text: string, starts: readonly number[], line: unknown, column: unknown): number | undefined {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || Number(line) < 1 || Number(column) < 1 || Number(line) > starts.length) { return; }
    const start = starts[Number(line) - 1]!;
    let end = Number(line) < starts.length ? starts[Number(line)]! - 1 : text.length;
    if (end > start && text[end - 1] === '\r') { end--; }
    const offset = start + Number(column) - 1;
    return offset <= end ? offset : undefined;
}

function preview(value: string): { text: string; truncated: boolean } {
    return value.length > MAX_TEXT_PREVIEW ? { text: value.slice(0, MAX_TEXT_PREVIEW), truncated: true } : { text: value, truncated: false };
}

function changedLines(text: string): number { return text ? text.split(/\r?\n/).length : 0; }

export function extractChangeActivity(state: unknown, snapshot: JsonObject, roots: readonly Root[]): ChangeActivity[] {
    if (!object(state) || !Array.isArray(state.initialFileContents) || !object(state.timeline) || !Array.isArray(state.timeline.operations)
        || state.timeline.operations.length > MAX_OPERATIONS) { return []; }
    const times = requestTimes(snapshot);
    const activity: ChangeActivity[] = [];
    let editCount = 0;
    for (const operation of state.timeline.operations) {
        if (!object(operation) || typeof operation.requestId !== 'string'
            || !Number.isSafeInteger(operation.epoch) || Number(operation.epoch) < 0) { continue; }
        const identity = fileIdentity(operation.uri, roots);
        if (!identity) { continue; }
        if (operation.type !== 'textEdit' || !Array.isArray(operation.edits) || !operation.edits.length) { continue; }
        editCount += operation.edits.length;
        if (editCount > MAX_EDITS) { return []; }
        const hunks: ChangeHunk[] = [];
        for (const edit of operation.edits) {
            if (!object(edit) || !object(edit.range) || typeof edit.text !== 'string'
                || ![edit.range.startLineNumber, edit.range.startColumn, edit.range.endLineNumber, edit.range.endColumn]
                    .every(value => Number.isSafeInteger(value) && Number(value) >= 1)
                || Number(edit.range.endLineNumber) < Number(edit.range.startLineNumber)) { continue; }
            const startLine = Number(edit.range.startLineNumber);
            const startColumn = Number(edit.range.startColumn);
            const endLine = Number(edit.range.endLineNumber);
            const endColumn = Number(edit.range.endColumn);
            hunks.push({
                startLine: Number(edit.range.startLineNumber), startColumn: Number(edit.range.startColumn),
                endLine: Number(edit.range.endLineNumber), endColumn: Number(edit.range.endColumn),
                addedLines: changedLines(edit.text), removedLines: startLine === endLine
                    ? (startColumn === endColumn ? 0 : 1) : endLine - startLine + (endColumn > 1 ? 1 : 0)
            });
        }
        if (!hunks.length) { continue; }
        activity.push({ key: activityKey(Number(operation.epoch), operation.requestId, identity), requestId: operation.requestId,
            rootId: identity.rootId, relativePath: identity.relativePath, at: times.get(operation.requestId), epoch: Number(operation.epoch),
            attribution: 'chat-edit-session', hunks });
    }
    return activity;
}

async function editingState(historyFile: string, snapshot: JsonObject): Promise<{ folder: string; state: JsonObject } | undefined> {
    if (typeof snapshot.sessionId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(snapshot.sessionId)
        || path.basename(path.dirname(historyFile)).toLowerCase() !== 'chatsessions') { return; }
    const folder = path.join(path.dirname(path.dirname(historyFile)), 'chatEditingSessions', snapshot.sessionId);
    const stateFile = path.join(folder, 'state.json');
    const stat = await fs.stat(stateFile).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_STATE_BYTES) { return; }
    let state: unknown;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { return; }
    return object(state) ? { folder, state } : undefined;
}

export async function readChangeActivity(historyFile: string, snapshot: JsonObject, roots: readonly Root[]): Promise<ChangeActivity[]> {
    const editing = await editingState(historyFile, snapshot);
    return editing ? extractChangeActivity(editing.state, snapshot, roots) : [];
}

function extractChangePreviews(state: JsonObject, snapshots: ReadonlyMap<string, string>, snapshot: JsonObject,
    roots: readonly Root[]): ChangePreview[] {
    const metadata = new Map(extractChangeActivity(state, snapshot, roots).map(item => [item.key, item]));
    if (!Array.isArray(state.initialFileContents) || !object(state.timeline) || !Array.isArray(state.timeline.operations)) { return []; }
    const current = new Map<string, string>();
    for (const entry of state.initialFileContents) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== 'string') { continue; }
        const identity = fileIdentity(entry[0], roots);
        const content = snapshots.get(entry[1]);
        if (identity && content !== undefined) { current.set(identity.key, content); }
    }
    const previews: ChangePreview[] = [];
    for (const operation of state.timeline.operations) {
        if (!object(operation) || typeof operation.requestId !== 'string' || !Number.isSafeInteger(operation.epoch)) { continue; }
        const identity = fileIdentity(operation.uri, roots);
        if (!identity) { continue; }
        if (operation.type === 'create' && typeof operation.initialContent === 'string') {
            const content = snapshots.get(operation.initialContent);
            if (content !== undefined) { current.set(identity.key, content); }
            continue;
        }
        if (operation.type !== 'textEdit' || !Array.isArray(operation.edits)) { continue; }
        const key = activityKey(Number(operation.epoch), operation.requestId, identity);
        const activity = metadata.get(key);
        const before = current.get(identity.key);
        if (!activity || before === undefined) { continue; }
        const starts = lineStarts(before);
        const prepared: { start: number; end: number; text: string; hunk: ChangeHunkPreview }[] = [];
        let valid = true;
        for (let index = 0; index < operation.edits.length; index++) {
            const edit = operation.edits[index];
            if (!object(edit) || !object(edit.range) || typeof edit.text !== 'string') { valid = false; break; }
            const start = offsetAt(before, starts, edit.range.startLineNumber, edit.range.startColumn);
            const end = offsetAt(before, starts, edit.range.endLineNumber, edit.range.endColumn);
            if (start === undefined || end === undefined || end < start || !activity.hunks[index]) { valid = false; break; }
            const removed = preview(before.slice(start, end));
            const added = preview(edit.text);
            prepared.push({ start, end, text: edit.text, hunk: { ...activity.hunks[index]!, removedText: removed.text,
                addedText: added.text, previewTruncated: removed.truncated || added.truncated } });
        }
        prepared.sort((left, right) => left.start - right.start || left.end - right.end);
        if (!valid || prepared.some((edit, index) => index > 0 && edit.start < prepared[index - 1]!.end)) { continue; }
        let after = before;
        for (const edit of [...prepared].reverse()) { after = after.slice(0, edit.start) + edit.text + after.slice(edit.end); }
        current.set(identity.key, after);
        previews.push({ key, hunks: prepared.map(edit => edit.hunk) });
    }
    return previews;
}

export async function readChangePreview(historyFile: string, snapshot: JsonObject, roots: readonly Root[], key: string): Promise<ChangePreview | undefined> {
    const editing = await editingState(historyFile, snapshot);
    if (!editing) { return; }
    const state = editing.state;
    const target = extractChangeActivity(state, snapshot, roots).find(item => item.key === key);
    if (!target) { return; }
    const targetKey = `${target.rootId}\0${target.relativePath}`;
    const hashes = new Set<string>();
    for (const entry of Array.isArray(state.initialFileContents) ? state.initialFileContents : []) {
        if (Array.isArray(entry) && typeof entry[1] === 'string' && fileIdentity(entry[0], roots)?.key === targetKey) { hashes.add(entry[1]); }
    }
    if (object(state.timeline) && Array.isArray(state.timeline.operations)) {
        for (const operation of state.timeline.operations) {
            if (object(operation) && operation.type === 'create' && typeof operation.initialContent === 'string'
                && fileIdentity(operation.uri, roots)?.key === targetKey) { hashes.add(operation.initialContent); }
        }
    }
    const snapshots = new Map<string, string>();
    let total = 0;
    for (const hash of hashes) {
        if (!/^[a-f0-9]{7,64}$/i.test(hash)) { continue; }
        const file = path.join(editing.folder, 'contents', hash);
        const blob = await fs.lstat(file).catch(() => undefined);
        if (!blob?.isFile() || blob.size > MAX_BLOB_BYTES || total + blob.size > MAX_BLOBS_BYTES) { continue; }
        snapshots.set(hash, await fs.readFile(file, 'utf8'));
        total += blob.size;
    }
    return extractChangePreviews(state, snapshots, snapshot, roots).find(item => item.key === key);
}