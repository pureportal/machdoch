# OpenAI Codex CLI and app-server: new or unexploited host capabilities (status: 2026-10-30)

Baseline: the earlier notes (`research_notes/Agent CLI integration opportunities/codex.md`, version 0.159.1). This file lists only what is new since then, or was in 0.159.1 but is unused by machdoch.

How to read the labels:
- **EXP** = gated by `#[experimental(...)]` in the Rust protocol source, and needs `initialize.capabilities.experimentalApi: true`.
- **STABLE** = no such marker. This is a schema label only: the `codex app-server` command itself is still labeled `[experimental]`.
- **min** = first version found. "≤0.166.0" means present at that tag, not in local 0.159.1, with the exact first version not established.
- "Source at tag" means GitHub source at `rust-v0.166.0`, read 2026-10-30. Changelog and release wording was read through a summarizing fetch, so treat it as paraphrase unless quoted.

## What changed since 0.159.1 (versions, schema diff, corrections to the earlier notes)

### Takeaway
The installed CLI is still **0.159.1**, while the latest release is **0.166.0 (2026-10-29)**. Regenerating the local schema therefore shows no change, so the real diff comes from the 0.166.0 source. It adds 12 client methods and 4 notifications, most of them EXP. Three behavior changes affect machdoch directly: the default thread unload delay fell from 30 minutes to 60 seconds, `review/start` lost `detached`, and `thread/goal/set` gained an `origin` field.

### Cited Findings
**Versions and method**
- `codex --version` prints `codex-cli 0.159.1`, and `npm view @openai/codex version` prints `0.166.0` — local commands, 2026-10-30.
- `generate-json-schema` works offline, with and without `--experimental`. For the local 0.159.1 CLI it gives 104 stable and 167 experimental client requests, 10 and 11 server requests, and 83 notifications in both bundles. `ClientRequest`, `ServerRequest` and `ServerNotification` are byte-identical to the schema behind the earlier notes — local schema output, 2026-10-30.
- 0.166.0 is dated 2026-10-29 and 0.165.0 is dated 2026-10-27 — [Changelog](https://learn.chatgpt.com/docs/changelog).

**Methods at 0.166.0 that are absent from the local 0.159.1 schema** (method registry: [common.rs at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs))

| Method or notification | Stability | Min version | Purpose |
|---|---|---|---|
| `thread/sample`, `thread/sample/cancel` | EXP | 0.164.0 ([Changelog](https://learn.chatgpt.com/docs/changelog)) | One-shot model response on an ephemeral fork |
| `thread/prediction/request`, `thread/prediction/updated` (notification) | EXP | ≤0.166.0 | Asynchronous prediction for a source turn |
| `thread/memory/read` | EXP | 0.165.0 ("thread memory summary reads") | Memory summary for a loaded thread |
| `thread/readState/update`, `thread/readState/changed` (notification) | EXP | 0.163.0 ("durable thread read state") | Read/unread state with revision checks |
| `thread/items/read` | EXP | 0.163.0 ("thread item lookup by ID", mapping inferred) | Item lookup by id |
| `thread/attachmentOwner/list` | STABLE | 0.162.0 (#50083, #50094) | Reverse lookup from resource to threads |
| `accountSession/list`, `accountSession/switch` | EXP | 0.166.0 (#57514) | ChatGPT workspace switching |
| `account/gcp/setup` | EXP | 0.166.0 (#57394) | Vertex AI provider setup |
| `account/bedrock/checkGovCloudRequirements` | EXP | ≤0.166.0 | Bedrock GovCloud status |
| `feedback/save` | STABLE | ≤0.166.0 | Not examined |
| `rawResponseItem/completed`, `rawResponse/completed` (notifications) | no marker | ≤0.166.0 | Paired with `thread/start.experimentalRawEvents`, documented "internal use only (e.g. Codex Cloud)" ([thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)) |

No stable method became experimental, no experimental method lost its marker, and no slash-named method was removed — programmatic diff of common.rs at tag against local schema. Names without a slash could not be classified by that diff.

**New fields at 0.166.0, absent from the 0.159.1 experimental schema**
- `thread/fork`: `attachToSource`, `experimentalPredictionMode`, `experimentalDisablePredictionMcp`, all EXP — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
- `thread/goal/set.origin?: "user" | "automatic"`, with the doc comment "Missing provenance does not supply user authorization", no EXP marker — [ThreadGoalSetParams.ts](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalSetParams.ts), [ThreadGoalMutationOrigin.ts](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadGoalMutationOrigin.ts).
- `turn/start`: `parentTurnId` and `rootTurnId` (STABLE; attribute delegated work to its originating turn) and `responsesapiClientMetadataPatch` (EXP) — [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
- `thread/list`: `excludedThreadIds`, max 100, from 0.163.0 ([README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md), [Changelog](https://learn.chatgpt.com/docs/changelog)), and `attachedToThreadId` ([PR #56351](https://github.com/openai/codex/pull/56351)).
- Thread items carry lifecycle timestamps, optional in the TypeScript exports, from 0.166.0 (#57172, #57420) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0).

**Behavior changes and corrections to the earlier notes**
- **Unload delay.** The default `thread_unload_delay_secs` went from 1800 to 60 seconds; threads unload after one minute with no subscribers and no activity. 0 means immediate unload — [PR #57242](https://github.com/openai/codex/pull/57242), merged 2026-10-26, in 0.166.0. The [App-server docs](https://learn.chatgpt.com/docs/app-server) still said 30 minutes on 2026-10-30, so docs and code disagree.
- **Review delivery.** `detached` is removed from `review/start` (#57667). The review runs on the supplied thread and returns that same `reviewThreadId`. For a separate thread call `thread/start` first; to keep history with custom instructions use `thread/fork` then `turn/start` — [README at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/README.md). The earlier notes described it as deprecated.
- **Archive and delete.** `thread/archive` and `thread/delete` reject live internal workers with `-32600` — [README at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/README.md). Unarchiving a parent restores spawned descendants (#57635) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0).
- **Conflict on notification stability.** The 0.159.1 generator lists the same 83 notifications in both bundles, but 0.166.0 source marks several as EXP, including `thread/queue/changed`, `thread/settings/updated`, `process/outputDelta`, `process/exited`, `turn/moderationMetadata` and all `thread/realtime/*` — [common.rs at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs). The earlier "all notifications are stable" statement should be read as a generator artifact, not as a stability promise.
- **Labels still conflict.** `permissionProfile/list` is described as beta in the [App-server docs](https://learn.chatgpt.com/docs/app-server) but carries no EXP marker in source.

### Inferences
- Probe the running version in machdoch instead of assuming one. On 0.159.1 every item in the table returns an error, and the user's CLI lags seven minor versions. Treat "unknown method" and "requires experimentalApi" as feature-absent signals.
- The 60-second unload matters to any machdoch flow that unsubscribes or reconnects: the thread may be gone sooner than the docs imply, so expect `notLoaded` and `thread/closed`. Set `config.thread_unload_delay_secs` explicitly where a longer window is wanted.
- machdoch's review call omits `delivery` (see `codex-app-server-session.spec.ts`), so the removal should not break it.

### Gaps
- Exact first version for `thread/prediction/*`, `feedback/save` and the raw-response notifications; I did not walk every tag. Releases 0.161.0 to 0.165.0 were read only through a summarizing fetch of the changelog.
- 0.166.0 was not executed locally, because updating the CLI was out of scope. All 0.166.0 claims come from source and release notes, not runtime tests.

## Thread control: fork, revert, compaction, archive, search, resume, metadata, multi-client, remote

### Takeaway
Attached forks and `thread/sample` are the main new primitives; both allow side work that does not pollute the main transcript. Cold resume now restores permissions and settings far more reliably, and a second writer process appears to get a conflict rather than a duplicate turn. machdoch's core code calls none of the resume, fork, revert, compact or list methods.

### Cited Findings
**Forks and sampling**
- `thread/fork.attachToSource` (EXP, min 0.165.0, [PR #56351](https://github.com/openai/codex/pull/56351), merged 2026-10-23):
  - Persists the fork as an attached thread, hidden from ordinary lists and created without emitting `thread/started`.
  - Discover it with `thread/list.attachedToThreadId`. The relationship is separate from spawned-agent parent filters and survives restarts.
  - "The source cannot be deleted while attached threads exist." It requires a paginated source and local storage, and is incompatible with `ephemeral` and `deferGoalContinuation` — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
  - Parent history is kept out of attached thread views from 0.166.0 (#57256) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0).
- `thread/sample` (EXP, min 0.164.0): "One model response on an ephemeral fork that inherits the source's configuration and context."
  - Params: `{threadId, expectedTurnId, prompt, effort?, threadSource?, turnTrigger?, responsesapiClientMetadata?, disableMcp?}`.
  - Result: `{sourceTurnId, responseId, text|null, inputTokens, cachedInputTokens, outputTokens}`. `text` is null if the model attempted a tool call.
  - `expectedTurnId` must be the loaded source's latest completed, failed or interrupted turn; stale or active sources are rejected.
  - Cancel with `thread/sample/cancel {requestId}` — [thread_sample.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread_sample.rs).
- `thread/fork.experimentalPredictionMode` (EXP): starts from the loaded parent's effective config, tools, environments and history "to maximize prompt-cache reuse". It needs a loaded, persisted parent and `ephemeral: true`, enables `features.reasoning_effort_override` on the fork, and cannot be combined with `path`, `lastTurnId` or `beforeTurnId` — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
- `thread/prediction/request {threadId, sourceTurnId}` returns `{}`, then `thread/prediction/updated {threadId, sourceTurnId, result: {type: completed, text} | {type: failed}}` — [thread_prediction.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread_prediction.rs).

**Revert and compaction**
- `thread/rollback` stays removed; `thread/revert` works on paginated threads — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md). 0.164.0 preserves thread model settings across resume and revert — [Changelog](https://learn.chatgpt.com/docs/changelog).
- Compaction: 0.163.0 added async compaction configuration; 0.164.0 wired background compaction into the turn lifecycle and stopped failed compaction from leaving partial summaries — [Changelog](https://learn.chatgpt.com/docs/changelog). 0.166.0 preserves reasoning-token accounting to avoid premature compaction (#57839) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0).
- Config: `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope = total|body_after_prefix` (default `total`), `compact_prompt`, `experimental_compact_prompt_file` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

**Resume with restored settings**
- 0.160.0: saved permissions restored on resume (#49160) — [0.160.0 release](https://github.com/openai/codex/releases/tag/rust-v0.160.0).
- 0.163.0: saved thread permissions restored on cold resume, including network grants. 0.164.0: compressed histories found and saved settings restored — [Changelog](https://learn.chatgpt.com/docs/changelog).
- 0.166.0: acknowledged permissions preserved across resume and fork, preferring source-owned settings snapshots over stale turn contexts ([PR #57227](https://github.com/openai/codex/pull/57227)); thread providers validated before resume and input (#57840) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0). Steer, compaction and manual queue start are rejected on provider mismatch — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md).
- `thread/resume.initialTurnsPage` (EXP) bootstraps recent turns in one response. `path` (EXP, UNSTABLE) must match the active rollout path if `threadId` names a running thread — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).

**Search, organization and metadata** (present in 0.159.1, not in the earlier notes' detail, unused by machdoch)
- EXP: `thread/search`, `thread/searchOccurrences`, `thread/timeline/list`. STABLE: `thread/section/move`, `threadSection/{list,create,update,delete}` — local schema 0.159.1.
- Attachments (STABLE): `thread/attachment/{add,list,remove}` store durable resource references such as `pull_request` without loading the thread, up to 100 per thread and 100 per page. Non-ephemeral forks copy them. `thread/attachment/updated` is broadcast after changes, and same-thread requests are serialized across connections — [README at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/README.md).
- `thread/read` and `thread/list` return read state for eligible local threads (EXP). `thread/readState/update` uses revision matching — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md).

**Multi-client and remote**
- 0.163.0 added connection-bound reply handles for app-server requests — [Changelog](https://learn.chatgpt.com/docs/changelog).
- Cross-process writers: two app-server processes sharing one `CODEX_HOME` could both auto-continue an active goal (0.144.3 to 0.146.x). A community reproduction on 2026-10-17 reports that on 0.163.0 the second `thread/resume` gets an active-writer conflict and starts no turn, 3/3 on Windows, Ubuntu and macOS. No maintainer has confirmed this and the issue is still open — [Issue #32793](https://github.com/openai/codex/issues/32793).
- Suggested workaround from that issue: attach through one server with `codex --remote unix:// resume` — [Issue #32793](https://github.com/openai/codex/issues/32793).
- Transport in 0.166.0: negotiated WebSocket compression for the remote client (#57218, #57220), Agents navigation for remote sessions (#57281), an option to disable plugin discovery prefetch at startup (#57249), and `codex doctor --network-only` (#57606) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0). `/daemon` restarts managed background servers from 0.163.0 — [Changelog](https://learn.chatgpt.com/docs/changelog).
- `remoteControl/*` (enable, disable, status, pairing, client list and revoke) is EXP, with `remoteControl/status/changed`; the CLI has `codex remote-control`. `--listen` still offers stdio, unix, `ws://IP:PORT` and off, with capability-token or signed-bearer WebSocket auth — local help and schema, 0.159.1.
- `codex queue --resume` resumes unloaded threads after queueing (#57232, min 0.166.0) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0).

### Inferences
- `thread/sample` is the cleanest way to generate titles, follow-up chips and side answers with prompt-cache reuse, without a transcript entry. This updates the earlier finding that follow-ups must be generated on a separate thread; on 0.164.0 or later a sampled reply suffices.
- `thread/prediction/*` looks like a built-in next-input prediction, which would also change the earlier "no follow-up suggestion" finding. The semantics are not documented, so this is a guess from the names and parameters.
- Attached forks fit a "side chat about this run" feature, and they are auto-discovered per parent. They cannot carry the goal-deferral flag, so forking a goal thread for a side chat still needs care.
- machdoch's grep of `apps/client/src/core` found no `thread/resume`, `thread/fork`, `thread/revert`, `thread/compact/start` or `thread/list` call. The largest stable, unexploited surface is durable thread lifecycle, and it requires a persistent `CODEX_HOME`, as the earlier notes said.
- machdoch should not run two app-servers over one `CODEX_HOME` while a goal is active, because the conflict behavior is only community-verified and older CLIs double-run.

### Gaps
- `thread/search` result shape and `thread/timeline/list` semantics were not read.
- Whether multiple clients on one server all receive server requests, and who may answer first, is not documented beyond replay of pending prompts on reconnect.

## Multi-agent, background work, cloud, automations, worktrees, SDK

### Takeaway
The notable additions are host-reserved V2 children and replaceable dynamic tools, but both are **Rust core APIs in 0.166.0 with no JSON-RPC method**. Guardian review now covers state-changing multi-agent calls. Automations have no public host API. Worktree creation is now a built-in agent tool.

### Cited Findings
**Multi-agent**
- [PR #57586](https://github.com/openai/codex/pull/57586) (merged 2026-10-27, 0.166.0) adds `CodexThread::create_child`, `prepare_child`, `ThreadManager::create_prepared_child` and an opt-in `HostToolInvocationLookup`. These create children under host-reserved ids and controllers, and can start them on another manager after the parent shuts down. common.rs at tag has no matching method.
- 0.166.0: state-changing multi-agent calls go through Guardian (#57451); failed subagents no longer mark tasks as needing attention (#57315) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0).
- 0.164.0: subagents inherit thread environments and step environment snapshots, and full agent forks keep parent history by default. 0.163.0: subagent capability preservation and an opt-in feature for subagent model context defaults — [Changelog](https://learn.chatgpt.com/docs/changelog).
- `turn/start.parentTurnId` and `rootTurnId` (STABLE, ≤0.166.0) let a host attribute delegated turns on other threads to an originating turn — [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
- `multiAgentMode` remains deprecated and ignored, so use `effort: "ultra"` — [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs). `multi_agent_v2` is stable and off by default locally — local `codex features list`, 0.159.1.

**Background terminals and processes**
- `thread/backgroundTerminals/list` returns `{processId, itemId, command, cwd, osPid, cpuPercent, rssKb}` — more detail than the earlier notes recorded. `terminate` and `clean` are also EXP — [App-server docs](https://learn.chatgpt.com/docs/app-server).

**Cloud**
- `codex cloud` subcommands are unchanged and still `[EXPERIMENTAL]`: `exec`, `status`, `list`, `apply`, `diff` — local help, 0.159.1. I found no app-server method for cloud tasks in [common.rs at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs). Cloud skill snapshots are frozen and catalogs refresh after mid-turn auth changes (0.164.0) — [Changelog](https://learn.chatgpt.com/docs/changelog).

**Scheduled tasks (automations)**
- Standalone tasks start a new chat each run and report to **Scheduled**; tasks inside a chat return to it and reuse context. Presets are minute intervals (chat tasks), daily and weekly; advanced schedules use an RFC 5545 RRULE. In Git repos a task runs locally or on a new background worktree. Tasks use `approval_policy = "never"` where org policy allows. Creation is from ChatGPT or Codex chats, or skills, and the page names no CLI or app-server API — [Scheduled tasks docs](https://learn.chatgpt.com/docs/automations.md?surface=app), undated, read 2026-10-30.
- Feature `in_app_local_automation` is stable/on locally — local `codex features list`, 0.159.1.

**Worktrees**
- 0.162.0 added tools to create and list managed Git worktrees from trusted local projects, and 0.164.0 retired the feature flag — [Changelog](https://learn.chatgpt.com/docs/changelog). `codex exec --worktree` already exists — earlier notes.

**SDK**
- Python: `Thread.run`, `turn`, `read`, `set_name`, `compact`; `Codex.thread_start`, `thread_list`, `thread_archive`, `thread_unarchive`, `thread_resume`, `thread_fork`; `TurnHandle.steer`, `interrupt`, `stream`. One client can handle several active turns. `thread_start` defaults to `ApprovalMode.auto_review`. `ExternalMessage`, `turn_service_tier`, `source` and explicit `include_turns` need CLI 0.151.0 or newer — [Python API reference at tag](https://github.com/openai/codex/blob/rust-v0.166.0/sdk/python/docs/api-reference.md). The page covers neither goals nor dynamic tools.

### Inferences
- machdoch cannot use host-reserved children or `replace_dynamic_tools` over stdio today. Both signal where the protocol may be heading, but do not plan around them until methods appear.
- machdoch can schedule its own recurring runs by starting threads itself. Nothing suggests a host can register Codex's scheduled tasks.
- The Python SDK's default of `auto_review` suggests OpenAI expects unattended hosts to use Guardian instead of `never`.

### Gaps
- `codex cloud` has no JSON output flag visible on `exec` in 0.159.1: its usage is `codex cloud exec --env <ENV_ID> [--attempts N] [--branch B] [QUERY]` (local help). The `status`, `list`, `diff` and `apply` flags were not captured in this pass, so scriptable output there is unverified.
- The automation storage format and whether the desktop app exposes it to third parties are undocumented.
- The TypeScript SDK was not rechecked at the tag.

## Goals: budgets, status transitions, continuation

### Takeaway
Goals are now an extension (`codex-rs/ext/goal`), and the source closes the earlier notes' gap on continuation semantics. Continuation fires when the thread goes idle and injects a context prompt. Goals stop on budget, usage limit, turn errors, or three consecutive empty or failed turns. Plan-mode turns are excluded. The model can mark a goal `complete`, `blocked`, or `paused`.

### Cited Findings
**Mechanism**
- Methods unchanged and STABLE: `thread/goal/set|get|clear`, with `thread/goal/updated|cleared`. New optional `origin` — see first section. Local schema confirms `origin` is absent in 0.159.1.
- `on_thread_idle` calls `runtime.continue_if_idle()`; `on_thread_resume` calls `restore_after_resume()` — [extension.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/extension.rs).
- Continuation text is injected as a goal-context input item from `templates/goals/continuation.md`, and includes tokens used, budget and remaining. The objective is framed as "user-provided data", not higher-priority instructions — [continuation.md](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/templates/goals/continuation.md), [steering.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/steering.rs).

**Status transitions**

| To status | Trigger | Actor |
|---|---|---|
| `complete` | `update_goal` after the completion audit | Model |
| `blocked` | `update_goal` after the blocked audit: the same blocker repeated for "at least three consecutive goal turns", counting the original turn and continuations | Model |
| `paused` | `update_goal` only at the user's explicit request, or host `thread/goal/set` | Model or host |
| `blocked` | Turn error other than usage limit (`TurnError`) | Runtime |
| `blocked` | `consecutive_empty_turns >= 3` | Runtime |
| `blocked` | `consecutive_execution_failure_turns >= 3` | Runtime |
| `usageLimited` | `UsageLimitExceeded` error | Runtime |
| `budgetLimited` | Token budget reached; wrap-up steering injected into the active turn and `TurnAbortReason::BudgetLimited` ends the turn | Runtime |

Sources: [tool.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/tool.rs), [runtime.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/runtime.rs), [accounting.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/accounting.rs), [extension.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/extension.rs), [budget_limit.md](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/templates/goals/budget_limit.md).

**Other rules**
- `create_goal` fails while an unfinished goal exists; `update_goal` rejects resume, budget-limited and usage-limited transitions — [tool.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/tool.rs). A May 2026 blog says the model may not pause goals — [danielvaughan.com](https://codex.danielvaughan.com/2026/05/03/codex-cli-goal-mode-persistent-objectives-token-budgets-agentic-loops/) — so that behavior has since changed or the blog was incomplete.
- `budget_limited` "takes precedence over paused" — [budget_limit.md](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/templates/goals/budget_limit.md).
- Plan-mode turns clear the current goal for accounting and return early — [extension.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/extension.rs).
- Blocked or aborted tool calls and `update_goal` itself do not count as progress — [extension.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/ext/goal/src/extension.rs). Interrupted continuations count toward the no-activity limit from 0.163.0 — [Changelog](https://learn.chatgpt.com/docs/changelog).
- `thread/fork.deferGoalContinuation` (EXP) copies the goal; the deferral persists in SQLite table `thread_goal_continuation_deferrals` and clears on the next explicit turn — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs), [migration](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/state/goals_migrations/0002_thread_goal_continuation_deferrals.sql).
- Forks inherit a snapshot of the goal, including its counters, unless the objective is invalid — [thread_fork_goal.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/thread_fork_goal.rs).
- A third-party guide dates `/goal` to v0.128.0 — [danielvaughan.com](https://codex.danielvaughan.com/2026/05/01/codex-cli-goal-workflows-persistent-long-horizon-task-execution/). I did not confirm this from a primary source.

### Inferences
- machdoch's `codex-native-goal.ts` sends no `origin`. From 0.166.0 it should send `origin: "user"` for user-driven `thread/goal/set` calls, because a missing value "does not supply user authorization". On 0.159.1 the field is unknown; whether it is rejected or ignored was not tested. What authorization it gates is also unclear, possibly Guardian review.
- A host should treat `blocked` as resumable: surface the reason and offer retry by setting `status: active`. Whether external set from `blocked` to `active` restarts continuation immediately was not read in detail.
- A host that keeps a goal running must stay subscribed. A goal thread that loses subscribers could now unload within about 60 seconds if idle.
- Plan-mode turns do not advance goals, so a host that keeps a goal thread in Plan mode should expect an active goal with no goal progress.

### Gaps
- `continue_if_idle` internal conditions and the `no-activity` limit value were not read in full.
- Budget semantics for subagent tokens and whether the budget counts cached tokens are not documented in what I read.

## Approvals, sandbox, permission profiles, dynamic tools, hooks, plugins, skills, MCP elicitation

### Takeaway
Named permission profiles are the new host-policy unit, usable at thread, turn and settings level but EXP. A new `humanCommand` approval kind and `requiredHumanApproval` capability appear in the main-branch README. Hooks, plugins, skills and MCP all gained host-relevant controls, and dynamic tools still cannot be swapped over JSON-RPC.

### Cited Findings
**Permission profiles and policy**
- `permissions: string` (EXP) on `thread/start`, `thread/resume`, `turn/start` and `thread/settings/update`; cannot be combined with `sandbox` or `sandboxPolicy` — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs), [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
- `permissionProfile/list` (no EXP marker, docs say beta) lists profiles and whether requirements allow each, cursor-paginated — [App-server docs](https://learn.chatgpt.com/docs/app-server).
- Config: `default_permissions` with built-ins `:read-only`, `:workspace`, `:danger-full-access`; custom `permissions.<name>.extends`; do not mix with `sandbox_mode` or `[sandbox_workspace_write]` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference).
- `sandboxPolicy` supports restricted reads through `readOnlyAccess` with `readableRoots` and `includePlatformDefaults` — [App-server docs](https://learn.chatgpt.com/docs/app-server).
- `approvalPolicy` is marked `#[experimental(nested)]`, so granular variants need the capability — [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
- `configRequirements/read` reports managed requirements including network, OpenTelemetry and `supportsIndependentSpeedModes` — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md). `requirements.toml` gained Windows registry overrides in 0.164.0 — [Changelog](https://learn.chatgpt.com/docs/changelog).
- `item/commandExecution/requestApproval` with `kind: "humanCommand"` allows only `accept`, `decline`, `cancel`. Session and persistent approvals do not satisfy it, and the command is rejected if no capable client is connected. The related `requiredHumanApproval` capability is on `initialize` — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md). Neither string is in the local 0.159.1 schema; presence in 0.166.0 was not verified.
- `userVerification/*` (EXP) offers P-256 local signing; native `openai/userVerification` requests arrive via `mcpServer/elicitation/request` — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md).
- Guardian: review timeout configurable from 0.165.0 — [Changelog](https://learn.chatgpt.com/docs/changelog). `approvals_reviewer = user|auto_review` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

**Dynamic tools**
- `thread/start.dynamicTools` is still EXP — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
- [PR #57553](https://github.com/openai/codex/pull/57553) (merged 2026-10-27, 0.166.0): `CodexThread::replace_dynamic_tools` swaps the catalog between model steps, preserving in-flight calls; an empty list clears. Persistent threads need `allow_persistent_dynamic_tool_updates`. Changes persist through restart and compaction. I found no JSON-RPC method for it in common.rs, and no such field among the EXP fields of `thread/settings/update`.
- Parallel dynamic tool calls from 0.164.0; inheritance by fresh V2 subagents from 0.162.0 — [Changelog](https://learn.chatgpt.com/docs/changelog).

**Hooks**
- 0.164.0: observation-only model request lifecycle hooks, lifecycle hooks for inter-agent messages, and plugin hook approval bound to plugin contents. 0.165.0: environment-scoped managed hooks and hook configuration on environment attachments — [Changelog](https://learn.chatgpt.com/docs/changelog).

**Plugins**
- `disabledPluginIds` on `turn/start` and `thread/settings/update` ("Omitted/null preserves the list; [] clears it"), present in the 0.159.1 experimental schema — [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs). Forks restore it — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md).
- 0.166.0: plugin process host with bounded IPC (#57290), bounded V8 runtime for UI plugin processes (#57508), eight concurrent loads (#57819), opt-in concise hints for explicitly selected plugins (#57317) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0). 0.163.0: configurable default plugin activation policy — [Changelog](https://learn.chatgpt.com/docs/changelog).
- Also in 0.159.1 stable: `plugin/reconcile`, `plugin/skill/read`, `plugin/share/*`, and `externalAgentConfig/{detect,import,import/readHistories,import/recordHistory}`, which imports other agents' config including plugins — local schema; [App-server docs](https://learn.chatgpt.com/docs/app-server).

**Skills**
- 0.166.0: incremental catalogs behind `skill_catalog_deltas` (#57262) and an option to omit descriptions (#57500) — [0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0). `skills.max_context_tokens` defaults to 2% of the context window, capped at 10000 — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

**MCP**
- `mcp_connection_sharing` now pools compatible local stdio servers that negotiate MCP `2026-07-28`. Legacy servers and servers requesting input at startup stay private, and elicitation routes to the calling chat — [PR #57211](https://github.com/openai/codex/pull/57211), 0.166.0.
- 0.164.0: enterprise MCP connections can authenticate with eligible Codex account grants or dedicated sign-in — [Changelog](https://learn.chatgpt.com/docs/changelog).
- `mcpServer/event/stream/start|stop` and `mcpServer/event/stream/notification` are EXP — [common.rs at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs). `mcpServerStatus/list` reports `serverCapabilities` with `serverName` filtering — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md).

### Inferences
- A permission-mode picker in machdoch should be driven by `permissionProfile/list` when available, with a `sandbox` plus `approvalPolicy` fallback for older CLIs. It should hide profiles the response marks as disallowed by effective requirements; I did not read that response field's exact name.
- `kind: "humanCommand"` must reach a real user. machdoch's `answerUnattendedGoalRequest` auto-accepts command approvals, so it should be checked against this kind if it ever appears; auto-answering a human checkpoint would defeat its purpose. Only relevant if the host declares `requiredHumanApproval`.
- MCP connection sharing reduces the cost of machdoch's per-run MCP servers on newer CLIs, but only for servers on the 2026-07-28 protocol.

### Gaps
- The `allow_persistent_dynamic_tool_updates` setting's location and any future JSON-RPC surface are unknown.
- `mcp_connection_sharing` config details and default were not read.
- Plugin process host semantics for third-party hosts are not documented in what I read.

## Memories, personality, model and reasoning switches, service tiers, realtime, image generation, review

### Takeaway
Memory v2 is the default for fresh profiles (0.165.0), with new read and status RPCs. Personality is dead and should be dropped from any roadmap. Reasoning changes mid-thread are more capable, but the mid-turn APIs remain EXP. Realtime and image generation gained no new protocol methods in the source read.

### Cited Findings
**Memories**
- Memory v2 is the default for fresh profiles and external-agent memories can be imported, from 0.165.0 — [Changelog](https://learn.chatgpt.com/docs/changelog). The [Memories docs](https://learn.chatgpt.com/docs/customization/memories) do not mention v2.
- `thread/memory/read {threadId}` returns `{summary|null}`; `memory/status {minConsolidatedThreads?}` (default 20, range 1 to 4096) returns `{v2ConsolidatedThreads, v2Ready}` — [memory.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/memory.rs). `memory/reset` and `thread/memoryMode/set` are EXP — [common.rs at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs).
- `features.memories` is off by default; `memories.use_memories`, `generate_memories`, `disable_on_external_context`, `max_rollout_age_days` (30), `max_rollouts_per_startup` (16), `max_raw_memories_for_consolidation` (256), `max_unused_days` (30), `min_rollout_idle_hours` (6), `min_rate_limit_remaining_percent` (25), `extract_model`, `consolidation_model` — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference). Stored under `$CODEX_HOME/memories/`; `/memories` controls one chat — [Memories docs](https://learn.chatgpt.com/docs/customization/memories).
- Open reports: toggles not reflecting config ([Issue #47812](https://github.com/openai/codex/issues/47812)) and memories generated but never injected ([Issue #29033](https://github.com/openai/codex/issues/29033)).

**Personality**
- `personality` is deprecated: "`friendly` and `pragmatic` no longer select a style" — [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs). `model/list.supportsPersonality` is always false — [README, main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md). Feature `personality` is `removed` — local `codex features list`.

**Model, reasoning, tier**
- STABLE sticky switches on `turn/start`: `model`, `effort`, `summary`, `serviceTier`, `cwd`, `sandboxPolicy`, plus one-turn `serviceTierForTurn` — [turn.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
- EXP: `turn/settings/update` (in-flight) and `thread/settings/update` with `thread/settings/updated` — [common.rs at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs).
- 0.165.0: reasoning-effort changes enabled by default for supported models — [Changelog](https://learn.chatgpt.com/docs/changelog). `thread/sample.effort` applies "only when the provider and model support cache-preserving reasoning-effort updates" — [thread_sample.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread_sample.rs). `reasoning_effort_override` and `step_model_switching` were `under development` in 0.159.1 — local `codex features list`.
- `thread/start.allowProviderModelFallback` (EXP): a provider with a static catalog may replace an unavailable model with its default — [thread.rs](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
- New providers: built-in Vertex AI (0.165.0), `account/gcp/setup`. GPT-6.1 Terra added to catalogs (0.165.0, 0.166.0) — [Changelog](https://learn.chatgpt.com/docs/changelog). Fast and Ultra Fast are enforced independently from 0.162.0 — earlier notes.

**Realtime and voice**
- `thread/realtime/{start,stop,appendAudio,appendText,appendSpeech,listVoices}`, plus notifications `started`, `itemAdded`, `item/started`, `item/transcript/delta`, `item/completed`, `transcript/delta`, `transcript/done`, `outputAudio/delta`, `sdp`, `error`, `closed`: all EXP, no additions since 0.159.1 — [common.rs at tag](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs). `realtime_conversation` is stable/on — local `codex features list`.

**Image generation**
- `image_generation` is stable/on, with `imageGeneration` thread items and no dedicated RPC — local schema and features, 0.159.1. 0.164.0 added TUI previews on Kitty and Sixel terminals — [Changelog](https://learn.chatgpt.com/docs/changelog).

**Review modes**
- Targets are unchanged (`uncommittedChanges`, `baseBranch`, `commit`, `custom`), and delivery is now effectively inline only — first section. No structured findings schema appeared in what I read. 0.162.0 preserves review targets across continuation — [Changelog](https://learn.chatgpt.com/docs/changelog).

### Inferences
- A "reasoning effort" dropdown can change on the next turn via stable `turn/start.effort`; only an in-flight change needs EXP `turn/settings/update`. Plain `model` or `effort` overrides persist for later turns, so a one-off must be set back.
- Remove personality UI; do not implement it.
- `thread/memory/read` plus `memory/status` could power a "what Codex remembers" panel. machdoch's isolated `CODEX_HOME` means memories start empty and accumulate only if the home persists.

### Gaps
- Whether `memories` feature default flipped with Memory v2 on fresh profiles: the changelog says default for fresh profiles, while config docs still say off. Probably v2 is the default pipeline when memories are on, but this is not confirmed.
- `thread/memoryMode/set` values at 0.166.0 were not re-read.
- No realtime integration guide was found.

## Highest-value next steps for machdoch (ranked)

### Takeaway
Ship in this order: version gating, `origin` on goals, durable lifecycle, then `thread/sample`. Everything else is opportunistic.

### Cited Findings
- All facts behind this ranking are cited in the sections above; this section contains no new facts.

### Inferences
1. **Version-gate.** Read the CLI version, keep schema-derived feature checks, and advise updating from 0.159.1 to 0.166.0, which includes the resume, permission, and race fixes (#57227, #57787, #57788). Cost: low.
2. **Goal hardening.** Send `origin: "user"` when supported, render `blocked` and `usageLimited` as actionable states, keep subscription alive, and never run a second app-server on the same home. Cost: low.
3. **Durable threads.** `thread/resume` with `excludeTurns`, `thread/list`, `thread/revert`, `thread/compact/start`. All STABLE; needs persistent `CODEX_HOME`. Cost: medium.
4. **`thread/sample`** for titles and follow-up chips, once 0.164.0 or later is the floor. Cost: low. EXP risk.
5. **`permissionProfile/list`** plus `permissions`, with fallback. Cost: medium. EXP risk.
6. **Attached forks** for side chats. Cost: medium. EXP risk, and very new.
7. **`thread/attachment/*`** to link PRs or issues to threads. STABLE. Cost: low.
8. **Do not build yet:** personality, dynamic-tool swapping, host-reserved children, automations integration, `thread/prediction/*`.

### Gaps
- None of this was runtime-tested, because model calls were out of scope and only 0.159.1 is installed.
