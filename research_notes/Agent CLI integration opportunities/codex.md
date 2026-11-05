# OpenAI Codex CLI (codex-rs) programmatic surfaces as a desktop-host integration target (status: late October 2026)

Scope: app-server JSON-RPC (v2), `codex exec`, `codex review`, and the official TypeScript and Python SDKs, judged against machdoch's current design. That design runs one-shot `codex exec --json` per chat turn with a throwaway CODEX_HOME. Only goals use app-server, and every server→client request is answered -32601.

Local sources. Every protocol shape below comes from **codex-cli 0.159.1**, the version installed locally, and was generated with read-only commands into the scratchpad. The scratchpad files are temporary: copy them before relying on the links.
- `SCR` = `C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad`
- `SCR/codex-schema/`: the existing schema bundle. Its ClientRequest.json is byte-identical to the stable output of `generate-json-schema` (no `--experimental`).
- `SCR/cx-stable/` and `SCR/cx-exp/` are `codex app-server generate-json-schema` output without and with `--experimental`. `SCR/m-stable.txt` and `SCR/m-exp.txt` are method lists extracted from them. **"Experimental-only" below means the method or field appears only in the `--experimental` bundle.** Such methods and fields need `initialize.capabilities.experimentalApi: true`.
- `SCR/cx-ts-exp/` (and `/v2/`) is `codex app-server generate-ts --experimental` output. Its doc comments are cited as `TS:<Type>`.
- Version drift: the newest Codex CLI release is **0.165.0 (2026-10-27)**, six minor versions ahead of the local 0.159.1 ([Changelog](https://learn.chatgpt.com/docs/changelog)). The `main`-branch app-server README already describes methods that do not exist in 0.159.1, such as `thread/memory/read`, `thread/readState/*` and `accountSession/*` ([app-server README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md)).

## App-server as the primary host protocol: lifecycle, thread persistence, resume, fork, revert, compact, inject, list and read

### Takeaway
App-server v2 is the full host protocol. It has a strict `initialize` → `initialized` handshake, an `experimentalApi` opt-in, per-connection notification opt-out, and durable threads. Threads are stored as JSONL rollouts plus SQLite metadata under CODEX_HOME. Resume, fork, revert, compaction, item injection and paginated history all exist, and most are **stable** in 0.159.1. Resume across process restarts requires the same CODEX_HOME on disk (sessions directory plus SQLite state), so machdoch's delete-after-run CODEX_HOME rules out resume.

### Cited Findings
**Lifecycle**
- Send `initialize` with `clientInfo {name, title, version}` and then the `initialized` notification, once per connection. Requests sent before that get `Not initialized`; a second `initialize` gets `Already initialized` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `InitializeCapabilities` = `{ experimentalApi: boolean, requestAttestation: boolean, explicitGatewayOauth?: boolean, mcpServerOpenaiFormElicitation?: boolean, optOutNotificationMethods?: string[] | null, extensions?: {...} }` — [TS:InitializeCapabilities](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/InitializeCapabilities.ts)
- Without `experimentalApi`, experimental methods and fields are rejected with `<descriptor> requires experimentalApi capability` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `optOutNotificationMethods` matches exact method names only. Unknown names are ignored, and requests, responses and errors are unaffected — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Transports:
  - `--listen stdio://` (default, JSONL), `unix://`, `unix://PATH`, `ws://IP:PORT` and `off` — [local `codex app-server --help`, 0.159.1](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/codex-help.txt)
  - WebSocket is "experimental, unsupported for production". It serves `/readyz` and `/healthz` and supports `--ws-auth capability-token|signed-bearer-token`. An overloaded server returns `-32001`; retry with backoff and jitter — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `clientInfo.name` feeds the Compliance Logs Platform. OpenAI asks enterprise integrations to get onto its known-clients list — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- The `codex app-server` subcommand itself is labeled `[experimental]`. The CLI also has a shared local daemon: `codex app-server daemon`, `codex app-server proxy`, `codex agents` ("Browse all agent sessions on the shared local app-server daemon"), `--remote ws://…|unix://` and `--no-daemon`. Feature `daemon_auto_start` is stable and on — local `codex --help`, `codex app-server --help` and `codex features list` (0.159.1)

**Method inventory (0.159.1)**
- **Stable (selection):** `thread/start|resume|fork|read|list|loaded/list|turns/list|items/list|archive|unarchive|delete|unsubscribe|revert|compact/start|inject_items|shellCommand|name/set|metadata/update|goal/set|goal/get|goal/clear|attachment/*`, `turn/start|steer|interrupt`, `review/start`, `model/list`, `account/rateLimits/read`, `account/usage/read`, `command/exec[/write|/resize|/terminate]`, `skills/*`, `hooks/list`, `plugin/*`, `app/*`, `mcpServer*`, `config/*`, `fs/*`, `experimentalFeature/list|enablement/set` — [SCR/m-stable.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-stable.txt)
- **Experimental-only methods:** `thread/queue/{add,list,update,delete,reorder,start}`, `thread/settings/update`, `turn/settings/update`, `thread/backgroundTerminals/{list,clean,terminate}`, `process/{spawn,writeStdin,resizePty,kill}`, `collaborationMode/list`, `thread/search`, `thread/timeline/list`, `thread/memoryMode/set`, `memory/*`, `environment/*`, `project/*`, `remoteControl/*`, `rollout/compress`, `thread/realtime/*`, `userVerification/*`, `plugin/search`, plus the `currentTime/read` server request — [SCR/m-exp.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-exp.txt) diffed against m-stable.txt
- **Experimental-only fields:**
  - `ThreadStartParams`: `dynamicTools`, `historyMode`, `permissions`, `environments`, `projectId`, `runtimeWorkspaceRoots`, `experimentalRawEvents`
  - `ThreadResumeParams`: `path`, `history`, `initialTurnsPage`
  - `ThreadForkParams`: `beforeTurnId`, `deferGoalContinuation`, `path`
  - `TurnStartParams`: `collaborationMode`, `additionalContext`, `responsesapiClientMetadata`, `permissions`, `environments`
  - `ThreadListParams`: `parentThreadId`, `ancestorThreadId`

  Source: field diff of `SCR/cx-stable` against `SCR/cx-exp` (`codex_app_server_protocol.v2.schemas.json`)
- All 83 server notifications are stable; no notification is experimental-only — [SCR/m-stable.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-stable.txt)

**thread/start**
- `ThreadStartParams` includes `model`, `modelProvider`, `serviceTier`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `config` (free-form overrides), `baseInstructions`, `developerInstructions`, `ephemeral`, `threadSource`, `dynamicTools` (experimental) and `selectedCapabilityRoots` — [TS:ThreadStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadStartParams.ts)
- If an MCP server marked required fails to start, `thread/start` or `thread/resume` fails — [App-server docs](https://learn.chatgpt.com/docs/app-server); config key `mcp_servers.<id>.required` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)

**Persistence**
- Threads are JSONL rollout logs with metadata in SQLite. `thread/metadata/update` patches `isPinned` and `gitInfo`. Persistent local threads use paginated history by default — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `sqlite_home` sets the directory of the SQLite state DB "used by agent jobs and resumable state". `history.persistence = save-all|none` controls `history.jsonl` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- The TypeScript SDK docs say threads are stored in `~/.codex/sessions` — [TS SDK README](https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md)
- `Thread` objects carry:
  - `id`: UUIDv7
  - `sessionId`: shared by a session tree
  - `forkedFromId`, `parentThreadId`
  - `ephemeral`
  - `status`: `notLoaded|idle|systemError|active{activeFlags: waitingOnApproval|waitingOnUserInput}`
  - `path`: "[UNSTABLE] Path to the thread on disk"

  Sources: [TS:Thread](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/Thread.ts), [TS:ThreadStatus](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadStatus.ts)
- `codex exec --ephemeral` means "Run without persisting session files to disk". The CLI also has `codex migrate-rollouts` ("migrate legacy local sessions to paginated thread history") — [local codex help](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/codex-help.txt)

**Resume**
- `thread/resume {threadId, model?, serviceTier?, cwd?, approvalPolicy?, sandbox?, config?, baseInstructions?, developerInstructions?, excludeTurns?}` — [TS:ThreadResumeParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadResumeParams.ts)
- Experimental resume fields:
  - `path`: "[UNSTABLE] Specify the rollout path to resume from"
  - `history`: "[UNSTABLE] FOR CODEX CLOUD - DO NOT USE"
  - `initialTurnsPage`: bootstrap a page of turns

  Source: [TS:ThreadResumeParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadResumeParams.ts)
- Full-history hydration from resume and fork is deprecated and emits `deprecationNotice`. Use `excludeTurns: true` and then `thread/turns/list` (with `itemsView` = `notLoaded|summary|full`) and `thread/items/list` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Resuming does not change `updatedAt`. If the resumed model differs from the recorded one, Codex warns and adds a one-time model-switch instruction — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Release fixes:
  - 0.164.0: "Resuming sessions now finds compressed histories and restores saved thread settings"
  - 0.163.0: "Resuming a saved thread restores its permissions and network approvals"

  Source: [Changelog](https://learn.chatgpt.com/docs/changelog)

**Fork**
- `thread/fork {threadId, lastTurnId? (inclusive), beforeTurnId? (exp), ephemeral?, excludeTurns?, deferGoalContinuation? (exp), …overrides}` — [TS:ThreadForkParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadForkParams.ts)
- Forking mid-turn without `lastTurnId` records an interruption marker. Ephemeral forks of paginated threads require `excludeTurns: true`. `thread/started` carries `forkedFromId` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- 0.165.0 "Added experimental attached thread forks to the app-server API" — [Changelog](https://learn.chatgpt.com/docs/changelog)

**Revert, compact, inject**
- `thread/revert {threadId, beforeTurnId}` removes that turn and every later turn. **It does not touch local files.** It replaces the removed `thread/rollback` and emits `thread/reverted` — [TS:ThreadRevertParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadRevertParams.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `thread/compact/start {threadId}` returns `{}` immediately and streams `contextCompaction` items. `thread/compacted` is deprecated — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `thread/inject_items {threadId, items: JsonValue[]}` appends raw Responses API items to a loaded thread's model-visible history without starting a turn. The items are persisted to the rollout — [TS:ThreadInjectItemsParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadInjectItemsParams.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)

**List, read, unsubscribe**
- `thread/list` paginates with `cursor`/`limit`. Filters: `sortKey`, `sourceKinds` (default interactive: `cli`, `vscode`), `archived`, `cwd`, `modelProviders`, `projectId` (exp), `parentThreadId`/`ancestorThreadId` (exp) — [TS:ThreadListParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadListParams.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `thread/read` returns stored metadata and status without loading the thread — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `thread/unsubscribe` returns `unsubscribed|notSubscribed|notLoaded`. After the last subscriber leaves, the thread unloads after a **30-minute grace period**, emitting `thread/status/changed` (notLoaded) and `thread/closed` — [App-server docs](https://learn.chatgpt.com/docs/app-server)

### Inferences
- **Native resume requires a persistent CODEX_HOME.** Rollouts live under the sessions directory and resumable state lives in SQLite (`sqlite_home`, which defaults under CODEX_HOME). Options:
  - Use one long-lived machdoch-owned CODEX_HOME, or one per workspace, and keep config.toml stable. Inject per-run MCP servers and instructions via `thread/start` `config` and `developerInstructions` instead of rewriting files.
  - Alternatively, keep CODEX_HOME isolated but stop deleting it.

  The experimental `thread/resume.path` could point at an archived rollout file. Whether that also needs the SQLite state is unverified.
- `thread/inject_items` makes it possible to seed a fresh Codex thread with prior machdoch history as real Responses items instead of re-sending a text transcript. The exact Responses item JSON shape has to be produced by the host.
- `thread/revert` rewrites the conversation only. A host "undo" must still restore files itself, from a git checkpoint or a `turn/diff/updated` reverse patch.
- One long-lived `codex app-server --listen stdio://` per app session, multiplexing threads, replaces one process per turn. This removes startup cost and enables everything else in these notes.

### Gaps
- I found no explicit statement of the on-disk layout (for example `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` versus SQLite-only paginated history) in the October 2026 docs, beyond "JSONL rollout logs + SQLite" and the SDK's `~/.codex/sessions`.
- It is unverified whether `thread/resume` by id works when `sqlite_home` differs between runs, or whether `path`-based resume works without the SQLite DB.
- I found no minimum version for the stable v2 thread APIs (`thread/fork`, `thread/revert`, `thread/inject_items`). The changelog page shown only reaches back to 0.161.0, and older entries were not retrievable in budget.

## Steering, queueing and graceful interrupt

### Takeaway
`turn/steer` (stable) appends input to the in-flight turn. It is guarded by a mandatory `expectedTurnId` and fails on non-steerable turns (review, compact). Queued follow-ups are a separate server-side queue, `thread/queue/*`. Its methods are **experimental-only**, while `thread/queue/changed` is a stable notification. `turn/interrupt {threadId, turnId}` ends the turn with status `interrupted` and keeps the process and thread alive.

### Cited Findings
- `TurnSteerParams = { threadId, input: UserInput[], expectedTurnId, clientUserMessageId?, additionalContext? (exp), responsesapiClientMetadata? (exp) }` returns `{ turnId }`. On `expectedTurnId`: "The request fails when it does not match the currently active turn" — [TS:TurnSteerParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnSteerParams.ts)
- A steer emits no new `turn/started` and accepts no `model`, `cwd`, `sandboxPolicy` or `outputSchema` overrides — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Error `codexErrorInfo.activeTurnNotSteerable { turnKind: "review" | "compact" }` — [TS:CodexErrorInfo](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CodexErrorInfo.ts)
- `turn/start` during an active turn: `TurnStartParams.turnTrigger` is documented as "Ignored when this request steers an already-active turn". `serviceTierForTurn` "Does not change the thread's tier or a turn being steered" — [TS:TurnStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnStartParams.ts)
- The public docs do not say how a plain `turn/start` behaves during an active turn. They do say `turn/start` with `toolOutput` (and empty `input`) is queued for the active turn — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Queue methods (experimental-only):
  - `thread/queue/add {threadId, input, clientUserMessageId}`
  - `thread/queue/list {threadId, cursor?}` returns `{data: QueuedSubmission[], nextCursor}`, where `QueuedSubmission = {id, input, clientUserMessageId}`
  - `thread/queue/update {threadId, queuedSubmissionId, input}`
  - `thread/queue/delete {threadId, queuedSubmissionId}`
  - `thread/queue/reorder {threadId, queuedSubmissionIds}`
  - `thread/queue/start {threadId, queuedSubmissionId?}` returns `{turn}`
  - Notification `thread/queue/changed {threadId}` (stable)

  Sources: [TS:ThreadQueueAddParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadQueueAddParams.ts), [TS:QueuedSubmission](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/QueuedSubmission.ts), [SCR/m-exp.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-exp.txt)
- CLI equivalent: `codex queue --thread <UUID|name> --message <TEXT>` ("Queue a message for an existing session") — local `codex --help` / `codex queue --help` (0.159.1)
- Feature flag `steer` is "removed / true", meaning steering is permanently on. `instant_interrupt` is "under development" — local `codex features list` (0.159.1)
- TUI: "Press Tab while Codex is running to queue follow-up text, slash commands, or `!` shell commands for the next turn" — [CLI features docs, via search](https://developers.openai.com/codex/cli/features)
- Changelog:
  - 0.163.0: "Send a follow-up while Codex is responding to steer it immediately"
  - 0.164.0: "Queued prompts now wait for pending permission selections to resolve before continuing"
  - 0.165.0: "Prevented queued agent messages from restarting work after an interrupt or a switch to Plan mode"

  Source: [Changelog](https://learn.chatgpt.com/docs/changelog)
- `turn/interrupt {threadId, turnId}` makes the turn complete with `status: "interrupted"`. `TurnStatus = completed|interrupted|failed|inProgress` — [TS:TurnInterruptParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnInterruptParams.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Interrupt stays available even under provider mismatch — [app-server README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md)
- `turn/settings/update {threadId, turnId, model?, effort?, summary?, serviceTier?, approvalsReviewer?}` (experimental) changes the active turn's model, effort or tier mid-turn — [TS:TurnSettingsUpdateParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnSettingsUpdateParams.ts)

### Inferences
- machdoch can offer "send while running = steer" (stable) by tracking the active `turnId` from `turn/started`. On `activeTurnNotSteerable` or a turn-id mismatch, it should fall back to a host-side queue that starts a new turn after `turn/completed`. That avoids depending on the experimental `thread/queue/*`.
- Replacing "kill process tree" with `turn/interrupt` keeps the thread resumable and leaves a clean `interrupted` turn in history.

### Gaps
- The exact behavior of a plain `turn/start` while a turn is active (implicit steer, rejection, or queue) is only implied by schema comments and was not tested. Testing it would mean sending prompts, which was out of scope.

## Approvals and user input (command, file change, permissions, requestUserInput, MCP elicitation)

### Takeaway
App-server has a complete human-in-the-loop surface:
- Policy and sandbox per thread and turn.
- Three approval server requests with typed decisions.
- `item/tool/requestUserInput`: structured multiple-choice questions, used by Plan/collaboration modes.
- MCP elicitation in form or URL mode.
- `serverRequest/resolved`, which lets a host clear its prompt UI.

machdoch currently answers -32601 to everything, which fails runs. Implementing even only `requestUserInput` and elicitation would be a real gain, even if it keeps `never` plus full access.

### Cited Findings
**Policy and sandbox values**
- `AskForApproval = "untrusted" | "on-request" | {granular: {sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations}} | "never"`. `SandboxMode = "read-only" | "workspace-write" | "danger-full-access"`. `ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent"` — [TS:AskForApproval](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/AskForApproval.ts), [TS:SandboxMode](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/SandboxMode.ts), [TS:ApprovalsReviewer](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ApprovalsReviewer.ts)
- Config reference: `approval_policy` = `on-request | never | {granular}`. It states "untrusted" is unsupported and `on-failure` is deprecated. `approvals_reviewer` = `user | auto_review` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- **Conflict:** the app-server docs page shows camelCase `unlessTrusted`/`onRequest` and sandboxPolicy tags `readOnly`/`workspaceWrite`/`dangerFullAccess`/`externalSandbox` — [App-server docs](https://learn.chatgpt.com/docs/app-server). Local 0.159.1 uses the kebab-case strings for thread-level `sandbox` and `approvalPolicy`. Probably `SandboxPolicy` (the turn-level object) uses camelCase type tags; the generated schema is the authority here.
- CLI `--approve-for-me`: "Route approval requests through automatic review using the workspace-write sandbox" — local `codex --help` (0.159.1)
- Subagents "inherit your current sandbox policy". In non-interactive flows an action that needs new approval fails, and the error goes back to the parent — [Subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)

**Command approval**
- Server request `item/commandExecution/requestApproval` params:
  - `kind`, `threadId`, `turnId`, `itemId`, `startedAtMs`, `approvalId?`, `environmentId`
  - `reason?`, `networkApprovalContext?`, `command?`, `cwd?`, `commandActions?`
  - `additionalPermissions?`, `proposedExecpolicyAmendment?`, `proposedNetworkPolicyAmendments?`, `availableDecisions?`

  Source: [TS:CommandExecutionRequestApprovalParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CommandExecutionRequestApprovalParams.ts)
- Response `{decision}`, where decision is `"accept" | "acceptForSession" | {acceptWithExecpolicyAmendment: {execpolicy_amendment}} | {applyNetworkPolicyAmendment: {network_policy_amendment}} | "decline" | "cancel"` — [TS:CommandExecutionApprovalDecision](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CommandExecutionApprovalDecision.ts)
- `kind: "humanCommand"` checkpoints allow only accept, decline or cancel. Pending prompts replay on reconnect. If no capable connection exists, the command is rejected — [app-server README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md) (main branch; may postdate 0.159.1)

**File-change and permissions approval**
- `item/fileChange/requestApproval {threadId, turnId, itemId, startedAtMs, reason?, grantRoot? [UNSTABLE]}` returns `{decision: "accept" | "acceptForSession" | "decline" | "cancel"}` — [TS:FileChangeRequestApprovalParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/FileChangeRequestApprovalParams.ts); [TS:FileChangeApprovalDecision](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/FileChangeApprovalDecision.ts)
- `item/permissions/requestApproval {threadId, turnId, itemId, environmentId, startedAtMs, cwd, reason, permissions: {network, fileSystem}}` returns `{permissions: GrantedPermissionProfile, scope: "turn" | "session", strictAutoReview?}` — [TS:PermissionsRequestApprovalParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/PermissionsRequestApprovalParams.ts); [TS:PermissionsRequestApprovalResponse](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/PermissionsRequestApprovalResponse.ts)
- The legacy v1 server requests `execCommandApproval` and `applyPatchApproval` still exist — [SCR/m-stable.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-stable.txt)

**Resolution and thread state**
- `serverRequest/resolved {threadId, requestId}` confirms a request was answered or cleared. The item then completes with `completed|failed|declined` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `ThreadActiveFlag` = `waitingOnApproval|waitingOnUserInput`, carried in `thread/status/changed` — [TS:ThreadActiveFlag](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadActiveFlag.ts)
- Guardian/auto-review surfaces: `thread/approveGuardianDeniedAction` (stable request) and notifications `item/autoApprovalReview/started|completed`, `autoApprovalReview/strictReviewRequired`, `guardianWarning` — [SCR/m-stable.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-stable.txt)

**requestUserInput**
- `item/tool/requestUserInput` params: `{threadId, turnId, itemId, questions: [{id, header, question, isOther, isSecret, options: [{label, description}] | null}], isBlocking, autoResolutionMs (deprecated)}`. Response: `{answers: {[questionId]: {answers: string[]}}}` — [TS:ToolRequestUserInputParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ToolRequestUserInputParams.ts); [TS:ToolRequestUserInputResponse](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ToolRequestUserInputResponse.ts)
- The docs label it experimental and say it asks 1–3 short questions, with `isOther` for free-form answers — [App-server docs](https://learn.chatgpt.com/docs/app-server). It is in the *stable* ServerRequest set of 0.159.1 — [SCR/m-stable.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-stable.txt). This conflict is noted, not resolved.
- Plan mode:
  - `TurnStartParams.collaborationMode` (EXPERIMENTAL) = `{mode: "plan" | "default", settings: {model, reasoning_effort, developer_instructions}}`. Its doc: "Takes precedence over model, reasoning_effort, and developer instructions"; `collaborationMode/list` is experimental — [TS:TurnStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnStartParams.ts), [TS:ModeKind](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/ModeKind.ts)
  - Feature flags: `collaboration_modes` "removed / true" (always on); `default_mode_request_user_input` "under development / false" — local `codex features list` (0.159.1)
- A third-party write-up describes v0.154 asynchronous TUI questions: suggested answer labels shown as a numbered list — [danielvaughan.com blog](https://codex.danielvaughan.com/2026/09/05/async-tui-questions-codex-cli-v0154-human-agent-collaboration/) (unofficial). 0.162.1 fixed "multi-line asynchronous questions" — [Changelog](https://learn.chatgpt.com/docs/changelog)

**MCP elicitation and app tools**
- `mcpServer/elicitation/request {threadId, turnId | null, serverName, …mode-specific}` supports modes `form`, `openai/form` (opt-in via `mcpServerOpenaiFormElicitation` or `extensions`) and `url`. Response: `{action: accept|decline|cancel, content: JsonValue | null, _meta}` — [TS:McpServerElicitationRequestResponse](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/McpServerElicitationRequestResponse.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- App (connector) tool calls with destructive annotations always require approval. Decline completes the `mcpToolCall` with an error — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Per-tool MCP approval config: `mcp_servers.<id>.default_tools_approval_mode` and `.tools.<tool>.approval_mode` = `auto|prompt|writes|approve` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)

### Inferences
- With `approvalPolicy: "never"` plus `danger-full-access`, command, file and permission approvals should not arrive. `requestUserInput` (plan mode or agent questions), MCP elicitation and dynamic-tool calls still can, and today each fails the run under -32601. A host should at minimum render `requestUserInput` as a question card, render elicitation as a form or URL-open prompt, and treat unknown requests with a safe "decline/cancel" rather than -32601.
- An opt-in "ask before commands" mode is straightforward: `approvalPolicy: "on-request"`, `sandbox: "workspace-write"`, and render `availableDecisions` as buttons.

### Gaps
- I found no authoritative description of what triggers `request_user_input` outside Plan mode in 0.159.1. `default_mode_request_user_input` suggests default mode does not expose it yet.
- The full `SandboxPolicy` (turn-level object) shape was not extracted.

## Reporting: token usage, rate limits, account usage, model reroute

### Takeaway
App-server provides everything needed for a context meter and plan-limit display: per-turn and cumulative token breakdowns with the model context window, pushed after each update, and ChatGPT plan rate-limit windows (primary and secondary, `usedPercent`, `resetsAt`), both readable and pushed. `codex exec --json` only gives a final usage object per turn.

### Cited Findings
- `thread/tokenUsage/updated {threadId, turnId, tokenUsage: {total, last, modelContextWindow}}`. Each `TokenUsageBreakdown` = `{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}` — [TS:ThreadTokenUsage](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadTokenUsage.ts); [TS:TokenUsageBreakdown](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TokenUsageBreakdown.ts)
- `account/rateLimits/read` response — [TS:GetAccountRateLimitsResponse](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/GetAccountRateLimitsResponse.ts):
  - `ordinaryUsageAllowed`
  - `rateLimits: RateLimitSnapshot`: legacy single bucket
  - `rateLimitsByLimitId: {[limitId]: RateLimitSnapshot}`: keyed for example by `codex`
  - `rateLimitResetCredits`, `accountId`, `rateLimitUpsell`
- `RateLimitSnapshot = {limitId, limitName, normalModelSlug, primary, secondary, credits: {hasCredits, unlimited, balance}, individualLimit, spendControlReached, planType, rateLimitReachedType}`. `RateLimitWindow = {usedPercent, windowDurationMins, resetsAt}` — [TS:RateLimitSnapshot](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/RateLimitSnapshot.ts); [TS:RateLimitWindow](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/RateLimitWindow.ts)
- `resetsAt` is in Unix seconds — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `account/rateLimits/updated {rateLimits: RateLimitSnapshot}` is pushed — [TS:AccountRateLimitsUpdatedNotification](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/AccountRateLimitsUpdatedNotification.ts)
- `account/usage/read {threadId?}` returns:
  - `summary {lifetimeTokens, peakDailyTokens, longestRunningTurnSec, currentStreakDays, longestStreakDays}`
  - `dailyUsageBuckets`
  - `threadUsage?`: estimated per-thread usage

  Sources: [TS:GetAccountTokenUsageResponse](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/GetAccountTokenUsageResponse.ts). It requires Codex-backed auth, not API-key-only or Bedrock — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `account/rateLimitResetCredit/consume {idempotencyKey, creditId?}` returns an outcome of `reset|alreadyRedeemed|nothingToReset|noCredit`. Also: `account/read`, `account/updated {authMode, planType}` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `model/rerouted {threadId, turnId, fromModel, toModel, reason: "highRiskCyberActivity"}`. Related: `model/safetyBuffering/updated`, `model/verification` — [TS:ModelReroutedNotification](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ModelReroutedNotification.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Errors arrive as `error {error: {message, codexErrorInfo?, additionalDetails?}}` followed by `turn/completed` with status `failed` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Local 0.159.1 `codexErrorInfo` values (camelCase) — [TS:CodexErrorInfo](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CodexErrorInfo.ts):
  - Limits: `contextWindowExceeded`, `sessionBudgetExceeded`, `usageLimitExceeded`, `rateLimitExceeded`, `flexUnavailable`, `serverOverloaded`
  - Policy: `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials`
  - Transport, with `httpStatusCode`: `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`
  - Other: `unauthorized`, `badRequest`, `sandboxError`, `threadRollbackFailed`, `activeTurnNotSteerable`, `internalServerError`, `other`

  The docs list PascalCase names, so treat the generated schema as authoritative.
- `codex exec --json` `turn.completed.usage` has `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` — [Non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode)
- 0.164.0 "Avoid double-counting retained reasoning in token usage". 0.163.0 "Account for token usage from incomplete responses" — [Changelog](https://learn.chatgpt.com/docs/changelog)

### Inferences
- machdoch can show a live context-fill gauge (`last.inputTokens` against `modelContextWindow`) and ChatGPT plan bars (5h and weekly style primary/secondary windows with reset countdowns) without scraping anything. The window semantics come from `windowDurationMins`.
- `usageLimitExceeded` and `rateLimitReachedType` let the host distinguish "plan limit hit" from transport errors and offer a reset credit or retry-after display.

### Gaps
- No cost-in-currency figure is exposed. Only tokens, credits balance and percentages are available; I found nothing on dollar cost per turn.

## Plan, diff and progress streaming

### Takeaway
App-server streams a live todo plan (`turn/plan/updated`), an aggregated per-turn unified diff (`turn/diff/updated`), message, reasoning-summary and plan deltas, command output deltas, file-patch updates and MCP progress. Every item has `item/started` and `item/completed`, and the completed item is authoritative.

### Cited Findings
- `turn/plan/updated {threadId, turnId, explanation | null, plan: [{step, status: pending|inProgress|completed}]}` — [TS:TurnPlanUpdatedNotification](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnPlanUpdatedNotification.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `turn/diff/updated {threadId, turnId, diff: string}` is an aggregated unified diff. Diff and plan events carry no items, so use `item/*` as the source of truth — [TS:TurnDiffUpdatedNotification](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnDiffUpdatedNotification.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Deltas:
  - `item/agentMessage/delta`
  - `item/plan/delta {itemId, delta}`: the Plan-mode plan item; may not exactly match the final item
  - Reasoning: `item/reasoning/summaryTextDelta` (`summaryIndex`), `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`
  - Commands: `item/commandExecution/outputDelta` (append in order), `item/commandExecution/terminalInteraction`
  - Files and MCP: `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`
  - `item/fileChange/outputDelta` is deprecated and no longer emitted

  Sources: [App-server docs](https://learn.chatgpt.com/docs/app-server); [SCR/m-stable.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-stable.txt)
- `agentMessage` items carry an optional `phase` of `commentary|partial_answer|final_answer` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `ThreadItem` types in 0.159.1: `userMessage`, `agentMessage`, `reasoning`, `plan`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`, `webSearch`, `imageView`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`, `hookPrompt`, `functionCallOutput`, `sleep` — [TS:ThreadItem](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadItem.ts)
- Reasoning summaries are configurable: `model_reasoning_summary = auto|concise|detailed|none` in config, and `summary` on turn/start, thread/settings/update and turn/settings/update — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference); [TS:TurnStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnStartParams.ts)
- `codex exec --json` emits only `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and `error`. Its item types include plan updates (todo list), reasoning, commands, file changes, MCP calls and web searches — [Non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode)
- Feature flags `cwd_relative_turn_diffs` and `concurrent_reasoning_summaries` are "under development" — local `codex features list` (0.159.1)

### Inferences
- machdoch could render a live checklist, a turn diff panel (with per-turn "revert files" via reverse apply), streaming reasoning summaries and live terminal output. None of these is possible with the current `item.completed`-only decoding.

### Gaps
- I did not verify whether `turn/diff/updated` covers files changed by unsandboxed shell commands in full-access mode, or only `apply_patch` edits.

## Review mode

### Takeaway
`review/start` (stable) runs Codex's built-in code reviewer inline on a thread against uncommitted changes, a base branch, a commit, or custom instructions. Output is bracketed by `enteredReviewMode`/`exitedReviewMode` items, with the final review text on the exit item. The CLI equivalents are `codex review` and `codex exec review` (with `--json` and `--output-schema`).

### Cited Findings
- `ReviewStartParams {threadId, target, delivery?: "inline" | "detached"}`. Targets: `{type: "uncommittedChanges"} | {type: "baseBranch", branch} | {type: "commit", sha, title | null} | {type: "custom", instructions}`. Response: `{turn, reviewThreadId}` — [TS:ReviewStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ReviewStartParams.ts); [TS:ReviewTarget](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ReviewTarget.ts); [TS:ReviewStartResponse](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ReviewStartResponse.ts)
- `detached` is deprecated (emits `deprecationNotice`) and unsupported for paginated parents. For a separate review thread, call `thread/start` (or `thread/fork`) and then review inline. `enteredReviewMode` fires on start and `exitedReviewMode` on completion with the final `review` text — [App-server docs](https://learn.chatgpt.com/docs/app-server); [app-server README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md)
- Review turns are not steerable (`NonSteerableTurnKind` includes `"review"`) — [TS:CodexErrorInfo](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CodexErrorInfo.ts)
- CLI: `codex review [PROMPT] --uncommitted | --base <BRANCH> | --commit <SHA> [--title]`. `codex exec review` adds `--json`, `--output-schema`, `-o`, `--ephemeral`, `-m`, `--skip-git-repo-check` and `--worktree` — local `codex review --help` / `codex exec review --help` (0.159.1)
- 0.162.0 "Preserve review targets and scope misalignment continuation metadata" — [Changelog](https://learn.chatgpt.com/docs/changelog)

### Inferences
- A machdoch "Review changes" button maps directly to `review/start` with `uncommittedChanges` or `baseBranch` on a forked or ephemeral thread. Rendering means one card from `exitedReviewMode.review`.

### Gaps
- I found no structured findings schema for review output in 0.159.1 (priority, file and line): `exitedReviewMode` carries a text `review`. The structured security findings belong to a separate "Codex Security TypeScript SDK (beta)" — [Codex SDK docs](https://learn.chatgpt.com/docs/codex-sdk.md)

## Fast mode and service tiers

### Takeaway
Fast is a per-model service tier with id `priority` (shown as "Fast"), advertised by `model/list` (`serviceTiers`, `defaultServiceTier`). It is selected per thread (`serviceTier` on start, resume or fork), per turn and sticky (`turn/start.serviceTier`), or for one turn only (`turn/start.serviceTierForTurn`, with `"default"` meaning standard). In config or `exec` it is set with `service_tier = "fast"`, which maps to `priority`. The `fast_mode` feature is stable and on by default.

### Cited Findings
- `Model` has `serviceTiers: [{id, name, description}]` and `defaultServiceTier`. `additionalSpeedTiers` is "Deprecated: use `serviceTiers` instead". It also has `multiAgentVersion` and `supportedReasoningEfforts` — [TS:Model](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/Model.ts)
- Local catalog — [SCR/codex-models.json](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/codex-models.json):
  - Every listed model has `service_tiers: [{"id":"priority","name":"Fast", …}]`. Descriptions are "2x speed, increased usage" for gpt-6.1-sol and gpt-6-astra, "1.5x speed" for gpt-6.1-terra, and similar for the others.
  - `additional_speed_tiers: ["fast"]`
  - Efforts reach `ultra` on most v2 models.
- `TurnStartParams.serviceTier` means "Override the service tier for this turn and subsequent turns". `serviceTierForTurn`: "Override the service tier only when this request starts a new turn. Use "default" for standard speed. Omitted or null inherits the thread's tier" — [TS:TurnStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnStartParams.ts)
- `serviceTier` also exists on `thread/start|resume|fork`, on experimental `thread/settings/update` ("`null` clears") and on `turn/settings/update` — [TS:ThreadStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadStartParams.ts); [TS:ThreadSettingsUpdateParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadSettingsUpdateParams.ts)
- Config:
  - `service_tier`: "Preferred tier for new turns. Use `fast` or another tier the active model advertises. `fast` maps to the request value `priority`"
  - `features.fast_mode`: boolean, stable, on by default, independent of `features.ultrafast_mode`

  Source: [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- A third-party troubleshooting article reports that copying `service_tier = "priority"` from API examples into config.toml triggers warnings on some models, and recommends `fast` — [aiidelist.com](https://aiidelist.com/blog/codex-priority-service-tier-warning-gpt-5-6-sol.md) (unofficial)
- `codexErrorInfo` includes `flexUnavailable`, which implies a `flex` tier exists — [TS:CodexErrorInfo](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CodexErrorInfo.ts)
- 0.162.0 "Enforce Fast and Ultra Fast policies independently". 0.164.0 "Support inline model, reasoning, and speed selection in /model" — [Changelog](https://learn.chatgpt.com/docs/changelog)

### Inferences
- For machdoch's exec path, add `-c service_tier="fast"` when the user toggles Fast. On app-server, pass the tier `id` from `model/list` (`"priority"`) as `serviceTier` on `thread/start`, or as `serviceTierForTurn` for a single fast turn. Show the toggle only when the selected model's `serviceTiers` is non-empty.

### Gaps
- It is unverified whether app-server's `serviceTier` field accepts the config alias `"fast"` as well as the advertised id `"priority"`. There are no official docs on cost multipliers beyond the catalog descriptions ("increased usage").

## Background and long-running work: command/exec, process/*, background terminals, unified exec, cloud tasks, goals

### Takeaway
- `command/exec` (stable) is a sandboxed, thread-less process runner with PTY, stdin, resize and terminate support.
- `process/*` (experimental) runs unsandboxed processes.
- `thread/backgroundTerminals/*` (experimental) manages the agent's long-lived unified-exec terminals.
- `thread/shellCommand` (stable) runs user `!` commands unsandboxed.
- Goals (stable methods in 0.159.1) persist an objective with a token budget and automatic continuation.
- `codex cloud` is an experimental CLI for remote tasks.

### Cited Findings
- `command/exec`:
  - Params: `command: string[]` (argv; empty rejected), `processId?` (required for streaming and follow-ups), `tty?`, `streamStdin?`, `streamStdoutStderr?`, `outputBytesCap?`, `disableOutputCap?`, `disableTimeout?`, `timeoutMs?`, plus `cwd` and `sandboxPolicy`
  - Follow-ups: `command/exec/write`, `command/exec/resize`, `command/exec/terminate`
  - Output notification: `command/exec/outputDelta`

  Sources: [TS:CommandExecParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CommandExecParams.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `process/spawn {command, processHandle, cwd, tty?, streamStdin?, streamStdoutStderr?, outputBytesCap?, timeoutMs?, env?}`, `process/writeStdin`, `process/resizePty`, `process/kill`, with notifications `process/outputDelta` and `process/exited`. These are experimental, need `experimentalApi`, and run outside the sandbox — [TS:ProcessSpawnParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ProcessSpawnParams.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `thread/backgroundTerminals/list|clean|terminate` (by `processId`) are experimental — [App-server docs](https://learn.chatgpt.com/docs/app-server); [SCR/m-exp.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-exp.txt)
- `features.unified_exec` ("Resumable command execution") is stable — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference). `unified_exec` and `unified_exec_tty` are both stable/true locally, and `write_stdin_approval` is stable/true — local `codex features list` (0.159.1)
- `thread/shellCommand {threadId, command: string, timeoutMs?}`:
  - Behavior: "runs unsandboxed with full access". On an idle thread it starts a standalone turn; on an active turn its output is injected into that turn.
  - Timeout: defaults to 1 hour; `0` means immediate timeout.

  Sources: [TS:ThreadShellCommandParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadShellCommandParams.ts); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Goals:
  - `thread/goal/set {threadId, objective?, status?, tokenBudget?}`, `thread/goal/get`, `thread/goal/clear`, with notifications `thread/goal/updated` and `thread/goal/cleared`
  - `ThreadGoal = {threadId, objective, status, tokenBudget, tokensUsed, timeUsedSeconds, createdAt, updatedAt}`
  - `ThreadGoalStatus = active|paused|blocked|usageLimited|budgetLimited|complete`

  Sources: [TS:ThreadGoalSetParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadGoalSetParams.ts); [TS:ThreadGoal](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadGoal.ts); [TS:ThreadGoalStatus](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadGoalStatus.ts)
- In 0.159.1 the `thread/goal/*` methods are in the **stable** method set — [SCR/m-stable.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-stable.txt)
- Goal rules: objective non-empty and at most 4,000 characters. A new objective replaces the goal and resets usage; re-sending the same objective, or omitting it, updates only status or budget — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- `features.goals` is stable and on by default: "Persisted goals and automatic continuation" — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- `thread/fork.deferGoalContinuation` (exp): "carry the source thread's current goal into the fork without starting its initial automatic continuation" — [TS:ThreadForkParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadForkParams.ts)
- `codex cloud [EXPERIMENTAL]` subcommands: `exec` ("Submit a new Codex Cloud task without launching the TUI"), `status`, `list`, `apply`, `diff`. `codex apply` applies the latest agent diff via `git apply` — local `codex cloud --help` (0.159.1)
- `sleep` items exist and the `sleep_tool` feature is stable/true — [TS:ThreadItem](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/ThreadItem.ts); local `codex features list`

### Inferences
- machdoch's goals path should drop `experimentalApi` dependence for goal calls (they are stable in 0.159.1) and keep it only for experimental fields it actually uses.
- Goals continue automatically after turns end, until `complete`, `budgetLimited` or `usageLimited`. A host using goals must keep the app-server process and thread alive and subscribed, which a one-shot exec cannot do.
- `command/exec` can back a host "run tests / terminal" panel that shares Codex's sandbox and auth without spawning Codex turns.

### Gaps
- The exact continuation trigger semantics for goals (when the next automatic turn starts, and how `blocked` is entered or exited) are not documented beyond the status enum.
- `codex cloud exec` flags and environment requirements were not explored further.

## Subagents and multi-agent v1/v2, hooks, skills, plugins, apps, MCP management, dynamic tools

### Takeaway
Multi-agent is on by default. The `multi_agent_v2` runtime is stable but off by default locally, and each model declares `multiAgentVersion`. In `ultra` effort Codex delegates proactively. Subagent activity surfaces as `collabAgentToolCall` and `subAgentActivity` items plus child threads (`parentThreadId`). Hooks, skills, plugins, apps and MCP are all inspectable and controllable over app-server. **Dynamic tools** let the host expose its own functions directly to the model: `thread/start.dynamicTools` (experimental) plus the stable `item/tool/call` server request. That is a credible replacement for an MCP sidecar.

### Cited Findings
**Multi-agent**
- Features: `multi_agent` stable/true, `multi_agent_v2` stable/false, `multi_agent_mode` removed — local `codex features list` (0.159.1)
- `Model.multiAgentVersion` per model. The local catalog has v2 for gpt-6.x and gpt-5.6-sol/terra, and v1 for gpt-5.6-luna, gpt-reserve and codex-auto-review — [SCR/codex-models.json](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/codex-models.json)
- `CollabAgentTool = spawnAgent | sendInput | resumeAgent | wait | closeAgent | sendMessage | followupTask | interruptAgent | listAgents`. Item `subAgentActivity {kind: started|interacted|interrupted|completed, agentThreadId, agentPath}` — [TS:CollabAgentTool](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/CollabAgentTool.ts); [TS:SubAgentActivityKind](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/SubAgentActivityKind.ts)
- `Thread.parentThreadId` is "only set if this thread is a subagent" — [TS:Thread](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/Thread.ts)
- `multiAgentMode` param: "@deprecated Ignored. Use `effort: "ultra"` for proactive multi-agent behavior" — [TS:TurnStartParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/TurnStartParams.ts)
- Subagent docs — [Subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents):
  - "Ultra enables proactive delegation"
  - Settings resolve as explicit spawn value, then `[agents]` default, then parent
  - Built-in agents are `default`, `worker` and `explorer`. Custom agents live in `~/.codex/agents/` or `.codex/agents/` and need `name`, `description` and `developer_instructions`
  - `agents.interrupt_message` defaults to true
- Config: `agents.enabled`, `agents.max_concurrent_threads_per_session` (legacy alias `agents.max_threads`), `agents.default_subagent_model`, `agents.default_subagent_reasoning_effort`, and `agents.<name>.config_file|description` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference). I found no key named `multi_agent_reasoning_effort`.
- Changelog:
  - 0.162.0 "Enable dynamic tool inheritance for fresh V2 subagents"
  - 0.163.0 "Allow hiding native tools while retaining the multi-agent V2 runtime"
  - 0.164.0 "Preserve parent history by default in full agent forks"; "Resume unloaded subagent threads when selected in the TUI"

  Source: [Changelog](https://learn.chatgpt.com/docs/changelog)

**Hooks**
- `hooks/list`, plus notifications `hook/started` and `hook/completed {threadId, turnId, run: HookRunSummary{id, eventName, handlerType, executionMode, scope, sourcePath, source, status, statusMessage, …}}` — [TS:HookStartedNotification](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/HookStartedNotification.ts); [TS:HookRunSummary](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/HookRunSummary.ts)
- Hook notifications fire for synchronous hooks only — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- Hook config: events `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `SessionEnd`; command and MCP-tool handlers run; prompt and agent handlers are parsed but skipped; `async`, `additionalContextLimit` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- CLI `--dangerously-bypass-hook-trust` exists — local `codex --help`
- Changelog: 0.164.0 "observation-only model request lifecycle hooks"; 0.165.0 "environment-scoped managed hooks" — [Changelog](https://learn.chatgpt.com/docs/changelog)

**Skills, plugins, apps, MCP**
- Skills: `skills/list` (`forceReload`, `perCwdExtraUserRoots`), `skills/extraRoots/set` (in-memory), `skills/config/write`, and notification `skills/changed`. `UserInput` supports `{type: "skill", name, path}` and `{type: "mention", name, path}` — [App-server docs](https://learn.chatgpt.com/docs/app-server); [TS:UserInput](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/UserInput.ts)
- Plugins: `plugin/list|read|install|uninstall` are "under development and shouldn't be used in production". Also `marketplace/*` and `app/list|read|installed` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- MCP management:
  - Methods: `mcpServerStatus/list` (`detail: full|toolsAndAuthOnly`), `mcpServer/oauth/login`, `mcpServer/resource/read`, `mcpServer/tool/call`, `config/mcpServer/reload`
  - Notification: `mcpServer/startupStatus/updated`
  - Config read/write: `config/read`, `config/value/write`, `config/batchWrite`

  Source: [App-server docs](https://learn.chatgpt.com/docs/app-server)

**Dynamic tools**
- `DynamicToolSpec = {type: "function", name, description, inputSchema, deferLoading?} | {type: "namespace", name, description, tools[]}` — [TS:DynamicToolSpec](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/DynamicToolSpec.ts); [TS:DynamicToolFunctionSpec](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/DynamicToolFunctionSpec.ts)
- Server request `item/tool/call {threadId, turnId, callId, namespace, tool, arguments}` → response `{contentItems: [{type: inputText, text} | {type: inputImage, imageUrl} | {type: inputAudio, audioUrl}], success}` — [TS:DynamicToolCallParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/DynamicToolCallParams.ts); [TS:DynamicToolCallResponse](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/DynamicToolCallResponse.ts)
- `dynamicTools` exists only in the experimental schema, while `item/tool/call` is in the stable ServerRequest set — schema diff of SCR/cx-stable and SCR/cx-exp
- Dynamic tools are persisted in rollout metadata and restored on `thread/resume` unless new ones are supplied. The flow is `item/started` (`dynamicToolCall`), then the client response, then `item/completed` — [App-server docs](https://learn.chatgpt.com/docs/app-server)
- 0.164.0 "Allow dynamic tool calls to execute in parallel" — [Changelog](https://learn.chatgpt.com/docs/changelog)

### Inferences
- machdoch's per-run MCP servers that wrap host-internal capabilities (for example Tauri app control) could become dynamic tools answered in-process. That removes MCP sidecar spawning and config.toml rewriting. The cost is depending on an experimental field and keeping the app-server connection alive, because the tools are answered over that connection.
- The brief's observation that subagents inherit config `developer_instructions` even with fork_turns "none" fits the documented explicit, then `[agents]`, then parent resolution order. The docs do not state it for instructions specifically.

### Gaps
- The `fork_turns` parameter semantics and the v1 vs v2 tool surface differences (beyond the enum above) were not found in official docs.
- Whether dynamic tools reach v1 subagents is unknown; the changelog only mentions "fresh V2 subagents".

## Follow-up suggestions (suggested next prompts)

### Takeaway
I found no Codex feature that proposes follow-up prompts after a turn, in either the TUI docs or the app-server protocol. The nearest relatives are agent questions with suggested answer options (`requestUserInput`), TUI recaps (`tui.auto_recap`, `/recap`), and plugin install suggestions (`tool_suggest`, `installSuggestionPluginNames`).

### Cited Findings
- No notification or request of that kind exists among the 83 server notifications or 10–11 server requests of 0.159.1. Across all generated TS bindings, the only file mentioning "suggest" is `v2/PluginInstalledParams.ts` (`installSuggestionPluginNames`, for mention surfaces that expose install entrypoints) — [SCR/m-exp.txt](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/m-exp.txt); [TS:PluginInstalledParams](file:///C:/Users/ehrha/AppData/Local/Temp/claude/C--Development-machdoch/dd3e5508-041e-4930-b633-c0e644aa1f2e/scratchpad/cx-ts-exp/v2/PluginInstalledParams.ts)
- The config reference has no follow-up-suggestion setting. The closest is `tui.auto_recap` (default true), which generates recaps while the terminal is unfocused, with `/recap` available — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- A web search found none. TUI queueing (Tab) and agent questions with suggested answers are related but different — [search summary incl. danielvaughan.com](https://codex.danielvaughan.com/2026/09/05/async-tui-questions-codex-cli-v0154-human-agent-collaboration/)
- Feature `tool_suggest` is stable/true locally; semantics not documented in the sources read — local `codex features list` (0.159.1)

### Inferences
- If machdoch wants follow-up chips for Codex, it must generate them itself, for example with a cheap side call or with `outputSchema` on a separate ephemeral thread.

### Gaps
- What `tool_suggest` does was not confirmed.

## Official SDKs and the exec CLI surfaces (resume, fork, output-schema)

### Takeaway
The **TypeScript SDK** (`@openai/codex-sdk`) is a thin wrapper over `codex exec --experimental-json`, essentially what machdoch already does. It adds `resume <id>`, `outputSchema` and AbortSignal cancellation, but has no approvals or steering. The **Python SDK** (`openai-codex`) drives `codex app-server` over JSON-RPC. `codex exec` itself supports `resume`, `fork`, `review`, `--output-schema`, `-o`, `--json` and `--ephemeral`.

### Cited Findings
- The TS SDK spawns `["exec", "--experimental-json"]` (plus `"resume", threadId`). Flags: `--model`, `--sandbox`, `--cd`, `--add-dir`, `--skip-git-repo-check`, `--output-schema <file>`, `--image`, `--thread-source`, `--config model_reasoning_effort=…`, `--config approval_policy=…`, `--config sandbox_workspace_write.network_access=…`, `--config web_search=…`, `--cyber-access-program`. The prompt goes in via stdin and the API key via `CODEX_API_KEY`. `signal` is passed to `spawn`, so AbortSignal cancels — [TS SDK exec.ts](https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/exec.ts)
- TS API: `new Codex({env, baseUrl, config, configOverrides})`, `startThread({workingDirectory, skipGitRepoCheck, …})`, `resumeThread(id)`, `thread.run()` (→ `finalResponse`, `items`), `thread.runStreamed()` (→ `{events}` async generator). `outputSchema` takes JSON Schema or Zod (via `zod-to-json-schema`, target `openAi`). Requires Node 18+; threads live in `~/.codex/sessions` — [TS SDK README](https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md)
- Python SDK — [Codex SDK docs](https://learn.chatgpt.com/docs/codex-sdk.md):
  - Install with `pip install openai-codex` (Python 3.10+). The SDK "controls the local Codex app-server over JSON-RPC".
  - API: `Codex` / `AsyncCodex`, `thread_start(model=…, sandbox=…)`, `thread.run()` → `final_response`, `CodexConfig(codex_bin=…)`, `Sandbox.read_only|workspace_write|full_access`. A per-turn sandbox also applies to later turns. Published builds bundle a pinned CLI runtime.
  - **Conflict on status:** the English docs fetched say stable (`--pre` for prereleases), while search snippets and third-party posts call it beta (v0.1.0b2 in June 2026) — [danielvaughan.com](https://codex.danielvaughan.com/2026/06/03/openai-codex-python-sdk-v01-complete-api-reference-practical-patterns/)
- `codex mcp-server` / `codex-mcp-server` have been removed. Custom clients are pointed at app-server — [Codex SDK docs](https://learn.chatgpt.com/docs/codex-sdk.md)
- `codex exec resume [SESSION_ID|name] [PROMPT] [--last] [--all] [-i]` and `codex exec fork <SESSION_ID> [PROMPT]`. `exec` flags include `--ephemeral`, `--ignore-user-config` ("auth still uses CODEX_HOME"), `--ignore-rules`, `--output-schema <FILE>`, `-o/--output-last-message`, `--json`, `--worktree`, `--thread-source`, `--approve-for-me`, `-p/--profile` ("Layer $CODEX_HOME/<name>.config.toml") and `--strict-config` — local `codex exec --help` / `codex exec resume --help` / `codex exec fork --help` (0.159.1)
- `--output-schema` asks for a final response that conforms to a JSON Schema. On app-server, `TurnStartParams.outputSchema` applies to the current turn only — [Non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode); [App-server docs](https://learn.chatgpt.com/docs/app-server)
- The docs warn not to set `OPENAI_API_KEY`/`CODEX_API_KEY` as job-level env vars in workflows that run repository-controlled code, and to treat `~/.codex/auth.json` like a password — [Non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode)

### Inferences
- The cheapest incremental upgrade on the exec path: keep a persistent CODEX_HOME, drop `--ephemeral`, record `thread.started.thread_id`, and use `codex exec resume <id> -` for later turns instead of re-sending history. Add `-c service_tier="fast"` and `--output-schema` where needed.
- The TS SDK offers machdoch (a Rust/Tauri host) nothing beyond its existing exec driver. The Python SDK shows that app-server is OpenAI's intended rich-client surface.

### Gaps
- No version-compatibility matrix between the SDK packages and the CLI was found.

## Recent changelog items relevant to integration (roughly 0.4x to 0.165)

### Takeaway
Only releases 0.161.0 to 0.165.0 (October 2026) could be read in the official changelog within budget. They show active churn in forks, queue, resume, hooks, dynamic tools and service tiers. Minimum versions for older features (turn/steer, thread/fork, review/start, goals) could not be confirmed from primary sources.

### Cited Findings
Source for all entries: [Changelog](https://learn.chatgpt.com/docs/changelog)
- **0.165.0 (2026-10-27):**
  - "experimental attached thread forks to the app-server API"
  - "Prevented queued agent messages from restarting work after an interrupt or a switch to Plan mode"
  - "Fixed fresh TUI sessions to honor the server's default approval reviewer"
  - "environment-scoped managed hooks"
- **0.164.0 (2026-10-23):**
  - Compaction: "Failed compaction no longer leaves partial summaries"; "Wire background compaction into the turn lifecycle"
  - Resume: "Resuming sessions now finds compressed histories and restores saved thread settings"; "Preserve thread model settings across resume and revert"
  - Queue and approvals: "Queued prompts now wait for pending permission selections"
  - App-server: experimental `thread/sample`; "one-shot app-server startup configuration discovery"
  - Tools and usage: "Allow dynamic tool calls to execute in parallel"; "Support inline model, reasoning, and speed selection in /model"; "Avoid double-counting retained reasoning in token usage"
- **0.163.0 (2026-10-15):**
  - "connection-bound reply handles for app-server requests"
  - "Send a follow-up while Codex is responding to steer it immediately"
  - "Resuming a saved thread restores its permissions and network approvals"
  - "async compaction feature configuration"
  - "Account for token usage from incomplete responses"
  - "`codex exec` no longer prints the same file diff again after an unrelated command"
  - "Allow hiding native tools while retaining the multi-agent V2 runtime"
- **0.162.0 (2026-10-08):**
  - "Enforce Fast and Ultra Fast policies independently"
  - "Consolidate command execution output into `aggregated_output`"
  - "Enable dynamic tool inheritance for fresh V2 subagents"
  - "Preserve review targets…"
  - "Preserve queued agent mail across session eviction"
- **0.162.1 (2026-10-09):** fixes for multi-line async questions and background-server feature compatibility checks
- **0.161.0 (2026-10-07):** `/mcp login <name>` from a terminal session

### Inferences
- Pinning machdoch's protocol bindings to a specific CLI version is prudent. The schema is version-specific (`generate-ts` / `generate-json-schema`, per the [App-server docs](https://learn.chatgpt.com/docs/app-server)), and 0.159.1 already lags 0.165.0. Regenerate the bindings at build time, or probe with `experimentalFeature/list` and `model/list` at runtime.

### Gaps
- No primary-source minimum versions for the 0.4x to 0.160 range (`turn/steer`, `thread/fork`, `thread/revert` replacing `thread/rollback`, `review/start`, goals, dynamic tools, `thread/queue/*`). The changelog page truncated before 0.161, and GitHub release notes were not fetched within the tool budget. Only a third-party blog dates async TUI questions to v0.154 ([danielvaughan.com](https://codex.danielvaughan.com/2026/09/05/async-tui-questions-codex-cli-v0154-human-agent-collaboration/)).
