# Provider feature compatibility

Investigated October 15, 2026, against the current workspace source.

Goal and Parallel Agents are independent settings. Machdoch-managed goals can retain managed parallel agents across work turns for every configured chat provider. Native goals can also retain managed parallel agents for Codex CLI and Claude CLI. This establishes orchestration compatibility; it does not establish successful live execution against every provider.

Native parallel agents have a separate instruction-delivery gate. Codex CLI, Copilot CLI, and OpenAI API currently cannot pass it. Claude CLI has a conditional route, but the ordinary desktop, terminal chat, and fleet controls do not supply the instruction plan required to expose that route.

## Provider coverage

These are all seven configured chat/agent providers in the [runtime contract](../apps/client/src/core/runtime-contract.generated.ts#L24). Quiver and Recraft are image services; Perplexity, Tavily, and Serper are search services. Audio and local media engines also do not host the chat Goal or Parallel Agents settings. Their use as tools is distinct from choosing the provider that runs the agent.

| Chat provider | Machdoch Goal + managed Parallel Agents | Native Goal + managed Parallel Agents        | Native Parallel Agents in the current implementation                                                              |
| ------------- | --------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| OpenAI API    | Compatible                              | Not implemented                              | Adapter exists for selected models, but instruction inheritance is unverified and execution is blocked            |
| Anthropic API | Compatible                              | Not implemented                              | Not implemented                                                                                                   |
| Google API    | Compatible                              | Not implemented                              | Not implemented                                                                                                   |
| Langdock      | Compatible                              | Not implemented                              | Not implemented                                                                                                   |
| Codex CLI     | Compatible                              | Compatible through app-server                | Blocked: subagent instruction delivery remains `unknown`                                                          |
| Claude CLI    | Compatible                              | Compatible with Claude Code 2.1.139 or later | Conditional runtime route using `--append-subagent-system-prompt-file`; unavailable through the ordinary controls |
| Copilot CLI   | Compatible                              | Not implemented                              | Blocked: subagent instruction delivery remains `unknown`                                                          |

“Managed Parallel Agents” means the `read-only` or `machdoch` setting. `disabled` is also compatible with either supported goal mode. Provider configuration, authentication, a valid model, available tools, and provider service limits still determine whether an actual run succeeds. Langdock's authenticated instruction contract is explicitly marked provisional in its [delivery descriptor](../apps/client/src/core/instruction-system/delivery.ts#L105).

For **Machdoch Goal + native Parallel Agents**, the native parallel restrictions in the last column still apply. For **native Goal + native Parallel Agents**, Codex is blocked by instruction delivery; Claude has a conditional backend route when its executable meets both the Goal version requirement and the subagent prompt-file capability check. Neither combination is selectable through the normal controls today. The other five providers have no native Goal route. Native and managed Parallel Agents are mutually exclusive choices within one turn; either can be paired with a supported Goal mode without creating two delegation layers.

## Who owns execution

| Feature                 | Machdoch owns                                                                                              | Provider owns                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Machdoch Goal           | Durable objective, pause/resume, accounting, continuation, stall detection, and independent evaluation     | Model inference and provider-specific tool execution                       |
| Native Goal             | Host goal record, cancellation/time boundary, final independent evaluation, and resume entry point         | Native continuation inside one provider invocation                         |
| Managed Parallel Agents | Worker launch, concurrent scheduling, tool/path boundaries, cancellation, results, and failure propagation | Each worker's inference; CLI providers run fresh external worker processes |
| Native Parallel Agents  | Selection, instruction-delivery checks, and provider configuration                                         | Subagent creation, scheduling, and internal lifecycle                      |

For native goals, Codex uses app-server with `features.goals=true` and the `thread/goal/set` protocol. Claude receives `/goal <objective>` in print mode; Machdoch removes `--bare` for that invocation. Copilot's autopilot invocation is not exposed as Native Goal. See [native command construction](../apps/client/src/core/_helpers/external-agent-provider.ts#L1593), [Codex protocol handling](../apps/client/src/core/_helpers/codex-native-goal.ts#L84), and [goal modes](../apps/client/src/shared/goals.ts#L29).

Native Goal is therefore shared orchestration, not a complete handoff of goal state. After the provider returns, Machdoch checks its evidence. An unverified native result pauses rather than starting another outer work turn automatically. Native goals support a host time limit; token and turn limits require Machdoch Goal. See [native stopping behavior](../apps/client/src/core/goals/run-goal.ts#L304) and [budget validation](../apps/client/src/core/goals/goal-execution.ts#L178).

## How the combinations work

The [goal runner](../apps/client/src/core/goals/run-goal.ts#L214) copies the original conversation context into every work turn, preserving `parallelAgentMode`. For native goals it additionally sends `nativeGoal` without replacing that parallel setting. The [agent runtime](../apps/client/src/core/agent-runtime.ts#L2480) constructs `run_parallel_agents` for managed modes and passes it into either the API execution loop or the external CLI's projected MCP tools.

The [goal evaluator](../apps/client/src/core/goals/goal-evaluation.ts#L81) uses a separate validator invocation. It clears native-goal execution, disables parallel agents and memory retrieval, and supplies an evaluation result protocol. API evaluators receive only the terminal result tool. CLI evaluators receive an empty scoped tool set. Parallel work belongs to the work turns, not the evaluator.

Managed workers are bounded tasks rather than copies of the whole parent agent. They use the parent's provider/model configuration, have no recursive delegation, and do not independently inherit the parent's goal loop. CLI workers explicitly disable parallel mode and memory. Two or three workers can run per call; write workers receive scoped file-edit tools and must have non-overlapping paths. Read workers have a limited inspection tool set. They do not inherit every parent MCP, browser, shell, or workflow capability. See [worker tool selection](../apps/client/src/core/_helpers/parallel-agent-sessions.ts#L321), [CLI worker setup](../apps/client/src/core/_helpers/parallel-agent-sessions.ts#L425), and [parallel scheduling](../apps/client/src/core/_helpers/parallel-agent-sessions.ts#L725).

## Restrictions and gaps

1. **Native parallelism is unavailable through ordinary controls.** `getAvailableParallelAgentModes` requires a matching instruction plan with verified subagent delivery. The desktop [picker](../apps/client/src/tauri/ui/chat-session/components/session-composer.tsx#L454), desktop [selection handler](../apps/client/src/tauri/ui/chat-session/_helpers/use-chat-session-controller.ts#L3107), terminal [`/parallel` handler](../apps/client/src/cli/_helpers/cli-chat-controls.ts#L87), and fleet [command/snapshot](../apps/client/src/cli/_helpers/cli-fleet-product.ts#L894) call the capability helpers without that plan. They therefore omit or reject Native. Saved native selections are also normalized to disabled when resolved without evidence. Wiring a verified plan into these paths is necessary before the conditional Claude route becomes usable there.

2. **Provider-native capability does not establish Machdoch support.** The [parallel capability helper](../apps/client/src/core/parallel-agent-capabilities.ts#L9) recognizes native subagents for three CLIs and selected OpenAI models, but the [delivery descriptors](../apps/client/src/core/instruction-system/delivery.ts#L140) mark CLI subagent delivery unknown. The [runtime preflight](../apps/client/src/core/provider-enrollment/instruction-delivery-preflight.ts#L112) leaves Codex and Copilot unknown, conditionally upgrades Claude, and explicitly leaves OpenAI multi-agent inheritance unknown. The [runtime assertion](../apps/client/src/core/agent-runtime.ts#L2466) blocks native execution before launch when inheritance cannot be confirmed. Enabling provider flags alone does not resolve this restriction.

3. **Goal disables Adaptive Controller.** Both work and evaluation contexts force `adaptiveControllerOverride: false`, even if the toolbar setting is enabled. Explicit reasoning and context-window settings remain subject to their own provider/model support. Goal therefore does not currently compose with adaptive reasoning, iteration, or worker-count selection. See [work context](../apps/client/src/core/goals/run-goal.ts#L219) and [adaptive setting resolution](../apps/client/src/core/adaptive-controller.ts#L75).

4. **Workflow protocols have different composition rules.** Goal handling is bypassed for structured result protocols, validator/generator roles, and deterministic actions. Managed parallel tools are also omitted when a result protocol is active. Ralph validator/router blocks and iterative prompt blocks use those protocols; an ordinary single-iteration prompt block can preserve its supplied conversation context. A workflow being parallel does not imply that every block can run Goal plus Parallel Agents internally. See [goal entry conditions](../apps/client/src/core/goals/goal-execution.ts#L27), [parallel tool conditions](../apps/client/src/core/agent-runtime.ts#L2480), and [Ralph prompt/validator execution](../apps/client/src/core/ralph.ts#L4321).

5. **Chat type and execution mode matter.** Pose chats reject Goal and omit managed parallel tools. Quick Voice hides Goal. Managed write workers require both parallel mode `machdoch` and run mode `machdoch`; otherwise workers are read-only. For external CLI parent agents, ordinary `ask` mode still selects full-access delegation unless the execution role is generator or validator. Ask is therefore not a general read-only boundary for CLI parent execution. See [chat controls](../apps/client/src/tauri/ui/chat-session/components/session-composer.tsx#L316), [goal validation](../apps/client/src/core/goals/goal-execution.ts#L171), [write access schema](../apps/client/src/core/_helpers/parallel-agent-sessions.ts#L766), and [CLI delegation](../apps/client/src/core/_helpers/external-agent-provider.ts#L290).

6. **Stored goals do not silently activate on ordinary messages.** A goal needs an explicit command or submitted objective. The restored objective can remain visible as a draft while disabled; opening the Goal control enables submission of that draft. Desktop and fleet task submission pass goal and parallel settings together. Resume preserves the host goal identity and consumed budget. Provider changes can make a native goal incompatible and require changing back or clearing it. See [goal draft submission](../packages/product-ui/src/use-goal-draft.ts#L123), [desktop submission](../apps/client/src/tauri/ui/chat-session/_helpers/use-session-task-submission.ts#L552), and [fleet submission](../apps/client/src/cli/_helpers/cli-fleet-product.ts#L1230).

7. **Offline and unconfigured providers cannot launch managed workers.** The runtime omits the delegation tool when offline or when the selected provider is not configured. Memory settings remain part of the parent's work context, but evaluation and CLI workers disable retrieval, and API workers receive empty memory. Reasoning and context-window controls remain subject to provider/model validation; they do not bypass the native parallel gate. See [tool availability](../apps/client/src/core/agent-runtime.ts#L2480), [worker context](../apps/client/src/core/_helpers/parallel-agent-sessions.ts#L592), and [evaluator context](../apps/client/src/core/goals/goal-evaluation.ts#L94).

## Upstream documentation and local executable checks

The official [Codex Goal guide](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) confirms native goals, durable thread state, and idle-boundary continuation. The installed executable reports `codex-cli 0.159.1` and advertises the app-server command. No authenticated Codex goal was launched for this audit.

The official [Claude Goal documentation](https://code.claude.com/docs/en/goal) explicitly allows background subagents: goal evaluation waits until their work finishes. It also documents noninteractive `/goal`. This confirms that the upstream features can coexist; Machdoch still needs its instruction-delivery gate and frontend wiring. Claude was not found by the PATH lookup, so its local native route was not exercised.

The installed `GitHub Copilot CLI 1.0.87` advertises fleet parallel subagent orchestration, also described in the official [Copilot fleet documentation](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet). Machdoch does not currently expose that capability as a verified native parallel route or a native Goal implementation. This finding is about the adapter, not a claim that Copilot itself lacks parallel agents.

## Verification

Retained and strengthened [27 combination tests](../apps/client/src/core/goals/goal-feature-combinations.spec.ts). They exercise the actual task/goal orchestration with injected API models and mocked external CLI transport: all seven providers, all three managed parallel settings, and both goal modes where exposed. Each enabled parallel case now calls the real managed delegation tool, starts two workers, reads a real temporary evidence file through the scoped tools, and checks the ordered worker results. Machdoch goals perform two work/evaluation cycles to verify delegation on continuation. Native goals check that the native objective and managed delegation reach the CLI boundary together. Workers retain the selected provider/model, cannot delegate recursively, and cannot write in these read-worker scenarios. Evaluation remains isolated in both goal modes. The submitted Adaptive Controller setting is enabled so the tests also exercise the Goal runner's override.

Recovery verification passed **558 tests across 30 files**, covering goals, API and CLI workers, each API adapter, native goal protocols, instruction enrollment/capabilities, Adaptive Controller, CLI/fleet submission, desktop composer/lifecycle, and shared Goal controls. Test TypeScript checking, targeted lint, and formatting passed. The combination suite uses read workers in both managed modes; scoped writes and cancellation/failure propagation are covered by the separate worker suites. The tests use fake model responses and CLI transport; they do not prove live provider service behavior, native subagent instruction inheritance, or complete desktop-to-provider execution.

The combination suite can be rerun from the repository root with:

```sh
pnpm --filter @machdoch/client exec vitest run src/core/goals/goal-feature-combinations.spec.ts
pnpm typecheck:test
```

A read-only `run_parallel_agents` attempt in the previous execution was reported as returning MCP error `-32603: fetch failed` without usable worker results. Recovery checked the surviving files, Git state, and chat snapshot; the snapshot retains the prior summary but no individual worker output. That attempt is not counted as successful parallel execution. Its cause was not established, and the error alone does not identify a provider defect or implicate Goal. The recovery source review and local tests were completed directly without repeating the failed remote delegation.

No application runtime behavior was changed. The investigation leaves the native frontend wiring, unverified native instruction inheritance, and failed live orchestration attempt unresolved.
