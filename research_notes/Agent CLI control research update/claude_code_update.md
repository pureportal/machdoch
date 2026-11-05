# Claude Code and Agent SDK: what a host can newly drive (state: 2026-10-30)

Scope note for the report writer. This update extends `research_notes/Agent CLI integration opportunities/claude_code.md` (CLI 2.1.312, SDK 0.3.312) and does not restate it. All web sources were read on 2026-10-30. The CLI changelog has no per-version dates, so its entries are dated by version number only; SDK versions are dated from the npm registry.

Stability tags used below:
- **[doc]**: on code.claude.com.
- **[typed]**: in the published `sdk.d.ts`, but not on the docs site.
- **[internal]**: only in the CLI bundle or SDK runtime, so it can change without notice.
- "min" is the minimum version. "min ?" means none was found.

Nothing here was verified by a model run, because the brief forbids model calls. "Local bundle" evidence comes from the installed `claude.exe` 2.1.312, which is two releases behind the latest. It is not linkable, so it is named instead of linked.

## What changed in the CLI changelog since 2.1.312, and in the SDK since 0.3.312?

### Takeaway
Very little changed for hosts: only 2.1.314 and SDK 0.3.314 carry new content, and most of it is fixes. The bigger gain is older surface the first notes left unexploited (see the sections below). Installed is 2.1.312; latest is 2.1.314.

### Cited Findings
- Versions:
  - Local `claude --version` prints `2.1.312 (Claude Code)`.
  - npm `latest` is SDK 0.3.314, with `claudeCodeVersion` 2.1.314, published 2026-10-30T00:14Z. 0.3.312 was published 2026-10-27. — [npm registry](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/latest)
  - The CLI changelog jumps from 2.1.312 to 2.1.314 with no 2.1.313 section. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  - SDK 0.3.313 is only "parity with v2.1.313", and it does not appear among the last npm publish times, which go 0.3.312 then 0.3.314. — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md); [npm registry](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk)
- SDK 0.3.314 additions: `sandbox_required_unavailable` in `startup_failure_reason`; `permissions.blockWritesOutsideWorkingDirectories` in `Settings`; `prewarm()` (alpha) on the `/core` entry point. — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- The control-request subtypes in the 0.3.314 `sdk.d.ts` match the 0.3.312 list in the first notes; no new public control request was spotted. — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- CLI 2.1.314 entries that matter to a host ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)):
  - **New setting:** `permissions.blockWritesOutsideWorkingDirectories`. Write, Edit and NotebookEdit refuse outside paths in every permission mode.
  - **Startup failures:** `claude -p` no longer exits 0 with no output on a startup failure; it prints the error and exits 1.
  - **`--setting-sources` leak fixed:** an excluded settings file could still supply auto mode rules and saved permission consents. machdoch's isolation depends on this flag.
  - **Local stream-json acknowledgement:** prompts containing tags such as `<bash-stdout>` were not acknowledged to a local stream-json host.
  - **Monitor and hooks:** Bash-matching hooks now run on Monitor's shell commands (they can block or ask, but not approve or rewrite), and hook `if` conditions such as `Monitor(tail *)` match.
  - **PreCompact output:** each hook's output is cut at 10,000 characters, which fixes compaction failing or repeating.
  - **Goal and auto-continue:** "Continue automatically at usage limit" could continue more than three times unprompted when a task restarted itself between waits, including a `/goal` check-in.
  - **Effort caps:** "Invalid effort level" under an admin cap now lowers the effort and retries.
  - **Worktree sandboxing:** sandbox protections did not apply to a worktree entered by `claude -p --resume` or `--continue`.
  - **Memory:** long headless and SDK turns with many subagents use less memory.
  - **Titles:** sessions that start with a skill or prompt command now get an auto-title, and sessions whose first prompt failed no longer stay untitled.
  - **Idle compaction:** added to VS Code and the Desktop Code tab. It also runs for subscribers with telemetry off, and on Bedrock, Vertex, Foundry and gateways once the one-hour cache is on.
- Host-relevant SDK entries the first notes did not list ([SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)):
  - 0.3.311: `ModelUsage.cacheCreationEphemeral5mInputTokens` and `...1hInputTokens`; background start-up work waits for the first model request (about 10 s at most).
  - 0.3.307: `wakeup_source` and `scheduled_for` on the `command_lifecycle` `started` frame (capability `lifecycle_wakeup_source_v1`).
  - 0.3.305: `recommendations` and `fix` on `get_usage` behaviors.
  - 0.3.304: stable row ids in `getContextUsage()`, plus plugin ids, agent and skill file paths and per-server MCP instruction shares when the CLI answers on its own stdio.
  - 0.3.301: `addPlugins` on `reloadPlugins()`, `BUILTIN_TOOL_NAMES`, per-tool MCP `permission_policy`.
  - 0.3.300: `updatedInput` from hook callbacks is now validated and unknown keys are dropped (`canUseTool` is unchanged); `thinking:{type:'disabled'}` runs as adaptive on models that cannot turn it off.
  - 0.3.296: `claude_code_version` in the `initialize` response.
  - 0.3.293: `subagent_type` on `background_tasks_changed` entries.
  - 0.3.292: `agent_id` on subagent messages; typed `ListAgents` result; SendMessage `recipient_kind`.
- `command_lifecycle` appears in the SDK changelog but not in `sdk.d.ts`, so it is effectively [internal]. — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md); [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- `SDKMessage` members the first notes did not catalogue ([sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)):
  - `system/informational {content, level: info|notice|suggestion|warning, tool_use_id, prevent_continuation, tag}`. Docs: a hook's `systemMessage` can arrive as this message. — [hooks](https://code.claude.com/docs/en/hooks)
  - `system/local_command_output` (slash command output).
  - `system/memory_recall {mode, memories[{path, scope, content}]}`.
  - `system/mirror_error`.
  - `system/control_request_progress` (long-running requests).
  - `system/worker_shutting_down {reason}`.
  - `system/elicitation_complete`, `plugin_install`, `auth_status`.
- `system/init.view_mode` (`focus|default`) is on headless per-turn init frames. It reflects `/focus`, which tells the model the user sees only its final message per turn. [typed] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- The `queued_notifications` capability lets a host send inbound `queued_notification` messages, which the CLI drains through the `ReadNotifications` tool. The comment says the cloud session backend reads this capability. [typed] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts); [SDK CHANGELOG 0.3.292](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)

### Inferences
- Upgrading machdoch's pinned CLI to at least 2.1.314 is worthwhile for two fixes alone: the `--setting-sources` leak and the silent exit 0 on startup failure.
- `init.view_mode` should be read: a host that ignores it can render collapsed-turn sessions wrongly.

### Gaps
- No release dates exist for individual CLI versions in the changelog.
- It is unclear why 2.1.313 has no changelog section; the SDK entry only says parity.

## Background work: how does a host start, list, attach to and stop it?

### Takeaway
There are four distinct lifecycles. In-process tasks are controlled over stream-json. Local background sessions go through shell commands. Cloud sessions go through `--cloud` and `--teleport`. Scheduled tasks are session, desktop or cloud scoped. Cloud sessions have a real scriptable send path, but no list API was found.

### Cited Findings
**Local background sessions (research preview per the first notes)**
- `claude --bg` (min 2.1.139) has useful options the first notes missed [doc]:
  - `--bg --exec '<cmd>'` runs a PTY-backed shell job with no model.
  - `--resume <full-uuid> --bg` continues under the same id (min 2.1.257), or starts a copy with a `note:` line. `--continue`, bare `--resume` and name or path forms always copy.
  - `--agent <name> --bg`, `--name`.
  - Where no trust dialog can appear, it fails with `Workspace not trusted`.
  - — [Agent view](https://code.claude.com/docs/en/agent-view); [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Listing: `claude agents --json [--all] [--cwd]` with fields `cwd, kind, startedAt, id, state, pid, status, waitingFor, sessionId, name`. `waitingFor` is one of `permission prompt|input needed|sandbox request|worker request|dialog open`. — [Agent view](https://code.claude.com/docs/en/agent-view)
- Control: `attach`, `logs`, `stop|kill`, `respawn [--all]`, `rm`, plus `rm --discard-unpushed <commit>@<worktree-id>` (min 2.1.260) and `--force-remove-worktree` (min 2.1.268). `claude daemon status|logs|stop` are documented, though `daemon` is not in the 2.1.312 `--help` command list. — [Agent view](https://code.claude.com/docs/en/agent-view); local `claude --help` 2.1.312
- No `claude send` exists. Peek replies and attach are the documented inputs, and dialogs cannot be answered by a peek reply. — [Agent view](https://code.claude.com/docs/en/agent-view)
- Supervisor facts:
  - Idle unattached sessions stop after about an hour.
  - Crashed sessions restart.
  - `CLAUDE_CONFIG_DIR` gives a separate supervisor.
  - `worktree.bgIsolation: none` turns off the worktree move.
  - `CLAUDE_CODE_PROCESS_WRAPPER` or the `processWrapper` setting routes these spawns through a launcher.
  - — [Agent view](https://code.claude.com/docs/en/agent-view); [Docs index](https://code.claude.com/docs/llms.txt)
- `--bg` with `-p` is still rejected, so a background session cannot be embedded over stream-json. — [Agent view](https://code.claude.com/docs/en/agent-view)

**In-session background work (stream-json)**
- `task_type` also has `local_workflow`, with `workflow_name` on `task_started`, so workflows join the task tray. [typed] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- `Stop` and `SubagentStop` hook inputs carry `background_tasks[]` and `session_crons[]`, which let a host distinguish "done" from "paused waiting". [typed] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- `CronCreate` and `CronList` outputs carry `nextFireAt` (0.3.299). [typed] — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- `TaskStop` also accepts a teammate or a named background agent by id or name. `TaskOutput` was removed in 2.1.277; Claude now reads the task's output file with Read. [doc] — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- `PushNotification` (a tool) sends a desktop notification, plus a phone push over Remote Control. [doc] — [Tools reference](https://code.claude.com/docs/en/tools-reference)
- MCP work is not waited for: when a `-p` run ends, MCP tasks continue on the server (resume that session to follow them), and calls moved by automatic backgrounding lose their result. — [Headless](https://code.claude.com/docs/en/headless)
- `--bare` turns off background commands and subagents entirely, and is "recommended for scripted and SDK calls, and will become the default for `-p` in a future release". That future default would disable most of this section. — [Headless](https://code.claude.com/docs/en/headless)
- Bare mode requires an API key or `apiKeyHelper` for Anthropic auth and never reads OAuth. — [Headless](https://code.claude.com/docs/en/headless)

**Cloud sessions and teleport**
- `claude --cloud "<task>"` creates a session (`--remote` is a deprecated alias). `--environment ccpool_...` and `--ref <branch>` target self-hosted runners. [doc] — [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web); [CLI reference](https://code.claude.com/docs/en/cli-reference)
- A scriptable send exists: `claude -p "msg" --cloud <session-id|url> --output-format json` returns `{ok, session_id, url}` or `{ok:false, session_id, error}`. It queues the message and exits. `stream-json` is not supported here. Without `-p` it fails with "not enabled for your account". [doc] — [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
- Pull down: `claude --teleport [id]`, `/teleport`, or `t` in `/tasks`. It needs clean git, the same repo (not a fork), a pushed branch and the same claude.ai account. The terminal gets its own copy. CLI handoff is one-way: a terminal session cannot be pushed to the cloud (only the Desktop app can do that). [doc] — [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
- Limits: no third-party providers; needs a claude.ai login (not an API key) and the org policy `allow_remote_sessions`. — [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
- Reading cloud output from the CLI is not offered: "Find the ID in your session list at claude.ai/code". `/autofix-pr` spawns a session with auto-fix on. — [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
- `worker_shutting_down` tells remote clients why a worker left, but its absence is not a dead-host signal. [typed] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)

**Scheduling**
- Three tiers: cloud, Desktop, and session-scoped (`/loop`, cron tools). Minimum intervals are 1 hour, 1 minute and 1 minute. Only session-scoped needs an open session, and recurring ones expire after 7 days. [doc] — [Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)
- Cloud scheduled tasks (research preview) have an API trigger: POST with a bearer token starts a session and returns its URL. The trigger and token can only be managed on the web. [doc] — [Routines](https://code.claude.com/docs/en/routines)
- The `RemoteTrigger` tool creates, updates, runs and lists cloud scheduled tasks and backs `/schedule`. This closes the first notes' gap: the only programmatic path is through Claude calling the tool. [doc] — [Tools reference](https://code.claude.com/docs/en/tools-reference)

**Prewarming (SDK only)**
- `startup()` returns a `WarmQuery`. `prewarm()` (alpha, min 0.3.282) returns a `SpareProcess`, bound later with `claim()`, for when the working directory is not yet known. — [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- The wire path includes an internal `claim_session` control, named in the 0.3.299 changelog entry. [internal] — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)

### Inferences
- For a local "run in background" button, machdoch can spawn `claude --bg --name X "<prompt>"` and poll `claude agents --json --all`. Output and approvals stay outside its UI, since `--bg` has no stream-json, so an attach terminal would be needed for `blocked` sessions.
- For a cloud button, `--cloud` plus `-p --cloud <id>` gives start and steer, and a claude.ai link gives viewing. That is a thin integration, but a cheap one.
- If `--bare` becomes the `-p` default, machdoch must pass an explicit opt-out or flags. Watch the changelog for this.

### Gaps
- No documented way to list cloud sessions, or to read their transcript, from the CLI.
- No minimum version was found for `--cloud`, `--exec` or the `-p --cloud <id>` send.
- `claim_session` semantics for a raw-CLI host were not verified.

## Multi-agent: subagents, teams, worktree isolation, messaging, and events

### Takeaway
Agent teams are out of reach for machdoch's current spawn: the docs say Claude does not spawn teammates under `-p` or the SDK. The usable multi-agent surfaces in `-p` are named subagents with SendMessage, nested subagents, worktree isolation, dynamic workflows, and cross-session messaging to other live sessions. Events now identify agents directly.

### Cited Findings
**Agent teams**
- Experimental and off by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). "Spawning teammates also requires an interactive session… In non-interactive mode with the `-p` flag, including Agent SDK sessions, Claude doesn't spawn teammates, and a subagent that Claude names runs as an ordinary subagent." [doc] — [Agent teams](https://code.claude.com/docs/en/agent-teams)
- State on disk: `~/.claude/teams/session-<8chars>/config.json`, removed at session end; `~/.claude/tasks/<team>/`, kept; mailboxes at `inboxes/<agent>.json`. Do not edit the config. One team per session, no nesting, and in-process teammates are not restored by `/resume`. — [Agent teams](https://code.claude.com/docs/en/agent-teams)
- Hooks: `TeammateIdle`, `TaskCreated` and `TaskCompleted`; exit 2 keeps working or refuses. Teammates start with the lead's permission mode, except `dontAsk`. A teammate plan is auto-approved unless its mode was changed after spawn. — [Agent teams](https://code.claude.com/docs/en/agent-teams)
- `--teammate-mode` is experimental and hidden from `--help`; `teammateMode` is `auto|tmux|iterm2|in-process`. Split panes are unsupported in Windows Terminal and VS Code's terminal. — [Agent teams](https://code.claude.com/docs/en/agent-teams)

**Subagents (usable in `-p`)**
- Frontmatter and `--agents` fields: `tools, disallowedTools, model, permissionMode, mcpServers, hooks, maxTurns, autoCompactWindow, skills, initialPrompt, memory, effort, background, omitClaudeMd, isolation`. [doc] — [Sub-agents](https://code.claude.com/docs/en/sub-agents)
- `isolation: worktree` gives a temporary worktree, with shell commands forced inside it, cleaned up if unchanged. It branches from the default branch by default, not the parent's HEAD. [doc] — [Sub-agents](https://code.claude.com/docs/en/sub-agents)
- `worktree` settings: `symlinkDirectories`, `sparsePaths`, `baseRef: fresh|head`, `bgIsolation`. The `WorktreeCreate` hook returns `worktreePath` and enables non-git VCS. [typed, doc] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts); [hooks](https://code.claude.com/docs/en/hooks)
- Limits: 20 concurrent subagents by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, min 2.1.217; exempt under ultracode). `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` caps nesting. In `-p`, a spawning subagent waits while fork mode is on, and nested ones go to the background if fork mode is off. [doc] — [Sub-agents](https://code.claude.com/docs/en/sub-agents)
- Forks: `subagent_type: "fork"` is on by default in `-p` and the SDK since 2.1.302; `CLAUDE_CODE_FORK_SUBAGENT=0` turns it off. — [SDK CHANGELOG 0.3.302](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- A subagent that stops at its `maxTurns` returns output marked partial, with a hint to continue through SendMessage. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- `--append-subagent-system-prompt[-file]` is now a documented flag; the first notes listed its initialize field as internal. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- `subagentPromptCacheTtl: 1h` keeps subagent caches longer, at the higher write rate. — [Agent teams](https://code.claude.com/docs/en/agent-teams)
- `SubagentHandback` exists only in auto mode (min 2.1.271): the classifier reviews a subagent's final report before delivery. — [Tools reference](https://code.claude.com/docs/en/tools-reference)

**Events and reading state**
- Identification fields [typed], from the [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md):
  - `agent_id` on subagent `assistant` and `user` messages (0.3.292), equal to the task's `task_id` and stable across resume.
  - `parent_task_id` and `run_id` (0.3.292).
  - `subagent_type` on `background_tasks_changed` (0.3.293).
  - Typed `ListAgents` `tool_use_result` with `sections` and `notes` (0.3.292).
  - SendMessage `recipient_kind` (0.3.292).
- Library helpers (SDK only): `listSubagents(sessionId)` and `getSubagentMessages(sessionId, agentId)`. — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)

**Cross-session messaging (separate, live sessions)**
- Tools are `ListAgents` and `SendMessage`, on by default (min 2.1.224 on macOS and Linux, 2.1.234 on native Windows). `notify_when_idle` asks for one notice (min 2.1.236, 12-hour expiry). [doc] — [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- A `-p` session binds an inbox socket too, so a long-running `-p` worker can receive messages and is listed. `--bare` does not bind one. On Windows the inbox is a named pipe. [doc] — [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- Host injection path: the session exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash. Native Windows requires a first line of `{"type":"auth","token":"..."}`, and connections idle for 30 s without a complete line are closed. [doc] — [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- Inbound rules:
  - `crossSessionInbound: accept|hold|refuse`.
  - Default: a session that bypasses permissions holds each message unless the sender also bypasses, for `dialogExpiry` (5 minutes in `-p`, then dropped).
  - `isolatePeerMachines: true` requires approval for off-machine sends, even in bypass.
  - Messages are plain text, about 1 M characters at most, with a 50-message queue.
  - To let a worker accept unattended: `crossSessionInbound: accept` in `--settings`.
  - — [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- `CLAUDE_CODE_TASK_LIST_ID` shares one task list across sessions. [doc] — [Env vars](https://code.claude.com/docs/en/env-vars)

**Dynamic workflows (min ?; size setting at 2.1.202, so older)**
- Claude writes a JS script, using `agent()`, `pipeline()`, `parallel()`, `phase()`, `log()`, `args`, and the runtime executes it in the background. Limits: 16 concurrent agents by default (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, 1 to 256, min 2.1.269), 4,096 items per call, 1,000 agents per run. No mid-run user input. [doc] — [Workflows](https://code.claude.com/docs/en/workflows)
- In `-p` and the SDK, the `Workflow` tool goes through normal permissions: allow rule `Workflow` or `Workflow(<name>)`, auto mode, bypass, a PreToolUse `allow`, or the host's `canUseTool`. In plan mode a hook's allow is not enough. [doc] — [Workflows](https://code.claude.com/docs/en/workflows)
- The `ultracode` keyword only triggers for input with `origin: {kind:"human"}`, never from a prompt passed with `-p`. `--effort ultracode` or setting `ultracode` turns it on per session, removes the concurrency limit and raises token use. [doc] — [Workflows](https://code.claude.com/docs/en/workflows)
- Usage-limit pausing does not happen in `-p` or the SDK: the affected agent fails. A workflow does not continue after a session exit on its own; it needs a `Workflow` relaunch, which replays saved results. [doc] — [Workflows](https://code.claude.com/docs/en/workflows)

### Inferences
- machdoch's stream-json host can render a subagent tree from `agent_id`, `parent_task_id` and `spawn_depth` without any team support. With stamped `origin:{kind:"human"}` messages it can also honour `ultracode`.
- An approval answer for `Workflow` could show the planned phases, if machdoch reads the tool input. The Desktop app does this.
- Since teams are unavailable in `-p`, a "team" feature in machdoch would mean several stream-json processes linked by cross-session messaging (`crossSessionInbound: accept`), not native teams.
- A `-p` process under machdoch with `bypassPermissions` will hold peer messages for 5 minutes and then drop them, unless it sets `crossSessionInbound`.

### Gaps
- The line format for posting to the inbox socket, beyond the auth line, was not found in the docs.
- Worktree enter or exit events in the stream were not found; the `WorktreeCreate` hook is the documented signal.
- Whether a workflow's agents emit `task_progress` with per-phase data was not confirmed.

## Session control: resume, fork, rewind, compaction, context, titles, stores

### Takeaway
The first notes cover the building blocks. New items are: a host-side store that is SDK-only, compaction control through hooks and settings, deferred tool resume for out-of-process answers, and clear signals that `rewind_conversation` is real but still internal.

### Cited Findings
- **Deferred tool flow (`defer`)** [doc], unexploited by the first notes. A PreToolUse hook returns `permissionDecision:"defer"`. The turn ends with `stop_reason:"tool_deferred"` and `deferred_tool_use {id,name,input}`. The host later runs `claude -p --resume <id>` with the same permission host, and the hook answers `allow` with `updatedInput`. It has no timeout, works only with a single tool call in the turn (it is ignored with a warning for batches), honours only `-p`, and a missing tool gives `tool_deferred_unavailable`. — [hooks](https://code.claude.com/docs/en/hooks)
- **Resume-time env:** `CLAUDE_CODE_RESUME_PROMPT` overrides the continuation text (default "Continue from where you left off."). [doc] — [Env vars](https://code.claude.com/docs/en/env-vars)
- **`rewind_conversation`:** still not in the public union. The SDK changelog mentions it with `interrupt_if_running` and a `prefillText` answer (0.3.299, 0.3.300), so hosts use it, but it is [internal]. — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- **Interactive rewind actions:** the `/rewind` menu has Restore code and conversation, Restore conversation, Restore code, Summarize from here, and Summarize up to here. No public control request for the summarize actions was found. — [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- **Session store** (alpha, SDK 0.2.113+):
  - `append(key, entries)` is called after the local write, about every 100 ms; `uuid` is the idempotency key; three attempts, then `mirror_error`.
  - `load(key)` runs in the SDK parent and materializes a temp JSONL for the subprocess to resume.
  - Optional methods are `listSessions`, `listSessionSummaries`, `delete` and subkey listing.
  - Reference adapters exist for S3, Redis and Postgres, with a conformance suite.
  - — [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage); [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- **Other SDK helpers:** `deleteSession`, `importSessionToStore`, `foldSessionSummary`, `getSubagentMessages`, `listSubagents`. — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- **`claude purge [path]`** deletes a project's transcripts, tasks, file history and its `~/.claude.json` entry from this machine. — local `claude --help` 2.1.312
- **Compaction control** [doc]:
  - PreCompact blocks with exit 2 or `decision:"block"`. A proactive auto-compact is then skipped. If the compaction was recovering from a context-limit error, the request fails. Input is `trigger` and `custom_instructions`. — [hooks](https://code.claude.com/docs/en/hooks)
  - PostCompact input includes `compact_summary`. — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
  - `/compact <focus>` takes focus instructions (works in cloud too). — [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
  - Tuning: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100k to 1M; suffixes min 2.1.304), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (can only lower), `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, per-subagent `autoCompactWindow` (min 2.1.296). — [Env vars](https://code.claude.com/docs/en/env-vars)
  - Idle compaction (terminal, min ~2.1.290): a 200K+ conversation idle for about 54 minutes compacts before the one-hour cache expires. `idleCompaction:false` and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` control it. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- **Compaction and resume fixes:** resuming a headless or SDK session could lose kept messages or its summary, or bring back old history (fixed for "compactions from this version on"). — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- **Transcript ordering fix:** `claude -p` and SDK sessions saved messages out of order, or kept messages that were taken back. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- **Titles:**
  - `title` initialize field and `rename_session` control (public).
  - `sessionTitle` from `SessionStart` (on startup, resume, fork) and from `UserPromptSubmit` hooks.
  - Hook input includes `session_title`, so a hook can avoid overwriting.
  - `generate_session_title` is [internal].
  - — [hooks](https://code.claude.com/docs/en/hooks); first notes
- **Context:** `getContextUsage()` rows now have stable ids (0.3.304). `prompt_id` is in hook input and status line JSON, which links events to one prompt. — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md); [hooks](https://code.claude.com/docs/en/hooks)
- **SIGTERM:** the turn is left unfinished and no result is recorded; send SIGINT or `interrupt` first. Closing input through the SDK cancels pending prompts. — [Headless](https://code.claude.com/docs/en/headless)

### Inferences
- `defer` is an alternative to a live `can_use_tool` wait when a question could sit for hours. It frees the process, and the session waits on disk.
- machdoch's Rust host cannot use `SessionStore`, since it runs in the SDK parent. Its equivalent is to tail the JSONL and resume from a transcript path, as the first notes describe.
- A PreCompact hook that adds machdoch-owned state, plus PostCompact's `compact_summary`, is a cheap way to show the user what the summary kept.

### Gaps
- No documented public control request for conversation rewind or for summarize-from-here was found.
- It is not stated whether idle compaction runs in a long-lived `-p` or stream-json process. The changelog only names the terminal, VS Code and Desktop.

## Hooks: events, handler types, and what a host can do

### Takeaway
Hooks are the most capable documented policy layer. A host can inject them per session through `--settings` (or `initialize.hooks` for callbacks), use HTTP handlers against a local server, and fail closed with `onFailure:"block"`. Blocking `Stop` works, but is bounded by a block cap.

### Cited Findings
- **Full event list (33 in 0.3.314):** `PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay`. — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- **Can block:** UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolBatch (stops the loop), SubagentStop, TaskCreated, TaskCompleted, Stop, TeammateIdle, ConfigChange (except policy), WorktreeCreate, PreCompact, PreModelSwitch, Elicitation, ElicitationResult. PermissionRequest decides through its `decision` object, and exit 2 is ignored. — [hooks](https://code.claude.com/docs/en/hooks)
- **Handler types** [doc] ([hooks](https://code.claude.com/docs/en/hooks)):
  - `command`: `command`, `args`, `async`, `asyncRewake`, `shell: bash|powershell`, `onFailure`.
  - `http`: `url`, `headers`, `allowedEnvVars`. A non-2xx response or connection failure is non-blocking unless `onFailure:"block"`. Settings `allowedHttpHookUrls` and `httpHookAllowedEnvVars` restrict it.
  - `mcp_tool`: `server`, `tool`, `input`. Not available for `SessionStart` at launch or any `Setup`.
  - `prompt`: `prompt` (use `$ARGUMENTS` for input), `model`. 30 s default.
  - `agent`: experimental, 60 s.
  - Common fields: `if` (permission-rule syntax, tool events only), `timeout`, `statusMessage`, `once` (skill frontmatter only).
  - Default command timeout is 600 s, or 30 s on `UserPromptSubmit`, `PreModelSwitch` and `PostModelSwitch`, and 10 s on `MessageDisplay`.
- **`onFailure:"block"`** (command and http, min 2.1.295) makes a failure act like exit 2. It has no effect on Stop, SubagentStop, TaskCompleted, TeammateIdle or async hooks. — [hooks](https://code.claude.com/docs/en/hooks)
- **Concurrency:** prompt and agent hooks run at most 24 at a time per session, and at most 12 of one event. — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- **What a host can do:**
  - **Policy:** `permissionDecision: allow|deny|ask|defer` (precedence deny > defer > ask > allow); `updatedInput`; PostToolUse `updatedToolOutput`; PermissionDenied `retry:true`.
  - **Inject context:** `additionalContext` (10,000 characters per string; overflow goes to a file with a 2,000-character preview); SessionStart `initialUserMessage`, which becomes the first turn in `-p`.
  - **Audit:** `--include-hook-events`; common input `session_id, prompt_id, transcript_path, cwd, scratchpad_dir (min 2.1.257), permission_mode, effort, agent_id, agent_type`.
  - **Display:** MessageDisplay `displayContent` replaces only on-screen text. `terminalSequence` is ignored in `-p` and the SDK.
  - **File watches:** SessionStart `watchPaths` drive `FileChanged`.
  - **Wake on background failure:** `asyncRewake` exit 2 wakes Claude.
  - — [hooks](https://code.claude.com/docs/en/hooks)
- **Blocking Stop to continue work:** `decision:"block"` with `reason`, or `hookSpecificOutput.additionalContext` for non-error feedback. Input gives `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. — [hooks](https://code.claude.com/docs/en/hooks); [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- **Block cap:** the cap is 8 consecutive blocks with no tool call in between, then the override fires. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` changes it; `0` disables it. — [hooks guide](https://code.claude.com/docs/en/hooks-guide); [Env vars](https://code.claude.com/docs/en/env-vars)
- **Exit 1 is not a block:** exit 1 without valid JSON is non-blocking; use exit 2. — [hooks](https://code.claude.com/docs/en/hooks)
- **Trust trap:** without `--bare`, a `-p` session runs hooks from a project's `.claude/settings.json` and connects its `.mcp.json`, even in an untrusted folder, with no dialog. — [Headless](https://code.claude.com/docs/en/headless)
- **`--restricted`:** removes code-running tools and WebFetch unless `--tools` names them, ignores user, project and local settings, refuses bypass, and lets only a person or the permission handler approve writes to settings, git and tool-config files. — local `claude --help` 2.1.312

### Inferences
- A clean host policy layer: `--setting-sources ""` plus `--settings '{"hooks":{...}}'` with HTTP hooks to a localhost port machdoch owns, and `onFailure:"block"` on PreToolUse. This is process-independent and needs no control-protocol changes. Whether `--settings` hooks fire under `--setting-sources ""` should be tested; the first notes left the analogous fastMode question open too.
- Prefer `initialize.hooks` callbacks over HTTP when the host already runs the control channel. It avoids a port and the `allowedHttpHookUrls` question.
- `additionalContext` on PostToolUse is a better route than user messages for feeding host-computed facts (diagnostics, test status) into a turn.

### Gaps
- Wire examples for `hook_callback` responses per event were not re-verified against this version.
- The `allowedEnvVars` behavior for Windows variable syntax was not checked.

## Structured output, budgets, fallback, effort, partial messages, permission modes, plan handoff

### Takeaway
Most of this is already in the first notes. The new points are the different reset behavior of turn and budget limits, the full `terminal_reason` list, and new auto mode settings. Plan handoff in a host is still undocumented.

### Cited Findings
- **Limits behave differently:**
  - `--max-turns` resets when the run takes another prompt ("the turn count resets"). With stream-json input, a message still queued when the limit ends a turn "stays queued and starts a new turn with its own limit". — [Mods API](https://code.claude.com/docs/en/plugins/mods/api); [CLI reference](https://code.claude.com/docs/en/cli-reference)
  - `--max-budget-usd` applies to the run's total cost and "keeps adding up when the run takes another prompt, so a retry returns the same reason". Reaching it also stops remaining background work. — [Mods API](https://code.claude.com/docs/en/plugins/mods/api); [Headless](https://code.claude.com/docs/en/headless)
- **`terminal_reason` values** [typed]: `blocking_limit, rapid_refill_breaker, prompt_too_long, image_error, model_error, api_error, malformed_tool_use_exhausted, aborted_streaming, aborted_tools, stop_hook_prevented, hook_stopped, tool_deferred, max_turns, background_requested, completed, budget_exhausted, structured_output_retry_exhausted, tool_deferred_unavailable, turn_setup_failed`. — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- **`SDKStartupFailureReason`** now includes `sandbox_required_unavailable`. `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` remains the way to get these as results. — [SDK CHANGELOG 0.3.314](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md); first notes
- **Structured output:** workflow agents retry five times, and `MAX_STRUCTURED_OUTPUT_RETRIES` changes the count. Refused responses no longer deliver `structured_output` (0.3.302). A dropped connection after delivery no longer gives `is_error:true` on a `success` result. — [Workflows](https://code.claude.com/docs/en/workflows); [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- **Task budget:** `taskBudget {total}` (alpha) tells the model its remaining tokens so it can pace itself. — [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- **Fallback:** `model_refusal_fallback` carries a `scope`: `session` swaps the session's model persistently, and `local` means only that subagent or side-question response came from the fallback. — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- **Advisor:** `--advisor <model>` enables the server-side advisor tool; `advisorModel` is the setting. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Effort and thinking:** `/effort ultracode` keeps the session's effort since 2.1.284 (it used to set `xhigh`), while `claude --effort ultracode` also sets `xhigh`. `setMaxThinkingTokens(n, display)` accepts `summarized|omitted|highlights`. — [Workflows](https://code.claude.com/docs/en/workflows); [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- **Partial messages:** closing `message_stop` fixes landed in 0.3.287 and 0.3.290. A WebFetch or WebSearch stepping aside for priority `now` gives `tool_use_result: {detachedToolCall:true}`, with the result in a later turn. — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- **Auto mode:**
  - New `Settings`: `autoMode`, `skipAutoPermissionPrompt`, `useAutoModeDuringPlan`, `permissions.disableAutoMode` (0.3.312).
  - `claude auto-mode` subcommand inspects or resets classifier configuration.
  - Classifier request charges have their own docs page.
  - In `-p` with no mode set, `default` applies. The docs say this applies generally; the changelog scopes it to third-party providers, telemetry off or a fresh install.
  - — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md); local `claude --help` 2.1.312; [Docs index](https://code.claude.com/docs/llms.txt); [Permission modes](https://code.claude.com/docs/en/permission-modes); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- **Interactive plan approval:** the options are use auto mode (or auto-accept edits, or bypass), manually approve edits, or keep planning; approval switches the mode. `/plan` as a prompt prefix re-enters plan mode. — [Permission modes](https://code.claude.com/docs/en/permission-modes)
- **Plan and mods:** a mod's `tool.check` can tighten but not loosen in plan mode, and `decider:"person"` restricts approval to the dialog or a host callback. — [Mod events](https://code.claude.com/docs/en/plugins/mods/events); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

### Inferences
- For plan handoff a host would: answer `can_use_tool` for `ExitPlanMode` with allow (optionally editing `plan` through `updatedInput`), send `set_permission_mode` to the chosen mode, then send the next message. This mirrors the interactive options, but the docs do not spell it out.
- `terminal_reason` is a better switch than `subtype` for UI messages, because `completed` is distinct from `stop_hook_prevented`, `hook_stopped` and `background_requested`.

### Gaps
- The documented host-side sequence for ExitPlanMode approval is still missing (open since the first notes).
- `rapid_refill_breaker` and `blocking_limit` have no description in the types.

## Goals: how `/goal` ends, its evaluator, reading state, and failure modes

### Takeaway
`/goal` is a session-scoped prompt Stop hook evaluated by the small fast model after each turn. machdoch's `error_max_turns` is expected behavior: the bundle checks `--max-turns` when the Stop hook blocks, and goal iterations share one prompt's turn count. The state event `active_goal` is typed, but in the local 2.1.312 bundle its stdout path was found only behind `CLAUDE_CODE_REMOTE`, so a local host may never see it.

### Cited Findings
**How it ends** — [Goal](https://code.claude.com/docs/en/goal)
- **Met:** the goal clears and an achieved entry is recorded.
- **Impossible:** the goal clears and a failed entry is recorded.
- **Unrecoverable error** (auth failure when self-managed, exhausted credit, context overflow that compaction cannot clear, unavailable model): the goal clears with a warning that starts `Goal cleared after an unrecoverable error`.
- **`/goal clear`:** aliases are `stop, off, reset, none, cancel`. `/clear` also removes it.
- **No-progress stop:** no tool use for several turns ends the loop with a warning, and the goal stays set, resuming on the next prompt.
- **Bounding it:** the condition limit is 4,000 characters, and the docs suggest a clause such as `or stop after 20 turns`, which the evaluator judges from the conversation.

**Evaluator** — [Goal](https://code.claude.com/docs/en/goal)
- It receives the condition and the conversation, runs on the small fast model (changed through `ANTHROPIC_DEFAULT_HAIKU_MODEL`, which also moves title generation and other background tasks), and calls no tools. It can only judge what Claude surfaced.
- It is skipped while a subagent or background shell runs. Check-ins start at 30 minutes, then 1 hour, then every 2 hours (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`, min 2.1.234). In `-p`, check-ins are delivered only at turn end, and automatic retries are described only for interactive sessions (min 2.1.269).
- Unavailable under `disableAllHooks` or `allowManagedHooksOnly`, and it follows the workspace trust rule for hooks.
- On resume the condition is restored, but the turn count, timer and token baseline reset.

**Reading state**
- `/goal` with no argument returns condition, duration, turns evaluated, token spend and last reason. Sent as a prompt, its output should appear as slash-command output. [doc] — [Goal](https://code.claude.com/docs/en/goal)
- `active_goal {value:{condition, iterations, set_at, tokens_at_start, last_reason}|null}` is emitted "when the user's /goal Stop hook reports met (clears) or not-yet-met (bumps iterations + last_reason)". It sits in `StdoutMessage`, not in `SDKMessage`. [typed] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- It is not on the TS reference page. — [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Local bundle 2.1.312 [internal]: the query loop yields `active_goal`, but the one site found that queues it for stream output sits inside `if(i.CLAUDE_CODE_REMOTE){...}`. The other sites read it on remote clients.
- Local bundle 2.1.312 [internal]: a transcript attachment `goal_status {met, failed, condition, reason, iterations, durationMs, tokens}` is written. The issue reporter below read the Stop hook's fire counts from the session's JSONL, which fits. — [Issue #101528](https://github.com/anthropics/claude-code/issues/101528)
- Local bundle 2.1.312 [internal]: on achievement, `sessionState.notifyMetadataChanged({goal:{...}})` is called.

**`error_max_turns` mechanism** (local bundle 2.1.312, [internal])
- In the Stop-hook branch: `let oe=tn+1; ... if(P&&oe>P) return ... yield {type:"max_turns_reached",maxTurns:P,turnCount:oe} ... {reason:"max_turns",turnCount:oe}`. This check comes before the block-cap check, and no goal-clearing call is visible in that branch.
- A third-party port of `/goal` describes the same order and says the goal is kept, though that is a secondary source. — [letrquan/book PR #414](https://github.com/letrquan/book/pull/414)
- machdoch passes `--max-turns` (`apps/client/src/core/_helpers/external-agent-provider.ts:2051`) and treats `error_max_turns` as resumable by sending `TURN_LIMIT_CONTINUE_PROMPT` when `turnLimitContinuations` allows (`apps/client/src/core/_helpers/claude-interactive-session.ts:730`). The default limit there is 0, so a goal run with no continuations configured ends at `error_max_turns`.

**Block cap on goals** (local bundle 2.1.312, [internal])
- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP??8`, with `Me>tt` as the test, so it fires on the ninth block; the issue quotes "9 consecutive times". After the warning the branch returns `{reason:"completed", goalPass:...}`.

**Known failure modes**
- [Issue #101528](https://github.com/anthropics/claude-code/issues/101528), opened 2026-10-12, open with no maintainer response, reported on 2.1.293 and reproduced on 2.1.308 on Windows 11:
  - A `/goal` kept re-prompting after the user said stop: the Stop hook fired 74 times and blocked 73.
  - In 55 blocks the evaluator's reason quoted the user's stop messages and still ruled "not met".
  - The cap fired 3 times, and each time the loop restarted on the next user message.
  - The cap notice appeared only in the UI, not in Claude's context.
  - Setting `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0` from inside the session did not stop it.
  - The agent cannot clear the goal itself. A user workaround is `/goal Reply once to me`.
  - A commenter reports `/goal` with no argument printing "No goal set" in a run where the Stop hook was active.
- Fixed in earlier versions (all in [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)):
  - Silent stall after API errors, now retry or pause.
  - Goal lost on resume after compaction.
  - "Prompt is too long" in hook-driven sessions after a reactive compaction.
  - Evaluator firing during background work.
  - Silent hang under `disableAllHooks`.

### Inferences
- A turn limit is a poor bound for goals, because the count covers model round trips across all iterations of one prompt. Options for machdoch:
  1. For goal sessions, do not pass `--max-turns`. Since it is a process flag, this needs a decision at spawn.
  2. Keep it and treat `error_max_turns` with an active goal as a checkpoint: send a continuation with `turnLimitContinuations:null` (no cap), and bound the goal through `--max-budget-usd` or a turn clause in the condition.
- When the block cap fires, the result will probably look successful (`reason:"completed"`), so `result` alone cannot tell a host that the goal was finished. It should also watch `system/informational` warnings and re-query `/goal`.
- Reading state from `active_goal` should be opportunistic. Handle it if it arrives (parsers must not reject the unknown type), and fall back on `/goal` status plus transcript `goal_status` attachments. Setting `CLAUDE_CODE_REMOTE` to obtain it would be unsafe, since that variable changes other behavior.
- Because `-p` has no idle check-ins, a goal parked on background work in a long-lived stream-json process stays silent until that work ends or a turn ends. machdoch's UI should show "waiting on background work".
- A host-owned goal is a realistic alternative: its own `Stop` hook callback can use `stop_hook_active`, `last_assistant_message` and `background_tasks`, run real checks (tests, git status) instead of judging the transcript, honor a user stop, and raise the block cap. That avoids the #101528 failure, which is about an evaluator with no tools.

### Gaps
- Whether `active_goal` reaches stdout in a local `-p` stream-json run was not tested, because model calls were out of scope. A short test is the single most useful follow-up.
- The bundle reading covers 2.1.312, not 2.1.314.
- Whether `goal_status` reaches stream-json as any message was not determined.
- Whether `/goal` under `--bare` works was not determined. `--bare` skips settings and plugin hooks but says built-in features are unaffected.
- The issue's "No goal set" comment conflicts with the docs' achieved-condition status; the cause is unknown.

## Plugins, skills, MCP elicitation, MCP Tasks, channels, output styles, status lines, new extension points

### Takeaway
The largest new extension point is mods (min 2.1.287): JS hooks shipped in plugins that run in `-p` and SDK sessions without UI. MCP gained server-run tasks and URL-mode elicitation, but `-p` hosts get much less of them. Channels and status lines remain mostly interactive.

### Cited Findings
**Mods** [doc, min 2.1.287] — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); [Mods API](https://code.claude.com/docs/en/plugins/mods/api); [Mod events](https://code.claude.com/docs/en/plugins/mods/events)
- Events include `session.start`, `turn.start`, `turn.complete`, `command.run`, `tool.call`, `tool.check`, `prompt.submit`, `session.receive`, `session.send`, `agent.spawn`, `model.complete`, `session.append`, `skill.prompt`, `ui.notify`.
- API namespaces: `$.command`, `$.tool`, `$.model` (`complete`, `fork`), `$.clock`, `$.ui`, `$.prompt.submit`, `$.agent.spawn`, `$.session` (`send`, `messages`, `usage`), `$.fs`, `$.process`, `$.http`, `$.store`, `$.env`, `$.settings`, `$.mcp`.
- Mods in `claude -p`:
  - `$.ui.ask` rejects (nobody to ask) and `$.ui.notify` returns `no-surface`.
  - Calls are refused with reasons such as `the run reached its --max-turns limit`, `the run is past its --max-budget-usd limit` and `the host has ended its input`.
  - A mod that submits a prompt per turn keeps a run alive unless a limit is set.
- `$.model.fork` reuses the cached conversation for a side request. `$.session.usage()` returns context window use and plan limits.
- Mods run in-process, so a host can add a typed tool plus guard logic without running an MCP server, shipped with `--plugin-dir`. — [CLI reference](https://code.claude.com/docs/en/cli-reference)

**Plugins** — [TS sdk.d.ts](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts); [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- `pluginDelivery:'initialize'` sends the list over stdin with `--await-initialize` (min 2.1.261), and avoids the Windows 32,767-character command line limit. `plugins_applied` confirms loading.
- `reload_plugins` with `addPlugins` loads folders at runtime (0.3.301).
- `--plugin-url` fetches a zip. A `workflows/` directory ships workflows, namespaced by plugin. — [Workflows](https://code.claude.com/docs/en/workflows)
- `claude plugin eval` and the plugin evals page cover testing. — [Docs index](https://code.claude.com/docs/llms.txt)

**MCP**
- **MCP tasks** (server-run long jobs, using the MCP tasks extension) [doc] — [MCP](https://code.claude.com/docs/en/mcp):
  - The call returns once accepted. Claude Code polls `tasks/get` (default 2,000 ms, clamped to 250 to 30,000, per `pollIntervalMs`).
  - `input_required` is answered with `tasks/update`, at most 16 keys per task. `tasks/cancel` is sent on stop, but not on exit. `tasks/result`, `tasks/list` and `notifications/tasks` are not used.
  - **In non-interactive sessions a task requesting input is cancelled, without `Elicitation` hooks or `onElicitation`.**
  - `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND=1` makes Claude wait (min 2.1.304, interactive only as described).
- **Elicitation:** URL mode on the 2025-11-25 and 2026-07-28 protocols. `bareElicitationCapability: true` is an escape hatch for servers that stop connecting. `property_order` preserves form order (0.3.299). — [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- **MCP Apps** (SEP-1865):
  - Tool `_meta.ui` carries `resourceUri` and `visibility`.
  - `mcp_read_resource` reads `ui://` resources for a host to render.
  - `mcp_call` has a "not for model" result mode for host-driven calls. [typed] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
  - Size caps differ for these tools (0.3.295). — [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- **Protocol runtime:** on revision 2026-07-28, `list_changed` arrives over a held-open stream, and channel servers cannot deliver on that revision. `MCP_PROTOCOL_NEGOTIATION=legacy` keeps every server on the older handshake. — [MCP](https://code.claude.com/docs/en/mcp)

**Channels** (research preview, min 2.1.80; permission relay min 2.1.81) — [Channels reference](https://code.claude.com/docs/en/channels-reference); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Server declares `experimental['claude/channel']` and emits `notifications/claude/channel`. `claude/channel/permission` relays approvals.
- `--channels` uses an allowlist; `--dangerously-load-development-channels` is for development.

**Skills, styles, status line**
- `initialize.skills`, `reloadSkills()`, and SessionStart `reloadSkills:true` make skills a hook installs usable in the same session. — [hooks](https://code.claude.com/docs/en/hooks); first notes
- `outputStyle` setting, with `reload_output_styles`. No change found. — [Output styles](https://code.claude.com/docs/en/output-styles)
- Status line JSON now includes `session_name`, `prompt_id`, `workspace.git_worktree`, and a `current_usage` breakdown. It is for interactive sessions only. — [Status line](https://code.claude.com/docs/en/statusline)

**Other new surfaces**
- `managedSettings` (SDK Options, 0.2.118) passes policy-tier settings in memory, "below IT-controlled managed sources". [doc in types] — [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts); [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- Deep links (`claude-cli://`) start sessions from a link. — [Docs index](https://code.claude.com/docs/llms.txt)
- Self-hosted environments: runners and an orchestrator, with `CLAUDE_CODE_SESSION_ACCESS_TOKEN` identity. — [Docs index](https://code.claude.com/docs/llms.txt)
- Projects: Claude coordinates several cloud threads on your repositories. — [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
- `--brief`, `SendUserMessage`, and new tools `SendUserFile`, `ReportFindings`, `Artifact`, `WaitForMcpServers`, `EndConversation`. `BUILTIN_TOOL_NAMES` lists public names. — [Tools reference](https://code.claude.com/docs/en/tools-reference); [sdk.d.ts 0.3.314](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.314/sdk.d.ts)
- The V2 session API for TS has been removed. — [Docs index](https://code.claude.com/docs/llms.txt)

### Inferences
- Priority candidates for machdoch, ordered by value for effort:
  1. Parse `active_goal`, `system/informational`, `local_workflow`, `agent_id` and `terminal_reason` leniently (a parser change only).
  2. Inject hooks through `--settings` for host policy and audit.
  3. Use `/goal` state handling with a host-owned Stop hook as a fallback.
  4. Use `defer` for questions that may wait long.
  5. Use `--bg` and `claude agents --json`, or `--cloud`, as external "send away" actions.
- An MCP server for machdoch's `-p` sessions should not depend on task `input_required` or elicitation inside tasks, because `-p` cancels those.
- Mods are powerful, but they run with the user's full permissions and are a young API (many mod entries in recent changelogs). Prefer hooks unless machdoch needs `$.model.fork` or in-process tools.

### Gaps
- Whether `--channels` works under `-p` stream-json was not checked. The first notes list the flag only.
- How `managedSettings` reaches the CLI on the wire, so whether a raw-CLI host can set it, was not determined.
- A complete mods event list was not captured here; see the [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference).
