import { randomBytes } from 'node:crypto';
import type { ResourceActivity } from './resource-history';

export function repositoryReadLines(activity: ResourceActivity): { mapped: boolean; lines: { number: number; text: string }[]; note: string } {
    const range = activity.range;
    const mapped = activity.evidence === 'content' && !!range && Number.isSafeInteger(range.startLine)
        && Number.isSafeInteger(range.endLine) && range.startLine > 0 && range.endLine >= range.startLine
        && activity.responseLines === range.endLine - range.startLine + 1;
    const preview = activity.preview;
    const rows = preview ? preview.split(/\r\n|\n|\r/) : [];
    let note = preview === undefined ? activity.previewUnavailable ?? 'No saved response text is available for this call.'
        : mapped ? 'Source line numbers match the explicit range in the saved response. Amber marks returned lines, not proof of model consumption.'
            : 'Source line mapping is unavailable or inconsistent. Numbers below refer only to the saved response; they are not source-file line numbers.';
    if (activity.previewTruncated) { note += ' Preview truncated; the final displayed line may be partial.'; }
    note += ' This is a saved response snapshot, not the current repository file.';
    return { mapped, lines: rows.map((text, index) => ({ number: (mapped ? range!.startLine : 1) + index, text })), note };
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

export function repositoryReadLinesHtml(activity: ResourceActivity, sessionLabel: string): string {
    const nonce = randomBytes(24).toString('base64');
    const view = repositoryReadLines(activity);
    const fields = [
        ['Session', sessionLabel], ['Repository', activity.resource ?? 'Unavailable'], ['Project', activity.project ?? 'Unavailable'],
        ['Requested path', activity.requestedPath ?? 'Unavailable'], ['Returned path', activity.returnedPath ?? 'Unavailable'],
        ['Requested version', activity.requestedVersion ? `${activity.versionType ?? 'Type unspecified'}: ${activity.requestedVersion}` : 'Server default (not resolved)'],
        ['Returned revision', activity.returnedRevision ?? 'Unavailable'],
        ['Recorded source range', activity.range ? `${activity.range.startLine}-${activity.range.endLine}` : 'Not supplied'],
        ['Call outcome', activity.outcome], ['Request time', activity.at ?? 'Unavailable']
    ];
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<title>Repository Read Lines</title><style nonce="${nonce}">
:root { color-scheme: light dark; --cp-bg: var(--vscode-editor-background); --cp-text: var(--vscode-editor-foreground);
  --cp-muted: var(--vscode-descriptionForeground); --cp-border: var(--vscode-panel-border);
  --cp-amber: var(--vscode-agentContextTrace-readSectionBackground); --cp-edge: var(--vscode-agentContextTrace-readSectionBorder);
  --cp-focus: var(--vscode-focusBorder); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--cp-bg); color: var(--cp-text); font: var(--vscode-font-size) var(--vscode-font-family, "Segoe UI", sans-serif); letter-spacing: 0; }
header { padding: 16px 20px; border-bottom: 1px solid var(--cp-border); }
h1 { margin: 0 0 12px; font-size: 16px; line-height: 22px; overflow-wrap: anywhere; }
#range-summary { margin: 0 0 12px; font-size: 12px; overflow-wrap: anywhere; }
summary { cursor: pointer; color: var(--cp-muted); font-size: 12px; margin-bottom: 8px; }
summary:focus-visible { outline: 1px solid var(--cp-focus); }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 16px; margin: 0; font-size: 12px; }
dt { color: var(--cp-muted); } dd { margin: 0; overflow-wrap: anywhere; }
#evidence { padding: 12px 20px; margin: 0; line-height: 1.5; color: var(--cp-muted); border-bottom: 1px solid var(--cp-border); }
h2 { margin: 0; padding: 12px 20px; font-size: 12px; }
#read-lines { margin: 0 0 20px; outline: none; }
#read-lines:focus-visible { outline: 1px solid var(--cp-focus); outline-offset: -1px; }
.read-line { display: grid; grid-template-columns: minmax(6ch, max-content) minmax(0, 1fr); padding: 0 20px 0 0; min-height: 22px;
  font: 12px/22px var(--vscode-editor-font-family, Consolas, monospace); }
.read-line.recorded { background: var(--cp-amber); border-left: 2px solid var(--cp-edge); }
.line-number { text-align: right; padding: 0 12px; color: var(--cp-muted); user-select: none; }
code { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
#no-text { padding: 0 20px; color: var(--cp-muted); }
@media (max-width: 480px) { dl { grid-template-columns: minmax(0, 1fr); gap: 4px; } dd { margin-bottom: 6px; } }
</style></head><body><header><h1>${escapeHtml(activity.returnedPath ?? activity.requestedPath ?? 'Repository file')} / Read-only</h1>
<p id="range-summary">${activity.range ? `Recorded source range: ${activity.range.startLine}-${activity.range.endLine}` : 'Source range not supplied'} | Returned revision: ${escapeHtml(activity.returnedRevision ?? 'Unavailable')}</p>
<details><summary>Call details</summary><dl>${fields.map(([name, value]) => `<dt>${escapeHtml(name!)}</dt><dd>${escapeHtml(value!)}</dd>`).join('')}</dl></details></header>
<p id="evidence">${escapeHtml(view.note)}</p><h2>${view.mapped ? 'Recorded Source Lines' : 'Saved Response Lines'}</h2>
<div id="read-lines" tabindex="0" role="region" aria-label="Saved repository response">${view.lines.map(line => `<div class="read-line${view.mapped ? ' recorded' : ''}"><span class="line-number">${line.number}</span><code>${escapeHtml(line.text) || ' '}</code></div>`).join('')}</div>
${!view.lines.length ? '<p id="no-text">No saved text to display.</p>' : ''}</body></html>`;
}