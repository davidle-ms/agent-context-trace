import { randomBytes } from 'node:crypto';

export function heatmapHtml(): string {
    const nonce = randomBytes(24).toString('base64');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<title>File read heatmap</title>
<script nonce="${nonce}">
(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme = param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();
</script>
<style nonce="${nonce}">
:root {
  color-scheme: light;
  --cp-bg: #f7f4ef;
  --cp-bg-elevated: #fcfbf8;
  --cp-surface: #ffffff;
  --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede;
  --cp-border-strong: #919191;
  --cp-text: #242424;
  --cp-text-muted: #5c5c5c;
  --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b;
  --cp-accent-hover: #9a1a41;
  --cp-accent-soft: rgba(177, 31, 75, 0.08);
  --cp-accent-fg: #ffffff;
  --cp-success: #16a34a;
  --cp-danger: #dc2626;
  --cp-warning: #f59e0b;
  --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86);
  --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a;
  --cp-bg-elevated: #343231;
  --cp-surface: #292929;
  --cp-surface-soft: #2e2e2e;
  --cp-border: #474747;
  --cp-border-strong: #5f5f5f;
  --cp-text: #dedede;
  --cp-text-muted: #919191;
  --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1;
  --cp-accent-hover: #fb7b91;
  --cp-accent-soft: rgba(253, 142, 161, 0.14);
  --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80;
  --cp-danger: #f87171;
  --cp-warning: #fbbf24;
  --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72);
  --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}
body {
  --cp-bg: var(--vscode-sideBar-background);
  --cp-surface: var(--vscode-editor-background);
  --cp-border: var(--vscode-panel-border);
  --cp-border-strong: var(--vscode-focusBorder);
  --cp-text: var(--vscode-foreground);
  --cp-text-muted: var(--vscode-descriptionForeground);
  --cp-single: var(--vscode-agentContextTrace-readSectionBackground);
  --cp-repeat: var(--vscode-agentContextTrace-readSectionRepeatBackground);
  --cp-frequent: var(--vscode-agentContextTrace-readSectionFrequentBackground);
  --cp-intense: var(--vscode-agentContextTrace-readSectionIntenseBackground);
  --cp-single-edge: var(--vscode-agentContextTrace-readSectionBorder);
  --cp-repeat-edge: var(--vscode-agentContextTrace-readFileRepeatForeground);
  --cp-frequent-edge: var(--vscode-agentContextTrace-readFileFrequentForeground);
  --cp-intense-edge: var(--vscode-agentContextTrace-readFileIntenseForeground);
  margin: 0; padding: 8px 12px; box-sizing: border-box; height: 100vh;
  display: flex; flex-direction: column; gap: 6px;
  background: var(--cp-bg); color: var(--cp-text);
  font: var(--vscode-font-size) var(--vscode-font-family, "Segoe UI", Aptos, Calibri, sans-serif);
  letter-spacing: 0;
}
* { box-sizing: border-box; }
#status, #empty { color: var(--cp-text-muted); overflow-wrap: anywhere; flex-shrink: 0; }
#status { font-size: 11px; max-height: 3.6em; overflow: auto; }
#filename { margin: 0; font-size: 12px; line-height: 16px; overflow-wrap: anywhere; flex-shrink: 0; }
#scale { display: flex; flex-wrap: wrap; flex-shrink: 0; gap: 4px 10px; font-size: 11px; color: var(--cp-text-muted); }
#scale span { display: inline-flex; align-items: center; gap: 4px; }
#scale i { width: 12px; height: 8px; border-left: 2px solid var(--edge); background: var(--shade); }
.single { --edge: var(--cp-single-edge); --shade: var(--cp-single); }
.repeat { --edge: var(--cp-repeat-edge); --shade: var(--cp-repeat); }
.frequent { --edge: var(--cp-frequent-edge); --shade: var(--cp-frequent); }
.intense { --edge: var(--cp-intense-edge); --shade: var(--cp-intense); }
#map { flex: 1; min-height: 320px; position: relative; margin: 20px 0 20px 34px; }
#map[hidden], #empty[hidden] { display: none; }
#heatmap { width: 100%; height: 100%; position: absolute; display: block; cursor: crosshair; touch-action: none; background: var(--cp-surface); }
#heatmap:focus-visible { outline: 1px solid var(--cp-border-strong); outline-offset: 2px; }
#viewport, #pointer { pointer-events: none; position: absolute; left: 0; right: 0; }
#viewport { border: 1px solid var(--cp-text-muted); min-height: 2px; }
#pointer { border-top: 1px solid var(--cp-text); }
#guides { position: absolute; inset: 0; pointer-events: none; }
.line-label { position: absolute; right: calc(100% + 6px); transform: translateY(-50%); color: var(--cp-text-muted); font: 10px/14px Consolas, monospace; white-space: nowrap; }
#position { height: 48px; flex-shrink: 0; font-size: 11px; line-height: 16px; white-space: pre-line; overflow: auto; overflow-wrap: anywhere; color: var(--cp-text-muted); }
@media (max-height: 260px) {
  body { padding: 4px 10px; gap: 3px; }
  #status { height: 14px; line-height: 14px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  #filename { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #position { height: 32px; }
}
</style></head><body>
<div id="status"></div><h2 id="filename">No file open</h2>
<div id="scale" aria-label="Recorded reads"><span class="single"><i></i>1</span><span class="repeat"><i></i>2-3</span><span class="frequent"><i></i>4-7</span><span class="intense"><i></i>8+</span></div>
<div id="empty">No file open</div>
<div id="map" hidden>
<canvas id="heatmap" role="slider" tabindex="0" aria-label="File line heatmap" aria-orientation="vertical" aria-valuemin="1"></canvas>
<div id="guides" aria-hidden="true"></div>
<div id="viewport"></div><div id="pointer" hidden></div></div>
<div id="position" aria-live="polite"></div>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const canvas = byId('heatmap');
const context = canvas.getContext('2d');
let state;
let currentLine = 1;
let pending;
let timer;
const tier = count => count >= 8 ? 'intense' : count >= 4 ? 'frequent' : count >= 2 ? 'repeat' : 'single';
function draw() {
  if (!state || byId('map').hidden) return;
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(bounds.width * ratio));
  canvas.height = Math.max(1, Math.round(bounds.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const styles = getComputedStyle(document.body);
  for (const range of state.ranges) {
    const top = (range.startLine - 1) / state.lineCount * bounds.height;
    const height = Math.max(1 / ratio, (range.endLine - range.startLine + 1) / state.lineCount * bounds.height);
    context.fillStyle = styles.getPropertyValue('--cp-' + tier(range.readCount)).trim();
    context.fillRect(0, top, bounds.width, height);
    context.fillStyle = styles.getPropertyValue('--cp-' + tier(range.readCount) + '-edge').trim();
    context.fillRect(0, top, 3, height);
  }
  drawGuides(bounds, ratio, styles);
  drawViewport();
}
function drawGuides(bounds, ratio, styles) {
  const boundaries = new Map([[0, 1], [state.lineCount, state.lineCount]]);
  for (const range of state.ranges) boundaries.set(range.endLine, range.endLine);
  for (const range of state.ranges) boundaries.set(range.startLine - 1, range.startLine);
  const labels = document.createDocumentFragment();
  const drawnRows = new Set();
  let lastLabelTop = -Infinity;
  context.fillStyle = styles.getPropertyValue('--cp-text-muted').trim();
  context.globalAlpha = 0.5;
  for (const [offset, line] of [...boundaries].sort(([left], [right]) => left - right)) {
    const top = offset / state.lineCount * bounds.height;
    const row = Math.min(Math.floor(top * ratio), canvas.height - 1);
    if (!drawnRows.has(row)) {
      context.fillRect(3, row / ratio, bounds.width - 3, 1 / ratio);
      drawnRows.add(row);
    }
    const endpoint = offset === 0 || offset === state.lineCount;
    if (!endpoint && (top - lastLabelTop < 18 || bounds.height - top < 18)) continue;
    if (offset === state.lineCount && state.lineCount === 1) continue;
    const label = document.createElement('span');
    label.className = 'line-label';
    label.textContent = String(line);
    label.dataset.offset = String(offset);
    label.style.top = (offset / state.lineCount * 100) + '%';
    labels.append(label);
    lastLabelTop = top;
  }
  context.globalAlpha = 1;
  byId('guides').replaceChildren(labels);
}
function drawViewport() {
  const visible = state?.visible;
  byId('viewport').hidden = !visible;
  if (visible) {
    byId('viewport').style.top = ((visible.startLine - 1) / state.lineCount * 100) + '%';
    byId('viewport').style.height = ((visible.endLine - visible.startLine + 1) / state.lineCount * 100) + '%';
  }
}
function point(line, focus = false) {
  if (!state?.navigable) return;
  currentLine = Math.max(1, Math.min(state.lineCount, line));
  byId('pointer').hidden = false;
  byId('pointer').style.top = ((currentLine - 0.5) / state.lineCount * 100) + '%';
  const matches = state.ranges.filter(range => range.startLine <= currentLine && range.endLine >= currentLine);
  const count = matches.reduce((total, range) => total + range.readCount, 0);
  const provenance = matches.some(range => !range.verified) ? 'Historical range; file may have changed.' : matches.length ? 'Source revision matches.' : 'No displayed read range.';
  const label = 'Line ' + currentLine + ' / ' + state.lineCount + ' | ' + count + ' recorded reads';
  byId('position').textContent = label + '\\n' + provenance;
  canvas.setAttribute('aria-valuenow', String(currentLine));
  canvas.setAttribute('aria-valuetext', label + '. ' + provenance);
  pending = { type: 'navigate', token: state.token, line: currentLine, focus };
  if (focus) { clearTimeout(timer); timer = undefined; }
  if (!timer) timer = setTimeout(() => { timer = undefined; if (pending) api.postMessage(pending); pending = undefined; }, focus ? 0 : 30);
}
function lineAt(event) {
  const bounds = canvas.getBoundingClientRect();
  return Math.floor((event.clientY - bounds.top) / bounds.height * state.lineCount) + 1;
}
canvas.addEventListener('pointermove', event => { if (state) point(lineAt(event)); });
canvas.addEventListener('click', event => { if (state) point(lineAt(event), true); });
canvas.addEventListener('pointerleave', () => { byId('pointer').hidden = true; clearTimeout(timer); timer = undefined; pending = undefined; });
canvas.addEventListener('keydown', event => {
  if (!state) return;
  const lines = { ArrowDown: currentLine + 1, ArrowUp: currentLine - 1, PageDown: currentLine + 20,
    PageUp: currentLine - 20, Home: 1, End: state.lineCount, Enter: currentLine, ' ': currentLine };
  if (!(event.key in lines)) return;
  event.preventDefault();
  point(lines[event.key], event.key === 'Enter' || event.key === ' ');
});
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'viewport' && state?.token === message.token) { state.visible = message.visible; drawViewport(); return; }
  if (message.type !== 'state') return;
  state = message;
  clearTimeout(timer); timer = undefined; pending = undefined;
  currentLine = Math.min(currentLine, state.lineCount || 1);
  byId('status').textContent = state.status;
  byId('status').title = state.status;
  byId('filename').textContent = state.filename || 'No file open';
  byId('filename').title = state.filename || '';
  byId('empty').textContent = state.empty;
  byId('empty').hidden = !state.empty;
  byId('map').hidden = !state.navigable;
  byId('map').style.marginLeft = Math.max(34, String(state.lineCount).length * 7 + 10) + 'px';
  byId('pointer').hidden = true;
  byId('position').textContent = '';
  canvas.setAttribute('aria-valuemax', String(state.lineCount || 1));
  canvas.setAttribute('aria-valuenow', String(currentLine));
  draw();
});
new ResizeObserver(draw).observe(canvas);
new MutationObserver(draw).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
api.postMessage({ type: 'ready' });
</script></body></html>`;
}