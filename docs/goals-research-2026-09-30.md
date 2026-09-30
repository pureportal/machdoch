# Persistent goals: research and implementation

Research date: September 30, 2026. Codex source inspected at commit `596ae94fb00f8325d6bf835a9ebdc90baab4ad33`. Provider documentation describes current behavior; source observations below refer to that specific checkout. No provider source was copied into Machdoch.

## What a goal adds

A goal is a durable outcome attached to a conversation. Finishing a model turn does not finish the goal: the runtime checks progress, preserves the objective, and either starts another turn or records a stopping state. This differs from a larger prompt, a scheduled recurring task, and a multi-agent workflow. Those features can complement a goal, but none supplies its lifecycle by itself.

The OpenAI cookbook emphasizes measurable completion, an identifiable verification surface, constraints, and explicit user control. It documents `/goal`, pause, resume, and clear, and identifies Codex 0.128.0 as the initial supporting release. [OpenAI cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

## Codex: an extensible, persisted state machine

The implementation is public in the Apache-2.0 repository. Current source places the goal runtime in `codex-rs/ext/goal`; older references to `core/src/tools/handlers/goal.rs` no longer describe the current tree. The extension separates API mutations, tool definitions, accounting, runtime scheduling, steering prompts, and events. [Repository license](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/LICENSE), [goal extension](https://github.com/openai/codex/tree/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/ext/goal).

| Concern     | Observed behavior                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Identity    | One goal per thread, with a distinct goal ID for stale-write protection.                                                             |
| State       | Active, paused, blocked, usage limited, budget limited, complete.                                                                    |
| Storage     | A dedicated goals database stores the objective, optional token budget, accumulated tokens, accumulated active time, and timestamps. |
| Model tools | `get_goal`, `create_goal`, and `update_goal`.                                                                                        |
| Host API    | `thread/goal/set`, `thread/goal/get`, and `thread/goal/clear`; mutations also produce events.                                        |
| Ownership   | Host operations can set/resume/change limits; the model's update tool can only complete, block, or pause.                            |

The database also has a continuation-deferral table. Deferral is a scheduling condition separate from goal status, so temporarily suppressing automatic work need not destroy the user's objective. [Goal migrations](https://github.com/openai/codex/tree/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/state/goals_migrations), [model](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/state/src/model/thread_goal.rs), [request processor](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/app-server/src/request_processors/thread_goal_processor.rs).

The tool contract requires explicit goal creation rather than inferring goals from ordinary tasks. Completion claims require the objective actually to be achieved. The model must not pause without a user request, nor call a task blocked merely because it is hard. Repeated genuine blockers are audited across at least three consecutive goal turns; resuming a blocked goal restarts that audit. [Tool specifications](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/ext/goal/src/spec.rs).

Automatic continuation takes a goal-state permit through the read/start window. It checks tool availability, continuation deferrals, thread existence, and active status before requesting an idle turn. The host admits that turn rather than manufacturing another user message. This avoids racing a clear or a replacement against a stale scheduler decision. [Runtime](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/ext/goal/src/runtime.rs).

Accounting records deltas from the last accounted usage rather than repeatedly adding cumulative totals. It tracks goal identity, turn baselines, active wall-clock time, and descendant usage. It distinguishes successful tool activity, failed execution, and empty final responses so continuation can stop when the runtime is failing without making useful progress. [Accounting](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/ext/goal/src/accounting.rs), [extension lifecycle](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/ext/goal/src/extension.rs).

The continuation template asks the agent to preserve the original scope, distinguish verified waits from activity-free restatements, and audit every requirement against current authoritative evidence. The objective is treated as user data, not an elevation of instruction priority. The core also marks host-authored goal updates with provenance so matching text alone is insufficient to impersonate them. [Steering template](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/ext/goal/templates/goals/continuation.md), [user-goal context](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/core/src/context/user_goal.rs).

### Why native Codex is not exposed by this implementation

Machdoch currently delegates Codex work through `codex exec`. The inspected exec client tracks its submitted task ID, processes that task's completion, and shuts down when its event processor requests shutdown. Its non-ephemeral fork path also explicitly sets `defer_goal_continuation`. That is not a reliable host-owned, multi-turn goal transport. This is a limitation of Machdoch's current integration, not a claim that Codex lacks native goals. [Exec client](https://github.com/openai/codex/blob/596ae94fb00f8325d6bf835a9ebdc90baab4ad33/codex-rs/exec/src/lib.rs).

A complete native Codex integration would need an app-server connection, persisted provider thread mapping, goal API calls, goal notifications, interruption, and lifecycle-aware disposal. Merely adding a `/goal` string or enabling goal tools in an ephemeral exec process would misrepresent native continuation and persistence. Therefore Codex remains supported through Machdoch's managed goal loop, with native goal creation explicitly disabled at that provider boundary.

## Claude: a separate completion evaluator

Claude documents `/goal` as a session-scoped prompt-based Stop hook. A separate small fast model checks the condition and transcript after a turn. Its verdict can continue work, achieve the condition, or declare it impossible; the reason guides the next turn. The evaluator does not independently read files or execute commands. Conditions must therefore be demonstrable in the transcript. The goal condition is limited to 4,000 characters, one goal is active per session, and permission mode remains separate from goal mode. Native print mode is documented: `claude -p "/goal …"`, with verbose stream JSON for progress. [Claude goal documentation](https://code.claude.com/docs/en/goal).

The same documentation describes failure handling and background scheduling: unrecoverable credential/credit/context/model problems can clear the goal; transient failures can retry, with a cap; rate or usage limits can pause. Running background work defers evaluation, and interactive idle check-ins use backoff and a bounded count. Resume restores the condition but resets its counters. These are provider-owned details; Machdoch does not pretend to reproduce them in native mode. [Claude goal documentation](https://code.claude.com/docs/en/goal).

The public Claude repository provides documentation, release notes, plugins, examples, and issue tracking. It does not provide the goal evaluator/runtime as an open-source reference implementation. Its published license points to Anthropic's commercial terms rather than an open-source license. Reverse-engineering writeups were found, but were not treated as authoritative implementation evidence. [Claude repository](https://github.com/anthropics/claude-code), [license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md).

Claude's bare invocation skips hooks, so it must not be used for native goals. Machdoch removes only that launch flag for the native path, retaining its existing run-scoped instruction transport and explicit MCP configuration. [Anthropic power-user documentation](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips), [CLI reference](https://code.claude.com/docs/en/cli-reference).

## Machdoch implementation

The feature lives at the shared task-execution boundary, so desktop chat, terminal chat, and Fleet use the same lifecycle. Ordinary messages do not create goals. Goals are scoped by workspace and session; command-line runs without a session use a separate workspace-scoped command-line identity.

Status, mode, pause, and clear commands operate locally without executor, evaluator, or post-task learning calls.

```text
/goal <objective>
    -> persist active goal
    -> execute work with existing provider and tool rules
    -> independently evaluate the evidence
       -> complete
       -> blocked
       -> continue
    -> checkpoint counters and status
```

The managed evaluator uses the selected provider/model with a fresh context. API evaluation exposes only the final-result tool. CLI evaluation uses the scoped worker path, disables native tools, and supplies an empty scoped tool set. CLI work captures bounded native tool results from Codex completion events, Claude tool-result messages, and Copilot tool-completion events. These observations reach the evaluator separately from the assistant's final claims; ordinary chat does not capture this extra evidence. A strict `goal-evaluation` control record carries the decision independently of the visible answer; missing or invalid records pause the goal.

The persisted states are active, paused, blocked, budget limited, and complete. State writes use the existing cooperative lock and atomic JSON writer. A separate runner lease prevents two runtimes from driving one goal. Goal IDs protect against resurrecting cleared/replaced objectives. Pause and clear are polled while work runs and cancel its signal. Terminal progress is emitted only after the whole goal run resolves, preventing intermediate turn completion from prematurely ending the desktop task.

Optional limits are explicit:

```text
/goal --turns 10 --tokens 100000 --minutes 30 Make all auth tests pass
/goal
/goal pause
/goal resume
/goal clear
/goal mode machdoch
/goal mode native
```

No token budget is inferred. Token limits include executor and evaluator usage available to the task recorder and are checked between calls and at reported progress boundaries; they are not a provider billing hard cap, and a call already in flight can exceed them. If usage is unavailable, a budgeted goal pauses. Turn limits count work turns, not evaluator calls. Active elapsed time excludes time spent paused. Time limits interrupt in-flight work. Three work turns without tool activity pause managed continuation. Provider or evaluation errors stop continuation instead of generating unbounded retries.

Native mode is offered for Claude CLI, with a launch-time version check for at least 2.1.139. Its own evaluator runs inside the provider invocation. Machdoch then independently checks the final result before recording completion; it does not run a second automatic executor loop in native mode. Native mode supports a host time limit. Token and host-turn limits require managed mode because Machdoch cannot reliably enforce those boundaries within the provider's own loop.

The Goal control provides mode selection, objective entry, status, pause, resume, and clear. Selected desktop mode is remembered for new chats and reloads; unsupported selections resolve to Machdoch mode. An already-created native goal retains its mode and rejects resumption on an incompatible provider rather than silently changing execution semantics.

## Verification and practical limits

Focused tests cover command parsing, persisted state, independent evaluation, resume, completion at a turn limit, token accounting, provider failures, missing decisions, inactivity, session isolation, concurrent runners, pause/clear races, native capability checks, actual Claude launch arguments, and the shared UI. An API integration test checks the evaluator's real advertised tool set. Rust protocol and conformance tests check the transport side.

Paid live model runs and a running desktop application were not used for verification. No development server was started. Native Claude behavior beyond argument/protocol handling depends on the installed CLI, workspace trust, hooks availability, authentication, and provider behavior. Closing the host does not schedule background continuation. Paused goals require explicit resume; an interrupted active goal can resume when the user sends a message in that session. Goal state survives restart, while evidence for a resumed run comes from the conversation and fresh inspection rather than a hidden reconstruction of every past tool result.

The focused regression suite, shared UI tests, TypeScript/Rust protocol tests, production CLI/UI builds, core/UI type checks, and lint checks for changed files passed. Full client checks remain blocked by existing assistant test references to removed modules and geometry exports. The desktop Rust check could not complete because the Windows native toolchain has no working Ninja installation and its cached Whisper build uses Ninja.
