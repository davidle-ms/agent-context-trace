import { excluded } from './core';
import { isUtf8 } from 'node:buffer';
import { marked, type Tokens } from 'marked';
import type { WorkItemActivity } from './work-items';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 500): string | undefined => typeof value === 'string' && value.trim()
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : undefined;
const MAX_PREVIEW_CHARS = 16384;
const MAX_SESSION_PREVIEW_CHARS = 512 * 1024;

export interface SearchMatch {
    path?: string;
    repository?: string;
    project?: string;
    branch?: string;
    revision?: string;
    lines: number[];
    snippetsAvailable: boolean;
}

export interface ResourceActivity {
    callId: string;
    toolId: string;
    server: string;
    kind: 'repository' | 'wiki' | 'search' | 'logs';
    operation: 'get_content' | 'get_page' | 'search';
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
    evidence: 'none' | 'metadata' | 'content' | 'text-response' | 'search-matches' | 'log-content';
    query?: string;
    scope?: { projects: string[]; repositories: string[]; paths: string[]; branches: string[] };
    skip?: number;
    top?: number;
    matches?: SearchMatch[];
    returnedMatches?: number;
    reportedMatches?: number;
    matchesTruncated?: boolean;
    searchInfoCode?: number;
    buildId?: number;
    logId?: number;
    requestedLogRange?: { startLine?: number; endLine?: number };
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

function savedResponseText(block: unknown): string | undefined {
    if (!object(block) || typeof block.value !== 'string' || block.value.length > 2 * 1024 * 1024) { return; }
    if (block.isText === true) { return block.value; }
    if (block.type !== 'embed' || block.isText !== false || block.asResource !== true || typeof block.mimeType !== 'string'
        || !['text/plain', 'text/markdown', 'application/json'].includes(block.mimeType.split(';')[0]!.trim().toLowerCase())) { return; }
    const bytes = Buffer.from(block.value, 'base64');
    if (bytes.toString('base64') !== block.value || !isUtf8(bytes)) { return; }
    return bytes.toString('utf8');
}

const nonnegative = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const scopeValues = (value: unknown): string[] => (Array.isArray(value) ? value.slice(0, 50) : [value])
    .map(item => text(item)).filter((item): item is string => item !== undefined);

function searchResult(entry: ResourceActivity, result: unknown): { content?: string } | undefined {
    if (!object(result) || result.isError === true || result.error || !Array.isArray(result.results)) { return; }
    entry.matches = [];
    entry.returnedMatches = result.results.length;
    entry.reportedMatches = nonnegative(result.count);
    entry.searchInfoCode = nonnegative(result.infoCode);
    entry.matchesTruncated = result.results.length > 200;
    const previews: string[] = [];
    let remaining = MAX_PREVIEW_CHARS + 1;
    for (const match of result.results.slice(0, 200)) {
        if (!object(match)) { continue; }
        const locations = object(match.matches) && Array.isArray(match.matches.content) ? match.matches.content : [];
        const version = Array.isArray(match.versions) && object(match.versions[0]) ? match.versions[0] : {};
        const path = text(match.path);
        const item: SearchMatch = { path, repository: object(match.repository) ? text(match.repository.name ?? match.repository.id) : undefined,
            project: object(match.project) ? text(match.project.name ?? match.project.id) : undefined,
            branch: text(version.branchName), revision: text(version.changeId),
            lines: [...new Set(locations.slice(0, 100).filter(object).map(location => positive(location.line))
                .filter((line): line is number => line !== undefined))], snippetsAvailable: false };
        if (locations.length > 100) { entry.matchesTruncated = true; }
        const snippets = [match.snippet, ...locations.slice(0, 100).filter(object).map(location => location.snippet)]
            .filter((snippet): snippet is string => typeof snippet === 'string' && !snippet.includes('\0'));
        if (snippets.length && !excluded(path ?? '')) {
            item.snippetsAvailable = true;
            if (remaining > 0) {
                const heading = `Search snippets only: ${item.repository ?? 'Repository unavailable'} ${path ?? 'Path unavailable'}\n`;
                const excerpt = (heading + snippets.map(snippet => snippet.slice(0, MAX_PREVIEW_CHARS + 1)).join('\n')).slice(0, remaining);
                previews.push(excerpt); remaining -= excerpt.length;
            }
        }
        entry.matches.push(item);
    }
    if (entry.matches.length !== Math.min(result.results.length, 200)) { entry.matchesTruncated = true; }
    entry.evidence = 'search-matches';
    return { content: previews.length ? previews.join('\n\n') : undefined };
}

function logResult(entry: ResourceActivity, result: unknown, savedText: string): { content: string } | undefined {
    let content: string | undefined;
    if (object(result)) {
        if (result.isError === true || result.error || result.buildId !== undefined && result.buildId !== entry.buildId
            || result.logId !== undefined && result.logId !== entry.logId) { return; }
        const lines = Array.isArray(result.lines) ? result.lines : Array.isArray(result.value) ? result.value : undefined;
        content = typeof result.content === 'string' ? result.content
            : lines?.every(line => typeof line === 'string') ? lines.join('\n') : undefined;
        if (content === undefined) { return; }
        if (typeof result.content !== 'string') { entry.responseLines = lines!.length; }
        const startLine = nonnegative(result.startLine), endLine = nonnegative(result.endLine);
        if (startLine !== undefined && endLine !== undefined && endLine >= startLine) { entry.range = { startLine, endLine }; }
        const link = resourceLink(result.webUrl ?? result.url, 'logs');
        if (link && new URL(link).searchParams.get('buildId') === String(entry.buildId)) { entry.url = link; }
    } else if (Array.isArray(result)) {
        if (!result.every(line => typeof line === 'string')) { return; }
        content = result.join('\n');
        entry.responseLines = result.length;
    } else if (typeof result === 'string') { content = result; }
    else if (result === undefined && !/^\s*[\[{]/.test(savedText)) { content = savedText; }
    if (content === undefined) { return; }
    entry.evidence = 'log-content';
    return { content };
}

export function resourceLink(value: unknown, kind: ResourceActivity['kind']): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) { return; }
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !(url.hostname === 'dev.azure.com' || /^[a-z0-9-]+\.visualstudio\.com$/i.test(url.hostname))) { return; }
        const segments = url.pathname.split('/').filter(Boolean);
        if (kind === 'search') { return; }
        if (kind === 'logs') {
            if (!url.pathname.endsWith('/_build/results') || !/^[1-9]\d*$/.test(url.searchParams.get('buildId') ?? '')) { return; }
        } else if (kind === 'repository' ? !segments.includes('_git') : !segments.includes('_wiki') || !segments.includes('wikis')) { return; }
        const original = new URLSearchParams(url.search);
        url.search = ''; url.hash = '';
        for (const key of kind === 'logs' ? ['buildId'] : kind === 'repository' ? ['path', 'version'] : ['pagePath']) {
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
                || typeof tool.toolId !== 'string' || !/^mcp_azuredevops_[^_]+_(repo_file|wiki|search_code|pipelines_build_log)$/.test(tool.toolId)
                || !object(tool.source) || tool.source.type !== 'mcp') { continue; }
            const timestamp = typeof request.timestamp === 'number' || typeof request.timestamp === 'string' ? new Date(request.timestamp) : undefined;
            calls.set(tool.toolCallId, { tool, at: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined });
            if (calls.size > 5000) { throw new Error('Chat has more than 5,000 supported external-resource calls.'); }
        }
    }
    let remainingPreview = MAX_SESSION_PREVIEW_CHARS;
    const activities: ResourceActivity[] = [];
    for (const [callId, { tool, at }] of calls) {
        const details = object(tool.resultDetails) ? tool.resultDetails : {};
        const specific = object(tool.toolSpecificData) ? tool.toolSpecificData : {};
        const input = parse(specific.rawInput) ?? parse(details.input);
        if (!object(input)) { continue; }
        const toolId = tool.toolId as string;
        const kind = toolId.endsWith('_repo_file') ? 'repository' : toolId.endsWith('_search_code') ? 'search'
            : toolId.endsWith('_pipelines_build_log') ? 'logs' : 'wiki';
        const operation = kind === 'search' ? 'search' : kind === 'wiki' ? 'get_page' : 'get_content';
        if (kind !== 'search' && input.action !== operation) { continue; }
        const source = tool.source as JsonObject;
        const entry: ResourceActivity = { callId, toolId: tool.toolId as string, server: text(source.serverLabel) ?? 'Azure DevOps MCP',
            kind, operation, project: text(input.project), resource: text(kind === 'repository' ? input.repositoryId : input.wikiIdentifier),
            requestedPath: text(input.path), requestedVersion: text(input.version), versionType: text(input.versionType), at,
            requestedUrl: resourceLink(input.url, kind),
            outcome: tool.isCancelled === true || object(tool.isConfirmed) && tool.isConfirmed.type !== 1 ? 'cancelled'
                : tool.isComplete !== true || !object(tool.isConfirmed) ? 'pending'
                    : tool.isError === true || details.isError === true ? 'failed' : 'unavailable', evidence: 'none', sections: [] };
        if (kind === 'search') {
            entry.query = text(input.searchText, 2000);
            entry.scope = { projects: scopeValues(input.project), repositories: scopeValues(input.repository), paths: scopeValues(input.path), branches: scopeValues(input.branch) };
            entry.skip = nonnegative(input.skip); entry.top = nonnegative(input.top);
        } else if (kind === 'logs') {
            entry.buildId = positive(input.buildId); entry.logId = positive(input.logId);
            entry.requestedLogRange = { startLine: nonnegative(input.startLine), endLine: nonnegative(input.endLine) };
        }
        let content: string | undefined;
        if (entry.outcome === 'unavailable' && Array.isArray(details.output)) {
            for (const block of details.output.slice(0, 20)) {
                const savedText = savedResponseText(block);
                if (savedText === undefined) { continue; }
                const result = parse(savedText);
                if (kind === 'search' || kind === 'logs') {
                    const extracted = kind === 'search' ? searchResult(entry, result) : logResult(entry, result, savedText);
                    if (!extracted) { continue; }
                    content = extracted.content; entry.outcome = 'returned'; break;
                }
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
                } else if (Array.isArray(result) || /^[\s]*[\[{]/.test(savedText) && result === undefined) {
                    continue;
                } else {
                    content = typeof result === 'string' ? result : savedText;
                    entry.evidence = 'text-response';
                }
                entry.outcome = 'returned';
                break;
            }
        }
        if (content !== undefined) {
            entry.responseLines ??= content.length ? content.split(/\r\n|\n|\r/).length : 0;
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