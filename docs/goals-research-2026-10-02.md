# Goal reliability follow-up

Research date: October 2, 2026. Codex accounting source was checked at public HEAD `e3c2a8393725c0fd8b0d1084301bf15ef35b6092`. This supplements the [September 30 research](goals-research-2026-09-30.md).

## Provider behavior

Codex treats a goal as a persistent completion contract: outcome, verification, constraints, and user-controlled lifecycle. Its continuation loop checks work against that contract across turns. [OpenAI goal guide](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

Codex serializes accounting, records usage deltas against a goal identity, and advances its accounting baseline after persistence succeeds. It separately tracks failed execution and empty continuation turns. These mechanisms prevent duplicate charging and stop some loops that have activity without progress. [Accounting source](https://github.com/openai/codex/blob/e3c2a8393725c0fd8b0d1084301bf15ef35b6092/codex-rs/ext/goal/src/accounting.rs).

Codex also guards continuation admission with a goal-state permit. A scheduler must not start work based on a goal that was cleared or replaced while it was deciding. [Runtime source](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/runtime.rs).

Claude Code uses a separate small model to evaluate a completion condition against the transcript after each turn. It cannot independently inspect files or run checks. Several turns without tool activity stop automatic continuation. Background tasks defer evaluation; check-ins back off and are bounded. Interactive transient-error retries are also bounded. Native print-mode goals need streaming output to show activity before the invocation ends. [Anthropic goal documentation](https://code.claude.com/docs/en/goal).

## Machdoch changes

The engineering inference is that an evaluator needs a host-enforced stopping boundary, and durable budget accounting must happen during long turns as well as between them.

- Verification races the executor against cancellation. A provider that never settles can no longer keep the evaluator waiting beyond its five-minute deadline or a shorter task limit. User cancellation also settles the evaluator promptly.
- The executor receives the verification duration limit. Progress and activity callbacks stop after verification exits, preventing late evaluator events from reviving a finished UI state. Late promise failures remain observed.
- Active runs checkpoint elapsed time and reported token usage every five seconds. Accounting uses the original run baseline and fresh values inside the existing file lock. It preserves goal identity and stopping states.
- Repeated-work detection compares worker results, observed tool evidence, and output sections. Changing evaluator suggestions alone cannot reset the stall counter.

The worker lease remains held until worker execution settles. Only the evaluator, which cannot perform work through tools, has the independent cancellation boundary. Existing native-provider selection and restart recovery remain in place.

## Verification limits

All 216 tests across the goal, timeout, locking, provider, and executor-prompt suites passed. Core type checking and isolated goal-test type checking passed. Full client lint and test type checking remain blocked by existing assistant-surface test errors.

Regression tests cover ignored cancellation, late evaluator events and failures, resume after a stalled evaluator, in-flight checkpoints without double charging, and changing evaluator suggestions during repeated work. Live provider processes and a desktop restart were not exercised. A sudden process exit can still lose usage not yet reported by the provider or saved since the last checkpoint.
