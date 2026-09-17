import { excluded } from './core';
import { marked, type Tokens } from 'marked';
import type { WorkItemActivity } from './work-items';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 500): string | undefined => typeof value === 'string' && value.trim()
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : undefined;
const MAX_PREVIEW_CHARS = 16384;
const MAX_SESSION_PREVIEW_CHARS = 512 * 1024;

export interface ResourceActivity {
    callId: string;
    toolId: string;
    server: string;
    kind: 'repository' | 'wiki';
    operation: 'get_content' | 'get_page';
    project?: string;
    resource?: string;
    requestedPath?: string;
    requestedUrl?: string;
    returnedPath?: string;
    requestedVersion?: string;
    versionType?: string;
    returnedRevision?: string;
    title?: string;
    at?: string;
    outcome: WorkItemActivity['outcome'];
    evidence: 'none' | 'metadata' | 'content' | 'text-response';
    responseLines?: number;
    range?: { startLine: number; endLine: number };
    sections: { title: string; startLine?: number; endLine?: number }[];
    sectionSource?: 'response metadata' | 'returned Markdown headings';
    url?: string;
    preview?: string;
    previewTruncated?: boolean;
    previewUnavailable?: string;
}

function parse(value: unknown): unknown {
    if (object(value)) { return value; }
    if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) { return; }
    try { return JSON.parse(value); } catch { return; }
}

function rangeOf(value: JsonObject): ResourceActivity['range'] {
    const startLine = value.startLine;
    const endLine = value.endLine;
    return typeof startLine === 'number' && typeof endLine === 'number' && Number.isSafeInteger(startLine)
        && Number.isSafeInteger(endLine) && startLine > 0 && endLine >= startLine ? { startLine, endLine } : undefined;
}

export function resourceLink(value: unknown, kind: ResourceActivity['kind']): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) { return; }
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !(url.hostname === 'dev.azure.com' || /^[a-z0-9-]+\.visualstudio\.com$/i.test(url.hostname))) { return; }
        const segments = url.pathname.split('/').filter(Boolean);
        if (kind === 'repository' ? !segments.includes('_git') : !segments.includes('_wiki') || !segments.includes('wikis')) { return; }
        const original = new URLSearchParams(url.search);
        url.search = ''; url.hash = '';
        for (const key of kind === 'repository' ? ['path', 'version'] : ['pagePath']) {
            const item = original.get(key);
            if (item && item.length <= 500) { url.searchParams.set(key, item); }
        }
        return url.toString();
    } catch { return; }
}

export function extractResourceActivity(snapshot: JsonObject): ResourceActivity[] {
    const calls = new Map<string, { tool: JsonObject; at?: string }>();
    for (const request of Array.isArray(snapshot.requests) ? snapshot.requests : []) {
        if (!object(request) || !Array.isArray(request.response)) { continue; }
        for (const tool of request.response) {
            if (!object(tool) || tool.kind !== 'toolInvocationSerialized' || typeof tool.toolCallId !== 'string'
                || typeof tool.toolId !== 'string' || !/^mcp_azuredevops_[^_]+_(repo_file|wiki)$/.test(tool.toolId)
                || !object(tool.source) || tool.source.type !== 'mcp') { continue; }
            const timestamp = typeof request.timestamp === 'number' || typeof request.timestamp === 'string' ? new Date(request.timestamp) : undefined;
            calls.set(tool.toolCallId, { tool, at: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined });
            if (calls.size > 5000) { throw new Error('Chat has more than 5,000 supported repository/wiki calls.'); }
        }
    }
    let remainingPreview = MAX_SESSION_PREVIEW_CHARS;
    const activities: ResourceActivity[] = [];
    for (const [callId, { tool, at }] of calls) {
        const details = object(tool.resultDetails) ? tool.resultDetails : {};
        const specific = object(tool.toolSpecificData) ? tool.toolSpecificData : {};
        const input = parse(specific.rawInput) ?? parse(details.input);
        if (!object(input)) { continue; }
        const kind = (tool.toolId as string).endsWith('_repo_file') ? 'repository' : 'wiki';
        const operation = kind === 'repository' ? 'get_content' : 'get_page';
        if (input.action !== operation) { continue; }
        const source = tool.source as JsonObject;
        const entry: ResourceActivity = { callId, toolId: tool.toolId as string, server: text(source.serverLabel) ?? 'Azure DevOps MCP',
            kind, operation, project: text(input.project), resource: text(kind === 'repository' ? input.repositoryId : input.wikiIdentifier),
            requestedPath: text(input.path), requestedVersion: text(input.version), versionType: text(input.versionType), at,
            requestedUrl: resourceLink(input.url, kind),
            outcome: tool.isCancelled === true || object(tool.isConfirmed) && tool.isConfirmed.type !== 1 ? 'cancelled'
                : tool.isComplete !== true || !object(tool.isConfirmed) ? 'pending'
                    : tool.isError === true || details.isError === true ? 'failed' : 'unavailable', evidence: 'none', sections: [] };
        let content: string | undefined;
        if (entry.outcome === 'unavailable' && Array.isArray(details.output)) {
            for (const block of details.output.slice(0, 20)) {
                if (!object(block) || block.isText !== true || typeof block.value !== 'string' || block.value.length > 2 * 1024 * 1024) { continue; }
                const result = parse(block.value);
                if (object(result)) {
                    if (result.isError === true || result.error || result.isFolder === true
                        || typeof result.path === 'string' && typeof input.path === 'string' && result.path !== input.path) { continue; }
                    if (kind === 'repository' && object(result.repository) && result.repository.id && input.repositoryId
                        && /^[a-f0-9-]{36}$/i.test(String(input.repositoryId)) && result.repository.id !== input.repositoryId) { continue; }
                    if (typeof result.content !== 'string' && typeof result.path !== 'string') { continue; }
                    entry.returnedPath = text(result.path);
                    entry.returnedRevision = text(result.commitId ?? result.eTag ?? result.etag);
                    entry.title = text(result.title);
                    entry.range = rangeOf(result);
                    entry.url = resourceLink(result.remoteUrl ?? result.webUrl ?? result.url, kind);
                    if (Array.isArray(result.sections)) {
                        entry.sections = result.sections.slice(0, 100).filter(object).filter(section => !!text(section.title))
                            .map(section => ({ title: text(section.title)!, ...rangeOf(section) }));
                        entry.sectionSource = 'response metadata';
                    }
                    content = typeof result.content === 'string' ? result.content : undefined;
                    entry.evidence = content === undefined ? 'metadata' : 'content';
                } else if (Array.isArray(result) || /^[\s]*[\[{]/.test(block.value) && result === undefined) {
                    continue;
                } else {
                    content = typeof result === 'string' ? result : block.value;
                    entry.evidence = 'text-response';
                }
                entry.outcome = 'returned';
                break;
            }
        }
        if (content !== undefined) {
            entry.responseLines = content.length ? content.split(/\r\n|\n|\r/).length : 0;
            if (kind === 'wiki' && entry.evidence === 'content' && !entry.sections.length && content.length <= 128 * 1024) {
                const headings = marked.lexer(content).filter((token): token is Tokens.Heading => token.type === 'heading');
                entry.sections = headings.slice(0, 100).map(heading => ({ title: text(heading.text)! })).filter(section => !!section.title);
                entry.sectionSource = 'returned Markdown headings';
                entry.title ??= text(headings.find(heading => heading.depth === 1)?.text);
            }
            if (excluded(entry.requestedPath ?? '') || excluded(entry.returnedPath ?? '')) {
                entry.previewUnavailable = 'Preview withheld for an excluded credential path';
            } else if (content.includes('\0')) {
                entry.previewUnavailable = 'Binary response preview unavailable';
            } else if (remainingPreview <= 0) {
                entry.previewUnavailable = 'Session preview limit reached';
            } else {
                const limit = Math.min(MAX_PREVIEW_CHARS, remainingPreview);
                entry.preview = content.slice(0, limit);
                entry.previewTruncated = content.length > limit;
                remainingPreview -= entry.preview.length;
            }
        }
        activities.push(entry);
    }
    return activities;
}

export function resourceMetadata(entries: readonly ResourceActivity[]): (Omit<ResourceActivity, 'preview'> & { previewAvailable: boolean })[] {
    return entries.map(({ preview, ...entry }) => ({ ...entry, previewAvailable: preview !== undefined }));
}

export function redactResourceActivity(session: { resources?: ResourceActivity[] }, redact: boolean): void {
    if (redact) { delete session.resources; }
    else if (session.resources) { session.resources = session.resources.map(({ preview, ...entry }) => entry); }
}