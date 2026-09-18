import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithin, Root } from './core';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_COMMANDS = 5000;
const MAX_COMMAND_CHARS = 16384;

export interface CommandActivity {
    callId: string;
    at?: string;
    sequence: number;
    summary: string;
    cwd?: string;
    language?: string;
    background: boolean;
    durationMs?: number;
    exitCode?: number;
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'pending' | 'unavailable';
    commandAvailable: boolean;
}

export interface CommandPreview {
    callId: string;
    command: string;
    truncated: boolean;
}

function text(value: unknown, limit: number): string | undefined {
    return typeof value === 'string' && value.trim() && !value.includes('\0')
        ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, limit) : undefined;
}

function date(value: unknown): string | undefined {
    if (typeof value !== 'number' && typeof value !== 'string') { return; }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function localPath(value: unknown): string | undefined {
    if (!object(value) || value.scheme !== 'file') { return; }
    if (typeof value.fsPath === 'string' && !/^[\\/]{2}/.test(value.fsPath)) { return value.fsPath; }
    const uriValue = typeof value.external === 'string' ? value.external
        : typeof value.path === 'string' && value.path.startsWith('/') ? `file://${value.path}` : undefined;
    if (uriValue) {
        try {
            const uri = new URL(uriValue);
            if (uri.protocol === 'file:' && (!uri.hostname || uri.hostname === 'localhost')) { return fileURLToPath(uri); }
        } catch { return; }
    }
    return;
}

function cwd(value: unknown, roots: readonly Root[]): string | undefined {
    const directory = localPath(value);
    if (!directory) { return; }
    const root = roots.find(candidate => isWithin(candidate.directory, directory));
    if (!root) { return 'Outside workspace'; }
    const relative = path.relative(root.directory, directory).split(path.sep).join('/');
    return relative ? `${root.name}/${relative}` : root.name;
}

function command(value: unknown): string | undefined {
    if (!object(value) || !object(value.toolSpecificData) || !object(value.toolSpecificData.commandLine)) { return; }
    return text(value.toolSpecificData.commandLine.forDisplay, MAX_COMMAND_CHARS);
}

function score(value: JsonObject): number {
    const data = object(value.toolSpecificData) ? value.toolSpecificData : undefined;
    return (object(data?.commandLine) ? 2 : 0) + (object(data?.terminalCommandState) ? 4 : 0)
        + (value.isCancelled === true || value.isError === true ? 8 : 0);
}

function calls(snapshot: JsonObject): { tool: JsonObject; requestAt?: string; sequence: number }[] {
    if (!Array.isArray(snapshot.requests)) { return []; }
    const found = new Map<string, { tool: JsonObject; requestAt?: string; sequence: number }>();
    let sequence = 0;
    for (const request of snapshot.requests) {
        if (!object(request) || !Array.isArray(request.response)) { continue; }
        const requestAt = date(request.timestamp);
        for (const tool of request.response) {
            if (!object(tool) || tool.kind !== 'toolInvocationSerialized' || tool.toolId !== 'run_in_terminal'
                || typeof tool.toolCallId !== 'string') { continue; }
            const existing = found.get(tool.toolCallId);
            if (!existing) {
                if (found.size >= MAX_COMMANDS) { return []; }
                found.set(tool.toolCallId, { tool, requestAt, sequence: sequence++ });
            } else if (score(tool) >= score(existing.tool)) { existing.tool = tool; existing.requestAt = requestAt ?? existing.requestAt; }
        }
    }
    return [...found.values()];
}

export function extractCommandActivity(snapshot: JsonObject, roots: readonly Root[]): CommandActivity[] {
    const activity: CommandActivity[] = [];
    for (const { tool, requestAt, sequence } of calls(snapshot)) {
        const data = object(tool.toolSpecificData) ? tool.toolSpecificData : undefined;
        const state = object(data?.terminalCommandState) ? data.terminalCommandState : undefined;
        const exitCode = typeof state?.exitCode === 'number' && Number.isSafeInteger(state.exitCode) ? state.exitCode : undefined;
        const durationMs = typeof state?.duration === 'number' && Number.isFinite(state.duration) && state.duration >= 0
            ? Math.round(state.duration) : undefined;
        const language = text(data?.language, 40);
        const outcome = tool.isCancelled === true ? 'cancelled' : tool.isError === true || exitCode !== undefined && exitCode !== 0 ? 'failed'
            : tool.isComplete !== true ? 'pending' : exitCode === 0 ? 'succeeded' : 'unavailable';
        activity.push({ callId: tool.toolCallId as string, at: date(state?.timestamp) ?? requestAt, sequence,
            summary: language ? `${language} command` : 'Terminal command', cwd: cwd(data?.cwd, roots), language,
            background: data?.isBackground === true, durationMs, exitCode, outcome, commandAvailable: command(tool) !== undefined });
    }
    return activity;
}

export function extractCommandPreview(snapshot: JsonObject, callId: string): CommandPreview | undefined {
    const saved = calls(snapshot).find(item => item.tool.toolCallId === callId)?.tool;
    const value = saved && command(saved);
    if (!value) { return; }
    const data = saved.toolSpecificData as JsonObject;
    const line = (data.commandLine as JsonObject).forDisplay as string;
    return { callId, command: value, truncated: line.trim().length > MAX_COMMAND_CHARS };
}