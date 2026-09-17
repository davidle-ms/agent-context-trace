# Agent Context Trace

A VS Code extension that shades filenames in the built-in **Explorer** and recorded sections inside open editors by how often they were read in the selected session. Editor sections use progressively stronger amber backgrounds with amber edge markers; Explorer filenames use matching amber frequency shades. Syntax colors are unchanged, and no inline count labels are added. **Agent Read Coverage** contains session controls, status, and an interactive heatmap of the open file, with no duplicate file tree. The eye toggle controls filenames, editor shading, and the heatmap without stopping history refresh or optional tracker recording.

## Preview Status

The preview includes an existing Copilot chat picker, a read-only local-history adapter, built-in Explorer and editor-section decorations, a hover-to-navigate file heatmap, and a persistent color toggle. Explicit instrumented tracker sessions remain available as an optional fallback. This is not a complete observer of all Copilot activity.

**Existing chat mode** recognizes supported completed/confirmed `copilot_readFile` entries in saved VS Code chat history. It does not require starting a tracker or using `#agentContextRead`. **Tracker mode** records only reads through that contributed tool. Neither mode infers reads from file visibility, search results, terminal commands, or prompt attachments. A colored file means recorded evidence exists at that path, not that the whole file or current revision was read or understood.

## Run Locally

Requires Node.js 22 or later, npm, desktop VS Code, and a trusted local workspace. Remote and virtual workspaces are not supported. The build targets the stable VS Code 1.100 API; runtime checks have been performed on Windows with VS Code 1.138.0. Other platforms and the minimum runtime version still need validation.

1. Run `npm ci --omit-lockfile-registry-resolved=true` using your configured npm registry.
2. Run `npm run compile`.
3. Press **F5** and select **Run Extension** to open an Extension Development Host.
4. Open a trusted local repository in that window. Start with synthetic or non-sensitive files.
5. Expand **Agent Read Coverage** in Explorer for its session controls and active-file heatmap. Browse files in the normal Explorer above it.

Alternatively, run `npm run package` and install the resulting VSIX using **Extensions: Install from VSIX**. The repository is private and the preview is unlicensed; do not publish it to the Marketplace without a separate licensing and release decision.

## Choose an Existing Copilot Chat

1. Click the history button in Agent Read Coverage, or run **Agent Context Trace: Choose Copilot Chat Session**.
2. On first use, approve read-only access to local history. This adapter uses private, version-dependent storage, not a supported cross-extension Copilot API.
3. Select an existing chat under **This Repository** at the top, or **Other Sessions** underneath. Each group is sorted by most recently saved first, with timestamps displayed in local time. No new tracker session is created, no prompt needs changing, and the Copilot chat itself is not opened or modified.
4. Filenames with recognized read entries turn amber in this repository. Reads pointing outside the current workspace or excluded paths are not displayed.
5. Continue using that chat normally in Copilot. The extension watches the selected history file and refreshes when VS Code saves changes. Use **Refresh Repository** if a write notification is missed. Updates can lag the live conversation.
6. Use **Toggle Read Colors** to show/hide markers without detaching from history. The selected history file and consent choice are remembered locally for reloads.

The section shows a live count of reads mapped to this repository. If it is empty, its status distinguishes no completed supported reads saved yet from recorded reads that do not map to included workspace files. The status updates when history changes instead of leaving a stale one-off notification. Selection rereads the file after attaching its watcher to cover saves during initial loading.

The picker checks saved chats across workspace storage in this VS Code profile and the default profile (useful when the preview runs in a separate profile). It displays up to 100 eligible chats **per group** and checks up to 200 workspace directories per profile, always including the current workspace's history folder. Newer chats from elsewhere cannot displace this repository's chats. The **Open History** section at the bottom contains **Browse a chat history folder...** and **Open a chat JSON or JSONL file...** for additional locations. Some chats have no saved title and appear with a short ID. Cloud-only, unsaved, and unsupported-format sessions might not appear.

Grouping uses VS Code's saved workspace association, not chat titles or incidental file-read matches. Single-folder sessions match that folder against the currently open roots; multi-root sessions match when any saved workspace root matches a current root. Relative paths, file URIs, JSON-with-comments workspace files, canonical paths, and Windows casing are supported. Matching is exact, so a sibling or parent directory is not assumed to be this repository; separate clones/worktrees are also distinct. Missing, remote, or unreadable workspace metadata stays under **Other Sessions**, with an unknown workspace label where needed. When no chats match this repository, the picker says so and still offers the remaining chats. Reading this association does not modify workspace or chat files.

The full-width horizontal line between the last repository chat and the first other chat is a native Quick Pick group border. For more contrast, add `"pickerGroup.border": "#8594A6"` to `workbench.colorCustomizations` in the desired VS Code profile. This colors all Quick Pick group borders in that profile, not only this boundary; thickness is controlled by VS Code. The extension does not change theme settings automatically. Group names stay plain, without decorative dashes. The native UI test temporarily applies this color in its isolated test profile, checks the actual border's position and width, and restores the setting afterward.

Supported input is the observed VS Code JSON snapshot or JSONL format with snapshot, replacement, and array-append records. Inputs are limited to 32 MiB and 10,000 mapped reads; other formats fail visibly rather than invent coverage. Only explicit file links in supported read-tool entries produce filename markers. Line ranges are extracted from `#L2-L5` links or an explicit single-file message ending in `lines 2 to 5`. A numeric navigation anchor alone is not treated as a read section. Missing metadata stays unknown; the extension never hashes today's file and claims it is the historical revision. A chat with no supported reads leaves files neutral, which does not prove they were never read.

**Delete Tracker / Disconnect Chat History** disconnects an existing chat selection without deleting the original chat. Selecting a different chat replaces the colors, rather than combining unrelated sessions.

## Highlighted File Sections

Open a file in the normal editor after selecting a chat or tracker session. Recorded ranges use amber whole-line shading with amber left-edge and overview-ruler markers. Background intensity increases with read frequency, without recoloring the code text. Hover over a section for its exact count, range, and source-version information. The existing eye toggle shows or hides both filename colors and section highlights.

| Highlight | Meaning |
|-----------|---------|
| Subtle amber | 1 recorded read. |
| Medium amber | 2-3 recorded reads. |
| Strong amber | 4-7 recorded reads. |
| Strongest amber | 8 or more recorded reads. The exact count remains in the tooltip. |
| No shading | Line numbers are absent/invalid, the file is too large, the recorded revision does not match, or highlighting is disabled. Filename colors may still be present. |

The scale is fixed, not relative to the most-read file. Both tracker and saved-chat evidence use the same amber backgrounds and markers at the same counts. Amber means recorded read frequency here, not an error, warning, or unverified source revision. More reads increase the background opacity on both light and dark themes. A short scale legend is shown in Agent Read Coverage. The shade does not imply model understanding, task quality, or that a historical range matches today's contents. Existing theme color IDs are preserved, so explicit user overrides still take precedence over these defaults.

Editor counts are **per line**: reads of lines 1-10 and 5-15 shade lines 5-10 more strongly (two reads) and leave the rest at one read. Adjacent spans merge only when they have the same count and evidence type. Explorer filename counts are **distinct recorded calls to that file** across the selected session, including calls with missing line numbers and earlier revisions. Such calls do not add to current-line counts. Repeated event IDs, view refreshes, and toggling do not inflate counts; choosing another session replaces them. Persisted history remains unchanged.

For saved-chat ranges without a source revision, the tooltip says **"Historical range; file may have changed."** Tracker ranges with a matching fingerprint identify that match in the tooltip. Missing line numbers never produce a section highlight.

Unrelated lines are not shaded. Out-of-bounds ranges are skipped, not silently reassigned to other lines. Editor counts include only reads whose snapshot matches the current document, or allowed history guides with unknown revisions; different known revisions are not added together at today's line positions. Editing a document clears stale verified highlights; they can return when the content again matches the recorded fingerprint. Historical guides are suppressed for dirty buffers and after edits observed while that session is selected. Switching away and back to a history session resets this observation guard, but its guides remain explicitly unverified.

Disable `agentContextTrace.showUnverifiedHistoryRanges` to show only revision-verified sections. The default is `true` so saved-chat ranges can be inspected with the historical-version tooltip. Theme IDs for one-read sections remain `agentContextTrace.readSectionBackground` and `agentContextTrace.readSectionBorder`. Higher-frequency backgrounds use `agentContextTrace.readSectionRepeatBackground`, `agentContextTrace.readSectionFrequentBackground`, and `agentContextTrace.readSectionIntenseBackground`. Their borders, ruler markers, and Explorer filename shades use `agentContextTrace.readFileRepeatForeground`, `agentContextTrace.readFileFrequentForeground`, and `agentContextTrace.readFileIntenseForeground` respectively.

Only visible local editors with matching recorded paths are processed, including split panes. Document fingerprints are cached by document version in memory, are not persisted for history guides, and are bounded to 1 MiB. Opening files or updating decorations never generates agent-read events or modifies source. The absence of section highlights is not proof that the agent did not read that section.

## File Heatmap

Choose a session, then open a local workspace file. **Agent Read Coverage** follows the active editor and shows its relative path, a vertical map from line 1 to the last line, and the same four amber frequency shades used inside the editor. It does not add a second file browser. In split editors, the most recently active text editor is the navigation target; focusing the heatmap retains that target while it stays visible.

Move the pointer down the map to scroll the corresponding source line into view, centered where possible. Hovering does not move the cursor, change selections, edit source, or record reads. The readout updates to `Line {number} / {total lines}` as the pointer moves and shows the exact displayed count and revision caveat. It stays visible in a separate footer while the map scrolls. Hovering source text in the active file also updates the readout and map marker, without scrolling the editor or changing its selection. Source-text updates use VS Code's hover provider and respect its hover delay and enabled setting; they do not add another tooltip. Click the map to focus that line in the editor. With keyboard focus on the heatmap, use Up/Down, Page Up/Page Down, or Home/End to navigate, and Enter/Space to focus the line.

The heatmap is at least 320px tall, with 20px of breathing room above and below it, and grows when more section height is available. Horizontal guides mark where recorded ranges start, end, or change frequency, with source-line numbers beside them. At a shared boundary, the label identifies the next range's first line. Closely spaced number labels are omitted to avoid overlap; hovering still shows the exact line. The outlined window tracks the editor's visible line range as you scroll. The map represents logical source lines, not wrapped screen rows. Long files compress multiple lines into each pixel; keyboard navigation gives exact single-line positioning. Drag the divider above Agent Read Coverage upward for a taller map. VS Code controls the section's initial height; short sections scroll rather than compressing the map below its minimum height.

The heatmap reuses the editor's displayed ranges, including revision checks, historical opt-out, dirty-buffer handling, and session isolation. Missing or stale ranges stay uncolored; they are not inferred as whole-file reads. Editing clears stale history colors in both places. The existing eye button also hides the heatmap. No-session, no-file, oversized-file, and unavailable-range states are explicit.

The embedded view receives only relative filenames, line counts, displayed read ranges, and viewport metadata, never source text or chat content. Its nonce-restricted scripts and styles load no network resources, and navigation messages are checked against the current file/session view and line bounds. Switching files or sessions invalidates pending navigation messages.

## Optional Instrumented Tracker

1. Run **Agent Context Trace: Start Session** and enter a name. This copies a tool reference with the tracker session ID to your clipboard.
2. Enable **Read File with Context Trace** in Copilot's tools picker, then paste the reference into your prompt. The tool name for APIs is `read_agent_context`; the prompt reference is `#agentContextRead`.
3. Ask Copilot to read a specific file and range through that tool. Approve the tool confirmation as appropriate.
4. Recorded filenames turn amber and gain an `R` badge in the built-in Explorer. Folders and files with no recorded reads receive no decoration from this extension; Agent Read Coverage does not list files.
5. Use the eye button or **Agent Context Trace: Toggle Read Colors** to hide or show markers. The preference survives restarting VS Code. Recording continues while markers are hidden.

Keep VS Code's `explorer.decorations.colors` enabled to see filename shades. The base `agentContextTrace.readFileForeground` theme color applies to files read once; the higher-frequency theme IDs are listed above. Selection styling and other providers such as Git or diagnostics can affect the final displayed color; turning this extension's colors off restores the remaining theme/provider styling, not necessarily plain white text. VS Code's file decorations are shared, so recorded-file decorations may also appear in editor tabs or Open Editors. Source content is never changed by coloring.

Example after replacing the session ID and absolute file path:

```text
Use #agentContextRead with sessionId "<copied tracker ID>" to read
lines 1-20 of "<absolute workspace file path>" and summarize them.
Do not bypass the tool's exclusions using another tool.
```

Use **Pause / Resume Session** or **Stop Session** to control tracker recording separately. Use **Select Tracker History** for previously recorded tracker sessions; displaying a session does not change which tracker is recording. Sessions from a previous process do not automatically resume. A tracker still marked recording/paused is shown as "other window or interrupted" because this preview cannot safely identify whether its owner is still running.

Browse and open files in the normal Explorer. Right-click a file there and choose **Show Recorded Read Details** to inspect its ranges, timestamps, and revisions. The same command in the Command Palette uses the active editor's file. Files without recorded reads show a brief informational message. Choosing a range makes a text selection only if the document fingerprint matches; otherwise the file opens with a warning. Automatic section shading is independent of the cursor selection and follows the evidence rules above.

## Privacy and Limits

- Existing-chat mode reads local files that can contain prompts and source code in memory, after opt-in. It retains only derived read metadata in memory and the consent/source-file selection in extension workspace state; it does not duplicate or modify the chat file. Explicit exports contain derived metadata only. Chat titles, paths, and timestamps remain sensitive.
- Historical coverage is best effort and version-dependent. Completed/confirmed tool entries are evidence of recorded activity, not proof of successful model consumption. Copilot's original save/retention behavior determines which entries remain available.
- Source is returned to Copilot when the read tool is invoked. The extension itself sends no trace telemetry to a separate service.
- Persisted metadata includes relative paths, tracker labels, timestamps, ranges, document fingerprints, and whether a buffer was unsaved. No source text, prompts, auth tokens, or tool response bodies are saved in the trace.
- Metadata is stored as JSON under the extension's workspace storage, outside the repository. It is not encrypted and can reveal project structure. Disk sync and backup policies still apply.
- Explicit export offers path/label redaction. Fingerprints, timestamps, and opaque root IDs remain metadata; redaction is not a guarantee of anonymity.
- Reads are limited to local workspace text files of at most 1 MiB, up to 500 lines per request, and bounded response size/token budget. Traversal and symlink/junction escapes are rejected. File browsing and display exclusions are handled by VS Code's built-in Explorer; the extension no longer enumerates directories or starts directory-listing watchers.
- Default read exclusions cover `.git`, dependencies, environment files, common credential locations, and private-key formats. Additional user-defined restrictions use `agentContextTrace.excludeGlobs` (workspace-relative glob patterns).
- **Copilot content exclusions and organization policies are not inherited by this custom tool.** Review policy compatibility before enabling it on organizational code. These checks are not a security sandbox against a hostile filesystem.
- Tracker mode records prepared successful responses only. Denied/failed/cancelled reads do not create tracker markers. Persistence happens before returning the response, so a crash or cancellation at delivery can leave an event without proof of model receipt.
- Tracker limits are 1,000 read events per session, 100 session files, and 4 MiB per session. Old stopped tracker sessions are pruned after 30 days when starting a new tracker. Only stopped tracker sessions can be deleted. Copilot's original history is never pruned or deleted by this extension.

## Development and Tests

| Command | Purpose |
|---------|---------|
| `npm run check-types` | Strict TypeScript validation. |
| `npm run compile` | Compile tests and bundle the extension. |
| `npm run test:unit` | Sixteen tests covering per-line frequency, inclusive overlaps, tier boundaries, deduplication, large intervals, revision checks, historical line-range formats, workspace association, chat replay/extraction, read-only handling, path scope, persistence, and attribution. |
| `npm run test:extension` | Native heatmap pixels, compact/expanded layouts, long-file hover alignment, keyboard navigation, cursor/source preservation, file switching, edit invalidation, four amber tiers, exact-count tooltips, split editors, shared toggle, grouped picker, and restart persistence. |
| `npm run package` | Produce a self-contained VSIX without runtime npm installation. |

The host test runner downloads VS Code 1.100.0 by default. To use an installed executable in PowerShell, set `$env:VSCODE_EXECUTABLE_PATH` to the full path of its executable before running the test command. Tests use temporary workspaces/profiles, and screenshots are written to the ignored `.vscode-test/screenshots` directory. TypeScript validation is temporarily disabled in the test profile so placeholder-code diagnostics do not override filename palette checks; normal user settings are untouched. Only the test windows expose local debugging endpoints; the extension does not start a server.

VS Code intentionally uses in-memory workspace/profile storage when `--extensionTestsPath` is present. The persistence regression therefore launches two **normal** isolated development windows and operates the UI through Playwright, rather than expecting test-mode storage to survive another process. See the [VS Code storage implementation](https://github.com/microsoft/vscode/blob/main/src/vs/platform/storage/electron-main/storageMainService.ts).

Tests use synthetic Copilot history fixtures and direct adapter calls. The history parser was also checked read-only against local VS Code 1.138.0 chat data, producing only aggregate read counts during validation. These checks do **not** constitute a signed-in, end-to-end live Copilot conversation test; that remains a manual acceptance gate.

## Remaining Work

The [implementation plan](docs/IMPLEMENTATION-PLAN.md) describes the larger target. Remaining work includes authenticated Copilot acceptance and policy review, minimum-version and cross-platform checks, cross-session analytics, rejected-call history, robust interrupted-session cleanup, a global disk budget, large-repository performance testing, and CI/release automation. The view retains the header eye toggle.
