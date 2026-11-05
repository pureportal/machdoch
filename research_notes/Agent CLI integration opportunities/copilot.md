# GitHub Copilot CLI and Copilot SDK as a deeper integration target for machdoch (state as of 2026-10-29)

Version context used throughout: the installed CLI is 1.0.103 (`copilot --version`). The latest CLI on npm is 1.0.105 (2026-10-28). The latest Rust SDK crate is 1.0.28 (2026-10-28) and bundles CLI 1.0.105. machdoch pins `github-copilot-sdk = "=1.0.7-preview.2"` with `default-features = false`. That crate was published 2026-07-11 and was generated against CLI 1.0.70. Abbreviation: **CR** means the local crate root `file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/`. **SDK-main** means `github/copilot-sdk` at main, fetched 2026-10-29.

## 1. Copilot SDK architecture, languages, session lifecycle and storage

### Takeaway
The Copilot SDK has been GA since 2026-06-02 and ships in six languages, Rust included. It spawns `copilot --server --stdio` (or `--server --port`), or attaches to `copilot --headless --port N`, and speaks Content-Length-framed JSON-RPC 2.0, protocol version 3. A single long-lived CLI process hosts many persistent sessions. Sessions can be created, resumed, forked, compacted, truncated or rewound, aborted, suspended and disconnected. Sessions live under `$COPILOT_HOME/session-state/<id>/`. The hand-written helpers count as the stable GA surface. **Every generated `rpc()` method carries an "Experimental" banner:** all 255 in 1.0.7-preview.2 and all 587 in SDK-main.

### Cited Findings
**Status and timeline**
- Technical preview opened 2026-01-14 and public preview 2026-04-02 (Java added). GA came 2026-06-02 ("Rust is new at General Availability"; six languages). The SDK is available to all Copilot subscribers including Free, and to non-subscribers via BYOK. These dates come from search-result snippets of the changelog posts — [GitHub changelog: technical preview](https://github.blog/changelog/2026-01-14-copilot-sdk-in-technical-preview/), [public preview](https://github.blog/changelog/2026-04-02-copilot-sdk-in-public-preview/), [GA](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)
- The GA post lists these changes since preview: a new Rust SDK that bundles the CLI by default; better multi-client support, where different clients contribute tools and permissions to one session; slash commands and interactive input prompts in all SDKs; and an "API surface declared stable after cleanup" — [GA changelog](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)
- The repo README says the SDK "is generally available and follows semantic versioning". It also says the SDK is "becoming Microsoft Copilot SDK" in a phased transition; package names may still say GitHub — [github/copilot-sdk README](https://github.com/github/copilot-sdk)

**Packages**
- Node/TS `@github/copilot-sdk`, Python `github-copilot-sdk`, Go `github.com/github/copilot-sdk/go`, .NET `GitHub.Copilot.SDK`, Rust `github-copilot-sdk`, Java `com.github:copilot-sdk-java`. Clojure and C++ ports are community-maintained and unsupported — [github/copilot-sdk README](https://github.com/github/copilot-sdk)
- npm `@github/copilot-sdk` dist-tags: latest `1.0.28`, prerelease `1.0.28-preview.0`, unstable `1.0.25-unstable…` — [npm registry](https://registry.npmjs.org/@github/copilot-sdk)
- Rust crate stable releases: 1.0.0 (2026-06-02), 1.0.7 (07-16), 1.0.13 (09-04), 1.0.14 (09-16), 1.0.17 (10-07), then near-daily releases up to 1.0.28 (10-28). `1.0.7-preview.2` dates from 2026-07-11 — [crates.io API](https://crates.io/api/v1/crates/github-copilot-sdk)
- Crate 1.0.28 pins `version=1.0.105` of the CLI — [docs.rs source cli-version.txt](https://docs.rs/crate/github-copilot-sdk/1.0.28/source/cli-version.txt). The local 1.0.7-preview.2 pins `version=1.0.70` — [CR cli-version.txt](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/cli-version.txt)
- `SDK_PROTOCOL_VERSION = 3` holds in both the local crate and SDK-main — [CR src/sdk_protocol_version.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/sdk_protocol_version.rs), [SDK-main sdk_protocol_version.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/sdk_protocol_version.rs)

**Transport and process model**
- The Rust crate's diagram reads `Client` → `Session` → "JSON-RPC over stdio or TCP" → `copilot --server --stdio`. It uses JSON-RPC 2.0 with LSP-style `Content-Length` framing — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md)
- The spawn args in `lib.rs` are `--server --stdio --no-auto-update` for stdio, or `--server --port <p> --no-auto-update` for TCP. Optional extras are `--auth-token-env`, `--no-auto-login`, `--session-idle-timeout <s>`, `--remote` and `--log-level` — [CR src/lib.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/lib.rs). Neither `--server` nor `--headless` appears in `copilot --help` on 1.0.103; both are undocumented in help (local CLI).
- `Transport` values:
  - `Default` reads `COPILOT_SDK_DEFAULT_CONNECTION`; `Stdio`.
  - `InProcess` uses FFI with no child process and is marked **experimental**. It needs the `bundled-in-process` feature, and it does not support per-client cwd/env/telemetry/github_token. `base_directory` still works and becomes `COPILOT_HOME`.
  - `Tcp{port, token}` auto-generates a 128-bit connection token. `External{host, port, token}` attaches to a running server.
  - Source: [CR src/lib.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/lib.rs)
- The docs give the external-server recipe as `copilot --headless --port 4321`. With no port it picks a random one and prints "Listening on http://localhost:…". It is loopback-only by default (`--host 0.0.0.0` to widen) and takes `--session-idle-timeout`. SDKs connect with `connection: RuntimeConnection.forUri(...)` (TS) or `URIConnection` (Go). The page notes "No built-in auth between SDK and CLI" — [docs: backend services](https://docs.github.com/en/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/backend-services)
- CLI 1.0.49: "--plugin-dir and --additional-mcp-config work in --server and --headless modes". CLI 1.0.58: "Remote JSON RPC is now enabled by default" — [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)

**Client options (Rust)**
- `ClientOptions` fields: `program` (`Resolve`/`Path`), `prefix_args`, `extra_args`, `working_directory`, `env`, `env_remove`, `transport`, `github_token`, `use_logged_in_user`, `log_level`, `session_idle_timeout_seconds`, `telemetry`, `base_directory`, `enable_remote_sessions`, `mode`, `session_fs` and `list_models_handler` — [CR src/lib.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/lib.rs)
- `base_directory` is exported as `COPILOT_HOME`, for "running multiple isolated SDK instances side-by-side" — [CR src/lib.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/lib.rs)
- `TelemetryConfig` can set exporter type, OTLP endpoint/protocol, a `file_path` (file exporter), `source_name` and `capture_content`. It works by injecting `COPILOT_OTEL_*`/`OTEL_*` env vars — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md)
- `ClientMode::CopilotCli` is the default and matches Copilot CLI behaviour. The crate warns "Do not use this mode for server-based multi-user applications". `ClientMode::Empty` turns optional features off unless opted in: custom instructions skipped, custom agents local-only, no co-author trailer, no `manage_schedule` tool, memory off, and no built-in skills from SDK 1.0.13 — [CR src/mode.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/mode.rs), [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs), [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)

**CLI bundling and resolution**
- With `bundled-cli` off, the crate does no PATH scanning. Callers must set `CliProgram::Path` or `COPILOT_CLI_PATH`. The README warns: "the SDK and CLI are versioned together", so do not assume an arbitrary installed CLI is compatible — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md)
- Conflict: the repo README says "Go, Java, and Rust require a manual CLI install or a PATH entry". The crate README says `bundled-cli` is on by default with no PATH scanning, and the GA post says the Rust SDK "bundles the Copilot CLI binary by default" — [github/copilot-sdk README](https://github.com/github/copilot-sdk) vs [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md)

**Session lifecycle: helper APIs (Rust, 1.0.7-preview.2)**
- On `Client`: `create_session`, `resume_session`, `list_sessions`, `get_session_metadata`, `delete_session`, `get_last_session_id`, `get/set_foreground_session_id`, `get_status`, `get_auth_status`, `list_models`, `ping`, `stop`, `force_stop`, `subscribe_lifecycle` and `rpc()` — [CR src/lib.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/lib.rs)
- On `Session`: `send`, `send_and_wait` (default timeout 60 s; one at a time per session), `get_events`/`get_messages`, `abort`, `set_model`, `disconnect`, `destroy`, `log`, `subscribe`, the `ui()` helpers (`elicitation`/`confirm`/`select`/`input`), `capabilities`, `workspace_path`, `remote_url` and `rpc()` — [CR src/session.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/session.rs)
- SDK-main adds `send_and_wait_typed`, `set_auto_tier`, `set_tools`, `prepare_session`/`prepare_resume_session` (subscribe before the first event, SDK 1.0.13) and `transcript_recovery` — [SDK-main rust/src/session.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/session.rs), [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)

**Session lifecycle: generated RPCs (all experimental)**
- Sessions: `sessions.open`, `sessions.fork` (`sessionId`, optional `toEventId`), `sessions.close`, `sessions.save`, `sessions.list`, `sessions.findByPrefix`, `sessions.findByTaskId` and `sessions.pruneOld`.
- History: `session.history.compact`, `.truncate` (to an event), `.abortManualCompaction` and `.summarizeForHandoff`.
- `session.suspend` ("preserving persisted state for later resume"), `session.shutdown` and `session.abort`.
- Source: [CR src/generated/rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs)
- SDK-main adds `session.history.rewind`, `listRewindPoints`, `previewRewind` (conversation plus file restore, "Not crash-atomic") and `clearContext`. It also adds `sessions.readPersistedEvents` (page through a session's journal without opening it), `sessions.delete` and `sessions.getMetadata` — [SDK-main rust/src/generated/rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- Every generated RPC method is annotated "**Experimental.** This API is part of an experimental wire-protocol surface … Pin both the SDK and CLI versions if your code depends on it." That is 255 of 255 locally and 587 of 587 in SDK-main (own scan of `Wire method:` doc blocks) — [CR src/generated/rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- `ResumeSessionConfig` can take `continue_pending_work`, which continues tool calls or permission requests pending when the previous connection dropped (pair it with `Client::force_stop` for hand-off). It can also take `suppress_resume_event`, which force-fails if the session doesn't exist (wire name `disableResume`) — [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs)

**Storage and persistence**
- Persistence lives under `~/.copilot/session-state/{sessionId}/` with `checkpoints/`, `plan.md` and `files/`. Provider keys and in-memory tool state are not persisted. The doc says supplying your own `sessionId` is "the key to resumable sessions". `deleteSession` is permanent; `disconnect()` keeps data and `destroy()` is deprecated. There is no idle timeout by default. `infiniteSessions` takes `backgroundCompactionThreshold` (e.g. 0.80) and `bufferExhaustionThreshold` (e.g. 0.95). The doc states "no built-in session locking", so concurrent access is undefined — [SDK docs: session persistence](https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md)
- A local session directory on this machine contains `events.jsonl`, `workspace.yaml`, `checkpoints/index.md`, `files/`, `research/` and `.workspace-fork.lock` (local `~/.copilot/session-state/<id>/` listing).
- Infinite sessions are on by default in the CLI. The CLI emits `session.compaction_start`/`session.compaction_complete`, and the session id stays stable across compactions — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md)
- Conflict on cleanup naming: SDK 1.0.13 says "`session.detach` replaces `session.destroy`". The Rust main `session.rs` still exposes `disconnect` and `destroy`, and the persistence doc names `disconnect()` as the replacement — [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md) vs [SDK-main session.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/session.rs)

**SessionConfig fields relevant to machdoch (local crate)**
- Model and reasoning: `model`, `reasoning_effort`, `reasoning_summary`, `context_tier` (`long_context`) and `model_capabilities` overrides.
- Streaming and prompts: `streaming`, `system_message` (section-level "customize"/transform) and `tools` (client tools, which can override built-ins).
- Tool filtering: `available_tools`, `excluded_tools` and `excluded_builtin_agents`.
- Extensibility: `mcp_servers`, `enable_config_discovery`, `skill_directories`, `instruction_directories`, `plugin_directories`, `disabled_skills`, `hooks`, `custom_agents`, `default_agent` and `agent`.
- Sessions, providers and limits: `infinite_sessions`, `provider` (BYOK), `session_limits` (experimental), `memory`, `config_directory`, `working_directory`, `github_token`, `remote_session`, `cloud` and `include_sub_agent_streaming_events` (default true).
- CLI-behaviour toggles: `commands`, `skip_custom_instructions`, `custom_agents_local_only`, `coauthor_enabled` and `manage_schedule_enabled`.
- Handler slots: permission, elicitation, MCP auth, user-input, exit-plan-mode, auto-mode-switch, hooks and system-message transform.
- Source: [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs)
- SDK 1.0.14 added `allowed_models` on Session/ResumeSessionConfig — [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)

### Inferences
- Moving from one-shot `copilot -p` to one long-lived `Client` (stdio, `base_directory` = machdoch's isolated COPILOT_HOME, `ClientMode::Empty`) would remove the need to re-send history. machdoch would `resume_session` by its own session id instead. That one change unlocks most of the capabilities below.
- Version skew risk: machdoch's crate was generated against CLI 1.0.70 and is used with CLI 1.0.103+ (no bundling). The wire schema has grown about 2.3x since then (255 to 587 methods; 106 to 150 event types). machdoch should either bump to 1.0.28 and point it at a matching CLI (1.0.105), or keep the bundled CLI. All the deep-integration RPCs are "experimental", so pin SDK and CLI together.

### Gaps
- No official doc confirms the exact semantics or stability of `--server` versus `--headless`. Both are hidden from `--help`, and the docs show only `--headless`.
- I did not verify method-by-method that each SDK-main RPC is present in the published 1.0.28 tarball. Main may be ahead of 1.0.28 by a day.

## 2. Mid-turn input: queueing, steering, interrupt and abort

### Takeaway
`session.send` takes a `mode` of `"enqueue"` (default; FIFO, runs after the current turn) or `"immediate"` (steering, injected before the next LLM request in the current turn). Abort is `session.abort`, which ends the turn and yields `session.idle{aborted:true}`. Newer CLIs/SDK-main add a much richer queue API: list, edit, reorder, withdraw, send-now and append-to-steering. They also add `session.interruptMainTurn`, which stops the main turn but keeps background agents and shells running. All of these are experimental.

### Cited Findings
- `MessageOptions` has these fields:
  - `prompt` and `mode` (`DeliveryMode::Enqueue` default / `Immediate` "Interrupt the session and run the prompt immediately").
  - `agent_mode` (`interactive`|`plan`|`autopilot`|`shell`) and `attachments`.
  - `request_headers` and `traceparent`/`tracestate`.
  - `display_prompt` ("shown in the timeline instead of `prompt`") and `wait_timeout`.
  - Source: [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs)
- Steering puts the message on the runtime's `ImmediatePromptProcessor` queue and injects it before the next LLM request in the current turn. It is "best-effort within the current turn". If a tool call is already committed, the steer applies after that call finishes. If the turn ends first, the message moves to the queue. The doc says "regular queue" in one place and "front of the queue" in another, an internal inconsistency. Queued items (`itemQueue`/`QueuedItem`) dequeue FIFO when the session goes idle; each one starts a full turn, and an empty queue emits `session.idle`. A returned message ID confirms acceptance, not consumption — [SDK docs: steering & queueing](https://github.com/github/copilot-sdk/blob/main/docs/features/steering-and-queueing.md)
- Queue RPCs available locally (1.0.7-preview.2): `session.queue.pendingItems` ("pending user-facing queued items and steering messages"), `session.queue.removeMostRecent` (LIFO) and `session.queue.clear`. Slash-command queueing uses `session.commands.enqueue` and `respondToQueuedCommand`. The event `pending_messages.modified` has an empty payload and signals a queue change — [CR src/generated/rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [CR src/generated/session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs)
- SDK-main adds these queue methods:
  - `session.queue.sendNow` ("Moves an addressable queued message into the live turn's steering lane"), `moveItem`, `insertAt`, `removeAt`, `updateText` and `duplicateAt`.
  - `withdrawMessage` ("Atomically withdraws an unchanged user message … from the queued or steering lane while unconsumed, or from the running turn it started…").
  - `appendSteering` and `setDrainPaused`.
  - Source: [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- SDK-main also adds:
  - `session.interruptMainTurn`: "Interrupts the current main agent turn while leaving running background work (subagents, sidekicks, and promoted attached shells) alive".
  - `session.cancelAllBackgroundAgents`: cancels background agents "without interrupting the main agent loop".
  - The event `agent.interrupted`: "Metadata for work the user interrupted".
  - Source: [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs), [SDK-main session_events.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/session_events.rs)
- `session.idle` payload: `aborted: Option<bool>`, "True when the preceding agentic loop was cancelled via abort signal". The event fires only when there are no background agents or attached shell commands in flight — [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs)
- Messages to a background agent go through `session.tasks.sendMessage` (local crate). CLI 1.0.92: "Messaging a running background agent steers its active turn" — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- CLI queueing changelog:
  - 1.0.79: prompts, shell commands and supported slash commands queue in local sessions; in-flight steering prompts show "pending · ctrl+c to cancel".
  - 1.0.87: consecutive steering prompts combine.
  - 1.0.89: Esc Esc takes back an unstarted prompt.
  - 1.0.90: withdrawn running prompts stay removed after resume.
  - 1.0.93: safe `/user` commands run during active turns; commands from relay hosts are queued.
  - 1.0.83: stopping a timed-out shell lets queued messages run.
  - Source: [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- SDK 1.0.14: messages carry typed source provenance (`user`, `system`, `agent-…`) through `send` with `source` — [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)

### Inferences
- machdoch could offer real "steer while running" by sending with `DeliveryMode::Immediate` and a "queue next" option with `Enqueue`, plus a visible, editable queue (`pendingItems`, and `sendNow`/`withdrawMessage` on newer SDKs). Its current model is kill-and-restart.
- Cancel could become `session.abort` (or `interruptMainTurn` to keep background work) instead of killing the process tree. That preserves session state and lets the next turn continue without re-sending history.

### Gaps
- No doc describes what happens to queued items on `session.abort` (cleared or kept). The steering doc is silent on it.

## 3. Permissions, user input, elicitation, plan mode and autopilot / auto-mode switching

### Takeaway
The CLI raises six kinds of host request, each with a `*.requested`/`*.completed` event pair and a `handlePending*` RPC: `permission`, `user_input` (ask_user), `elicitation` (forms/URL), `exit_plan_mode`, `auto_mode_switch` (rate-limit fallback to Auto) and `session_limits_exhausted`. A host answers either by installing SDK handler traits (the SDK replies automatically) or by subscribing to events and calling the RPC itself. If no handler is installed, the matching wire flag is false and the feature is disabled or left to another client. Without a user-input handler, `ask_user` is disabled.

### Cited Findings
- The five Rust handler traits and their setters are `PermissionHandler` (`with_permission_handler`), `ElicitationHandler`, `UserInputHandler`, `ExitPlanModeHandler` and `AutoModeSwitchHandler`. "The CLI's `requestPermission` / `requestElicitation` / `requestUserInput` / etc. wire flags are derived automatically from which traits you've installed". Clients without a handler are skipped so another connected client can answer — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md)
- `user_input_handler: None` sends `requestUserInput: false` and "the `ask_user` tool is disabled" — [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs)
- `permission.requested` data contains:
  - `permissionRequest`, one of `Shell`, `Write`, `Read`, `Mcp`, `Url`, `Memory`, `CustomTool`, `Hook`, `ExtensionManagement` or `ExtensionPermissionAccess`.
  - `promptRequest` (derived UI prompt), `requestId` and `resolvedByHook`.
  - An experimental auto-approval judge outcome.
  - `Write` requests include `diff`, `fileName`, `newFileContents`, `intention` and `canOfferSessionApproval`.
  - Source: [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs)
- `PermissionResult` values: `approve_once`, `reject(feedback)`, user-not-available, or `NoResult` (let another client answer). Wire decisions include `ApproveOnce`, `ApproveForSession`, `ApproveForLocation`, `ApprovePermanently`, `Reject` and `UserNotAvailable`, among others. Manual reply goes through `session.permissions.handlePendingPermissionRequest`. `session.permissions.pendingRequests` "reconstructs the set of pending tool permission requests from the session's event history" — [CR src/handler.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/handler.rs), [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs), [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs)
- Session-level permission RPCs: `session.permissions.configure` (rules/paths/URLs/allow-all), `setApproveAll`, `setAllowAll` (removed in SDK-main), `modifyRules` and `paths.add`/`list`. SDK-main adds `session.permissions.setMode`/`getMode` with values `manual`, `assisted` (LLM safety recommendations) and `allow-all` — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- `user_input.requested` carries `question`, `choices`, `allowFreeform`, `requestId` and `toolCallId`; the reply goes to `session.ui.handlePendingUserInput`. Elicitation carries a message, an optional JSON Schema and a mode (`Form`/`Url`); the reply goes to `session.ui.handlePendingElicitation`. Hosts can also *raise* elicitation themselves via `session.ui.elicitation` and the helpers `confirm`/`select`/`input` — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md), [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs)
- SDK 1.0.13: `askUserVariant` accepts `legacy` or `elicitation` — [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)
- Exit plan mode:
  - `ExitPlanModeData` has `summary` (markdown), `planContent`, `actions` (e.g. "interactive", "autopilot", "autopilot_fleet") and `recommendedAction` (default "autopilot").
  - `ExitPlanModeResult` has `approved`, `selectedAction` and `feedback`.
  - The reply goes to `session.ui.handlePendingExitPlanMode`.
  - CLI 1.0.14 made the SDK `exit_plan_mode.requested` event always emitted. CLI 1.0.55 offers the `exit_plan_mode` tool only while in plan mode.
  - Source: [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs), [CR src/handler.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/handler.rs), [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- Auto-mode switch is a rate-limit fallback to the Auto model. `auto_mode_switch.requested` carries `errorCode`, `requestId` and `retryAfterSeconds`. Responses are `Yes`, `YesAlways` ("auto-accept future auto-mode switches in this session") and `No` (stay and surface the rate-limit error). The reply goes to `session.ui.handlePendingAutoModeSwitch`. CLI 1.0.35 added `continueOnAutoMode` — [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs), [CR src/handler.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/handler.rs), [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- Session-limit exhaustion: `session_limits_exhausted.requested`/`.completed`, answered with `session.ui.handlePendingSessionLimitsExhausted` — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs)
- Modes: `session.mode.get`/`set` and the event `session.mode_changed`. `MessageOptions.agent_mode` sets the mode per message.
- CLI flags: `--mode interactive|plan|autopilot`, `--autopilot`, `--plan` (combine with `--mode autopilot` to auto-approve the plan; 1.0.79) and `--max-autopilot-continues` (default 5).
- Source: local `copilot --help` (1.0.103); [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs); [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- `--assisted-approval` / `COPILOT_ASSISTED_APPROVAL`: a probabilistic safety judge reviews permission requests. It is "not a security boundary", is valid only non-interactively, and overrides `--allow-all-tools`. Without permission options, requests needing approval are denied in non-interactive runs — [docs: CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference). CLI 1.0.104: "Assisted Permissions are available without experimental mode". On local 1.0.103 the help still says it requires `--experimental` — [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- Resume handling: CLI 1.0.98 "Resuming respects abandoned pending-permission work and continues only active requests". CLI 1.0.90 "prompts stay answerable after resuming interrupted sessions" — [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)

### Inferences
- machdoch could swap `--allow-all --no-ask-user --autopilot` for in-app approval cards, using the structured `Write.diff` and the shell command info. It could also turn `ask_user` questions into native chat prompts and offer plan review (Approve → autopilot / interactive / fleet). Auto-switch-on-rate-limit would become a user prompt.

### Gaps
- I did not obtain the full field list of `PermissionPromptRequest` or the full list of exit-plan-mode action strings.

## 4. Reporting: quota, premium requests / AI credits, context info, metrics and multipliers

### Takeaway
Billing moved to token-based **AI Credits** on 2026-06-01; premium requests remain for legacy and annual plans. The SDK exposes five sources:
- `account.getQuota`: plan entitlement, used amount, remaining % and reset date.
- `session.usage.getMetrics`: session totals in nano-AIU and premium-request cost, per-model tokens and code changes.
- `session.metadata.contextInfo`: context-window breakdown.
- The `assistant.usage` event, per call.
- `models.list`, which returns `billing.multiplier` and token prices.

All of these are experimental. The CLI can also cap a session with `--max-ai-credits` (min 30) and can write `--usage-output-file` JSON. Newer SDKs add `session.quota.get/refresh/takeWarnings` and the `session.quota_observation` event.

### Cited Findings
- `account.getQuota` returns `quotaSnapshots` keyed by type (e.g. `chat`, `completions`, `premium_interactions`). Each snapshot has `entitlementRequests` (-1 = unlimited), `isUnlimitedEntitlement`, `usedRequests`, `remainingPercentage`, `overage`, `overageAllowedWithExhaustedQuota`, `usageAllowedWithExhaustedQuota` and `resetDate` (ISO 8601). It accepts a GitHub token so a host can read a given user's quota — [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs), [SDK docs: usage & billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md)
- `session.usage.getMetrics` returns:
  - Cost: `totalPremiumRequestCost` ("may be fractional due to multipliers"), `totalNanoAiu` and `totalUserRequests`.
  - Timing and tokens: `totalApiDurationMs`, `lastCallInput/OutputTokens` and `tokenDetails`.
  - `modelMetrics` per model (requests, usage, totalNanoAiu).
  - `codeChanges{filesModified, filesModifiedCount, linesAdded, linesRemoved}`, plus `currentModel` and `sessionStartTime`.
  - Source: [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs)
- `session.metadata.contextInfo` returns `totalTokens`, `limit`, `promptTokenLimit`, `systemTokens`, `conversationTokens`, `toolDefinitionsTokens`, `mcpToolsTokens`, `bufferTokens`, `compactionThreshold` and `modelName`. Related calls: `getContextAttribution` (per-source: skills, subagents, MCP servers, built-in tools) and `getContextHeaviestMessages`. `recomputeContextTokens` is in SDK-main and the docs — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs)
- The `assistant.usage` event is per API call, sub-agents included, and is ephemeral (not replayed on resume). Its fields:
  - Identity: `model`, `initiator` ("sub-agent", "mcp-sampling") and `parentToolCallId`.
  - Tokens: `inputTokens`, `outputTokens`, `cacheRead/WriteTokens` and `reasoningTokens`.
  - Cost and quota: `cost` (multiplier cost, experimental), `copilotUsage` and `quota_snapshots` (crate-private).
  - Timing and outcome: `duration`, `timeToFirstTokenMs`, `finishReason` and `reasoningEffort`.
  - `session.usage_info` (ephemeral) gives `currentTokens`, `tokenLimit`, `messagesLength`, `systemTokens`, `conversationTokens` and `toolDefinitionsTokens`.
  - Source: [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs), [SDK docs: usage & billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md)
- Provider quota: `session.quota.get` (local state, no network), `session.quota.refresh` and `session.quota.takeWarnings`, plus the event `session.quota_observation`. Observation kinds are `authoritative_budget`, `advisory_balance` and `admission_state`. The doc says to keep missing/null distinct from zero. It also flags `session.quota`, `usage.getMetrics`, `metadata.contextInfo` and `recomputeContextTokens` as experimental; .NET raises `GHCP001` for them — [SDK docs: usage & billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md), [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- SDK-main also adds `models.listTokenPriceUnits` (prices in AI Credits vs nano-AIU) and `session.limitPrediction.predict` ("Predicts an AI-credit session limit for the session's resolved model") — [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- Billing change: Copilot moved from premium requests to usage-based **AI Credits** on 2026-06-01. Monthly Pro/Pro+ users migrated automatically; annual plans stay on premium requests until expiry. This comes from a search snippet of the official post — [GitHub changelog 2026-04-27](https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/)
- CLI `help billing` explains:
  - The footer shows remaining AI credit budget, or premium requests on legacy billing.
  - `/statusline` options `quota` and `ai-used`.
  - `/model` shows per-token costs, or a request multiplier on legacy.
  - `/context`, plus `/usage` (AI credits, token breakdown and limit progress).
  - Source: local `copilot help billing` (1.0.103)
- CLI `help limits`: `--max-ai-credits <credits>` is opt-in with a minimum of 30. It is "a soft cap" because usage is known only after a response. Hidden compaction work counts. Timeline status appears around 50/75/90%. Subagents share the parent's limit. The SDK equivalent is `SessionConfig.session_limits` (experimental; SDK 1.0.5 `sessionLimits: { maxAiCredits }`) — local `copilot help limits`; [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)
- `--usage-output-file <file>` "Write[s] final usage statistics as JSON" (local `copilot --help`). CLI 1.0.81: "`--usage-output-file` includes per-agent usage metrics". CLI 1.0.100: usage reporting no longer shows "phantom spend after resume" — [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)

### Inferences
- A machdoch "plan limits" widget can show `account.getQuota` once per app start or per refresh as remaining % and reset date, keyed by `premium_interactions`, or the AI-credit budget on new billing. Per-turn spend would come from `assistant.usage`/`getMetrics`, and a context bar from `session.usage_info`/`contextInfo`. Even without moving to the SDK, `--usage-output-file` is a simpler replacement for the OTel file exporter in one-shot mode.

### Gaps
- I did not find which `quotaSnapshots` key represents the AI-credit budget for token-billed users. The docs list only `premium_interactions`, `chat` and `completions`.
- I found no authoritative nano-AIU-to-AI-Credit conversion. The doc says to confirm against billing docs before dividing by 1e9.

## 5. Progress events: tool calls, subagents, plan/todo, file changes, streaming deltas, background tasks and shells

### Takeaway
The session event stream has 106 types locally and 150 in SDK-main. Each event has an envelope `{id, timestamp, parentId, ephemeral, agentId, type, data}`, and `agentId` identifies sub-agent events. Event families cover turns, deltas, tools, subagents, skills, plan/todo signals, workspace files, background tasks, usage and compaction. Background shells and agents are first-class "tasks" (`session.tasks.*`). Detached shells run as independent processes and keep running after the turn ends. Their output can be read with `tasks.getProgress`, or `tasks.readOutput` on newer SDKs.

### Cited Findings
- Envelope: `agent_id` is the "Sub-agent instance identifier. Absent for events emitted by the root/main agent and for session-level events" — [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs). The docs mark `parentToolCallId` deprecated on several events in favor of `agentId` — [SDK docs: streaming events](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md)
- Full local event list (1.0.7-preview.2):
  - Assistant: `assistant.turn_start`, `assistant.intent`, `assistant.reasoning`, `assistant.reasoning_delta`, `assistant.message_start`, `assistant.message`, `assistant.message_delta`, `assistant.streaming_delta`, `assistant.tool_call_delta`, `assistant.turn_end`, `assistant.idle`, `assistant.usage`.
  - Tools: `tool.user_requested`, `tool.execution_start`, `tool.execution_progress`, `tool.execution_partial_result`, `tool.execution_complete`, `external_tool.requested`, `external_tool.completed`.
  - Sub-agents and skills: `subagent.started`, `subagent.completed`, `subagent.failed`, `subagent.selected`, `subagent.deselected`, `skill.invoked`.
  - Session: `session.start`, `session.resume`, `session.idle`, `session.error`, `session.warning`, `session.info`, `session.shutdown`, `session.task_complete`, `session.title_changed`, `session.mode_changed`, `session.model_change`, `session.plan_changed`, `session.todos_changed`, `session.workspace_file_changed`, `session.background_tasks_changed`, `session.compaction_start`, `session.compaction_complete`, `session.truncation`, `session.snapshot_rewind`, `session.usage_info`, `session.usage_checkpoint`, `session.context_changed`, `session.custom_agents_updated`, `session.skills_loaded`, `session.mcp_servers_loaded`, `session.mcp_server_status_changed`, `session.tools_updated`, `session.session_limits_changed`, `session.remote_steerable_changed`, `session.handoff`, `session.schedule_created`, `session.schedule_cancelled`, `session.schedule_rearmed`, `session.autopilot_objective_changed`, `session.auto_mode_resolved`.
  - Requests: `permission.*`, `user_input.*`, `elicitation.*`, `exit_plan_mode.*`, `auto_mode_switch.*`, `session_limits_exhausted.*`, `sampling.*`.
  - Commands and queue: `command.queued`, `command.execute`, `command.completed`, `commands.changed`, `pending_messages.modified`.
  - MCP: `mcp.oauth_required`, `mcp.tools.list_changed`.
  - Hooks: `hook.start`, `hook.progress`, `hook.end`.
  - Messages: `user.message`, `system.message`, `system.notification`.
  - Source: [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs)
- Added in SDK-main:
  - `tool.shell_output`: "Live, append-only shell output. Not persisted or replayed"; it replaces the deprecated `tool.execution_partial_result`.
  - `agent.interrupted`, `assistant.turn_retry`, `model.call_start`, `model.call_finished`, `model.call_final_result`.
  - `session.autopilot_stopped`: "Attached background work may remain active; this is not session-wide idle".
  - `session.completion_receipt`, `session.context_cleared`, `session.quota_observation`, `session.auto_tier_recommendation`, `subagent.configured`.
  - `human_response.recorded`, `ui.ephemeral_query`, `workflow.run_started`, `workflow.run_updated`, `workflow.run_settled`, `assistant.fusion_phase_*`.
  - Source: [SDK-main session_events.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/session_events.rs)
- Tool events:
  - `tool.execution_start` has `toolCallId`, `toolName`, `arguments`, `mcpServerName`/`mcpToolName`, `shellToolInfo`, `turnId`, `model` and `parentToolCallId`.
  - `tool.execution_complete` has `success`, `result`, `error`, `sandboxed`, `toolTelemetry`, `isUserRequested` and `turnId`.
  - `subagent.started` has `agentName`, `agentDisplayName`, `agentDescription`, `model` and `toolCallId`.
  - Source: [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs)
- Streaming: set `streaming: true` to get `assistant.message_delta`/`assistant.reasoning_delta`; concatenating the deltas reproduces the final message. With streaming off, only the final `assistant.message`/`assistant.reasoning` arrive. `include_sub_agent_streaming_events` defaults to true — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md), [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs)
- Plan and todo:
  - `session.plan_changed` carries `operation` (plan-file create/update/delete); `session.plan.read`/`update`/`delete` operate on `plan.md`.
  - `session.todos_changed` is signal-only: "No payload — clients should call session.plan.readSqlTodosWithDependencies()", or `readSqlTodos`.
  - `assistant.intent` gives a short "what I'm doing" string.
  - Source: [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs), [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs)
- File changes:
  - `session.workspace_file_changed` (`path`, `operation`) refers to the *session workspace files dir*, not the repo.
  - Repo edits surface through `Write` permission requests (`diff`, `newFileContents`), `tool.execution_*` and `usage.getMetrics.codeChanges`.
  - `session.workspaces.diff` / `listCheckpoints` / `readCheckpoint` exist, and SDK-main has `history.previewRewind`.
  - The streaming-events doc says there are "No dedicated events" for file changes; write permissions carry `fileEdits` snapshots.
  - Source: [CR session_events.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/session_events.rs), [SDK docs: streaming events](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md)
- Background tasks:
  - RPCs: `session.tasks.list`, `startAgent`, `getProgress`, `cancel`, `remove`, `sendMessage`, `refresh` ("detached background shells"), `waitForPending`, `promoteToBackground` and `getCurrentPromotable`.
  - Each `TaskShellInfo` has `attachmentMode` (`Attached` = managed PTY / `Detached` = "independent background process"), `executionMode`, `command`, `pid`, `logPath`, `status`, `canPromoteToBackground`, `startedAt` and `completedAt`.
  - `TaskShellProgress` gives `recentOutput`.
  - `session.background_tasks_changed` is signal-only.
  - SDK-main adds `session.tasks.readOutput` ("after a cursor, optionally waiting for new output or for the shell to finish") and client-owned tasks via `register`/`update`.
  - Source: [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs), [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- Do shells survive the turn?
  - 1.0.62: "Shells promoted to background from /tasks keep running after the turn ends", and `write_bash` interactive input is no longer supported.
  - 1.0.66: Copilot can read from and stop detached background shells.
  - 1.0.60: session completion waits for background shells.
  - 1.0.86: the status row shows it is waiting on background shells.
  - 1.0.88: prompt mode warns when it stops waiting.
  - 1.0.104: interactive and SDK Autopilot sessions keep waiting for attached background tasks, while `-p --autopilot` honors `COPILOT_TASK_WAIT_TIMEOUT_SECONDS`.
  - 1.0.33: non-interactive mode waits for background agents before exiting.
  - Source: [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- Built-in tool names seen in crate tests/code include `bash`, `powershell`, `view`, `edit`, `create`, `grep`, `web_fetch`, `task`, `read_agent`, `list_agents`, `write_agent`, `ask_user`, `task_complete`, `sql`, `report_intent`, `exit_plan_mode` and `skill` — [CR tests/e2e](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/tests/e2e/)

### Inferences
- machdoch currently drops all `agentId` events. With the SDK it could render nested subagent cards (`subagent.started`/`completed`/`failed`, keyed by `toolCallId`), a live todo list (`todos_changed` → `readSqlTodosWithDependencies`) and live shell output (`tool.shell_output`).
- In one-shot mode, killing the process tree kills attached shells. With a persistent server, background shells and agents survive the turn and can be listed and stopped from the UI.

### Gaps
- I could not confirm from primary docs the current shell tool names `read_bash`/`stop_bash`/`list_bash` (only `write_bash` appears in the changelog), or their Windows `powershell` equivalents.
- The JSONL record set of `--output-format=json` in prompt mode is not documented beyond `workflow.result`.

## 6. Follow-up suggestions (suggested next prompts)

### Takeaway
I found no follow-up or next-prompt suggestion feature in Copilot CLI or the SDK. There is no such event or RPC in the local crate or SDK-main. The nearest building blocks are `session.ui.ephemeralQuery`, a no-tools side query on the current context, and host-driven composer completions.

### Cited Findings
- A case-insensitive search for "suggest"/"follow-up" in the local crate's events, API types and types found only unrelated hits: a notification "follow-up URL", and "follow-up message"/"follow-up turns" in background-task docs. No `suggest*` event exists in SDK-main `session_events.rs` (own grep) — [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs), [SDK-main session_events.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/session_events.rs)
- `session.ui.ephemeralQuery` "Runs a transient no-tools model query against the current conversation context". SDK-main adds the event `ui.ephemeral_query` ("does not modify conversation history") — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [SDK-main session_events.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/session_events.rs)
- `session.completions.request` returns "host-driven completion items for the current composer input", and `getTriggerCharacters` returns the trigger characters — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs)
- The CLI has `/ask` (`/btw`) for side questions — [docs: CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- `session.auto_tier_recommendation` is a model-routing recommendation, not a prompt suggestion — [SDK-main session_events.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/session_events.rs)
- A web search found no CLI-specific suggested-prompts feature; results covered queueing, ask_user and other products — [About Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli)

### Inferences
- machdoch could generate its own suggestions after `session.idle` with `ephemeralQuery`: no tools, no history mutation, though it still bills model usage. It could also use a cheap separate model call.

### Gaps
- `ephemeralQuery` request/response shapes and billing were not checked.

## 7. Custom agents, skills, MCP, hooks, plugins, instructions; ACP as an alternative protocol

### Takeaway
The SDK can declare everything per session: `custom_agents` plus `agent`, `skill_directories`/`disabled_skills`, `mcp_servers`, `plugin_directories`, `instruction_directories`/`skip_custom_instructions`, `hooks` (programmatic SessionHooks) and system-prompt section transforms. Runtime RPCs list and toggle each of these. The CLI equivalents are `--agent`, `--plugin-dir`, `--additional-mcp-config`, `--disable-builtin-mcps`, `--add-github-mcp-tool(set)`, `--no-custom-instructions` and `--add-dir`. ACP (`copilot --acp [--stdio|--port]`) is still **public preview**. It has fewer host controls than the SDK: launch-fixed settings, no `--fleet`, and some TUI commands are unavailable.

### Cited Findings
- `CustomAgentConfig` list plus `agent` (the agent to activate at start) and `default_agent` (hide tools from the default agent while keeping them for sub-agents) — [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs). SDK 0.2.0: `customAgents` with `agent` pre-selects at creation — [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)
- Agent RPCs: `session.agent.list`, `select`, `deselect`, `getCurrent` and `reload`; SDK-main adds `setPrompt`. Events: `subagent.selected`/`deselected` and `session.custom_agents_updated` — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs)
- CLI custom-agent changes:
  - 1.0.22: `skills` field.
  - 1.0.66: reasoning effort in definitions.
  - 1.0.83: several models tried in order, with `model-policy: required`.
  - 1.0.86: `include-custom-instructions` opt-in.
  - 1.0.97: agent-scoped declarative hooks.
  - 1.0.100: `search`/`web`/`todo` tool aliases.
  - The programmatic reference says an agent's model takes precedence over `--model`.
  - Source: [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md), [docs: CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- Skills: `session.skills.list`, `enable`, `disable`, `reload` and `getInvoked`; `skills.discover` and `skills.config.setDisabledSkills`; the event `skill.invoked`. SDK-main adds install flows (`skills.planInstall`/`applyInstall`) — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- MCP:
  - Session RPCs: `session.mcp.list`, `listTools`, `enable`, `disable`, `reload`, `reloadWithConfig`, `start`/`stop`/`restartServer`, `oauth.login`, `configureGitHub`/`removeGitHub` and `resources.*`.
  - Global config RPCs: `mcp.config.add`, `remove`, `update` and `list`.
  - Events: `session.mcp_servers_loaded`, `session.mcp_server_status_changed` and `mcp.oauth_required`.
  - `McpAuthHandler` lets a host supply OAuth tokens (SDK 1.0.5 `onMcpAuthRequest`).
  - Source: [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)
- Built-in MCPs: `--disable-builtin-mcps` disables "github-mcp-server, githubiq". `--enable-all-github-mcp-tools`, `--add-github-mcp-toolset` and `--add-github-mcp-tool` widen the default CLI subset. `--mcp-github-auth <server=origin>` scopes GitHub auth to one MCP origin (1.0.90). `--additional-mcp-config` takes JSON or `@file` — local `copilot --help` (1.0.103); [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- Hooks, events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`, `preToolUse`, `permissionRequest` (CLI), `postToolUse`, `postToolUseFailure`, `agentStop`, `subagentStart`, `subagentStop`, `errorOccurred`, `preCompact` and `notification`.
- Hooks, types: `command`, `http` (https required for preToolUse/permissionRequest) and `prompt`.
- Hooks, locations: policy dirs, `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, settings.json `hooks`, `.claude/settings*.json`, and plugin `hooks.json`.
- Hooks, outputs: `permissionDecision` (allow/deny/ask), `modifiedArgs`, `additionalContext`, `modifiedResult` and `decision: block`. `userPromptSubmitted.modifiedPrompt` works only for SDK programmatic hooks.
- Source: [docs: hooks configuration](https://docs.github.com/en/copilot/reference/hooks-configuration)
- SDK hooks: `SessionHooks` covers `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmitted`, `SessionStart`, `SessionEnd` and `ErrorOccurred`; the GA post also lists MCP tool calls and permission requests. `hook.start`/`progress`/`end` events report hook execution — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md), [GA changelog](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)
- Plugins: `plugin_directories` (CLI 1.0.55 added `pluginDirectories` on `session.create`/`resume`), `plugins.list`, `install`, `enable` and `disable`, and `marketplaces.*`. CLI `--plugin-dir` — [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md), [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs)
- Instructions:
  - `--no-custom-instructions` disables AGENTS.md "and related files"; SDK equivalents are `skip_custom_instructions` and `instruction_directories`.
  - RPCs: `session.instructions.getSources`, `instructions.discover`; SDK-main adds `instructions.reload`.
  - CLI 1.0.89 supports `.claude/rules`. CLI 1.0.100 auto-applies path-specific `.github/instructions` files.
  - Source: local `copilot --help`; [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs); [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- System prompt: `system_message` with section-level customize/transform (`SystemMessageTransform`). GA highlights editing sections such as identity, tone, tool instructions and safety rules — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md), [GA changelog](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)
- Client tools: `Tool` plus `ToolHandler` can override built-ins (SDK 0.1.30 `overridesBuiltInTool`) and use `skipPermission`. Deferred loading is set with `defer: "auto"|"never"` — [CR README.md](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/README.md), [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)
- ACP launch and status: `copilot --acp` starts an "Agent Client Protocol server" (local `copilot --help`). It went public preview 2026-01-28 — [GitHub changelog (search snippet)](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/). The docs still say "in public preview and subject to change".
- ACP transport and settings: `--stdio` (default, NDJSON, one client) or `--port` (TCP, 127.0.0.1, multi-client). Tool filtering and reasoning effort are fixed at launch, and `session/new` takes only `cwd` and `mcpServers`.
- ACP protocol surface: `session/update` with `agent_message_chunk` and `available_commands_update`; client-side `requestPermission`; slash commands via `session/prompt`.
- ACP limits: `/diff`, `/resume`, `/theme`, `/settings`, `/login`, `/help`, `/tasks` and `/undo` don't run over ACP. Docs source: [docs: ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- `--fleet` is "Not supported in ACP server mode" — [docs: CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- ACP changelog:
  - 1.0.25: client-provided MCP servers on start/load.
  - 1.0.39: toggle allow-all.
  - 1.0.40: skills as slash commands, live plan, `/compact` `/context` `/usage` `/env`.
  - 1.0.81: subagent IDs and live updates.
  - 1.0.88: managed settings apply.
  - 1.0.95: `--context` honored.
  - 1.0.103: sandbox settings honored on resume.
  - Source: [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)

### Inferences
- machdoch writes a run-scoped custom agent file today. With the SDK it could pass `custom_agents` plus `agent` in memory per session and skip file-system writes. It could also use programmatic hooks for policy, such as blocking paths or injecting context.
- ACP is only worth it if machdoch wants one protocol across several agent CLIs. For Copilot specifically, the SDK/JSON-RPC exposes far more: quota, metrics, queue, tasks, plan approvals, rewind, and per-session tool filters.

### Gaps
- The full `CustomAgentConfig` field list and the custom-agent frontmatter reference were not extracted. The command-reference page is 469K characters and only the first 200K were read.
- ACP `session/load`, `session/cancel` and `session/set_mode` are not documented on the ACP page.

## 8. Model and reasoning discovery via SDK (`models.list`)

### Takeaway
`models.list` (`Client::list_models`, which machdoch already uses) returns, per model:
- `id`, `name`
- `capabilities.limits` and `capabilities.supports` (`vision`, `reasoningEffort`, `adaptiveThinking`)
- `supportedReasoningEfforts`, `defaultReasoningEffort`
- `billing` (`multiplier`, `discountPercent` for auto, `tokenPrices` in AI Credits per batch including long-context tier)
- `policy` (`state` and `terms`)
- picker category and price category

Session-scoped `session.model.list`, `switchTo` and `setReasoningEffort` change the model live. Experimental.

### Cited Findings
- `Model` fields:
  - Identity and policy: `id`, `name`, `policy{state, terms}`.
  - Picker grouping: `modelPickerCategory`, `modelPickerPriceCategory`.
  - Reasoning: `supportedReasoningEfforts`, `defaultReasoningEffort`.
  - Capabilities: `capabilities.limits{max_context_window_tokens, max_output_tokens, max_prompt_tokens, vision}` and `capabilities.supports{vision, reasoningEffort, adaptiveThinking}`.
  - Billing: `billing{multiplier, discountPercent, tokenPrices{batchSize, inputPrice, outputPrice, cacheReadPrice, cacheWritePrice, maxPromptTokens, longContext}}`.
  - Source: [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs)
- `discountPercent` is "Populated for the synthetic `auto` model". `maxPromptTokens`: "The total context window is this value plus the model's max_output_tokens" — [CR api_types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/api_types.rs)
- Session model RPCs: `session.model.list` (uses the session's auth context), `getCurrent`, `switchTo` (model plus optional reasoning) and `setReasoningEffort`; the event is `session.model_change`. SDK-main adds `switchAutoTier`, `setAllowedModels` and `getReasoningSummaries`, plus `models.getBuiltInCatalog` (no auth/network) and `models.listTokenPriceUnits` — [CR rpc.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/generated/rpc.rs), [SDK-main rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- CLI flags: `--reasoning-effort none|minimal|low|medium|high|xhigh|max`, `--context default|long_context`, `--auto-tier <preference>` and `--model auto` (local `copilot --help`, 1.0.103). Session-config equivalents are `reasoning_effort`, `reasoning_summary` and `context_tier` — [CR src/types.rs](file:///C:/Users/ehrha/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/github-copilot-sdk-1.0.7-preview.2/src/types.rs)
- The docs say prices change and should be read at runtime, and that `billing.multiplier` is the premium-request multiplier — [SDK docs: usage & billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md)
- Recent CLI model changes:
  - 1.0.100: reasoning-only max-token responses error instead of looping.
  - 1.0.101: switching only reasoning effort no longer forces compaction.
  - 1.0.104: managed "fusion" model starts on Auto.
  - 1.0.86: reasoning-effort change applies before the next request in an active turn.
  - 1.0.79: `/model` is session-scoped by default.
  - Source: [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)

### Inferences
- machdoch's model picker can show vision support, reasoning levels (with default), context window, and cost (multiplier or AI-credit token prices) straight from `list_models`. It can then change model or effort mid-session without restarting.

### Gaps
- The `ModelPickerCategory` and `ModelPolicyState` enum values were not enumerated.

## 9. Recent changelog items (CLI and SDK) relevant to deeper integration

### Takeaway
The CLI ships almost daily (1.0.79 → 1.0.105 between Aug 10 and Oct 28, 2026). The SDK ships stable releases nearly daily in October (1.0.17 → 1.0.28) and bundles the matching CLI. Recent themes:
- Assisted permissions going non-experimental.
- Richer queueing and steering.
- Background shells and tasks that outlive turns.
- AI-credit usage reporting and session limits.
- Subagent visibility for ACP and SDK clients.
- Plugin, skill and MCP lifecycle management.
- Managed (enterprise) settings across server and ACP modes.

### Cited Findings
**CLI releases** — all from [copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- 1.0.105 (2026-10-27): Copilot Fusion High/Max work from long-context sessions.
- 1.0.104 (10-27): Assisted Permissions available without experimental mode. Interactive and SDK Autopilot sessions keep waiting for attached background tasks.
- 1.0.103 (10-22): ACP honors sandbox settings on resume. Legacy `--remote`/`--no-remote` flags retired in favor of hosting flags.
- 1.0.102 (10-21): `-p` honors managed Auto model. Subagents honor custom/MCP tool approvals.
- 1.0.101 (10-20): `assistedApprovalInstructions` setting. Native structured output for workflow subagents.
- 1.0.100 (10-19): `--trust-folder` for one-off `-p`. `--disable-client-telemetry`. Path-specific `.github/instructions`. Usage no longer shows phantom spend after resume.
- 1.0.97 (10-13): agent-scoped declarative hooks. Synchronous `/task` JSON output includes failed child errors and lifecycle events. `--output-format json` redacts secrets. `/usage` shows billed AI Credits.
- 1.0.93 (10-07): MCP config changes apply between turns without restarting the session.
- 1.0.92 (10-05): messaging a running background agent steers its active turn.
- 1.0.90 (09-30): `--mcp-github-auth`. Session-scoped read-only dir approvals.
- 1.0.88 (09-22): managed settings apply to ACP, AHP host and server sessions. `/fork` runs during active turns.
- 1.0.81 (08-27): MCP 2026-07-28 spec support. ACP clients receive subagent IDs and live updates. `--usage-output-file` includes per-agent usage.
- 1.0.79 (08-10): `--plan` combines with `--mode autopilot`. Local queueing of prompts, shell commands and slash commands.
- Earlier, still relevant:
  - 1.0.70 is the CLI bundled with machdoch's crate.
  - 1.0.66: read and stop detached shells; session limits use the `sessionLimits` key.
  - 1.0.67: session-limit minimum 30 AI credits.
  - 1.0.62: background shells survive the turn; SDK memory config.
  - 1.0.58: Remote JSON-RPC enabled by default.
  - 1.0.55: `pluginDirectories` on `session.create`/`resume`.
  - 1.0.51: `--session-id` resumes sessions/tasks.
  - 1.0.49: `--plugin-dir`/`--additional-mcp-config` in `--server`/`--headless`.
  - 1.0.14: SDK `handlePendingElicitation`; `exit_plan_mode.requested` always emitted.

**SDK releases** — all from [SDK CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)
- The changelog's newest entry is v1.0.14 (2026-09-16), so CHANGELOG.md lags behind crates.io and npm, which have 1.0.28.
- v1.0.14: Rust `allowed_models`; message `source` provenance; `setAutoTier("fast")`; `managedSettings.clearCache`.
- v1.0.13 (09-04): `session.detach` replaces `destroy`; `featureFlags`/`managedSettings` on create and resume (requires CLI ≥ 1.0.79-5); `askUserVariant`; Rust `Client::prepare_session`/`prepare_resume_session` and `event_buffer_capacity`; `ClientMode::Empty` defaults to no built-in skills.
- v1.0.7 (07-16): tool search (`defer: "auto"`); `agentId`/`parentAgentId` in request-handler contexts; in-process FFI transport for Node/Rust/Python/Go.
- v1.0.5 (07-01): `onMcpAuthRequest`; `enableCitations`, `excludedBuiltinAgents` and `sessionLimits: { maxAiCredits }`.
- v1.0.2 (06-18): opt-in memory; `ModelBilling.tokenPrices`.

### Inferences
- Because the CLI moves daily and every deep RPC is "experimental", machdoch should treat the pair (SDK crate version, CLI version) as one pinned dependency and upgrade them together. The bundled-CLI feature of 1.0.28 (CLI 1.0.105) does that by construction.

### Gaps
- No GitHub changelog (github.blog) entries specific to the SDK after 2026-06-02 were found. Per-release SDK notes after 1.0.14 would have to come from GitHub Releases (`rust/v*` tags), which I did not fetch.
