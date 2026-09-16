# Agent Context Trace

A VS Code extension that colors the filename text of files with recorded agent reads in the built-in **Explorer** and the **Agent Read Coverage** section. Toggle the colors on or off without stopping recording.

## Preview Status

The first working slice includes a native repository tree, session controls, an instrumented read tool, local metadata storage, read details, and JSON export. It is an experimental developer preview, not a passive observer of all Copilot activity.

**Only reads through `#agentContextRead` are recorded.** Built-in Copilot reads, search results, terminal commands, prompt attachments, and other tools are outside its coverage. A colored file means at least one range at that path was recorded in the selected tracker session, not that its entire contents or current revision were read or understood.

## Run Locally

Requires Node.js 22 or later, npm, desktop VS Code, and a trusted local workspace. Remote and virtual workspaces are not supported. The build targets the stable VS Code 1.100 API; runtime checks have been performed on Windows with VS Code 1.138.0. Other platforms and the minimum runtime version still need validation.

1. Run `npm ci --omit-lockfile-registry-resolved=true` using your configured npm registry.
2. Run `npm run compile`.
3. Press **F5** and select **Run Extension** to open an Extension Development Host.
4. Open a trusted local repository in that window. Start with synthetic or non-sensitive files.
5. Expand **Agent Read Coverage** in Explorer.

Alternatively, run `npm run package` and install the resulting VSIX using **Extensions: Install from VSIX**. The repository is private and the preview is unlicensed; do not publish it to the Marketplace without a separate licensing and release decision.

## Track a Session

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

Use **Pause / Resume Session** or **Stop Session** to control recording separately. Select historical sessions with the history button; displaying a session does not change which session is recording. Sessions from a previous process do not automatically resume. A historical session still marked recording/paused is shown as "other window or interrupted" because this preview cannot safely identify whether its owner is still running.

Click a file to open it, or use **Show Recorded Read Details** to inspect its ranges, timestamps, and revisions. Selecting a range highlights it only if the current document fingerprint matches; otherwise the file opens with a stale-revision warning. These are explicit navigation selections, not a continuous editor heatmap.

## Privacy and Limits

- Source is returned to Copilot when the read tool is invoked. The extension itself sends no trace telemetry to a separate service.
- Persisted metadata includes relative paths, tracker labels, timestamps, ranges, document fingerprints, and whether a buffer was unsaved. No source text, prompts, auth tokens, or tool response bodies are saved in the trace.
- Metadata is stored as JSON under the extension's workspace storage, outside the repository. It is not encrypted and can reveal project structure. Disk sync and backup policies still apply.
- Explicit export offers path/label redaction. Fingerprints, timestamps, and opaque root IDs remain metadata; redaction is not a guarantee of anonymity.
- Reads are limited to local workspace text files of at most 1 MiB, up to 500 lines per request, and bounded response size/token budget. Traversal and symlink/junction escapes are rejected. The tree omits symbolic links and follows applicable `files.exclude` display rules.
- Default read exclusions cover `.git`, dependencies, environment files, common credential locations, and private-key formats. Additional user-defined restrictions use `agentContextTrace.excludeGlobs` (workspace-relative glob patterns).
- **Copilot content exclusions and organization policies are not inherited by this custom tool.** Review policy compatibility before enabling it on organizational code. These checks are not a security sandbox against a hostile filesystem.
- This preview records prepared successful responses only. Denied/failed/cancelled reads do not create read markers. Persistence happens before returning the response, so a crash or cancellation at delivery can leave an event without proof of model receipt.
- Limits are 1,000 read events per session, 100 session files, and 4 MiB per session. Old stopped sessions are pruned after 30 days when starting a new session. History deletion is limited to stopped sessions to avoid modifying a live foreign writer's data.

## Development and Tests

| Command | Purpose |
|---------|---------|
| `npm run check-types` | Strict TypeScript validation. |
| `npm run compile` | Compile tests and bundle the extension. |
| `npm run test:unit` | Seven core tests covering range semantics, path scope, metrics, persistence failures, and session attribution. |
| `npm run test:extension` | Isolated native VS Code tests, computed Explorer filename text colors and screenshots with the toggle on/off, session restoration, and normal-window restart tests. |
| `npm run package` | Produce a self-contained VSIX without runtime npm installation. |

The host test runner downloads VS Code 1.100.0 by default. To use an installed executable in PowerShell, set `$env:VSCODE_EXECUTABLE_PATH` to the full path of its executable before running the test command. Tests use temporary workspaces/profiles, and screenshots are written to the ignored `.vscode-test/screenshots` directory. Only the test windows expose local debugging endpoints; the extension does not start a server.

VS Code intentionally uses in-memory workspace/profile storage when `--extensionTestsPath` is present. The persistence regression therefore launches two **normal** isolated development windows and operates the UI through Playwright, rather than expecting test-mode storage to survive another process. See the [VS Code storage implementation](https://github.com/microsoft/vscode/blob/main/src/vs/platform/storage/electron-main/storageMainService.ts).

The tests verify host registration and invoke the read adapter directly. They do **not** constitute a signed-in, end-to-end Copilot conversation test. That remains a manual acceptance gate.

## Remaining Work

The [implementation plan](docs/IMPLEMENTATION-PLAN.md) describes the larger target. Remaining work includes authenticated Copilot acceptance and policy review, minimum-version and cross-platform checks, cross-session analytics, continuous editor highlights, rejected-call history, robust interrupted-session cleanup, a global disk budget, large-repository performance testing, and CI/release automation. The initial view uses a single toggle icon; separate state-specific menu labels are also planned.
