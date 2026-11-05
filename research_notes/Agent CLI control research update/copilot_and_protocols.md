# GitHub Copilot CLI host capabilities and cross-tool agent protocols (state as of 2026-10-30)

Version context, checked 2026-10-30:
- Installed CLI: 1.0.103 (`copilot --version`). Latest stable CLI: 1.0.105 ([releases](https://github.com/github/copilot-cli/releases)).
- Latest stable SDK: v1.0.28, which snapshots CLI 1.0.105-1 ([SDK releases](https://github.com/github/copilot-sdk/releases)); npm dist-tag `latest` is also 1.0.28 ([npm](https://registry.npmjs.org/@github/copilot-sdk)).
- "SDK-main" means `github/copilot-sdk` at main, fetched 2026-10-30.
- "machdoch today" means `apps/client/src/core/_helpers/copilot-server-session.ts` as read 2026-10-30. The earlier notes describe machdoch as one-shot `-p`; that part is out of date. machdoch already uses `--server --stdio`.

## Copilot: what changed since 1.0.103, and which host capabilities remain unexploited?

### Takeaway
Only two stable CLI releases followed 1.0.103 (1.0.104 and 1.0.105), and their host-relevant changes are small: Assisted Permissions leave experimental mode, and SDK Autopilot keeps waiting for attached background tasks. The larger opportunity is what machdoch has not wired yet: permission and plan-approval requests, `session.fleet.start`, session resume, workflows, the richer queue, `interruptMainTurn`, and credit-based quota. Every generated RPC on SDK-main is still marked Experimental even though the SDK is GA, so the SDK and CLI versions must be pinned together.

### Cited Findings

**Releases since 1.0.103**
- 1.0.105 (changelog date 2026-10-27; the releases page shows 28 Oct): Copilot Fusion High/Max can be selected from long-context sessions — [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md), [releases](https://github.com/github/copilot-cli/releases)
- 1.0.104 (2026-10-27): interactive and SDK Autopilot sessions keep waiting for attached background tasks instead of stopping at the wait timeout, while `-p --autopilot` still honors it. Assisted Permissions no longer need experimental mode. The managed "fusion" model starts on Auto and applies `fusionTier` settings — [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md)
- 1.0.103 (2026-10-22), the installed version: ACP sessions honor saved sandbox settings and `--sandbox`/`--no-sandbox`, including on resume. Hosting and connection flags were reworked, and `--remote`/`--no-remote` were retired. Windows shims such as `npm.cmd` get the same sandbox grants as `npm` — [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md)
- 1.0.101 (2026-10-20): headless and SDK sessions without an OAuth handler skip MCP servers that need sign-in; renewable grants still connect. Dynamic workflow subagents get native structured output. A new `assistedApprovalInstructions` setting guides Assisted Permissions. Changing only reasoning effort no longer forces compaction — [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md)
- The local 1.0.103 help text still says `--assisted-approval` requires `--experimental` (local `copilot --help`). That matches the 1.0.104 change, so machdoch must not assume the non-experimental behavior until it upgrades.

**SDK status**
- GA since 2026-06-02, with semver stated in the repo README; the product is "becoming Microsoft Copilot SDK" — [earlier notes' GA changelog source](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/), [SDK README](https://github.com/github/copilot-sdk). VS Code's 2026-08-26 post already calls it the Microsoft Copilot SDK — [VS Code blog](https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture)
- Own scan of SDK-main on 2026-10-30: `rust/src/generated/rpc.rs` has 587 unique wire methods. All 624 "Wire method" doc lines are matched by 624 "Experimental" lines, with the warning "Pin both the SDK and CLI versions if your code depends on it" — [rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs)
- Per-release SDK notes are thin: v1.0.27 lists internal dependency updates, and v1.0.28 only updates the CLI snapshot. v1.0.28-preview.0 refreshes session event types and adjusts permission and elicitation handling. `CHANGELOG.md` still stops at v1.0.14 (2026-09-16) — [SDK releases](https://github.com/github/copilot-sdk/releases), [SDK CHANGELOG](https://raw.githubusercontent.com/github/copilot-sdk/main/CHANGELOG.md)

**Capability catalogue.** Stability "Exp." means the generated RPC banner applies. Minimum version is the earliest CLI changelog entry I could tie to the feature. "Newer than CLI 1.0.70" means the method is on SDK-main but was absent from `github-copilot-sdk` 1.0.7-preview.2, which targets CLI 1.0.70, according to the earlier note `research_notes/Agent CLI integration opportunities/copilot.md`. The exact first version is not known.

| Capability | Mechanism | Stability | Minimum version | machdoch today |
|---|---|---|---|---|
| Permission cards | `requestPermission: true`, `permission.requested`, `session.permissions.handlePendingPermissionRequest`, `pendingRequests` | Exp. | Before CLI 1.0.70 | Sets `setApproveAll` to true, so no card is shown |
| Permission modes | `session.permissions.setMode`/`getMode` (`manual`, `assisted`, `allow-all`) | Exp. | Newer than CLI 1.0.70; Assisted without experimental flag in 1.0.104 | Not used |
| Plan approval | `requestExitPlanMode`, `exit_plan_mode.requested`, `session.ui.handlePendingExitPlanMode`; actions include `autopilot_fleet` | Exp. | Event always emitted since 1.0.14; plan-menu actions 0.0.415 | `requestExitPlanMode: false` |
| Plan content and todos | `session.plan.read`/`update`/`delete`, `readSqlTodosWithDependencies`, `session.plan_changed`, `session.todos_changed` | Exp. | SDK plan APIs 0.0.411 | Parses `update_todo` tool arguments instead |
| Fleet | `session.fleet.start` takes optional `prompt` and `attachments`, returns `{started}` | Exp. | SDK fleet API 0.0.411 | Not used |
| Autopilot | `session.mode.set`, `agent_mode` per message, `session.autopilotObjective.getState`, `session.autopilot_stopped` | Exp. | `/autopilot <objective>` 1.0.55; `autopilot_stopped` newer than CLI 1.0.70 | Server path sends no `agentMode`; the one-shot path passes `--autopilot` (`external-agent-provider.ts`) |
| Background tasks | `session.tasks.list`, `cancel`, `sendMessage`, `startAgent`, `promoteToBackground`, `readOutput`, `register`, `update` | Exp. | Steering via `sendMessage` 1.0.92; `readOutput` and `register`/`update` newer than CLI 1.0.70 | Uses `list` and `cancel` only |
| Interrupt keeping background work | `session.interruptMainTurn`, `session.cancelAllBackgroundAgents` | Exp. | Newer than CLI 1.0.70 | Uses `session.abort` |
| Editable queue | `session.queue.sendNow`, `withdrawMessage`, `moveItem`, `updateText`, `setDrainPaused`, `appendSteering`, `snapshot` | Exp. | Newer than CLI 1.0.70 | Uses `mode:"immediate"` only |
| Session resume | `session.resume` with `continue_pending_work`; `--session-id` since 1.0.51 | Helper API stable; generated RPC Exp. | 1.0.51 for the CLI flag | Turn-scoped session, ended by `session.destroy` |
| Fork and rewind | `sessions.fork`, `session.history.rewind`, `listRewindPoints`, `previewRewind` | Exp. | `/fork` 1.0.45; rewind RPCs newer than CLI 1.0.70 | Not used |
| Workflows | `copilot workflow run`, `session.workflow.run`, `getRunProgress`, `pause`, `resume`, `cancel`; `workflow.run_*` events | Exp. for RPC; CLI subcommand documented | Structured output 1.0.101 | Not used |
| Scheduling | `session.schedule.add`, `addAt`, `addCron`, `list`, `stop` | Exp. | Not determined | Not used |
| Usage and credits | `session.usage.getMetrics`, `session.quota.get`/`refresh`/`takeWarnings`, `session.quota_observation`, `session.limitPrediction.predict`, `sessionLimits` | Exp. | `--usage-output-file` per-agent 1.0.81; `/usage` billed credits 1.0.97; quota RPCs newer than CLI 1.0.70 | `account.getQuota`, `assistant.usage`, and labels for `premium_interactions`/`chat` only |
| Live MCP control | `session.mcp.*`, `mcp.config.*`; config applies between turns | Exp. | `mcp.config.*` 1.0.15; between-turn apply 1.0.93; MCP 2026-07-28 in 1.0.81 | Passes servers at session creation |
| Hooks, skills, plugins, custom agents | `hooks`, `skill_directories`, `plugin_directories`, `custom_agents` on session create | Config fields GA; RPCs Exp. | Plugin dirs 1.0.55; agent-scoped declarative hooks 1.0.97 | Uses custom agent; `hooks: false` |
| Provenance and credentials | `send()` message `source`; session-scoped rotating GitHub credential callback; `managedSettings` | SDK feature | SDK 1.0.13 and 1.0.14; `managedSettings` needs CLI 1.0.79-5+ | Not used |
| Cloud delegation | `/delegate` or `&` prefix; `--connect`, `--resume` for cloud sessions; `/delegate --base` | Slash command; no documented non-interactive form | `/delegate` 0.0.353; `--base` 1.0.69 | Not used |
| Remote and Mission Control hosting | `session.remote.enable`, `sessions.startRemoteControl`, `--host-environment`, `--sync-session` | Exp.; flags in local help | Hosting flags 1.0.103; `--connect` 1.0.32 | Not used |
| AHP hosting and client | `--ahp`, `/ahp` gated by `AHP_CLIENT`; AHP host flag (see conflict below) | Feature-gated, undocumented in `--help` | `--ahp` 1.0.80-0; managed settings for AHP hosts 1.0.88 | Not used |
| Canvases and MCP Apps | `session.canvas.*` for extension canvases; `requestMcpApps` session flag for MCP Apps | Exp. | CLI canvases 1.0.71; flag not dated | `requestMcpApps: false` |

Sources for the table: [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md), [rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs), [session_events.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/session_events.rs), [api_types.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/api_types.rs), [SDK CHANGELOG](https://raw.githubusercontent.com/github/copilot-sdk/main/CHANGELOG.md), [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), [delegate docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/delegate-tasks-to-cca), [v1.0.80-0 release](https://github.com/github/copilot-cli/releases/tag/v1.0.80-0), and local `copilot --help` (1.0.103).

**Details behind the table**
- `/fleet`: the main agent acts as orchestrator and runs independent subtasks in parallel, each with its own context window. It may consume more AI Credits than a single agent. The page gives no SDK details — [fleet docs](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet). `--fleet` is "Not supported in ACP server mode" — [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- Workflows: `copilot workflow run NAME` takes `--args`, `--silent`, `--output-format json` and `--result-file`, and rejects `-p`, `-i`, `--agent`, `--fleet`, `--autopilot`, `--resume` and `--continue`. Exit codes are 0, 1, 2 and 130 — [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- `/delegate` creates a branch and draft PR, runs on Copilot cloud agent, and continues if the machine shuts down. The docs give no non-interactive form for it — [delegate docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/delegate-tasks-to-cca)
- Conflict on the AHP host flag: the 1.0.88 changelog names `copilot --ahp-host`, while the local 1.0.103 help text mentions `--host-ahp` and lists no standalone entry for it — [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md), local `copilot --help`
- `--host-environment <name>` "Start[s] a headless Mission Control environment (no local listener unless --host-ahp is also set)"; `--sync-session` enables read-only account history sync and "does not enable incoming control" (local `copilot --help`, 1.0.103).
- SDK cleanup: v1.0.13 replaced `session.destroy` with `session.detach`, so disconnecting one client no longer ends a shared session — [SDK CHANGELOG](https://raw.githubusercontent.com/github/copilot-sdk/main/CHANGELOG.md). machdoch still sends `session.destroy` at turn end (`copilot-server-session.ts`, around line 666).

### Inferences
- Highest-value items, in order:
  1. Keep the session alive across turns and call `session.resume`. Most other features depend on this.
  2. Enable `requestExitPlanMode` and `requestPermission` without `setApproveAll`, because machdoch already has question UI that could carry them.
  3. Use `session.fleet.start` and show `agentId`-grouped subagents.
  4. Replace `session.abort` with `interruptMainTurn` when background work should survive.
  5. Add `session.quota.*` so credit-billed users see correct limits. The `QUOTA_LABELS` map covers only legacy-style keys.
- Upgrading from 1.0.103 to 1.0.105 is low risk but brings few host features. The change that matters is the Autopilot wait behavior: it applies to SDK Autopilot sessions, so it would affect machdoch once the server path uses Autopilot, while the one-shot `-p --autopilot` path keeps the timeout.
- Delegation is a poor first target: the documented entry point is a slash command, and I found no structured event contract for it.
- AHP deserves watching rather than adopting: Copilot can apparently attach or host it, but the flags are gated and inconsistently named.

### Gaps
- Exact first versions for most RPCs were not determined. The SDK changelog stops at v1.0.14, and later release notes are mostly internal.
- I did not test any of the RPCs live, as model calls were out of scope. The method list proves only that the schema declares them, and `session.create` flag behavior is from the existing code and earlier notes.
- `session.fleet.start` has no public how-to that I could find, and no documented way to pick the subagent model per task.
- I did not confirm which `quotaSnapshots` key carries AI-credit budgets, an open question from the earlier notes.
- `docs/features/background-tasks.md` does not exist on SDK-main (404), so task semantics rest on generated doc comments.

## ACP: version, CLI support, surface, and what it omits

### Takeaway
ACP v1 is the stable protocol; v2 has been a Draft since 2026-07-20 and should stay behind a flag. Nearly every CLI in scope is reachable through ACP, natively or by adapter, but Copilot's ACP is still public preview and omits fleet. ACP would give machdoch breadth for new CLIs, not a replacement for its native Copilot, Claude and Codex drivers, because steering, rate limits, and background-task control remain outside stable ACP. The active draft RFDs, however, are closing the background and subagent gaps quickly.

### Cited Findings

**Version and governance**
- v1 is stable; v2 is Draft, with schemas tagged `schema-v2.0.0-alpha.N`. ACP advises gating v2 behind both version negotiation and feature flags, not enabling it by default in production before stabilization, and supporting v1 and v2 side by side. No stabilization date is given — [v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md), [ACP updates](https://agentclientprotocol.com/updates)
- Recent stabilizations: boolean config options (2026-07-06), elicitation (2026-07-22), tool call names (2026-09-17) — [ACP updates](https://agentclientprotocol.com/updates)
- Package versions on 2026-10-30: `@agentclientprotocol/sdk` 2.1.0, Rust crate `agent-client-protocol` 3.6.0, `@agentclientprotocol/claude-agent-acp` 0.99.1, `@agentclientprotocol/codex-acp` 2.5.0 — [npm](https://registry.npmjs.org/@agentclientprotocol/sdk/latest), [crates.io](https://crates.io/api/v1/crates/agent-client-protocol). SDK major versions do not indicate protocol version.

**What v1 exposes**
- Baseline agent methods: `initialize`, `authenticate`, `session/new`, `session/prompt`. Optional: `session/load` (`loadSession`), `logout`, `session/set_mode`. `session/cancel` is a notification — [v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md)
- Client methods: `session/request_permission` (baseline); capability-gated `fs/*`, `terminal/*` and `elicitation/create` — [v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md)
- `session/update` variants: message and thought chunks, tool calls and updates, plans, available commands, mode changes, notices, context compactions — [v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md). Earlier stabilized: `session/list`, `session/resume`, `session/close`, `session/delete`, config options and `usage_update` — [ACP updates](https://agentclientprotocol.com/updates)

**What v2 changes**
- `session/update` can arrive at any time. A prompt response returns the inserted message's `messageId` rather than marking turn end, and the agent signals idle. Updates use patch semantics by stable ID. Diffs become structured file changes with optional `git_patch`. Permission requests gain `title`, `description` and an extensible `subject`. Unknown enum variants use a `_` prefix — [v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md)
- The announcement says the lifecycle is meant to make queueing, steering and background updates possible, but it does not define a steering feature — [v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md)

**Active drafts, directly relevant to live agent state**
- Background Work RFD (draft, revised through 2026-10-27): no new entity. Terminals, tool calls and subagent sessions can outlive foreground work. It adds a `paused` status, `tool_call/cancel` and `terminal/cancel`, and a `background` list on `state_update`. `session/cancel` stops only foreground work and `session/close` stops all. `claude-agent-acp` and `codex-acp` would replace their private async-task extensions — [RFD](https://agentclientprotocol.com/rfds/v2/background-work)
- Subagent Sessions RFD (draft, revised 2026-10-29): children are their own sessions announced by `subagent_update`, behind `unstable_subagents`. Clients may not prompt or steer a child; only per-child `cancel` is defined. Child costs are not summed into the parent. Authors validate against Claude Code (Agent SDK 0.3.280) and Codex (0.156.1), and state this does not claim adapters already implement the revision — [RFD](https://agentclientprotocol.com/rfds/subagents)
- Steering has no RFD in the published index — [ACP llms.txt](https://agentclientprotocol.com/llms.txt). `_session/steering` ships in both adapters as an extension; a PR merged 2026-07-28 describes it — [block/buzz #3007](https://github.com/block/buzz/pull/3007). I could not verify the status of ACP PR #1261 cited in the earlier notes.

**CLI support**
- Registry on 2026-10-30, 43 entries: `github-copilot-cli` 1.0.105 (`npx @github/copilot --acp`), `claude-acp` 0.99.1, `codex-acp` 2.5.0, `gemini` 0.66.0 (`--acp`), `cursor` 2026.10.22, `opencode` and `opencode-v2` 2.2.2, `qwen-code` 0.26.4 (`--acp --experimental-skills`), `amp-acp` 0.10.0, `antigravity-acp` 1.4.5, among others. Aider is absent — [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- Adapters are not all first-party: `amp-acp` points to the personal repository `tao12345666333/amp-acp`, and `antigravity-acp` lists no repository — [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- The human-readable agents page lists 48 agents and differs from the registry: it omits Antigravity and Amp, and describes Claude as using "Zed's SDK adapter" while the registry points at the `agentclientprotocol` organization — [ACP agents](https://agentclientprotocol.com/overview/agents), [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

**Copilot's ACP in detail**
- Docs say public preview, "subject to change". They document `initialize`, `session/new`, `prompt`, `requestPermission` and `available_commands_update`, with tool and effort settings fixed at server start. `/diff`, `/resume`, `/theme`, `/settings`, `/login`, `/help`, `/tasks` and `/undo` do not run — [ACP server docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- The changelog shows more than the docs: session load (0.0.410), agent and plan modes (0.0.402), reasoning config (0.0.421), client MCP servers (1.0.25), allow-all toggle (1.0.39), live plan and custom-agent switching (1.0.40), `closeSession` and token usage in prompt results and `usage_update` (1.0.78), subagent IDs and raw event subscriptions (1.0.81) — [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md)
- `/usage` and `/context` return output over ACP without calling the model — [ACP server docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)

**Omissions compared with native protocols**

| Need | Stable ACP v1 | Native |
|---|---|---|
| Steering mid-turn | Extension only (`_session/steering`) | Copilot `session.send mode:"immediate"`, Codex `turn/steer` |
| Editable queue | None | Copilot `session.queue.*` |
| Rate limits and plan quota | None; `usage_update` covers context and cost | Copilot `account.getQuota`, Codex `account/rateLimits/*` |
| Background tasks | Draft RFD only | Copilot `session.tasks.*`, Claude `stopTask`, Codex `thread/backgroundTerminals/*` |
| Subagents | Draft RFD; Copilot has its own IDs | Copilot `agentId`, `subagent.*` |
| Fork and rewind | RFD for fork; rewind absent | Copilot `sessions.fork`, `history.rewind` |
| Fleet | Not supported on Copilot | `session.fleet.start` |

Sources: the rows combine the [v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md), [ACP llms.txt](https://agentclientprotocol.com/llms.txt), [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), [rpc.rs](https://github.com/github/copilot-sdk/blob/main/rust/src/generated/rpc.rs), and the [earlier host-integration notes' Codex and Claude sources](https://learn.chatgpt.com/docs/app-server).

**A competing protocol the question did not name: AHP**
- Microsoft's Agent Host Protocol is state-first. Clients subscribe to URI-addressed channels (sessions, chats, terminals, changesets), receive a snapshot plus ordered actions, apply shared reducers, and replay missed actions on reconnect. Several clients can approve or cancel on one session. It is described as "under active development" — [VS Code blog, 2026-08-26](https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture), [Agent Host docs, shown 2026-10-28](https://code.visualstudio.com/docs/agents/concepts/agent-host)
- The site lists spec v1.0.0 under MIT, with client libraries for TypeScript, Rust, Kotlin, Swift, Go and .NET — [AHP site](https://microsoft.github.io/agent-host-protocol/). The VS Code post lists Rust, TypeScript, Kotlin, Go and Swift, omitting .NET — [VS Code blog](https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture)
- First-party adapters for Copilot, Claude and Codex run inside the Agent Host; the Copilot adapter uses the Copilot SDK — [Agent Host docs](https://code.visualstudio.com/docs/agents/concepts/agent-host). Neither page mentions ACP. Search results included commentary questioning whether AHP will become truly multi-vendor; I did not isolate which article made the claim, and the likely candidates are [DevOps.com](https://devops.com/?p=189332) and [Visual Studio Magazine](https://visualstudiomagazine.com/articles/2026/08/26/microsoft-formalizes-vs-code-agent-host-as-open-architecture-for-persistent-ai-sessions.aspx)

### Inferences
- Recommended stance: add an ACP v1 client as the integration path for **additional** CLIs, and keep native drivers for Copilot, Claude and Codex. Do not migrate existing drivers, since doing so would lose steering, quota, queue and fleet.
- Model machdoch's internal task view on the ACP v2 and Background Work RFD concepts, which already resemble `AgentLiveTracker`: state plus a background list with per-item cancel. Then a future v2 client needs little translation.
- Negotiate `_session/steering` opportunistically, and treat absence as "queue until idle".
- AHP's snapshot and action model fits a multi-client host, including machdoch's fleet relay, better than ACP's event stream does. But AHP is young and Microsoft-led, and machdoch would be a competing host rather than a client. Read it as a design reference for now.

### Gaps
- The numeric v1 `protocolVersion` was not visible on the page fetched.
- I could not establish whether Copilot `--acp` supports `_session/steering`, `session/list` or `session/resume`; docs mention resume only in passing.
- Adapter feature parity at the current versions was not re-verified beyond the earlier notes.
- I did not read the AHP reference pages or test its client libraries.

## MCP: latest revision, Tasks, elicitation, sampling, identity, registry, and host work

### Takeaway
The latest revision is 2026-07-28, final and breaking: MCP is now stateless, with no `initialize` handshake or protocol sessions, and server-initiated requests are replaced by a retry-based Multi Round-Trip pattern. Tasks moved into a Beta extension, and Sampling (including sampling with tools from 2025-11-25) is now Deprecated, so machdoch should not build on it. Priorities for machdoch's host are dual-version client support, MRTR elicitation with the mandated UI safeguards, then Tasks and Apps.

### Cited Findings

**Revision**
- The final 2026-07-28 revision shipped on that date, after an RC on 2026-05-21 — [MCP protocol blog tag](https://blog.modelcontextprotocol.io/tags/protocol/), [RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- Removed: `initialize`/`notifications/initialized`, `Mcp-Session-Id`, the HTTP GET endpoint, `resources/subscribe`, `ping`, `logging/setLevel`, `notifications/roots/list_changed`, and SSE resumability (`Last-Event-ID`). A broken stream loses the in-flight request and the client must re-issue it — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Added: every request carries version and capabilities in `_meta`; servers MUST implement `server/discover`, which also serves as a backward-compatibility probe on stdio; `subscriptions/listen` is a single stream for change notifications; results carry a required `resultType`; list results carry required `ttlMs` and `cacheScope` — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Results that omit `resultType` from earlier-protocol servers MUST be treated as `"complete"` — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- The missing-resource error moved from `-32002` to `-32602`. New codes include `UnsupportedProtocolVersion` `-32022` — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

**Tasks**
- 2025-11-25 added experimental Tasks (SEP-1686) — [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog). 2026-07-28 moved them to extension `io.modelcontextprotocol/tasks`, replacing blocking `tasks/result` with `tasks/get` polling and adding `tasks/update`, while removing `tasks/list` — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Stage is "Beta, to Core", so it is intended for later promotion — [extensions overview](https://modelcontextprotocol.io/docs/extensions/overview)
- Client duties: declare the extension per request, handle a polymorphic `resultType:"task"` response, poll at `pollIntervalMs`, fulfill `input_required` via `tasks/update`, and **persist task IDs** so polling survives a crash. Statuses are `working`, `input_required`, `completed`, `failed`, `cancelled`. Cancellation is cooperative. `notifications/tasks` via `subscriptions/listen` can replace polling — [Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview)

**Elicitation**
- Forms take flat primitive schemas. URL mode is mandatory for sensitive data. The flow now uses `InputRequiredResult`, and the client retries the original request with `inputResponses` and echoed `requestState`. `notifications/elicitation/complete` and `elicitationId` are gone — [elicitation spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Client MUSTs: show which server is asking; offer decline and cancel; allow review of form answers; for URL mode, never pre-fetch, never open without consent, show the full URL, and open it so neither client nor LLM can inspect content. SHOULD highlight the domain and warn on Punycode — [elicitation spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
- Note for Tauri: the spec's example says an app-embedded web view is unsuitable where it lets the client inspect content (WKWebView on iOS, as opposed to SFSafariViewController) — [elicitation spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)

**Sampling with tools**
- `tools` and `toolChoice` were added in 2025-11-25 (SEP-1577) — [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog). In 2026-07-28, Roots, Sampling and Logging are **Deprecated** (SEP-2577) with a minimum twelve-month window; the suggested migration is direct LLM provider integration — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

**Server identity and registry**
- `io.modelcontextprotocol/serverInfo` appears in `_meta` of results, and `server/discover` advertises identity — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Server Cards (SEP-2127 Final; extension Beta) give out-of-band metadata for remote servers at the recommended `<streamable-http-url>/server-card`, with domain discovery through `/.well-known/ai-catalog.json`. They deliberately exclude tools and capabilities, and clients should prefer live `server/discover` values on disagreement. Cards are advisory, not a security proof — [SEP-2127](https://modelcontextprotocol.io/seps/2127-mcp-server-cards), [extensions overview](https://modelcontextprotocol.io/docs/extensions/overview)
- The official Registry is still **in preview**, with possible breaking changes or data resets. Names use reverse DNS tied to GitHub or domain verification. It does **not** scan security, leaving that to package registries and aggregators, and it is "not intended to be directly consumed by host applications". Hosts should use downstream registries implementing its OpenAPI spec — [Registry about](https://modelcontextprotocol.io/registry/about)

**Other extensions and auth**
- MCP Apps (`io.modelcontextprotocol/ui`) is Stable; OAuth Client Credentials and Enterprise-Managed Authorization are Stable; Skills over MCP is Beta — [extensions overview](https://modelcontextprotocol.io/docs/extensions/overview)
- Apps render HTML in a sandboxed iframe; templates are declared in advance so hosts can prefetch and review them, and UI actions go through the same audit and consent path — [RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- Client auth duties: validate `iss` per RFC 9207 if present, send `application_type` on Dynamic Client Registration, key stored credentials by issuer and re-register when it changes, and prefer Client ID Metadata Documents, since DCR is now Deprecated — [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- The client matrix's check marks did not survive page conversion, so only "Partial" entries were legible — [client matrix](https://modelcontextprotocol.io/extensions/client-matrix). Copilot CLI is not a row on it, though CLI 1.0.81 claims 2026-07-28 support — [CLI changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md)
- SDKs on 2026-10-30: `@modelcontextprotocol/sdk` 1.32.2 and Rust `rmcp` 3.8.0 — [npm](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest), [crates.io](https://crates.io/api/v1/crates/rmcp). machdoch's `apps/client` and `apps/cloud` depend on `^1.32.2`.

### Inferences
Suggested host work for machdoch, in order:
1. **Dual-version client.** Probe with `server/discover`, fall back to `initialize` for older servers, treat missing `resultType` as complete, and update any `-32002` matching. Check whether SDK 1.32.2 handles this before writing it.
2. **MRTR elicitation UI** with the mandated safeguards. Open URL-mode links in the system browser rather than a Tauri webview, which appears to be the conservative reading of the spec.
3. **Caching** by `ttlMs`, and re-issue on broken streams.
4. **Tasks.** Persist IDs in machdoch's existing task store and surface them as background items, a natural fit with the live task panel. Beta, so keep the code isolated.
5. **Apps.** Stable, and machdoch currently sends `requestMcpApps: false` to Copilot. Do it after core work, because a sandboxed iframe in Tauri needs its own security review.
6. **Do not add Sampling or Roots.** Keep any existing support only for compatibility.
7. **Registry.** Do not consume the official registry directly; if machdoch adds discovery, use a downstream aggregator and display the verified namespace rather than treating it as a safety signal.

Note the distinction between two host roles: agent CLIs act as MCP hosts for their own servers. machdoch's own MCP host only sees these flows on servers it connects to directly. For servers passed through to a CLI, elicitation reaches machdoch only through that CLI's protocol, such as Copilot's `requestElicitation`.

### Gaps
- I did not verify how fully `@modelcontextprotocol/sdk` 1.32.2 implements 2026-07-28 client behavior, or Tasks.
- I did not audit machdoch's MCP host code; only a file-level search for protocol terms was run.
- The client matrix's support cells were unreadable after conversion, so per-client Tasks support is unknown.
- The deprecated-features registry and MRTR page were not read in full.

## A2A, AG-UI and similar event standards: status and fit for a host showing live agent state

### Takeaway
Neither fits as machdoch's integration layer today, because no CLI in scope exposes them as a control surface. A2A v1.0 is a stable agent-to-agent task protocol now under the Agentic AI Foundation; it could later expose machdoch or remote workers to other agents. AG-UI is the closest to "live agent state" in concept, but it is aimed at agent frameworks and web frontends. For a host driving coding CLIs, ACP and AHP are the relevant standards.

### Cited Findings

**A2A**
- Latest released version is 1.0.0; earlier 0.3.0, 0.2.6 and 0.1.0 are still published. Operations: Send Message, Send Streaming Message, Get/List/Cancel Task, Subscribe to Task, push notification config CRUD, Get Extended Agent Card. States: SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED. Bindings: JSON-RPC, gRPC, HTTP+JSON — [A2A spec](https://a2a-protocol.org/latest/specification/)
- A2A became an AAIF hosted project on 2026-08-17, alongside MCP, AGENTS.md, goose and agentgateway. v1.0 shipped in March 2026 with multi-protocol bindings, version negotiation, multi-tenancy and signed agent cards. IBM's Agent Communication Protocol merged into A2A in August 2025 — [AAIF post](https://aaif.io/blog/a2a-joins-aaif). Secondary sources differ on the v1.0 date (March versus April 2026) — [dailyaiworld, via search summary](https://dailyaiworld.com/blogs/a2a-10-joins-agentic-ai-foundation-internet-agents). The AAIF date also differs slightly from the spec site's banner, whose blog URL is dated 2026/08/27 — [A2A spec](https://a2a-protocol.org/latest/specification/)
- Name collision: "ACP" in that article means IBM's protocol, not the Agent Client Protocol — [AAIF post](https://aaif.io/blog/a2a-joins-aaif)
- The AAIF post mentions no coding agents; a June 2026 analysis reported as saying A2A v1.0.1 lacks protocol-level human escalation and audit replay is secondary and unverified — [AI2Work](https://ai2.work/blog/google-s-a2a-protocol-joins-the-agentic-ai-foundation-with-mcp)
- `@a2a-js/sdk` is at 1.3.0 — [npm](https://registry.npmjs.org/@a2a-js/sdk/latest)

**AG-UI**
- Event families: lifecycle (`RunStarted`, `RunFinished`, `RunError`, steps), text messages, tool calls, state (`StateSnapshot`, `StateDelta` via JSON Patch, `MessagesSnapshot`), activity, reasoning, subagents (`SubagentStarted`, `SubagentFinished`, `SubagentError`), `Raw` and `Custom`. Interrupts are a `RunFinished` with `outcome: {type:"interrupt"}`, resumed by a new run with a `resume` array. Extended `RunStarted` and `RunFinished` and `MetaEvent` are DRAFT — [AG-UI events](https://docs.ag-ui.com/concepts/events)
- Positioned as agent-to-user, next to MCP (tools) and A2A (agents). It came from CopilotKit's partnership with LangChain and CrewAI. Integrations are frameworks such as Microsoft Agent Framework, Google ADK, Mastra and Pydantic AI, with community support for the Claude Agent SDK. The page lists Google Antigravity as first-party. No formal governance is described — [AG-UI intro](https://docs.ag-ui.com/introduction)
- `@ag-ui/core` is at 1.0.3 — [npm](https://registry.npmjs.org/@ag-ui/core/latest)

### Inferences
- A2A: machdoch could expose a fleet machine or a queued task as an A2A agent, because its task states map well onto machdoch's. That is an interoperability feature for later, not a way to drive CLIs. No in-scope CLI was found serving A2A.
- AG-UI: its event taxonomy, especially the snapshot-plus-delta state and subagent events, is a useful checklist for machdoch's fleet protocol (`task-thinking` types). Adopting it on the wire would add a translation layer with no consumer. It might matter if machdoch's cloud UI were to embed third-party AG-UI agents.
- Standards map for machdoch: **host to agent** is native SDKs plus ACP; **host to its own UIs** is an internal protocol, with AHP and AG-UI as design references; **agent to tools** is MCP; **machdoch to other agents** is A2A, optionally.

### Gaps
- No primary source on coding-agent adoption of A2A was found, and none says that any in-scope CLI implements it.
- The AG-UI page did not name transports beyond "HTTP and WebSockets" as examples, and no governance or spec version was stated.
- A2A's human-in-the-loop limitation is reported only by a secondary source. The spec's `INPUT_REQUIRED` state partly contradicts a broad reading of that claim.

## Should machdoch add further CLIs, what control surfaces do they offer, and would ACP cover them?

### Takeaway
Yes, through a single ACP client rather than per-CLI drivers, with Cursor and OpenCode as the best first targets. Gemini CLI needs caution because of Google's move to Antigravity, whose official ACP status is unclear. Skip Aider: it has no protocol. Amp is better reached through its own stream-json, which has steering, because its ACP route is a third-party wrapper. Qwen Code is a cheap add-on once ACP exists.

### Cited Findings

| CLI | Native control surface | ACP route | Notes |
|---|---|---|---|
| **Cursor CLI** | `agent acp`, plus `--api-key` and auth tokens | Native; registry `cursor` 2026.10.22 | Rich `cursor/*` extensions |
| **OpenCode** | `opencode serve` HTTP/OpenAPI with SSE | Native `opencode acp`; registry 2.2.2 | Best non-ACP API of the set |
| **Gemini CLI** | Headless JSON/JSONL | Native `gemini --acp`; registry 0.66.0 | Replaced for many users |
| **Antigravity CLI (`agy`)** | Reported stream-json headless | Unconfirmed; registry `antigravity-acp` has no repo | Official docs not found |
| **Qwen Code** | `-p` with stream-json; `qwen serve` REST+SSE | Native `--acp`; registry 0.26.4 | Registry adds `--experimental-skills` |
| **Amp** | `--execute --stream-json`, `--stream-json-input` with `steer` | Third-party `amp-acp` 0.10.0 | Native stream has steering |
| **Aider** | `--message`; unsupported Python API | None | Not in registry; latest release 0.86.2, 2026-02-12 |

**Cursor**
- `agent acp` uses stdio JSON-RPC, one message per line. It supports `session/new`, `session/load`, `session/prompt`, `session/cancel` and permissions (`allow-once`, `allow-always`, `reject-once`). Modes are `agent`, `plan`, `ask` — [Cursor ACP docs](https://cursor.com/docs/cli/acp)
- Extensions include blocking `cursor/ask_question` and `cursor/create_plan`, and notifications `cursor/update_todos`, `cursor/task`, `cursor/generate_image`. Dashboard team MCP servers are unavailable in ACP mode. Unanswered permissions can block execution — [Cursor ACP docs](https://cursor.com/docs/cli/acp)

**OpenCode**
- `opencode acp` runs over stdio with built-in and custom tools, MCP, `AGENTS.md`, agents and permissions; `/undo` and `/redo` are not yet supported — [OpenCode ACP docs](https://opencode.ai/docs/acp/)
- `opencode serve` (default 127.0.0.1:4096, docs updated 2026-10-29) offers OpenAPI 3.1 at `/doc`, `POST /session/:id/message`, `prompt_async`, `abort`, `fork`, `revert`/`unrevert`, permission replies with `remember`, and SSE at `GET /event`. Optional HTTP basic auth via `OPENCODE_SERVER_PASSWORD` — [OpenCode server docs](https://opencode.ai/docs/server/)
- Version conflict: npm `opencode-ai` shows 1.19.5, while the ACP registry lists `opencode` 2.2.2 and `opencode-v2` — [npm](https://registry.npmjs.org/opencode-ai/latest), [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

**Gemini CLI and Antigravity**
- Gemini ACP docs (updated 2026-04-10) list `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode` and `unstable_setSessionModel`, plus a proxied file system service. The page says Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" for unpaid-tier and Google One users, and has "not been optimized for Gemini 4 Argon" — [Gemini ACP docs](https://geminicli.com/docs/cli/acp-mode/), [Gemini headless docs](https://geminicli.com/docs/cli/headless/)
- Enterprises on Gemini Code Assist or Google Cloud reportedly keep access — [secondary: search summary, letsdatascience](https://letsdatascience.com/news/google-replaces-gemini-cli-with-antigravity-cli-574b2056)
- Headless streaming events: `init`, `message`, `tool_use`, `tool_result`, `error`, `result`; exit codes 0, 1, 42, 53 — [Gemini headless docs](https://geminicli.com/docs/cli/headless/)
- `agy` ACP status conflicts: a community discussion reports no ACP support — [NeverWrite #241](https://github.com/jsgrrchg/NeverWrite/discussions/241). A closed PR claims `agy --acp` exists but calls the adapter a workaround — [openab #863](https://github.com/openabdev/openab/pull/863). A forum post claims stream-json headless is supported — [Google AI forum](https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051). None is official documentation.

**Qwen Code**
- `qwen --acp` speaks ACP over stdio; `qwen serve` currently uses a custom REST and SSE dialect, with a proposal to add ACP Streamable HTTP — [Qwen design doc](https://qwenlm.github.io/qwen-code-docs/en/design/daemon-acp-http/README/). Headless supports `-p` and `stream-json`, and stream-json input is "still in development" per the docs' note — [Qwen headless docs](https://qwenlm.github.io/qwen-code-docs/pt-BR/users/features/headless/)

**Amp**
- `--stream-json` emits `system init` (with MCP status and still-running subagents), `user`, `assistant`, `system subagent_finished` and `result` (with `permission_denials`). `--stream-json-input` allows several messages per run; a message sent while busy is queued, and `steer: true` handles it at the next interruption point. `amp threads continue` resumes, and subagents survive process exit — [Amp streaming JSON docs](https://ampcode.com/docs/cli/streaming-json)
- The npm package was renamed to `@ampcode/cli` — [npm](https://registry.npmjs.org/@sourcegraph/amp/latest)

**Aider**
- `--message` and `--message-file` run one instruction and exit. The Python `Coder` API "is not officially supported or documented", and there is no protocol — [Aider scripting](https://aider.chat/docs/scripting.html). Latest PyPI release 0.86.2, 2026-02-12 — [PyPI](https://pypi.org/pypi/aider-chat/json)

### Inferences
- Priority:
  1. **ACP client with registry install**, tested first against Cursor and OpenCode.
  2. **Qwen Code**, which should work at low cost once the client exists.
  3. **Gemini CLI** only as an ACP entry, labelled for paid and enterprise users.
  4. **Amp** native driver only on demand. It resembles machdoch's Claude stream-json driver and has true steering.
  5. **Antigravity** when Google documents ACP or a stable protocol; do not install the unattributed registry binary automatically.
  6. **Aider**: no; a one-shot wrapper would offer no live state.
- ACP coverage is good for sessions, tool calls, permissions and modes on all but Aider. It leaves CLI-specific gaps: Cursor questions and plan approvals are `cursor/*` extensions, so machdoch's question UI needs a small per-agent extension mapping to reach parity. Steering and quota will mostly be missing.
- Security for registry-distributed binaries: pin versions, show the publisher and repository, and warn when no repository is listed, since `antigravity-acp` and `cursor` list none and `amp-acp` is a personal repository.
- ACP agents own their auth and billing, so machdoch's plan-limit display would degrade to `usage_update` for those CLIs. The UI should mark this as limited rather than show empty quota.

### Gaps
- No testing was done, since installing agents and model calls were out of scope. All capability statements come from documentation.
- Official Google documentation for `agy` was not found; the sources are community or forum posts, and the Google status statement comes from a notice on the Gemini docs.
- Cursor's page has no date or version. Amp's pages show no date, and I did not read Amp's SDK reference.
- Qwen's English ACP doc URL returned 404. Its ACP details come from a design doc and a registry entry, and which session methods it supports is unconfirmed.
- OpenCode's reason for the two registry entries (`opencode` and `opencode-v2`) and the npm version gap was not determined.
