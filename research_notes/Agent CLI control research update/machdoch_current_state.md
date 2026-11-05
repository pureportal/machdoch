# machdoch current state: provider CLI and agent control

Read from the working tree on 2026-10-30 at version 37.3.2 (HEAD `f5f09c47`) with uncommitted edits present. Uncommitted items are marked **[uncommitted]** and may change: Claude turn-limit continuation and image input, the adaptive-plan field removal, and the cloud `client` execution target.

Citations are repo-relative `path:line`. Abbreviations:
- `H` = `apps/client/src/core/_helpers`
- `EAP` = `H/external-agent-provider.ts`
- `CL` = `H/claude-interactive-session.ts`
- `CX` = `H/codex-app-server-session.ts`
- `CP` = `H/copilot-server-session.ts`
- `CG` = `H/codex-native-goal.ts`
- `CTRL` = `apps/client/src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts`
- `RPT` = `reports/Agent CLI integration opportunities.md`

## Which recommendations in the earlier report are implemented, partly implemented, or untouched?

### Takeaway
Most of Phase 0 and Phase 1 of the earlier roadmap shipped in 37.2.0 (2026-10-29): a control channel that lives for one turn, on all three CLIs. Nothing in Phase 2 or 3 shipped except a turn-scoped task list and suggestions by a different mechanism. There is no persistent provider session, resume, fork, rewind, native context injection or background work that outlives a turn, so new research should start from those and must not re-recommend the one-turn control channel.

### Cited Findings

**Roadmap status (rows from `RPT:124-142`)**

| Phase | Item | Status | Evidence and what is left |
|---|---|---|---|
| 0 | Usage, context, plan windows from streams | Implemented on live paths | `CL:499-545`, `CL:671-679`, `CL:764-769`; `CX:596-645`; `CP:452-471`, `CP:607-628`; rendered in `packages/client-ui/src/conversation/agent-live-panel.tsx:97-114` |
| 0 | Replace Copilot OTel with `--usage-output-file` | Untouched | OTel exporter still set at `EAP:2561-2574` and overrides usage at `EAP:2813-2822`; no `usage-output-file` match in core |
| 0 | Codex native review | Implemented, narrowly | `review/start` on the app-server rather than `codex exec review` (`CX:331-336`). Target is fixed to `uncommittedChanges` (`EAP:1822-1824`). Triggered only by an exact prompt match (`apps/client/src/tauri/ui/chat-session/_helpers/review-changes.ts:14-15`). No base-branch or commit target, no structured result |
| 0 | Fast toggles | Implemented for Claude and Codex | Claude `--settings {"fastMode":true}` (`EAP:1996-2000`, `EAP:2028`) with disabled-reason notice (`CL:486-496`); Codex `serviceTier: "priority"` (`EAP:1782-1785`, `EAP:1818`). Only on live paths. Copilot has none (`apps/client/src-tauri/src/runtime_snapshot/model_catalog/copilot_cli.rs:44`) |
| 0 | Claude prompt suggestions, read to EOF | Implemented | `initialize.promptSuggestions: true` (`CL:219-223`), event handled at `CL:388-392`. Still bound by the 10-second kill and the one-process transcript gating described in `RPT:86` |
| 0 | Harden Codex goals | Partial | Typed replies to server requests done (`CG:44-73`). `experimentalApi: true` still sent (`CG:108`, also `CX:163`). Question cards not done: goals auto-answer (`CG:49-60`) |
| 0 | Cancel escalation; let the CLI's background wait run; Windows startup-failure results | Partial | Interrupt first, kill after grace: 6 s in the runner (`EAP:928`, `EAP:1320-1338`), 8 s in the UI, second stop kills at once (`apps/client/src/tauri/ui/chat-session/_helpers/graceful-stop.ts:4`, `:13-40`). Startup-failure results set on the live path only (`EAP:2067-2071`). The 10-second post-result kill is unchanged (`EAP:136`, `EAP:1245-1269`); no `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` match |
| 0 | Show Copilot subagent and Claude task events | Implemented | `CP:483-508`; `CL:551-620` |
| 1 | Internal event model shaped like ACP v2, protocol log viewer | Partial | `InteractiveAgentSession` interface (`H/agent-interactive-session.ts:16-25`) and full-snapshot `AgentLiveState` (`packages/fleet-protocol/src/task-thinking.ts:206-226`). It is a snapshot, not an ACP-style lifecycle: there is no `running`/`requires_action`/`idle` state or stop reason field. No ACP code and no protocol log viewer found in `apps/client/src` |
| 1 | Claude control channel for the turn | Mostly implemented | Steer `priority: "next"`, interrupt with `cancel_queued`, question cards, progress summaries (`CL:218-223`, `CL:245-252`, `CL:258-264`, `CL:415-469`). Not done: `--include-partial-messages`, `--forward-subagent-text`, `priority: "now"` (type allows it at `CL:297`, never sent), `set_model`, `perTaskStopAffordance`, elicitation (rejected at `CL:420-426`) |
| 1 | Codex chat on app-server | Implemented | `EAP:1760-1853`, `EAP:1918-1931`, `CX:159-176`. Deltas deliberately opted out (`CX:164-174`). MCP elicitations auto-declined (`CX:387-389`) |
| 1 | Copilot crate upgrade and SDK-driven turns | Partial, by another route | Turns drive `copilot --server --stdio` with hand-written JSON-RPC in TypeScript (`CP:54-84`, `CP:167-170`, `EAP:2152-2248`) rather than the crate. The crate is still pinned at `=1.0.7-preview.2` (`apps/client/src-tauri/Cargo.toml:37`). Exit-plan, auto-mode-switch, elicitation and hooks are off (`CP:320-325`) |
| 1 | "Needs input" state across chat, notifications, fleet | Partial | Sidebar card and composer state (`apps/client/src/tauri/ui/chat-session/components/sessions-sidebar.tsx:664`, `session-composer.tsx:837`); question card reaches the cloud via live state (`packages/client-ui/src/conversation/remote-conversation-host.tsx:337-344`). No notification or dedicated fleet field found |
| 2 | Session supervisor, machdoch-owned homes, idle eviction, resume | Untouched | Session contract is "for the length of one turn" (`H/agent-interactive-session.ts:11-15`); `--no-session-persistence` unconditional (`EAP:2019`); homes live in a temp root (`apps/client/src/core/provider-enrollment/materializer.ts:625`, `:668`, `:723`, `:990`) |
| 2 | Native context injection | Untouched | No `shouldQuery` or `inject_items` match in core; prompts still carry history (`EAP:2584-2589`) |
| 2 | Native branch and edit via fork/truncate | Untouched | No `--fork-session`, `thread/fork`, `session.fork`, `history.truncate` match in core. Branch and edit exist as machdoch fleet commands (`packages/fleet-protocol/src/index.ts:514`, `:1039`, `:1045`) |
| 2 | Background-task tray with three-level stop | Partial | Task list and per-task stop for Claude and Copilot, turn-scoped (`CL:283-293`, `CP:219-226`, panel at `agent-live-panel.tsx:109-110`). Stop-turn and stop-task exist; Codex has no stop-task; background work cannot survive the turn (`CP:644-662`) |
| 2 | Suggestions for all providers | Implemented by the report's weakest option | System-prompt instruction and a trailing `<machdoch-follow-ups>` block stripped from the answer (`H/follow-up-suggestions.ts:11-16`, `:26-47`; `EAP:2469-2476`, `EAP:3273-3299`). `RPT:88` called this the weakest route. The ephemeral fork and `ephemeralQuery` routes are unused |
| 3 | Host tools without MCP sidecars | Untouched | Enrollment still projects MCP config per run (`EAP:2134`, `EAP:2173-2175`) |
| 3 | Generic ACP driver | Untouched | No `acp` match in `apps/client/src/core` |

**Claims in the earlier report that are now out of date**
- "Closes stdin after the prompt" no longer holds on live paths. It still holds on the one-shot paths (`EAP:1994-1995`, `H/agent-cli-inference.ts:187`).
- "Answers every Codex server request with -32601" no longer holds for known methods (`CG:44-73`, `CX:375-393`). Unknown methods still get -32601 (`CX:391`, `CG:71`, `CP:386-388`).
- `--stream=off` and `--no-ask-user` now apply only to Copilot exec runs (`EAP:2284-2287`). The live path uses `streaming: true` (`CP:317`).

**Claims that still hold**
- `--no-session-persistence` (`EAP:2019`).
- The 10-second kill (`EAP:136`).
- The pinned Copilot crate (`apps/client/src-tauri/Cargo.toml:37`).
- Isolated per-run homes (`EAP:1832`, `apps/client/src/core/provider-enrollment/materializer.ts:625`).

**New work that the report did not list**
- Automatic continuation after Claude's `--max-turns` inside the same process **[uncommitted]** (`CL:730-751`, `EAP:2033-2038`, `EAP:1626-1634`).
- Turn-limit stops reported as unfinished rather than failed (`EAP:3079-3088`).
- Steering status tracked per message with resend on failure (`H/agent-live-tracker.ts:205-237`, `agent-live-panel.tsx:91-94`).
- Early steers merged into the opening prompt (`CX:338-352`, `CP:372-381`).

### Inferences
- Do not re-recommend: the one-turn control channel, steer, graceful interrupt, question cards, plan and diff display, task display, usage and limit meters, fast mode, or Codex review as a concept.
- Candidate new recommendations:
  - persistent sessions and resume;
  - fork and rewind;
  - background work past the turn;
  - remote relay of control actions;
  - native context injection;
  - compaction and context control;
  - live text deltas;
  - review on other providers and targets;
  - native rather than prompt-block suggestions.
- By hand-writing the Copilot protocol, machdoch sidesteps crate/CLI skew at build time but moves it to runtime. The only gate is the `--server` probe (`EAP:2334-2339`), and the protocol shape is unchecked against the CLI version. Claude has the same shape: `cancel_queued` and `priority` are sent with no version gate, although `RPT:78` lists minimum versions for them. The only version check seen is for native goals (`EAP:1961-1972`).

### Gaps
- The 17 live tests in `RPT:182-200`: no record of their outcomes in the repo, so which were run is unknown. Unit specs exist for each session (`H/*-session.spec.ts`).
- I did not read the Rust side of the Copilot crate usage beyond the version pin.

## Which live capabilities work on which provider and transport?

### Takeaway
Live control exists only on the three "live session" transports, and only when the run is attended (desktop chat). Native goals, scoped workers, read-only validators and older CLIs fall back to transports with no steering. Resume, fork, rewind and compaction control are absent everywhere.

### Cited Findings

**How a run picks its transport**
- **Claude stream-json:** not a native goal, not a scoped worker, and `--input-format` was probed (`EAP:1994-1995`). Goal evaluators and Ralph blocks also use it, unattended.
- **Claude one-shot `-p`:** native goals, scoped workers, or a CLI without the flag.
- **Codex app-server chat:** full-access, not scoped, not a native goal, and `app-server` was probed (`EAP:1918-1931`).
- **Codex app-server goal:** `CG`, selected at `EAP:1867-1916`.
- **Codex `exec --json`:** scoped workers, read-only validators and generators (`EAP:315-324`), or no app-server (`EAP:1932-1945`).
- **Copilot server:** full-access, not scoped, `--server` probed, and the run-scoped agent file was readable (`EAP:2334-2351`, `EAP:2577-2582`).
- **Copilot exec:** everything else (`EAP:2353-2380`).
- **Attended:** `agentFeatures.liveControl === true` (`EAP:2773-2774`), which only desktop chat submission sets (`apps/client/src/tauri/ui/chat-session/_helpers/use-session-task-submission.ts:562-567`). Unattended runs still publish live state but with empty capabilities and no control endpoint (`CL:196-198`, `CX:138-142`, `CP:150`, `EAP:2791-2796`).

**Capability matrix.** Y = works, P = partial, N = not implemented, A = auto-answered. Cloud access is covered in the next question.

| Capability | Claude stream-json | Claude one-shot | Codex app-server chat | Codex app-server goal | Codex exec | Copilot server | Copilot exec |
|---|---|---|---|---|---|---|---|
| Steer | Y `priority:"next"` `CL:258-264` | N | Y `turn/steer` `CX:206-216`; not on reviews `CX:195-197` | N | N | Y `session.send` immediate `CP:198-204` | N |
| Questions | Y `AskUserQuestion` `CL:415-469`; unattended denied with a message `CL:434-437` | N, no prompt host `EAP:2003-2012`; behaviour untested | Y `requestUserInput` `CX:395-426`, enabled by config `CX:321`; A when unattended `CX:416-420` | A `CG:49-60` | N | Y `userInput.request` `CP:385-417`; A when unattended `CP:398-401` | N `--no-ask-user` `EAP:2287` |
| Plan | Y TodoWrite, TaskCreate/Update `CL:647-664`, `CL:707-724`, env `EAP:2068` | N | Y `turn/plan/updated` `CX:444-457` | N | N | P parsed from `update_todo` args `CP:556-560`, `CP:86-97` | N |
| Subagents | Y `task_started`, summaries `CL:551-575`, `CL:222` | runs, not shown | P display only, `canStop:false` `CX:557-566`; child-thread events filtered `CX:433-435` | runs, not shown | runs, not shown | Y `subagent.*` `CP:483-508`; background via tasks | runs, not shown |
| Background tasks | Y `task_*`, `background_tasks_changed` `CL:550-620` | N | P foreground commands only, `background:false` `CX:541-556`; no `backgroundTerminals` | N | N | Y `session.tasks.list` `CP:563-605` | N |
| Stop task | Y `stop_task` `CL:283-293` | N | N, no handler `CX:148-156` | N | N | Y `session.tasks.cancel` `CP:219-226` | N |
| Usage and limits | Y `rate_limit_event`, context, cost `CL:499-545`, `CL:671-679`, `CL:764-769` | final `result.usage` only `H/external-agent-cli-output.ts:472` | Y `tokenUsage`, `rateLimits` `CX:312`, `CX:464-469`, `CX:596-645` | tokens only `CG:232-258` | final usage `H/external-agent-cli-output.ts:327` | Y `getQuota`, `assistant.usage`, `usage_info` `CP:314`, `CP:452-471`, `CP:607-628` | OTel file `EAP:2813-2822` |
| Follow-up suggestions | native + prompt block `CL:388-392`, `EAP:2469-2476` | prompt block | prompt block | prompt block | prompt block when full-access | prompt block | prompt block |
| Fast mode | Y `EAP:1996-2000`, `EAP:2028` | N, gated on live | Y `EAP:1782-1785`, `EAP:1818` | N | N | N | N |
| Review | prompt only | prompt only | Y `review/start`, uncommitted only `CX:331-336`, `EAP:1822-1824` | N | prompt only | prompt only | prompt only |
| Resume | N `EAP:2019` | N `EAP:2019` | N, ephemeral unless native subagents `EAP:1817` | N, thread kept (`CG:163`) but its home is run-scoped | N `EAP:1661` | N, `session.destroy` at turn end `CP:666` | N |
| Fork | N | N | N | N | N | N | N |
| Rewind / checkpoints | N | N | N | N | N | N | N |
| Compaction control | N | N | N | N | N | N, notice only `CP:518-520` | N |
| Native goals | no, runs one-shot | Y `/goal` as input `EAP:2056` | off `EAP:1794` | Y `thread/goal/set` `CG:170-174` | off `EAP:1673` | none `apps/client/src/shared/goals.ts:32-36` | none |

**Other live-path facts**
- **Control endpoint.** One loopback HTTP server per turn with a per-run bearer token, routes `/v1/steer`, `/v1/interrupt`, `/v1/answer`, `/v1/tasks/stop` (`H/agent-task-control-server.ts:104-171`, `:188`, `:199`). The desktop client sits in `apps/client/src/tauri/ui/agent-control-client.ts:65-74`.
- **Steer fallback.** Steering falls back to the queue when the run lacks the capability, when attachments or prompt enhancement are present, or on send failure (`CTRL:8243-8268`).
- **Live text.**
  - Claude: no `--include-partial-messages`.
  - Codex: deltas opted out (`CX:164-174`).
  - Copilot: ephemeral events dropped before decoding (`CP:439`).
  - Result: text arrives per completed message rather than as a token stream, despite `streaming: true` on Copilot.
- **Provider API runs.** The live schema's provider enum is CLI-only (`packages/fleet-protocol/src/task-thinking.ts:124-128`), so those runs have no live panel or steering.
- **Turn caps.**
  - Default `executorTurns` 64 and `autopilotExecutorIterations` 16 (`apps/client/src/core/runtime-contract.generated.ts:92-93`).
  - Among CLIs, only Claude gets `--max-turns` (`EAP:2032`, `EAP:2050-2052`). Codex and Copilot have no turn cap from machdoch.
  - The Copilot exec path passes `--autopilot` (`EAP:2286`). The server path does not, and treats `assistant.idle` as the end of the turn (`CP:429`).

### Inferences
- With the default limits and the uncommitted continuation, a single Claude live turn can reach about 64 x 17 = 1,088 model turns before stopping, since each `--max-turns` stop gets another prompt up to 16 times (`CL:730-751`, `EAP:1627-1634`).
- `CX:433-435` drops notifications for other thread ids, so Codex sub-agents are likely visible only through items on the parent thread. I did not test this.

### Gaps
- No runtime test here; the matrix comes from code and specs, not live runs (instructions forbade model calls).
- Actual Claude behaviour for `AskUserQuestion` on the one-shot path is not determined by the code (`RPT:186`, test 3).
- Whether the stable-tier or experimental-tier Codex methods are required by what machdoch sends now was not rechecked against the installed schema.

## What own orchestration does machdoch have beyond the CLIs?

### Takeaway
machdoch has a substantial host layer, but all of it treats a provider run as a disposable, restartable step and carries context as prompt text. Ralph is the only system with durable checkpoints and resume; goals persist only a status record.

### Cited Findings

**Goal mode** (`apps/client/src/core/goals/`)
- *Control.* A loop over `execute()` plus an independent evaluator per turn (`apps/client/src/core/goals/run-goal.ts:196-352`).
  - Machdoch mode stops on `complete`, on three consecutive `blocked` verdicts, or after three no-progress turns (`run-goal.ts:306-318`, `:335-343`).
  - Budgets are token, turn and time (`run-goal.ts:72-90`, `:203-206`).
  - The status record is an atomically written file under the user config directory, keyed by workspace and session (`goal-store.ts:26-34`, `:62-70`), and is polled every 250 ms so an external pause aborts the run (`run-goal.ts:91-119`).
- *Limits.*
  - In-run history is an in-memory array (`run-goal.ts:128-130`), capped at 40 messages in prompts (`run-goal.ts:224-227`). Only `reason`, up to 12,000 characters, is persisted (`run-goal.ts:148-152`).
  - The adaptive controller is forced off (`run-goal.ts:228`).
  - The evaluator uses the same provider and model, with evidence of up to 12 x 4k history, 20k response and 10 x 4k sections (`goal-evaluation.ts:46-67`), and has a 5-minute cap (`goal-evaluation.ts:14`).
  - Available on Claude and Codex in native mode; Copilot is Machdoch-mode only (`apps/client/src/shared/goals.ts:32-36`).

**RALPH flows** (`apps/client/src/core/ralph.ts`, `ralph-starter-flows/`)
- *Control.* A graph runner (`ralph.ts:18296`) over prompt, validator, decision, pack, ask-user, interview, utility, MCP tool/resource/prompt, media-flow, group and end blocks (`ralph.ts:910-1015`).
  - Each iteration calls `executeTask` with a typed result protocol (`ralph.ts:4325-4344`, `:4449-4451`, `:4488-4490`).
  - Bounds: per-block `maxIterations` (`ralph.ts:886`), `maxTransitions` and `maxTotalTransitions` (`ralph.ts:1354-1355`), repeated-failure limit 3 (`ralph.ts:369`).
  - An autonomy policy adds recovery, backoff, stagnation and deferral (`ralph.ts:674-686`, `:725-748`).
  - Durable checkpoints with 2-minute leases and heartbeat (`ralph.ts:370`, `:1349`, `:1358-1360`, `:177`), an `abandoned` derived status (`ralph.ts:529`, `:3116`, `:3145`), `waiting-for-input` (`ralph.ts:528`), optional isolated worktree (`ralph.ts:1343`), and `machdoch ralph resume <run-id> (--input-json|--retry-current)` (`apps/client/src/cli/_helpers/cli-help-text.ts:248`).
- *Limits.* No provider session continuity between blocks. `ralph.ts` sets no `agentFeatures`, so block runs are unattended with no steer or question cards; it has its own ask-user and interview blocks instead.

**Parallel agents**
- *Control.* Modes are `disabled`, `read-only`, `machdoch`, and `native` when probed (`apps/client/src/core/parallel-agent-capabilities.ts:8-9`, `:24-34`). The `run_parallel_agents` tool runs 2-3 workers (`H/parallel-agent-sessions.ts:25`, `:30-32`, `:46`) with 8 turns each and a tool-call cap (`H/parallel-agent-worker.ts:22`, `:186`) and explicit write paths (`H/parallel-agent-worker.ts:161`).
- *Limits.* On CLIs a worker is a scoped run with native tools off: Claude `--tools ""` (`EAP:2020-2021`), Codex read-only sandbox (`EAP:1653-1656`), Copilot excluded tools (`EAP:2288-2291`). Scoped workers are never live sessions (`EAP:1995`), so there is no per-worker steer or stop; progress is timeline events only (`apps/client/src/core/agent-runtime.ts:2529-2543`). Native subagents run inside the CLI and machdoch only observes them.

**Adaptive controller**
- *Control.* Regex and length scoring into `simple`, `standard` or `deep` (`apps/client/src/core/adaptive-controller.ts:62-67`, `:100-116`). The profile caps history, memory, lessons and workspace-run characters, picks reasoning if the user left it on default, and sets 2 or 3 workers (`adaptive-controller.ts:26-60`, `:156-164`). Applied at `apps/client/src/core/agent-runtime.ts:2464-2471`. **[uncommitted]** edit removes its executor-turn and autopilot-iteration caps.
- *Limits.* Static heuristic with no feedback from outcomes or token use; decided once per task.

**Reasoning bank**
- *Control.* Workspace-scoped lessons with outcome, confidence, and helpful and harmful counts (`apps/client/src/core/reasoning-bank.ts:18-34`, `:135`), capped at 240 stored and 4 retrieved within 1,600 characters (`reasoning-bank.ts:58-60`). Consolidated by an internal model call after a task (`apps/client/src/core/reasoning-bank-consolidation.ts:280`, `:336`, `:348-349`; `apps/client/src/core/execution.ts:720-727`).
- *Limits.* Reaches providers as prompt text (`H/conversation-prompt-context.ts:600`). Learns only at task end.

**Memory**
- *Control.* Session, workspace and global tiers capped at 24, 64 and 40 entries of 280 characters (`apps/client/src/core/memory.ts:16-18`, `:25`), with retrieval (`apps/client/src/core/memory-retrieval.ts:121`), tools (`H/memory-tool-definitions.ts:210`), and post-task consolidation (`execution.ts:720-727`).
- *Limits.* Injected as prompt text (`H/conversation-prompt-context.ts:509`). CLI native memory is switched off by isolation (`apps/client/src/core/provider-enrollment/instruction-delivery-preflight.ts:183-184`). Goal evaluators run with it disabled (`goal-evaluation.ts:97-100`).

**Scheduler** (`apps/client/src/core/scheduler.ts`)
- *Control.* Cron and interval triggers plus Ralph watches, targeting a prompt or a Ralph flow (`scheduler.ts:199-204`, `:320`, `:417`). Missed-run policies `skip`, `enqueue-latest` (default), `enqueue-all` (`scheduler.ts:96`, `H/split-due-times-by-missed-policy.helper.ts:7`). Concurrency 1, retries 1 (3 for unattended Ralph), 30-second heartbeat, 5-minute abandoned detection, chain depth 25 (`scheduler.ts:102-118`).
- *Limits.* Runs are unattended (no `liveControl`). No use of Claude's host-declared scheduled run (`CLAUDE_CODE_HOST_SCHEDULED_RUN` has no match).

**Fleet commands** (`packages/fleet-protocol/src/index.ts`)
- *Control.* Task `cancel`, `retry`, `continue` (`index.ts:481-485`); many session commands including `submit-message`, `set-goal-mode`, `set-parallel-agent-mode`, `edit-message`, `replay-message`, `branch-session` (`index.ts:514`, `:1039-1051`, `:1144-1149`); running-message action (`composer-contract.ts:91`). Executed by the desktop (`apps/client/src/tauri/ui/chat-session/_helpers/use-fleet-control.ts:1560-1597`, `:1625-1631`).
- *Limits.* No `steer`, `answer` or `stop-task` command kinds. Cloud-executed tasks run `machdoch run --json` with Claude, Codex or the machdoch runtime only, no Copilot (`apps/client/src/core/cloud/native-agent.ts:119`, `:129-147`).

**Instruction system** (`apps/client/src/core/instruction-system/`)
- *Control.* A frozen resolution and delivery plan bound by digest before launch (`EAP:2490-2509`), delivery grades `full`, `compatible`, `unsupported` (`instruction-system/types.ts:259`), per-provider isolated home rendering (`provider-enrollment/materializer.ts:625`, `:668`, `:681`, `:723`), and receipts. After an indeterminate failure, automatic replay is prohibited (`EAP:2857`).
- *Limits.* Isolation is per run, which `RPT:168-172` flags as the main conflict with persistent sessions.

**MCP host** (`apps/client/src/core/mcp/`, `local-mcp/`)
- *Control.* MCP client, config, OAuth, discovery and MCP Apps (`mcp/client.ts`, `mcp/apps.ts`, `mcp/oauth-*.ts`), a local machdoch MCP server (`local-mcp/server.ts:8-10`), workspace run control (`local-mcp/run-control.spec.ts:19-20`), per-run projection into CLIs (`EAP:2134`, `EAP:2209`), and app-result observation (`EAP:2723-2752`).
- *Limits.* Elicitations are declined or not requested (`CX:387-389`, `CP:323`, `CL:420-426`). Still sidecar based.

### Inferences
- Ralph's checkpoint and lease model is the existing precedent for durable long runs. Goals lack it, and a "goal as durable run" design could reuse it rather than start fresh.
- The layers overlap: Machdoch-mode goals, Ralph validators and Claude's own continuation all add looping at different levels, and only some of them see token use.

### Gaps
- I read Ralph by structure and signatures, not line by line (the file exceeds 18,000 lines), so its exact recovery semantics are summarized from type definitions and helper names.
- Exact trigger conditions for memory and reasoning consolidation calls were not traced.

## Are the known limits accurate, and what others exist?

### Takeaway
All four stated limits hold, with useful nuance: remote users can already answer questions and stop the whole task, and "unattended" does not cover Machdoch-mode goals on the desktop. Several further limits were found, most importantly the unchanged 10-second kill and the lack of any live state in native goals.

### Cited Findings

**Stated limits**
1. **Remote steering and stop-task are not relayed: confirmed.**
   - Comment and guard in `packages/client-ui/src/composer/remote-composer.tsx:686-687`, and `CTRL:7151`.
   - No fleet command for them (`packages/fleet-protocol/src/index.ts:481-485`).
   - `AgentLiveRunDetails` receives no `onStopTask` remotely (`packages/client-ui/src/conversation/remote-conversation-host.tsx:338-348`), and the stop button needs it (`agent-live-panel.tsx:109-110`).
   - The endpoint is loopback only and is not part of the persisted trace (`H/agent-task-control-server.ts:188`, `packages/fleet-protocol/src/task-thinking.ts:241-259`).
   - *Nuance:* remote users do see live state and can answer a question, because the next message answers it on the desktop "whether it was typed here or sent from machdoch.cloud" (`CTRL:8196-8229`, `remote-conversation-host.tsx:341-344`). They can also cancel the task and use queue or stop-and-send.
2. **Native goals have no turn cap and are evaluated once per run then paused: confirmed.**
   - Token and turn budgets are rejected (`apps/client/src/core/goals/goal-execution.ts:178-182`).
   - Claude omits `--max-turns` (`EAP:2030-2032`).
   - Codex sets no budget (`CG:170-174`).
   - After one evaluation a non-complete native goal pauses (`run-goal.ts:340-350`), and a single `blocked` verdict is final (`run-goal.ts:308-310`).
   - The `--minutes` limit is host-enforced by abort (`run-goal.ts:72-90`).
3. **Unattended runs auto-answer questions: confirmed, with variation.**
   - Claude denies the tool with a message (`CL:434-437`). Codex and Copilot return `UNATTENDED_ANSWER` as the answer (`CX:416-420`, `CP:398-401`, text at `H/agent-interactive-session.ts:134-135`).
   - Codex and Copilot also avoid offering the tool when unattended (`CX:321`, `CP:319`).
   - *Nuance:* goal turns spread the original `conversationContext` (`run-goal.ts:221-229`), so Machdoch-mode goal turns started from desktop chat stay attended.
4. **`--no-session-persistence` is used for Claude runs: confirmed and unconditional**, including native goals (`EAP:2019`) and inference calls (`H/agent-cli-inference.ts:187`). `CLAUDE_CONFIG_DIR` also points into the run's temp root (`provider-enrollment/materializer.ts:668`, `:695`, `:990`, disposal at `:1132`).

**Other limits found**
- **Background work ends with the turn.** The 10-second grace applies after a terminal result on every provider (`EAP:136`, `EAP:1245-1269`). Claude's stdin closes on `result` and later turns are ignored (`CL:405-407`, `CL:773-775`). Copilot stops background tasks explicitly and says so (`CP:644-662`). The Codex session closes at `turn/completed` (`CX:516-518`).
- **Native goals have no live state or controls.** Claude native is excluded from the live path (`EAP:1995`). Codex native uses a separate decoder without a tracker (`CG:75-102`, `EAP:1012-1014`). Stop means pause plus `turn/interrupt` on Codex (`CG:122-133`) and a process kill on Claude (`EAP:1307-1340`).
- **Native goal context is sent once.** On Claude it goes into the system prompt (`EAP:2458-2468`) with `/goal <objective>` as input (`EAP:2056`).
- **Remote steer path is ambiguous.** Fleet `submit-message` uses `input.runningAction ?? runningTaskMessageAction` (`CTRL:8485-8490`), so a desktop steer preference could apply to a remote message. See Gaps.
- **Multi-part questions answered by chat message collapse.** The same text goes to every item (`apps/client/src/tauri/ui/chat-session/_helpers/session-needs-input.ts:24-28`).
- **Mid-turn model or effort changes do not exist on any provider** (no `set_model`, `apply_flag_settings` or `session.model.switchTo` match in core).
- **Claude elicitation, dialog and hook requests get an error reply** (`CL:420-426`). Copilot exit-plan, auto-mode-switch and elicitation are off (`CP:320-323`), so its rate-limit fallback handshake is unused.
- **No limit-aware pausing.** Rate-limit data only produces limits and notices (`CL:536-544`, `CX:625-645`). Nothing in `goals/` or `ralph.ts` reads it, so a goal does not wait for a window reset.
- **`experimentalApi: true` is still declared** on both Codex paths (`CX:163`, `CG:108`), though `RPT:146` says goals do not need it.

### Inferences
- A native goal's stop on Claude leaves no transcript and no recorded usage, because usage comes from the final `result` (`H/external-agent-cli-output.ts:472`) and persistence is off.
- A question inside a desktop Machdoch-mode goal can stall it until the user returns or the idle timeout fires. This follows from the code paths above; I did not observe it.

### Gaps
- Whether `CTRL:8485-8490` can actually steer from the cloud, given that `CTRL:7151` says a steer preference queues there, was not traced to a conclusion.
- Whether a pending question pauses the idle timeout: the default is 20 minutes (`H/task-execution-timeouts.ts:6`) and the desktop has a `chatIdleTimeoutMinutes` setting (`apps/client/src/tauri/ui/runtime.ts:2688`). I found no code that suspends it during a question, but I did not exhaustively trace activity marking.

## What weaknesses show up in practice?

### Takeaway
Local goal records show long, expensive runs that rarely finish: of 45 records on this machine, 1 is complete, none of the 35 native ones is, and none set a budget. After a crash the host keeps only a status record and the provider's context is gone, because each process is disposable and token accounting counts cache reads at full weight and arrives only at the end of a CLI run.

### Cited Findings

**Local goal records** (`<user config dir>/goals/*.json`, read for numeric fields and fixed system reason strings only)

| Mode, status | n | Median tokens (M) | Median turns | Median elapsed (min) |
|---|---|---|---|---|
| machdoch, active | 3 | 123.9 | 10 | 890 |
| machdoch, blocked | 6 | 63.4 | 5 | 475 |
| machdoch, complete | 1 | 11.1 | 4 | 126 |
| native, active | 13 | 3.9 | 2 | 887 |
| native, blocked | 3 | 79.4 | 2 | 1,214 |
| native, paused | 19 | 92.8 | 1 | 288 |

- Total recorded: about 3,423M tokens across 45 records; the largest is 382.6M. No record has a time, token or turn budget.
- The user's "10M" example is in the lower range; records of 9.8M and 10.3M exist. The goal record does not store a cache-read share, so the "mostly cache reads" claim is not verifiable from it.
- Fixed reason strings:
  - 17 x "The goal could not be verified. Resume to continue." (`run-goal.ts:346-348`)
  - 8 x "A parallel worker failed..."; all 8 records predate the fix commit `11daaaa6` of 2026-10-27, so this may already be resolved
  - 2 x verification timed out, both on 2026-10-30 after native runs of 188M and 330M tokens (`goal-evaluation.ts:14`, `:118`)
- 16 records are `active`, most with an empty reason and long elapsed time. A running goal rewrites its status on every exit path (`run-goal.ts:358-366`, `:409-414`), so most of these are likely leftovers from crashes or kills. Four sit within 886-890 minutes on the same date. The data cannot separate runs still in progress.

**Crash and restart behaviour**
- The desktop marks an unfinished task as crashed on restart (`apps/client/src/tauri/ui/chat-session.model.ts:3645-3652`) and can apply a recovered final result if one exists (`apps/client/src/tauri/ui/chat-session/_helpers/recovered-task-result.ts:22-30`).
- A stale `active` goal is flipped to paused only when a later `/goal` status or mode command takes the run lock (`goal-execution.ts:63-96`). It restarts only by user action, via resume or by re-sending the same objective (`goal-execution.ts:160-168`). I found no automatic goal resume in `apps/client/src/tauri/ui`.
- A restart loses the in-memory turn history (`run-goal.ts:128-130`) and all provider-side context, because of `--no-session-persistence`, the ephemeral flag, and temp homes disposed at the end (`EAP:2019`, `EAP:1817`, `provider-enrollment/materializer.ts:990`, `:1132`).
- `goal.turns` and `tokensUsed` survive, so budgets keep counting.
- Long single runs are the riskiest shape: a Claude native goal or a continued live session accumulates everything in one process (`EAP:2030-2032`, `CL:730-751`).

**Token accounting**
- Anthropic input includes cache creation and cache reads, and `totalTokens` adds them at full weight (`packages/model-runtime/src/providers/stream-events.ts:218-232`). `tokensUsed` and `tokenBudget` use that total (`apps/client/src/core/model-usage.ts:215-218`, `run-goal.ts:61-68`, `:80-88`).
- Claude usage comes from the last `result` (`H/external-agent-cli-output.ts:472`), which `RPT:43` describes as main loop only, excluding subagents.
- Usage reaches the goal only when a CLI run ends; the live counters in `AgentLiveState` do not feed the recorder (`H/agent-live-tracker.ts:90-109`, `run-goal.ts:66-68`). A killed run reports none unless telemetry exists, which is consistent with `active` records showing long elapsed time and near-zero tokens.
- A token budget on a provider without usage pauses the goal (`run-goal.ts:251-262`).

**Fixed extra model calls per goal turn or task**
- One evaluator on the same model (`goal-evaluation.ts:46-67`).
- Memory and reasoning consolidation after the task (`execution.ts:712-732`).
- The follow-up instruction block in the system prompt (`EAP:2469-2476`).
- Default context window `highest` (`EAP:1777`, `EAP:1979-1982`).

### Inferences
- Cache reads probably dominate because each model call re-reads the whole context. 100 calls at 100k context is already 10M counted tokens, so a 10M run does not imply 10M tokens of new work. The billing impact is much lower than the count suggests, and a budget based on this total would trip far earlier than cost would justify.
- Native goals look structurally unlikely to reach `complete` in this data. There is one evaluator pass over truncated evidence after a long run, and no continuation when it says "continue". Resume restarts a fresh CLI process with only history and `goal.reason`, re-paying context. The 0 of 35 result supports this, though the sample includes development and test runs on one machine and I cannot separate Claude from Codex.
- Compaction is invisible to machdoch: no provider compaction event other than a Copilot notice is handled (`CP:518-520`), so a context-growth problem cannot be seen or acted on from goal mode.

### Gaps
- No per-run token breakdown (input, cache read, cache write, output) was examined. Goal records keep only totals, and I did not locate a persisted per-call log, so the cache-read share of the 10M run is unconfirmed by my evidence.
- Crash root causes (sidecar exit, CLI failure, sleep, user kill) cannot be read from goal records. `elapsedMs` may include machine sleep because it is wall-clock (`run-goal.ts:57-60`).
- Goal records do not name the provider, so per-CLI completion rates are unknown.
- UI display of a stale `active` goal after restart was not checked in a running app.
