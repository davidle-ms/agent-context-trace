# Agent Context Trace

A VS Code extension that colors filename text in the built-in **Explorer** and **Agent Read Coverage** section from a selected Copilot chat's recorded reads. Toggle the colors without stopping history refresh or optional tracker recording.

## Preview Status

The preview includes an existing Copilot chat picker, a read-only local-history adapter, a native repository tree, and persistent color toggle. Explicit instrumented tracker sessions remain available as an optional fallback. This is not a complete observer of all Copilot activity.

**Existing chat mode** recognizes supported completed/confirmed `copilot_readFile` entries in saved VS Code chat history. It does not require starting a tracker or using `#agentContextRead`. **Tracker mode** records only reads through that contributed tool. Neither mode infers reads from file visibility, search results, terminal commands, or prompt attachments. A colored file means recorded evidence exists at that path, not that the whole file or current revision was read or understood.

## Run Locally

Requires Node.js 22 or later, npm, desktop VS Code, and a trusted local workspace. Remote and virtual workspaces are not supported. The build targets the stable VS Code 1.100 API; runtime checks have been performed on Windows with VS Code 1.138.0. Other platforms and the minimum runtime version still need validation.

1. Run `npm ci --omit-lockfile-registry-resolved=true` using your configured npm registry.
2. Run `npm run compile`.
3. Press **F5** and select **Run Extension** to open an Extension Development Host.
4. Open a trusted local repository in that window. Start with synthetic or non-sensitive files.
5. Expand **Agent Read Coverage** in Explorer.

Alternatively, run `npm run package` and install the resulting VSIX using **Extensions: Install from VSIX**. The repository is private and the preview is unlicensed; do not publish it to the Marketplace without a separate licensing and release decision.

## Choose an Existing Copilot Chat

1. Click the history button in Agent Read Coverage, or run **Agent Context Trace: Choose Copilot Chat Session**.
2. On first use, approve read-only access to local history. This adapter uses private, version-dependent storage, not a supported cross-extension Copilot API.
3. Select an existing chat by title and saved-update time. No new tracker session is created, no prompt needs changing, and the Copilot chat itself is not opened or modified.
4. Filenames with recognized read entries turn blue in this repository. Reads pointing outside the current workspace or excluded paths are not displayed.
5. Continue using that chat normally in Copilot. The extension watches the selected history file and refreshes when VS Code saves changes. Use **Refresh Repository** if a write notification is missed. Updates can lag the live conversation.
6. Use **Toggle Read Colors** to show/hide markers without detaching from history. The selected history file and consent choice are remembered locally for reloads.

The section shows a live count of reads mapped to this repository. If it is empty, its status distinguishes no completed supported reads saved yet from recorded reads that do not map to included workspace files. The status updates when history changes instead of leaving a stale one-off notification. Selection rereads the file after attaching its watcher to cover saves during initial loading.

The picker checks saved chats across workspace storage in this VS Code profile and the default profile (useful when the preview runs in a separate profile). It displays the most recent 100 eligible files and checks up to 200 workspace directories per profile. Chats from other profiles or locations can be selected using **Browse a chat history folder...** or **Open a chat JSON or JSONL file...**. Some chats have no saved title and appear with a short ID. Cloud-only, unsaved, and unsupported-format sessions might not appear.

Supported input is the observed VS Code JSON snapshot or JSONL format with snapshot, replacement, and array-append records. Inputs are limited to 32 MiB and 10,000 mapped reads; other formats fail visibly rather than invent coverage. Only explicit file links in supported read-tool entries produce markers. Missing range/revision metadata is shown as unavailable; the extension does not hash today's file and claim it is the historical revision. It does not highlight unverifiable historical ranges. A chat with no supported reads leaves files neutral, which does not prove they were never read.

**Delete Tracker / Disconnect Chat History** disconnects an existing chat selection without deleting the original chat. Selecting a different chat replaces the colors, rather than combining unrelated sessions.

## Optional Instrumented Tracker

1. Run **Agent Context Trace: Start Session** and enter a name. This copies a tool reference with the tracker session ID to your clipboard.
2. Enable **Read File with Context Trace** in Copilot's tools picker, then paste the reference into your prompt. The tool name for APIs is `read_agent_context`; the prompt reference is `#agentContextRead`.
3. Ask Copilot to read a specific file and range through that tool. Approve the tool confirmation as appropriate.
4. Recorded filenames turn blue and gain an `R` badge in the built-in Explorer and Agent Read Coverage. Folders and files with no recorded reads receive no decoration from this extension.
5. Use the eye button or **Agent Context Trace: Toggle Read Colors** to hide or show markers. The preference survives restarting VS Code. Recording continues while markers are hidden.

Keep VS Code's `explorer.decorations.colors` enabled to see the filename color. Customize it with the `agentContextTrace.readFileForeground` theme color. Selection styling and other providers such as Git can affect the final displayed color; turning this extension's colors off restores the remaining theme/provider styling, not necessarily plain white text. VS Code's file decorations are shared, so recorded-file decorations may also appear in editor tabs or Open Editors. Source content is never changed by coloring.

Example after replacing the session ID and absolute file path:

```text
Use #agentContextRead with sessionId "<copied tracker ID>" to read
lines 1-20 of "<absolute workspace file path>" and summarize them.
Do not bypass the tool's exclusions using another tool.
```

Use **Pause / Resume Session** or **Stop Session** to control tracker recording separately. Use **Select Tracker History** for previously recorded tracker sessions; displaying a session does not change which tracker is recording. Sessions from a previous process do not automatically resume. A tracker still marked recording/paused is shown as "other window or interrupted" because this preview cannot safely identify whether its owner is still running.

Click a file to open it, or use **Show Recorded Read Details** to inspect its ranges, timestamps, and revisions. Selecting a range highlights it only if the current document fingerprint matches; otherwise the file opens with a stale-revision warning. These are explicit navigation selections, not a continuous editor heatmap.

## Privacy and Limits

- Existing-chat mode reads local files that can contain prompts and source code in memory, after opt-in. It retains only derived read metadata in memory and the consent/source-file selection in extension workspace state; it does not duplicate or modify the chat file. Explicit exports contain derived metadata only. Chat titles, paths, and timestamps remain sensitive.
- Historical coverage is best effort and version-dependent. Completed/confirmed tool entries are evidence of recorded activity, not proof of successful model consumption. Copilot's original save/retention behavior determines which entries remain available.
- Source is returned to Copilot when the read tool is invoked. The extension itself sends no trace telemetry to a separate service.
- Persisted metadata includes relative paths, tracker labels, timestamps, ranges, document fingerprints, and whether a buffer was unsaved. No source text, prompts, auth tokens, or tool response bodies are saved in the trace.
- Metadata is stored as JSON under the extension's workspace storage, outside the repository. It is not encrypted and can reveal project structure. Disk sync and backup policies still apply.
- Explicit export offers path/label redaction. Fingerprints, timestamps, and opaque root IDs remain metadata; redaction is not a guarantee of anonymity.
- Reads are limited to local workspace text files of at most 1 MiB, up to 500 lines per request, and bounded response size/token budget. Traversal and symlink/junction escapes are rejected. The tree omits symbolic links and follows applicable `files.exclude` display rules.
- Default read exclusions cover `.git`, dependencies, environment files, common credential locations, and private-key formats. Additional user-defined restrictions use `agentContextTrace.excludeGlobs` (workspace-relative glob patterns).
- **Copilot content exclusions and organization policies are not inherited by this custom tool.** Review policy compatibility before enabling it on organizational code. These checks are not a security sandbox against a hostile filesystem.
- Tracker mode records prepared successful responses only. Denied/failed/cancelled reads do not create tracker markers. Persistence happens before returning the response, so a crash or cancellation at delivery can leave an event without proof of model receipt.
- Tracker limits are 1,000 read events per session, 100 session files, and 4 MiB per session. Old stopped tracker sessions are pruned after 30 days when starting a new tracker. Only stopped tracker sessions can be deleted. Copilot's original history is never pruned or deleted by this extension.

## Development and Tests

| Command | Purpose |
|---------|---------|
| `npm run check-types` | Strict TypeScript validation. |
| `npm run compile` | Compile tests and bundle the extension. |
| `npm run test:unit` | Eleven tests covering chat-history replay/extraction, live empty-state/read-count feedback, read-only handling, range semantics, path scope, metrics, persistence failures, and tracker attribution. |
| `npm run test:extension` | Existing-chat selection without a tracker, saved-history watcher updates, Explorer filename colors and screenshots, toggle, session restoration, and normal-window restart tests. |
| `npm run package` | Produce a self-contained VSIX without runtime npm installation. |

The host test runner downloads VS Code 1.100.0 by default. To use an installed executable in PowerShell, set `$env:VSCODE_EXECUTABLE_PATH` to the full path of its executable before running the test command. Tests use temporary workspaces/profiles, and screenshots are written to the ignored `.vscode-test/screenshots` directory. Only the test windows expose local debugging endpoints; the extension does not start a server.

VS Code intentionally uses in-memory workspace/profile storage when `--extensionTestsPath` is present. The persistence regression therefore launches two **normal** isolated development windows and operates the UI through Playwright, rather than expecting test-mode storage to survive another process. See the [VS Code storage implementation](https://github.com/microsoft/vscode/blob/main/src/vs/platform/storage/electron-main/storageMainService.ts).

Tests use synthetic Copilot history fixtures and direct adapter calls. The history parser was also checked read-only against local VS Code 1.138.0 chat data, producing only aggregate read counts during validation. These checks do **not** constitute a signed-in, end-to-end live Copilot conversation test; that remains a manual acceptance gate.

## Remaining Work

The [implementation plan](docs/IMPLEMENTATION-PLAN.md) describes the larger target. Remaining work includes authenticated Copilot acceptance and policy review, minimum-version and cross-platform checks, cross-session analytics, continuous editor highlights, rejected-call history, robust interrupted-session cleanup, a global disk budget, large-repository performance testing, and CI/release automation. The initial view uses a single toggle icon; separate state-specific menu labels are also planned.
