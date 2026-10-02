# Instruction delivery verification

Verified on 2026-10-02 on Windows.

The audit covers all seven configured agent providers, canonical instruction resolution, API requests and continuations, CLI launch preparation, managed parallel workers, and native subagent boundaries.

## Changes

- Forward runtime-created instruction delivery plans and the receipt collection into CLI execution. Direct model-runtime callers previously created a plan without passing it to the CLI boundary.
- Attach Claude's run-scoped instruction file to nested subagent prompts through `--append-subagent-system-prompt-file` when the executable advertises that flag.
- Block native delegation when the reviewed capability cannot confirm instruction delivery to every child. This currently blocks native Codex, Copilot, and OpenAI beta delegation, and Claude versions without the subagent file flag. Single-agent execution and Machdoch-managed parallel agents remain supported.
- Accept CLI capabilities only from successful help probes. Failed or timed-out help output previously could be mistaken for evidence that a flag was supported. Failed probes no longer establish availability; version extraction selects the version line after startup diagnostics.

## Instruction selection and transport

Enabled global profiles, matching automatic profiles, workspace assignments with their declared directory scopes, and flow guidance are resolved into one frozen canonical envelope. The envelope retains source scope and precedence. Tests cover selection, ordering, deduplication, boundary handling, budgets, immutable snapshots, and provider adaptation.

Independent provider-native instruction files are inventoried and suppressed rather than automatically selected. Applicable instructions come from the canonical Machdoch library and invocation context. Oversized instructions block the invocation rather than being silently truncated.

API adapters include the frozen instructions on initial requests, tool continuations, and retries. Managed parallel API workers receive the envelope in their system prompt; CLI workers receive a separate invocation-scoped native instruction projection.

CLI enrollment re-probes the executable and compares its delivery plan with the reviewed plan before materialization. An unavailable executable, missing required flag, changed capability plan, or missing instruction snapshot blocks the launch.

## Provider results

| Provider    | Instruction transport                                                               | Automated verification | Live verification                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| OpenAI      | Responses `instructions`, reattached with `previous_response_id`                    | Passed                 | `gpt-5.4-nano`: instruction-only canary returned through a tool call on both initial request and continuation          |
| Anthropic   | Messages top-level `system` on every request                                        | Passed                 | Unverified: no API credentials                                                                                         |
| Google      | Gemini `systemInstruction` on every request                                         | Passed                 | `gemini-3.1-flash-lite`: instruction-only canary returned through a tool call on both initial request and continuation |
| Langdock    | Route-specific system message, Anthropic system field, or Gemini system instruction | Passed                 | Unverified: no API credentials; authenticated conformance remains provisional                                          |
| Codex CLI   | Isolated `CODEX_HOME/config.toml` `developer_instructions`                          | Passed                 | `codex-cli 0.159.1`: returned the canary supplied only through native configuration; exit 0                            |
| Claude CLI  | Run-scoped parent and subagent system-prompt file flags                             | Passed                 | Unverified: CLI not installed                                                                                          |
| Copilot CLI | Selected run-scoped custom-agent profile in isolated `COPILOT_HOME`                 | Passed                 | `GitHub Copilot CLI 1.0.87`: returned the canary supplied only through the custom-agent file; exit 0                   |

Live checks used temporary instruction libraries and workspaces. They did not change the user's instruction profiles or provider settings. Temporary provider enrollment and verification workspaces were removed afterward.

## Checks

```powershell
pnpm --filter @machdoch/client exec vitest run --maxWorkers=2 src/core/instruction-system src/core/provider-enrollment src/core/_helpers/external-agent-provider.spec.ts src/core/_helpers/parallel-agent-cli-sessions.spec.ts src/core/_helpers/parallel-agent-sessions.spec.ts src/core/_helpers/provider-adapters src/core/execution.spec.ts
pnpm --filter @machdoch/client typecheck:core
```

- Targeted suite: 37 files passed; 439 tests passed; one Windows-excluded ownership symlink test skipped.
- Core type check passed.
- A focused TypeScript check covering all changed specs and their dependencies passed.
- Formatting and lint checks passed for all changed TypeScript files; `git diff --check` passed.
- The first test run hit three Windows process-startup/file-lock timing failures. The expanded runs with two workers passed those checks.
- Commit preparation corrected the scope-registry fixture's `exactOptionalPropertyTypes` error. Core, production UI, and core-test type checks pass; full client lint and UI-test type checks remain blocked by existing assistant UI tests that reference removed modules, exports, and layout fields.

## Limits and provider references

Successful payload checks and live canaries establish delivery and the behavior observed in these invocations. They do not guarantee that a model will follow every instruction in every response, or that an untested provider version behaves identically.

Claude documents a file flag for attaching instructions to nested subagent prompts. The adapter uses it without placing instruction bodies on the command line. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)

Copilot documents that several built-in and custom subagents do not receive repository instructions by default, and that `--no-custom-instructions` takes precedence. Parent custom-agent delivery therefore does not establish child delivery. [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

Codex documents `developer_instructions` as session developer guidance. Its native child-inheritance capability remains unconfirmed in Machdoch's delivery descriptor, so native delegation is blocked pending a verified contract. [Codex configuration reference](https://developers.openai.com/codex/config-reference)
