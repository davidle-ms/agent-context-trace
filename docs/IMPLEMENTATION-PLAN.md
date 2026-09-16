# Agent Context Trace Implementation Plan

Status: First working read-to-color slice implemented; broader plan and acceptance gates remain in progress.
Date: 2026-09-16
Target: A local-first TypeScript extension for desktop VS Code and GitHub Copilot agent mode.

### Implementation Checkpoint

Editor sections: the existing eye toggle controls automatic line shading as well as Explorer filename colors. Recorded reads use four amber background intensities with blue edge/ruler markers: 1, 2-3, 4-7, and 8+ reads. Amber represents frequency for all evidence types, not a warning or an unverified revision. Syntax colors are unchanged and there are no inline count labels; Explorer filename shades remain blue. Increasing opacity makes more-read sections more prominent in light and dark themes. An interval-boundary sweep computes exact per-line counts and splits overlapping ranges; equal-count adjacent spans merge. Read IDs are deduplicated. Explorer filenames use distinct per-file calls in the selected session, while editor counts exclude known nonmatching revisions and missing line ranges. Exact counts and provenance remain in tooltips, with a concise legend in the coverage section. A matching tracker fingerprint is identified in the tooltip; history without a fingerprint says "Historical range; file may have changed." The historical opt-out, edit invalidation, and visible/split-editor updates are preserved. Sixteen core/parser tests and native rendering checks cover amber intensities, unchanged text colors, file totals, overlaps, duplicate refreshes, and session isolation. This supersedes the former gray/blue backgrounds, labels, and earlier editor-highlight proposals below.

Implemented: repository-grouped Copilot chat picker, opt-in read-only local-history adapter, selected-file watcher, optional registered read tool and tracker sessions, Explorer and editor read-frequency shades, a controls-only coverage section, persisted color toggle, read details, and JSON export. Sixteen core/parser tests and native host checks pass on Windows VS Code 1.138.0, including rendered frequency tiers, exact-count hovers, edit invalidation, split editors, session changes, grouping, history refresh, and persistence.

Picker grouping: This Repository contains chats whose saved folder or multi-root workspace roots match a current root; Other Sessions underneath contains the remaining chats. Each group is newest-first by saved history modification time and independently capped at 100 entries. Current workspace storage is always considered. Unknown metadata remains in the lower group; titles and incidental read paths do not establish repository ownership. Open History actions remain at the bottom. Metadata parsing is bounded and uses a JSONC parser for VS Code workspace files; its ESM entry is bundled into the extension.

Session workflow clarification: Choose Copilot Chat Session is now the primary action. Existing-chat mode reads private JSON/JSONL history after consent, filters supported completed/confirmed read-tool entries to the current workspace, and never writes to Copilot history. It stores no copied source/transcript and makes no claim of complete coverage. Unavailable line ranges/revisions stay unknown. Tracker mode remains an optional stable-API fallback. This explicitly supersedes the original tracker-only scope and no-history-adapter decision below; remaining task tables primarily describe the instrumented path.

Explorer clarification: the duplicate file directory in Agent Read Coverage has been removed. That section now contains controls and status only; built-in Explorer provides file browsing and filename colors. Show Recorded Read Details is available in the built-in Explorer context menu or from the Command Palette for the active file. Display-only URIs, directory enumeration, and custom-tree directory watchers are removed. This supersedes all custom repository-tree proposals below. Native tests check zero rows in coverage, real Explorer colors, read details, and preserved controls. Real-file decorations may also appear in tabs because VS Code shares them across surfaces.

The original plan below remains the target design, not a claim that every task is complete. Current source is consolidated into core, extension, and views modules; tests use Node's test runner plus assertion-based host tests, not Mocha. Initial storage limits are 1,000 events and 4 MiB per session, with 100 retained session files. Only prepared successful reads are persisted. The toolbar currently uses one toggle command/icon; interrupted-session ownership, dynamic workspace roots, global storage budgeting, and large-tree refresh performance need further hardening. See [README.md](../README.md) for actual usage and limitations.

Still unverified: a signed-in Copilot conversation using the tool, enterprise policy compatibility, the minimum supported runtime, and other operating systems. Remaining features include cross-session comparison, rejected-call history, configurable retention, and CI/release automation. Phase 0 is therefore partially verified, not closed.

## 1. Problem and Opportunity

GitHub Copilot already exposes some file-reading activity, but developers must piece together individual tool calls to understand context gathering. Reviewing exact line ranges, repeated reads, and activity across sessions is cumbersome.

Agent Context Trace makes recorded reads visible by coloring filenames in the existing Explorer. Agent Read Coverage provides session controls and status without duplicating the file directory. Session details, file summaries, and optional editor line highlights support that primary experience. The initial product provides evidence for investigation, not proof of model reasoning or automatic optimization.

## 2. Scope and Tracking Contract

### MVP

- Choose an existing saved Copilot chat without starting a tracker; show supported historical file-read evidence and refresh as the selected history file changes.
- Obtain opt-in before local-history access and disclose the adapter's private, version-dependent format. Original chats are read-only; unknown ranges/revisions are never fabricated.
- Contribute a read-only language-model tool that Copilot can invoke explicitly.
- Capture the requested range and the actual range prepared for return by that tool.
- Associate events with an explicit, extension-owned tracker session.
- Provide an Agent Read Coverage controls/status section, leaving all file browsing in VS Code's built-in Explorer.
- Color files with recorded reads for the selected tracker session and provide a persistent on/off toggle that affects appearance only.
- Provide session controls, file navigation, optional editor line highlights, and JSON export.
- Persist bounded metadata locally, with retention and deletion controls.
- Support trusted, local, single-root and multi-root desktop workspaces. Prioritize Windows, then validate macOS and Linux before claiming support.

### Boundaries

| Observation | MVP contract |
|-------------|--------------|
| This extension's read tool | Record validated calls and distinguish successful, rejected, failed, and cancelled outcomes. |
| Built-in Copilot reads | Existing-chat mode recognizes supported completed/confirmed `copilot_readFile` history entries; absence of such evidence is not proof of no read. |
| Search results, terminal commands, attachments, and other tools | Not captured. Never infer reads from document-open or editor-visibility events. |
| Copilot chat identity | Existing-chat mode uses the ID/title in the selected local file, not a public session API. Tracker sessions remain user-managed and separate. |
| Tool invocation token | Treat `toolInvocationToken` as opaque. Do not inspect, persist, or use it as a session key. |
| Model consumption | A prepared tool response does not prove that the model received, retained, understood, or used its contents. |
| Completeness | Label provenance as instrumented-tool-only or local Copilot history (best effort). Do not report a percentage of all Copilot reads. |
| Token cost | Do not equate lines with tokens or repeated reads with waste. Token and billing attribution are outside MVP. |

The instrumented tool is the optional stable-API capture path. The user's existing-chat requirement is addressed by an explicitly opt-in private-history adapter, not an editor-visibility heuristic or an undocumented API presented as supported. Validate adapter compatibility on every supported VS Code version; keep source access read-only and make partial coverage visible.

### Deferred

Cloud session discovery, additional history formats/tool types, private debug-log parsing, terminal/search instrumentation, VS Code Web, remote extension hosts, team dashboards, cloud storage, automatic context optimization, and policy enforcement remain deferred. Bounded local chat discovery and read-only historical display are implemented.

## 3. Baseline and Technology Decisions

At planning time, the repository contained only [README.md](../README.md), [.gitignore](../.gitignore), and this plan under `docs/`. The implementation checkpoint above supersedes that baseline. The file/task tables below retain the original proposed structure for future work.

| Area | Decision |
|------|----------|
| Language | TypeScript with strict checking. |
| APIs | Stable VS Code extension APIs for UI/tool integration; opt-in, version-dependent on-disk chat history for existing chats. Verify both API and file-format compatibility before extending supported versions. |
| Tool | `contributes.languageModelTools` plus `vscode.lm.registerTool`; implement `LanguageModelTool<ReadInput>`. |
| UI | Native `TreeDataProvider`, scoped `FileDecorationProvider`, commands, `StatusBarItem`, and optional `TextEditorDecorationType`; no webview or frontend framework for MVP. File coloring is separate from editor line highlighting. |
| Storage | Versioned JSON metadata under `ExtensionContext.storageUri`, outside the repository. This is local storage, not encrypted storage. |
| Build | npm, TypeScript, and esbuild; use the configured private npm registry. Keep registry endpoints and credentials out of commits. |
| Testing | Mocha and Node assertions for pure logic; `@vscode/test-electron` for extension-host integration tests. |
| Packaging | `@vscode/vsce`; VSIX distribution first. Marketplace publication requires a later explicit decision. |

## 4. Terminology and Metrics

| Term | Meaning |
|------|---------|
| Tracker session | A UUID and user-provided label grouping this extension's observations, independent of Copilot's internal session identity. |
| Read event | Metadata for one tool invocation, with provenance, outcome, time, and valid ranges when available. |
| Requested range | The 1-based inclusive start and end lines supplied to the tool. |
| Returned range | The actual complete lines included in the constructed response, excluding line-number prefixes and metadata. |
| Revision | Fingerprint of the captured document snapshot, distinguishing reads before and after edits. |
| Read volume | Sum of successful returned-range lengths, including repeated access. |
| Unique lines | Union of successful intervals, grouped by workspace root, relative file path, and revision. |
| Repeated-line volume | Read volume minus unique lines within the same grouping. Repetition can be necessary and is not automatically waste. |
| Historical highlight | A recorded range applicable only while the current document fingerprint matches the event's revision. |

Across revisions, label summed unique lines as revision-scoped, not distinct lines in today's codebase. Do not imply that files with no recorded reads were ignored by Copilot. Cross-session comparison reports activity and overlap, not task-quality scores.

## 5. User Experience

1. The developer installs the extension, opens a trusted local workspace, and starts a named tracker session.
2. Start Session assigns a UUID and offers a Copy Session Reference command containing the tool reference and tracker session ID. Do not modify workspace instructions automatically.
3. The developer enables the contributed tool in Copilot and references it in the prompt. The model must supply that session ID on each invocation.
4. VS Code presents the tool's confirmation flow, subject to the user's approval settings. Confirmation describes the file, range, session, and local metadata recording.
5. The Agent Read Coverage section displays repository roots, folders, and files. A session picker selects which tracker session supplies the coloring; selecting history does not change the recording session.
6. Files with recorded reads gain a theme-aware color and `R` badge. Selecting a file opens it; its context menu exposes recorded line ranges and read details. Optional editor decorations show matching-revision ranges.
7. The view-title on/off control shows or hides file colors and read badges immediately. Tracking continues while colors are off; turning them back on restores markers from recorded history, including new reads captured while hidden.
8. Pause blocks new reads through this tool; resume re-enables the current session. Stop finalizes it. Built-in Copilot activity remains unaffected.
9. The developer reviews summaries, compares retained sessions, exports JSON explicitly, or deletes recorded metadata.

Provide accessible labels, keyboard navigation, native theme colors and icons, empty states, cancellation feedback, missing-file states, storage-error states, and a persistent partial-coverage indicator. Use tooltips and documentation for explanations rather than filling the sidebar with tutorial text.

### Primary Feature: Toggleable Repository File Colors

| Element or state | Behavior |
|------------------|----------|
| Section | Contribute `agentContextTrace.readCoverage` under `views.explorer`, titled Agent Read Coverage. It is a separate section, not a replacement for the built-in Explorer. |
| Repository tree | Show the local workspace folder hierarchy, not only a list of touched files. Load directory entries lazily; respect applicable `files.exclude` rules and omit `.git`. Display exclusions are not read permissions. |
| Recorded read | A file with at least one prepared response in the selected tracker session receives the contributed `agentContextTrace.readFileForeground` color, with blue-toned defaults for light/dark themes and accessible high-contrast defaults, plus an `R` badge. |
| Meaning of a color | At least one range at this path was recorded in this tracker session. It does not mean the entire file, its current revision, or every line was read. Keep historical revision details available. |
| No recorded read | Normal file appearance. Tooltip uses "No recorded read in this session," never "The agent has not read this file." |
| Folders | Keep folders neutral; any descendant count is explicitly a count of files with recorded reads, not a folder-read marker. Do not propagate file decorations to ancestors. |
| File details | Hover shows the selected session, recorded call count, and last recorded time. A Show Read Details command lists actual ranges and revisions; no source content is persisted. |
| Toggle | `agentContextTrace.toggleFileColors`, available in the view title and Command Palette. Use native eye/eye-closed icons with Show Read Colors / Hide Read Colors tooltips and a checked state in the view menu. |
| Toggle on | Default for a workspace. Apply file colors and `R` badges to recorded paths in the selected session. |
| Toggle off | Remove this extension's file colors and `R` badges while leaving the repository tree, navigation, details, recording, and stored events intact. |
| Persistence | Store `fileColorsEnabled` in `ExtensionContext.workspaceState`; restore it after reload. Do not write the preference into repository files. A storage failure must not claim that the preference was saved. |
| Session changes | Recompute markers from the selected session, clearing old-session decorations first. A new session starts neutral until its first recorded read. |
| History deletion | Clear markers derived from deleted sessions. If the selected session disappears, clear the selection; never silently show combined history. |
| Accessibility | Provide badges, readable tooltips, and screen-reader state alongside color. Do not make color the only signal. |

Native trees support foreground colors, icons, and badges, not arbitrary full-row background fills. Color the filename text in the built-in Explorer and the dedicated section without modifying source files. Respect `explorer.decorations.colors`; selection styling and Git or other providers may affect the final appearance. Do not promise independent tab colors because VS Code shares real-file decorations across surfaces.

Use display-only `agent-context-trace:` resource URIs for the custom tree and also decorate actual `file:` URIs for recorded workspace paths. Build the real-URI index from session metadata without requiring custom tree expansion. Invalidate the union of previous and current real URIs on reads, toggles, selection changes, and history deletion so Explorer cannot retain stale session colors. Keep validated file mappings for navigation and never register a display-scheme content provider that exposes source. Use root-qualified identity and Windows-aware path matching. Verify the rendered filename text in both trees, rather than treating a colored icon or returned decoration object as sufficient evidence.

Directory enumeration, view refreshes, human file opens, and toggles must never create agent-read events. Refresh using metadata only; do not open or hash every repository file just to paint the tree. File colors represent historical recorded paths, while optional editor line highlights still require a matching current revision.

## 6. Architecture and Flows

### Components

| Component | Trigger | Responsibility |
|-----------|---------|----------------|
| Extension entry point | Activation/deactivation | Register contributions, restore history, own disposables, and flush pending writes. |
| Tracked read tool | Copilot tool invocation | Validate input, obtain a permitted snapshot, format numbered lines, and record an outcome. |
| Read service | Tool calls | Canonicalize paths, enforce scope/exclusions, read bounded text, and compute revision metadata. |
| Session service | Commands and tool calls | Own tracker identities, state transitions, and in-flight invocation registration. |
| Trace store | Session/event changes | Serialize writes, validate schemas, enforce limits, restore history, export, and delete metadata. |
| Analytics | History/view selection | Merge intervals and derive revision-aware summaries and comparisons. |
| Coverage view | Directory expansion, file changes, and store notifications | Present the lazy repository tree, session selection, file details, navigation, and optional editor line highlights. |
| File color provider | Selected-session or toggle changes | Derive scoped file colors/badges from recorded metadata and invalidate previous decorations without changing capture state. |

### Flow A: Instrumented Read

```text
Prompt references tool + tracker session ID
  -> VS Code confirmation -> tracked read tool
  -> validate session / trust / scope / exclusions
  -> bounded document snapshot -> numbered response + range metadata
  -> persist event -> return LanguageModelToolResult
  -> refresh repository file colors when enabled
  -> refresh matching-revision editor highlights when enabled
```

### Flow B: Session Lifecycle

```text
Start -> Recording <-> Paused -> Stopped
           |           |
           +-> extension host terminates -> Interrupted history
```

Only one recording session is allowed per extension-host window in MVP. Invocations require an exact session ID; never silently move an event into a newly selected session. Independent windows create distinct IDs and write only their own session files. A new host shows old unfinished sessions as interrupted only after confirming they are not owned by a live writer; it never auto-resumes them or rewrites another window's live state.

File-color visibility and selected history are independent view state, not session lifecycle states. Toggle off must not invoke pause/stop; toggling on must not start a session or reread source files.

### Flow C: Failures and Shutdown

| Situation | Required behavior |
|-----------|-------------------|
| Invalid input, denied path, missing session, or non-recording session | Return an actionable tool error; never read source content. Store a sanitized rejection only when it can be safely attributed to a known session. |
| Cancellation or pause/stop during a read | Capture session ownership at entry, check cancellation before delivery, and drain in-flight operations before finalizing the session. Never count cancellation as returned lines. |
| Storage failure | Fail the tracked read before returning source; mark tracking unavailable. Do not silently return unrecorded data. |
| Crash after persistence but before delivery | Retain the event as a prepared response. Persisted metadata is not an exactly-once receipt from Copilot. |
| Session deletion during a write | Stop/cancel the session, drain its write queue, then remove its data so delayed writes cannot recreate it. |

## 7. Data Model

### Tool Input

```json
{
  "sessionId": "<tracker-session-uuid>",
  "filePath": "<absolute-local-workspace-file-path>",
  "startLine": 10,
  "endLine": 30
}
```

Require all fields, integer positive line numbers, `endLine >= startLine`, and no additional properties. Session IDs are routing identifiers, not authentication credentials. Revalidate inputs inside the tool even when the host validates the input schema.

### Persisted Types

| Type | Fields | Rules |
|------|--------|-------|
| `TrackerSession` | `schemaVersion`, `id`, `label`, `ownerInstanceId`, `createdAt`, `endedAt?`, `state`, `roots`, `coverage` | `coverage` is always `instrumented-tool-only`. States: recording, paused, stopped, interrupted. |
| `WorkspaceRootRef` | `id`, `displayName` | Persist an opaque root ID, not an absolute path. Associate it with the open workspace; require explicit remapping when unavailable. |
| `ReadEvent` | `schemaVersion`, `id`, `sessionId`, `startedAt`, `durationMs`, `source`, `outcome`, `file?`, `requestedRange?`, `returnedRange?`, `revision?`, `truncated`, `errorCode?` | `source` is `tracked-tool`. Outcomes: prepared, rejected, failed, cancelled. Only prepared responses contribute to returned-line metrics. |
| `FileRef` | `rootId`, `relativePath` | Canonical, root-relative path; external paths and rejected raw inputs are not persisted. |
| `RevisionRef` | `snapshotHash`, `documentVersion`, `isDirty`, `lineCount` | Hash the bounded snapshot in memory. Document versions alone are not stable across reopen/restart. |
| `SessionSummary` | `eventCount`, `fileCount`, `readVolume`, `revisionScopedUniqueLines`, `repeatedLineVolume`, `outcomeCounts` | Derived from validated events, not a second authoritative dataset. |

Store one bounded, versioned JSON document per tracker session. Use a serialized mutation queue and temporary-file replacement; persist atomically before reporting a recorded event. Deduplicate by event ID. Reject unknown future schemas without overwriting data; recover other valid sessions if one file is corrupt.

No source text, prompts, tool result bodies, auth tokens, or Copilot internals are persisted. Labels, paths, timestamps, and fingerprints are still sensitive metadata. Export must preview included fields and offer path/label redaction; never include absolute machine paths by default.

## 8. Read Semantics and Privacy

| Concern | Implementation requirement |
|---------|----------------------------|
| Trust and availability | Declare unsupported in untrusted and virtual workspaces for MVP. Check trust and supported local URI schemes in code, not only contribution `when` clauses. Disable unsupported remote execution. |
| Workspace boundaries | Resolve the root and candidate path canonically. Use separator-aware containment and Windows-aware comparisons; reject traversal, UNC paths, unsupported device paths, and symlink/junction escapes. Recheck around access; do not claim protection against a hostile concurrent filesystem mutation. |
| Exclusions | Apply extension-owned user-configured exclusions plus conservative secret defaults such as `.env`, credentials, private keys, `.git`, and dependencies. Never assume `.gitignore` is a security policy. |
| Copilot policies | Do not claim to inherit Copilot content exclusions or organization rules. Phase 0 must assess policy compatibility; block organizational rollout if required restrictions cannot be honored. Workspace trust is not a substitute for data-access approval. |
| Snapshot | Use the existing VS Code text document when dirty; otherwise open the permitted text document. Capture one bounded snapshot before computing output and metadata. Never save or modify the file. |
| Bounds | Check size before loading where possible and recheck the in-memory snapshot, including dirty buffers. Reject binary/unsupported content and oversized files. |
| Lines | Use 1-based inclusive tool coordinates and convert explicitly to VS Code's 0-based ranges. Clamp the end to EOF and report truncation; reject a start beyond EOF. Test empty documents, CRLF, and final empty lines. |
| Output | Return numbered source lines with the actual range and partial-coverage metadata. Avoid splitting lines silently; reject an oversized requested result with guidance to request a smaller range. Respect a caller's response budget where the verified API exposes one. |
| Cancellation | Check the cancellation token before access, after asynchronous work, and before preparing delivery. Never count incomplete text as a complete range. |
| Local-first meaning | The extension sends no telemetry or trace metadata to a separate service. Source content is still returned to Copilot when the approved tool is invoked, subject to the user's Copilot configuration. |
| Errors and logging | Persist enumerated error codes, not arbitrary exception messages or raw inputs that could contain source or secrets. |

### Initial Constants and Settings

Define constants in `src/config.ts` and document them in the extension manifest. Treat sizes as conservative starting limits to validate, not performance claims.

| Constant or setting | Initial value | Purpose |
|---------------------|---------------|---------|
| `SCHEMA_VERSION` | `1` | Persisted model version. |
| `TOOL_NAME` | `read_agent_context` | Unique registration name; check collisions before release. |
| `TOOL_REFERENCE_NAME` | `agentContextRead` | Prompt reference name. |
| `MAX_FILE_BYTES` | 1 MiB | Bound disk reads and snapshot hashing. |
| `MAX_LINES_PER_READ` | 500 | Bound requested ranges. |
| `MAX_RESPONSE_CHARACTERS` | 32,000 | Bound formatted output independently of line count. |
| `MAX_EVENTS_PER_SESSION` | 10,000 | Stop further tracked reads with a clear capacity message. |
| `MAX_STORAGE_BYTES` | 100 MiB per workspace | Bound total retained metadata; never silently discard current-session events. |
| `agentContextTrace.retentionDays` | 30 | Prune closed history on activation and periodically. |
| `agentContextTrace.maxSessions` | 100 | Remove oldest closed sessions under retention rules; do not prune live writers. |
| `FILE_COLORS_ENABLED_DEFAULT` | `true` | Initial file-color visibility; persist the developer's toggle as `fileColorsEnabled` in workspace state. |
| `READ_FILE_COLOR_ID` | `agentContextTrace.readFileForeground` | Contributed theme color for the dedicated repository tree's recorded files. |
| `agentContextTrace.decorateReads` | `false` | Separate opt-in historical line highlights inside editors; unaffected by the file-color toggle. |
| `agentContextTrace.excludeGlobs` | Conservative defaults above | User-controlled restrictions, never changed by tool input. |

Use a maintained glob matcher if exclusion matching needs more than simple canonical checks. Do not implement a custom glob parser. Fail visibly at capacity when no safely removable history remains.

## 9. Implementation Tasks

Effort levels: Low = small isolated change; Medium = a component with local branching and tests; High = host integration, lifecycle coordination, or multiple security boundaries. These are planning estimates, not code-size targets.

All methods below are planned contracts. Async signatures may be refined after the feasibility test. No implementation in the current repository can be copied.

| ID | Location and method/task | Responsibility | Depends on | Can Copy From | Effort |
|----|--------------------------|----------------|------------|---------------|--------|
| T01 | `package.json`, `tsconfig.json`, `esbuild.mjs`, development/test configuration | Create minimal extension scaffold; pin compatible APIs and toolchain; verify build and extension-host activation. Preserve existing files. | None | Official VS Code extension samples; adapt scaffolding | Medium |
| T02 | `src/tool.ts`: `prepareInvocation(options, token)` and `invoke(options, token)` feasibility version; native tree probe | Demonstrate one explicit Copilot invocation with matching ranges; render colored filename text in Explorer and the dedicated section, toggle it, and verify neutral files remain unaffected. Check version and policy assumptions. | T01 | Official chat and tree samples for API shape only | High |
| T03 | `src/model.ts`: types; `src/config.ts`: constants and settings | Define the contracts in Sections 7-8 and validate configured numeric bounds. | T02 accepted | Need to implement | Low |
| T04 | `src/session.ts`: `start(label: string): Promise<TrackerSession>` | Allocate UUID/root IDs and immutable window ownership; refuse a second recording session in the same window. | T03 | Need to implement | Medium |
| T05 | `src/session.ts`: `requireRecording(id: string): TrackerSession`, `setState(id, state): Promise<void>` | Validate explicit attribution; coordinate pause/resume/stop and in-flight cancellation; never auto-switch attribution. | T04 | Need to implement | High |
| T06 | `src/read.ts`: `resolveReadableFile(filePath: string): Promise<ResolvedFile>` | Implement canonical containment, scheme/size checks, exclusions, and policy gates before reading. | T03 | Node/VS Code filesystem APIs; need policy logic | High |
| T07 | `src/read.ts`: `readRange(input: ReadInput, token: CancellationToken): Promise<ReadSnapshot>` | Snapshot text, validate line bounds, handle EOF/dirty buffers, calculate revision, and prepare bounded complete lines. | T06 | VS Code text document APIs; need semantics | High |
| T08 | `src/tool.ts`: production `prepareInvocation` and `invoke` | Combine session ownership, safe reads, confirmation, output formatting, cancellation, and persisted outcome ordering from Flow A. | T05, T07, T10 | T02 prototype after validation | High |
| T09 | `src/store.ts`: `load(): Promise<TrackerSession[]>` | Validate persisted schema, restore closed/interrupted history safely, and isolate corrupt records and live foreign writers. | T03 | Need to implement | Medium |
| T10 | `src/store.ts`: `saveSession(session)`, `append(event)`, `flush()` | Serialize bounded per-session mutations, deduplicate IDs, atomically replace JSON, and surface write failures. | T09 | Need to implement | High |
| T11 | `src/store.ts`: `prune(now)`, `deleteSession(id)`, `clearHistory()` | Apply age/count/byte limits, exclude live writers, drain queues, and confirm explicit destructive commands. | T05, T10 | Need to implement | High |
| T12 | `src/analytics.ts`: `mergeRanges(ranges: LineRange[]): LineRange[]` | Merge sorted overlapping/adjacent inclusive intervals without enumerating every line. | T03 | Need to implement | Medium |
| T13 | `src/analytics.ts`: `summarize(events): SessionSummary`, `compare(left, right): SessionComparison` | Count only prepared responses; group by root/path/revision; report overlap and outcomes without quality/cost claims. | T12 | Reuse `mergeRanges` | Medium |
| T14 | `src/views.ts`: `getChildren(node?)`, `getTreeItem(node)`, `selectSession(id)` | Lazy repository hierarchy including neutral files, directory metadata refresh, session picker, stable root-qualified IDs, accessible states, and file read details. | T06, T09, T13 | Official tree view sample for API shape | Medium |
| T15 | `src/views.ts`: `provideFileDecoration(uri, token)`, `refreshFileColors()`, `openRead(event)`, `updateDecorations(editor, session)` | Handle display and real-file URIs with non-propagating color/badge metadata; invalidate old/new URIs on toggle/session/deletion; revalidate navigation and suppress stale editor highlights. | T06, T13, T14 | VS Code file decoration and navigation APIs | Medium |
| T16 | `src/commands.ts`: `registerCommands(context, services)`, `toggleFileColors(): Promise<void>` | Register session controls, selection, read details, compare/export/delete, and separate file-color/editor-highlight toggles. Persist fileColorsEnabled in workspace state, update menu context, and refresh without altering recording. | T05, T11, T14, T15 | Need to implement | Medium |
| T17 | `src/store.ts`: `exportSession(id, options): Promise<ExportPayload>` | Produce schema-versioned JSON with provenance and optional path/label redaction; write only after user chooses destination. | T10, T13 | Reuse persisted schema validation | Medium |
| T18 | `src/extension.ts`: `activate(context)`, `deactivate()` | Register tool, coverage view, scoped file decoration provider, commands, and settings; restore toggle state; own directory watchers/listeners and flush on shutdown. | T08, T14-T17 | Official activation pattern; need lifecycle coordination | Medium |
| T19 | `src/test/core.test.ts` | Pure tests for ranges, attribution, policy validation, storage, export, capacity, and error/cancellation behavior. | T03-T13, T17 | Mocha and Node assertion APIs | High |
| T20 | `src/test/extension.test.ts` | Host tests for repository enumeration without false reads, Explorer filename text colors, toggle persistence, recording while hidden, neutral files/folders, session isolation, trust, and Windows paths; visually verify native themes. | T18, T19 | Official extension testing sample | High |
| T21 | `README.md`, `.vscodeignore`, packaging/CI configuration | Document coverage/privacy, add repeatable gates, inspect VSIX contents, and complete the controlled Copilot demo. | T20 | Official packaging guidance | Medium |

Write tests alongside each component; T19 and T20 represent the final consolidated suite and missing-case pass, not a deferred testing phase.

## 10. Milestones and Dependencies

| Phase | Tasks | Deliverable and exit gate | Estimate |
|-------|-------|---------------------------|----------|
| 0. Feasibility | T01-T02 | Typechecked prototype; explicit Copilot invocation and scoped native-tree coloring/toggle verified; VS Code/Copilot versions recorded; policy and session limitations accepted. Stop if attribution or instrumented adoption is unsuitable. | 1-2 engineer-days |
| 1. Trusted capture | T03-T11 | Recording session, safe bounded reads, revision-correct ranges, deterministic attribution, and durable metadata. Negative security and cancellation tests pass. | 4-6 engineer-days |
| 2. Visibility | T12-T18 | Repository tree with session-scoped file colors and persistent appearance-only toggle; summaries/details, navigation, optional editor highlights, and export. | 3-4 engineer-days |
| 3. Validation and packaging | T19-T21 | Completed regression suite, performance measurement, inspected VSIX, and reproducible demo. | 2-3 engineer-days |

Total: approximately 10-15 engineer-days for one engineer familiar with TypeScript, excluding approvals or unavailable platform capabilities. Overall complexity: High. Phase 0 is the primary uncertainty gate.

The critical path is T01 -> T02 -> contracts and safe capture -> durable tool integration -> activation/UI integration -> host validation -> packaging. After T03, read validation, storage, and pure analytics can proceed independently against the agreed contracts. UI development can use synthetic events after T13. Parallel tracks describe sequencing options; this plan does not assign people or launch agents.

### Effort Summary

| Component | Low | Medium | High |
|-----------|-----|--------|------|
| Scaffold and feasibility (T01-T02) | 0 | 1 | 1 |
| Contracts, sessions, reads (T03-T08) | 1 | 1 | 4 |
| Storage and retention (T09-T11) | 0 | 1 | 2 |
| Analytics, UI, commands, export, wiring (T12-T18) | 0 | 7 | 0 |
| Verification and packaging (T19-T21) | 0 | 1 | 2 |
| Total: 21 tasks | 1 | 11 | 9 |

## 11. Proposed File Changes

These are implementation-stage paths, not files created by this plan. Keep the structure compact; split modules further only when behavior warrants it.

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `README.md` | Setup, Agent Read Coverage section and color toggle, explicit tool/session workflow, limitations, privacy, test/demo instructions. |
| Keep | `.gitignore` | Existing extension artifact exclusions; extend only if the selected scaffold introduces new output. |
| Create | `package.json`, `package-lock.json`, `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs` | Manifest, reproducible dependencies, build, and static checks. |
| Create | `.vscode/launch.json`, `.vscode/tasks.json` | Extension Development Host debugging and repeatable build/test tasks. |
| Create | `.vscode-test.mjs` | Extension-host test runner configuration. |
| Create | `.vscodeignore` | Exclude test artifacts, traces, fixtures, local configuration, and development-only files from VSIX. |
| Create | `src/extension.ts`, `src/config.ts`, `src/model.ts` | Lifecycle, settings, shared contracts. |
| Create | `src/session.ts`, `src/read.ts`, `src/tool.ts`, `src/store.ts` | Session ownership, safe reads, tool adapter, persistence. |
| Create | `src/analytics.ts`, `src/views.ts`, `src/commands.ts` | Metrics, repository tree, scoped file decorations, navigation, and toggle/session commands. |
| Create | `src/test/core.test.ts`, `src/test/extension.test.ts` | Consolidated pure and host tests with temporary synthetic workspaces. |
| Create | `.github/workflows/ci.yml` | Typecheck, lint, tests, and package inspection; no automatic publication. |

Expected implementation footprint: 1 existing file modified, 22 files created, and the existing ignore file retained. Prefer runtime-generated temporary fixtures over checked-in source traces. No service, database, or infrastructure deployment is needed.

## 12. Integration and Configuration

| Surface | Registration or integration |
|---------|-----------------------------|
| Tool contribution | Define `name`, `displayName`, `modelDescription`, `userDescription`, `inputSchema`, `canBeReferencedInPrompt`, `toolReferenceName`, and trust/session-aware availability. Registration name must match `lm.registerTool`. |
| Activation | Verify tool-driven activation against the selected minimum VS Code release. Avoid a permanent startup watcher just to observe Copilot. |
| Commands and menus | Use the `agentContextTrace.*` prefix. Command handlers must enforce state even when called outside menus. |
| View and status | Contribute Agent Read Coverage under `views.explorer`. View description identifies the displayed session; status identifies the recording session separately. Provide native picker and file-detail commands. |
| File colors | Register `FileDecorationProvider` for this view's display-URI scheme and actual `file:` URIs in the selected session's recorded-path index; set color, `R` badge, tooltip, and `propagate: false`. Return no decoration when disabled, neutral, or outside scope. Contribute light/dark/high-contrast theme defaults. |
| Toggle wiring | Bind view-title and Command Palette actions to `agentContextTrace.toggleFileColors`; expose `agentContextTrace.fileColorsEnabled` as a menu context key. Persist its boolean in workspace state, and fire both tree and file-decoration changes to clear cached markers immediately. |
| Event refresh | Store changes update the selected session's metadata index; lazy directory listing/watchers maintain structure without opening file contents. Invalidate old and new session URIs when selection changes. Editor listeners update line highlights only, never generate read events. |
| Settings | Keep file-color visibility as local workspace state, separate from the optional `agentContextTrace.decorateReads` editor setting. Retention, session limits, and exclusions remain independently configured. |
| Dependencies | Lock versions and preserve the configured npm registry without checking in private endpoints. Bundle runtime dependencies and inspect licenses/VSIX contents. |
| Host support | Pin tested API versions; declare trust/virtual-workspace restrictions and reject unsupported remote hosts explicitly. A working extension host is not proof of Copilot integration. |

## 13. Validation Strategy

### Test Matrix

| Area | Discriminating cases | Expected result |
|------|----------------------|-----------------|
| Feasibility | In a synthetic file request lines 2-4 through `#agentContextRead`; perform a built-in read separately. | Numbered response and one attributed event agree exactly for the contributed tool; built-in read is not falsely logged. |
| Range semantics | CRLF/LF, empty file, final newline, EOF clamp, reversed/non-integer bounds, huge single line, output-budget rejection. | Actual returned ranges match complete response lines; invalid requests never inflate metrics. |
| Repeated reads | Same-revision ranges 1-10 and 5-15; repeat at a changed revision. | First pair gives volume 21, unique 15, repeated 6; changed revision remains separate. |
| Scope/security | Traversal, sibling-prefix directory, Windows casing, symlink/junction escape, secret exclusion, external URI, binary, oversized dirty buffer. | Access denied before content return; no raw denied inputs/source in stored errors. |
| Sessions | Missing/wrong ID, concurrent tool calls, pause/stop mid-read, window switch, reload, two windows on the same workspace. | No cross-session attribution, lost updates, accidental auto-resume, or foreign-writer modifications. |
| Persistence | Failed write, malformed JSON, future schema, duplicate event ID, crash boundary, delete during queued write. | Visible failure, safe recovery, no silent overwrite, no resurrected deleted data, no model-delivery claim. |
| Retention | Age/count/byte limits, live sessions, full capacity with no removable history. | Prune only safe closed history; block further tracked capture visibly when necessary. |
| UI/navigation | Dirty edit, undo, renamed/deleted file, stale revision, detached root, keyboard-only use, high-contrast theme. | No misleading live highlights or wrong-file navigation; accessible and explicit state. |
| Repository colors | Read only one of several visible files, then issue a rejected/cancelled read for another. Expand folders and open a file manually. | Only a prepared recorded read produces color/`R` badge; other files and folders remain neutral. Listing/opening files creates no agent-read events. |
| Color toggle | Turn colors off during recording, perform another tracked read, reload, and toggle on again. Exercise the editor-highlight setting separately. | Markers disappear immediately, capture continues, off state survives reload, and all retained markers return on enable. No pause, deletion, source edits, or change to editor-highlight preference. |
| Color scope | Switch sessions, delete selected history, inspect built-in Explorer filename text and duplicate filenames in multi-root workspaces. | No stale-session or cross-root colors; both Explorer and the dedicated section reflect the selected session. Unrecorded files/folders receive no extension decoration. Other providers remain installed and may affect the displayed color. |
| Privacy/export | Synthetic source and prompt markers, sensitive labels, redacted export, local debug output inspection. | No source/prompt/auth material persists; path/label redaction works; exports remain explicit and scoped. |
| Packaging | Install resulting VSIX into a clean profile and inspect archive contents. | Commands/view/tool register; no trace files, secrets, or development-only artifacts ship. |

Run pure tests without a Copilot account. Use extension-host tests to invoke the tool adapter deterministically. Keep the real Copilot session as a separate manual acceptance gate with a signed-in account; automated adapter tests must not be reported as an end-to-end Copilot pass.

### Performance Targets

- At the 10,000-event limit, cold history load and summary computation should complete within 2 seconds on a documented reference machine.
- Target under 200 ms p95 incremental tracking overhead per bounded read, excluding human confirmation, model/network time, and baseline file access. Measure against the same reader with metadata recording disabled in the benchmark harness.
- Debounce native view/decorations updates and calculate interval unions rather than materializing every line. Test responsiveness with many files and repeated overlapping intervals.
- Validate lazy tree expansion and color toggling in a large repository without bulk document opens or snapshot hashing; refresh only materialized nodes and affected display URIs where possible.
- Record actual measurements before claiming the targets are met. Adjust limits or storage implementation based on evidence.

### Required Commands After Scaffold

Establish `npm ci`, `npm run check-types`, `npm run lint`, `npm run test:unit`, `npm run compile`, `npm run test:extension`, and `npm run package`. These commands are proposed and do not exist yet. CI must use an approved, authenticated registry configuration without exposing credentials; use a headless display where required for Linux extension-host tests.

### Demo Acceptance Checklist

- [ ] Start a named tracker session and explicitly invoke its tool from Copilot.
- [ ] Show repository files in Agent Read Coverage and demonstrate a recorded file gaining color and an `R` badge while neutral files stay unchanged.
- [ ] Toggle file colors off, record another read, then toggle on and show both markers without interrupting capture.
- [ ] Verify the off preference survives reload, recorded Explorer filename text returns to its normal theme/provider color, and source content remains unchanged.
- [ ] Switch displayed tracker sessions and verify old colors clear; test the independent editor line-highlight setting.
- [ ] Read overlapping ranges and show correct volume, unique-line, and repetition metrics.
- [ ] Edit the file and demonstrate revision separation and stale-highlight suppression.
- [ ] Show that a built-in Copilot read is outside coverage, not secretly intercepted.
- [ ] Reject an excluded/out-of-workspace file and cancel an in-flight read safely.
- [ ] Pause, resume, stop, reopen history, and compare two tracker sessions.
- [ ] Export redacted metadata and delete local history without it reappearing.
- [ ] Install and run the packaged VSIX in a clean profile.

## 14. Risks and Follow-Up Decisions

| Risk or decision | Response |
|------------------|----------|
| Instrumented tool is inconvenient or bypassed | Validate adoption in Phase 0; disclose coverage in every result. A future passive adapter requires separately verified supported APIs. |
| Session labels are mistaken for Copilot session identities | Use explicit tracker terminology and IDs; do not inspect opaque tokens or private storage. |
| Custom reads bypass expected policy restrictions | Review exclusions and enterprise requirements before real-code use; demonstrate first on synthetic content. |
| Local metadata reveals sensitive project structure | Minimize retained fields, avoid repository storage, disclose sensitivity, support redacted export and deletion. |
| Read count is mistaken for efficiency or correctness | Pair future evaluations with task outcomes and measured latency/token data. Repeated reads alone do not justify optimization. |
| File changes invalidate historical locations | Fingerprint snapshots; never silently apply old highlights to changed content. |
| Platform API changes | Pin the tested minimum version and add compatibility checks before expansion. Private Copilot logs are not a fallback dependency. |
| Publishing or telemetry scope expands | Require a separate decision. No automatic Marketplace publishing, cloud collection, repository pushes, or source retention. |

An initial pilot should measure whether developers locate and explain context issues faster using the extension than using the existing Copilot UI. Treat that comparison as product validation, distinct from technical test coverage.

## 15. References

- [VS Code Language Model Tool API guide](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code Workspace Trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [VS Code Tree View guide](https://code.visualstudio.com/api/extension-guides/tree-view)
- [VS Code FileDecorationProvider reference](https://code.visualstudio.com/api/references/vscode-api#FileDecorationProvider)
- [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [VS Code extension packaging and publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Official chat tool sample](https://github.com/microsoft/vscode-extension-samples/blob/main/chat-sample/src/tools.ts)

API guidance was checked while drafting this plan. The exact installed VS Code/Copilot versions, minimum compatible engine version, and real tool invocation remain Phase 0 verification work, not completed implementation claims.