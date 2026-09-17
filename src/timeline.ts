import type { HistorySession } from './history';
import type { WorkItemActivity } from './work-items';

export type EvidenceKind = 'local' | 'work-item' | 'repository' | 'wiki' | 'search' | 'logs';

export interface EvidenceTimelineEntry {
    key: string;
    callId: string;
    kind: EvidenceKind;
    at?: string;
    title: string;
    detail: string;
    outcome: WorkItemActivity['outcome'] | 'recorded';
    tab: 'file-tab' | 'work-tab' | 'repository-tab' | 'wiki-tab' | 'search-tab' | 'logs-tab';
    targets?: { rootId: string; relativePath: string }[];
}

const timestamp = (value: string | undefined): number => {
    const parsed = value ? new Date(value).getTime() : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};
const kindOrder: EvidenceKind[] = ['local', 'work-item', 'repository', 'wiki', 'search', 'logs'];

export function evidenceTimeline(session: HistorySession): EvidenceTimelineEntry[] {
    const entries: EvidenceTimelineEntry[] = [];
    const localCalls = new Map<string, typeof session.events>();
    for (const event of session.events) {
        const events = localCalls.get(event.id) ?? [];
        events.push(event);
        localCalls.set(event.id, events);
    }
    for (const [callId, events] of localCalls) {
        const first = events[0]!;
        const targets = events.map(event => event.relativePath);
        const ranges = events.map(event => event.startLine === undefined ? 'range unavailable' : `lines ${event.startLine}-${event.endLine}`);
        entries.push({ key: `local:${callId}`, callId, kind: 'local', at: first.at,
            title: targets.length === 1 ? targets[0]! : `${targets.length} local files`,
            detail: targets.map((target, index) => `${target} (${ranges[index]})`).join('\n'), outcome: 'recorded', tab: 'file-tab',
            targets: events.map(event => ({ rootId: event.rootId, relativePath: event.relativePath })) });
    }
    const workCalls = new Map<string, WorkItemActivity[]>();
    for (const item of session.workItems ?? []) {
        const items = workCalls.get(item.callId) ?? [];
        items.push(item);
        workCalls.set(item.callId, items);
    }
    for (const [callId, items] of workCalls) {
        const first = items[0]!;
        const identifiers = items.map(item => item.itemId ? `#${item.itemId}` : 'unknown item');
        const titles = items.map(item => item.title).filter((title): title is string => !!title);
        entries.push({ key: `work-item:${callId}`, callId, kind: 'work-item', at: first.at,
            title: `${first.operation} ${identifiers.join(', ')}`,
            detail: titles.length ? titles.join('\n') : `${items.length} work-item response${items.length === 1 ? '' : 's'}`,
            outcome: items.some(item => item.outcome === 'returned') ? 'returned' : first.outcome, tab: 'work-tab' });
    }
    for (const resource of session.resources ?? []) {
        const title = resource.kind === 'search' ? resource.query ?? 'Code search'
            : resource.kind === 'logs' ? `Build ${resource.buildId ?? 'unknown'} / Log ${resource.logId ?? 'unknown'}`
                : resource.returnedPath ?? resource.requestedPath ?? (resource.kind === 'wiki' ? 'Wiki page' : 'Repository file');
        const detail = resource.kind === 'search' ? `${resource.returnedMatches ?? 0} returned matches`
            : resource.kind === 'logs' ? `${resource.responseLines ?? 0} returned log lines`
                : [resource.resource, resource.project, resource.returnedRevision].filter(Boolean).join(' | ') || 'Resource metadata unavailable';
        entries.push({ key: `${resource.kind}:${resource.callId}`, callId: resource.callId, kind: resource.kind, at: resource.at,
            title, detail, outcome: resource.outcome, tab: `${resource.kind}-tab` as EvidenceTimelineEntry['tab'] });
    }
    return entries.sort((left, right) => timestamp(left.at) - timestamp(right.at)
        || kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) || left.callId.localeCompare(right.callId));
}