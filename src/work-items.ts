type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const shortText = (value: unknown): string | undefined => typeof value === 'string' && value.trim()
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 240) : undefined;

export interface WorkItemActivity {
    callId: string;
    toolId: string;
    server: string;
    operation: 'get' | 'get_batch' | 'list_comments';
    itemId?: number;
    project?: string;
    title?: string;
    revision?: number;
    url?: string;
    requestedFields: string[];
    returnedFields: string[];
    commentIds?: number[];
    returnedComments?: number;
    outcome: 'returned' | 'unavailable' | 'failed' | 'cancelled' | 'pending';
    at?: string;
}

export function workItemLink(value: unknown, itemId: number): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) { return; }
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !(url.hostname === 'dev.azure.com' || /^[a-z0-9-]+\.visualstudio\.com$/i.test(url.hostname))) { return; }
        const segments = url.pathname.split('/').filter(Boolean);
        const restIndex = segments.indexOf('_apis');
        const webIndex = segments.indexOf('_workitems');
        const minimum = url.hostname === 'dev.azure.com' ? 1 : 0;
        if (restIndex >= minimum && segments[restIndex + 1]?.toLowerCase() === 'wit'
            && segments[restIndex + 2]?.toLowerCase() === 'workitems' && segments[restIndex + 3] === String(itemId)) {
            url.pathname = '/' + [...segments.slice(0, restIndex), '_workitems', 'edit', String(itemId)].join('/');
        } else if (!(webIndex >= minimum && segments[webIndex + 1] === 'edit' && segments[webIndex + 2] === String(itemId)
            && segments.length === webIndex + 3)) { return; }
        url.search = ''; url.hash = '';
        return url.toString();
    } catch { return; }
}

function jsonObject(value: unknown): JsonObject | undefined {
    if (object(value)) { return value; }
    if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) { return; }
    try { const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : undefined; } catch { return; }
}

function fieldNames(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === 'string'
        && /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(name)))].slice(0, 200) : [];
}

export function extractWorkItemActivity(snapshot: JsonObject): WorkItemActivity[] {
    const calls = new Map<string, { tool: JsonObject; at?: string }>();
    if (!Array.isArray(snapshot.requests)) { return []; }
    for (const request of snapshot.requests) {
        if (!object(request) || !Array.isArray(request.response)) { continue; }
        for (const tool of request.response) {
            if (!object(tool) || tool.kind !== 'toolInvocationSerialized' || typeof tool.toolCallId !== 'string'
                || typeof tool.toolId !== 'string' || !/^mcp_azuredevops_[a-zA-Z0-9_]+_wit_(?:work_item|get_work_item)$/.test(tool.toolId)
                || !object(tool.source) || tool.source.type !== 'mcp') { continue; }
            const timestamp = typeof request.timestamp === 'string' || typeof request.timestamp === 'number' ? new Date(request.timestamp) : undefined;
            calls.set(tool.toolCallId, { tool, at: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined });
            if (calls.size > 5000) { throw new Error('Chat has more than 5,000 supported work-item calls.'); }
        }
    }
    const activities: WorkItemActivity[] = [];
    for (const [callId, { tool, at }] of calls) {
        const details = object(tool.resultDetails) ? tool.resultDetails : {};
        const specific = object(tool.toolSpecificData) ? tool.toolSpecificData : {};
        const input = jsonObject(specific.rawInput) ?? jsonObject(details.input);
        const toolId = tool.toolId as string;
        if (!input) { continue; }
        const operation = toolId.endsWith('_get_work_item') ? 'get' : input.action;
        if (operation !== 'get' && operation !== 'get_batch' && operation !== 'list_comments') { continue; }
        const source = tool.source as JsonObject;
        const ids: (number | undefined)[] = operation === 'get_batch' && Array.isArray(input.ids)
            ? [...new Set(input.ids.map(positiveId).filter((id): id is number => id !== undefined))].slice(0, 200)
            : [positiveId(operation === 'list_comments' ? input.workItemId : input.id)];
        if (!ids.length) { ids.push(undefined); }
        const results: unknown[] = [];
        if (Array.isArray(details.output)) {
            for (const block of details.output.slice(0, 20)) {
                if (!object(block) || block.isText !== true || typeof block.value !== 'string' || block.value.length > 2 * 1024 * 1024) { continue; }
                let parsed: unknown;
                try { parsed = JSON.parse(block.value); } catch { continue; }
                if (operation === 'get_batch') {
                    const items = Array.isArray(parsed) ? parsed : object(parsed) && Array.isArray(parsed.value) ? parsed.value : [];
                    results.push(...items.slice(0, 200));
                } else { results.push(parsed); }
            }
        }
        for (const itemId of ids) {
            const activity: WorkItemActivity = { callId, toolId, server: shortText(source.serverLabel) ?? 'Azure DevOps MCP',
                operation, itemId, project: shortText(input.project), requestedFields: fieldNames(input.fields), returnedFields: [],
                outcome: tool.isCancelled === true || object(tool.isConfirmed) && tool.isConfirmed.type !== 1 ? 'cancelled'
                    : tool.isComplete !== true || !object(tool.isConfirmed) ? 'pending' : tool.isError === true || details.isError === true ? 'failed' : 'unavailable', at };
            if (activity.outcome === 'unavailable') {
                for (const result of results) {
                    if (operation === 'list_comments') {
                        const comments = object(result) && Array.isArray(result.comments) ? result.comments : Array.isArray(result) ? result : undefined;
                        if (!comments || comments.length > 1000 || itemId === undefined
                            || comments.some(comment => !object(comment) || !positiveId(comment.id)
                                || comment.workItemId !== undefined && comment.workItemId !== itemId)) { continue; }
                        activity.commentIds = [...new Set(comments.map(comment => (comment as JsonObject).id as number))];
                        activity.returnedComments = activity.commentIds.length;
                        activity.outcome = 'returned';
                        break;
                    }
                    if (!object(result) || !positiveId(result.id) || !object(result.fields) || itemId !== undefined && result.id !== itemId) { continue; }
                    activity.itemId = result.id as number;
                    activity.title = shortText(result.fields['System.Title']);
                    activity.project = shortText(result.fields['System.TeamProject']) ?? activity.project;
                    activity.revision = positiveId(result.rev);
                    activity.returnedFields = fieldNames(Object.keys(result.fields));
                    const links = object(result._links) ? result._links : object(result.links) && object(result.links.links) ? result.links.links : {};
                    activity.url = workItemLink(object(links.html) ? links.html.href : undefined, activity.itemId) ?? workItemLink(result.url, activity.itemId);
                    activity.outcome = 'returned';
                    break;
                }
            }
            activities.push(activity);
            if (activities.length > 10000) { throw new Error('Chat has more than 10,000 work-item activity entries.'); }
        }
    }
    return activities;
}

export function redactWorkItemActivity(session: { workItems?: WorkItemActivity[] }): void {
    delete session.workItems;
}