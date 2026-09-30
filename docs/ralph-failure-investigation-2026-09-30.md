# RALPH failure investigation — 2026-09-30

The two flows in the supplied screenshot stopped for different reasons. Both retained recoverable checkpoints and ended with lifecycle status `blocked` and semantic outcome `deferred`.

| Flow | Run | Actual failure |
| --- | --- | --- |
| Repository Refactor & Validation Loop | `2026-09-30T08-21-00-698Z` | `BEGIN_SCOPE_CYCLE` rejected a scope registry with schema version 1. The current parser requires version 2. |
| Autonomous Code Improvement Loop | `2026-09-30T08-21-06-668Z` | Native verification initially failed because libclang was unavailable. A later bundled-bindings workaround produced Linux ABI layout errors on Windows. The run eventually exhausted its repeated-failure limit at `baseline-verification`. |

Refactor stopped after 4 block results in approximately 2.7 seconds. Code Improvement ran from 08:21:06 to 10:53:59 UTC, approximately 2 hours 33 minutes, with 531 block results. In Berlin, these runs started at approximately 10:21 and the longer run stopped at 12:53.

This investigation examined both complete workspace run records, their logs and retained plans, both workspace flows, both user-scoped copies, eight historical user-scoped run records, the shared execution helpers, and the relevant native dependency build artifacts. It did not restart the flows or change application code, saved flows, registries, or plans.

## Confirmed findings

### 1. Refactor reads an incompatible, obsolete registry

**High; immediate cause of the Refactor stop.**

The [Refactor registry](../.machdoch/ralph/scope-registry/repository-refactor-validation-loop.scope-registry.json) contains `schemaVersion: 1` and was last updated on 2026-07-29. It also contains obsolete repository paths such as `src-tauri/src`, predating the current `apps/client/src-tauri` layout.

[The parser](../apps/client/src/core/_helpers/ralph-scope-registry.helper.ts), lines 974–994, accepts only the current version 2. `BEGIN_SCOPE_CYCLE` reads this file before scanning the repository, so discovery never gets an opportunity to refresh it. `UPDATE_SCOPE_REGISTRY`, `SELECT_SCOPE`, and `MARK_SCOPE_RESULT` use the same strict reader and can encounter the same failure.

Directly parsing the existing file reproduces `Expected a supported Ralph scope registry schema.` Parsing the Code Improvement registry succeeds with version 2 and 130 retained scope entries.

Recovery should archive the incompatible registry and its Markdown companion, then regenerate current scope evidence. Merely changing the version number would retain obsolete paths and selection state. No legacy reader or compatibility migration is needed.

Evidence: [Refactor log](../.machdoch/ralph/runs/2026-09-30T08-21-00-698Z/simple.md), `Begin Scope Cycle`, 08:21:02 UTC.

### 2. Native verification lacks a usable libclang environment

**High; original cause of Code Improvement verification failures.**

Ten baseline checks and fourteen candidate checks failed with `Unable to find libclang`. The execution environment has no `LIBCLANG_PATH`, and `C:/Program Files/LLVM/bin` is absent. `cargo check --locked` reproduces the same build-script panic and exit code 101 today.

[Project-command detection](../apps/client/src/core/ralph.ts), lines 11338–11580, selects direct Cargo commands. Those commands do not go through the Windows prerequisite handling in [run-tauri.mjs](../apps/client/scripts/run-tauri.mjs) or the [CI toolchain check](../.github/scripts/check-windows-desktop-toolchain.ps1). A RALPH check can therefore reach native compilation without the prerequisite validation performed by the desktop build path.

Repair the native build environment before resuming Rust work: make the required Windows LLVM/libclang installation available to the process and validate the MSVC/CMake prerequisites. The investigation establishes that libclang is unavailable to this process; it does not establish whether a usable installation exists elsewhere on the machine.

Evidence: [Code Improvement run](../.machdoch/ralph/runs/2026-09-30T08-21-06-668Z/run.json), first `baseline-verification` result, and the current `cargo check --locked` reproduction.

### 3. The bundled-bindings workaround is invalid for this Windows target

**High; cause of the final repeated verification failure.**

At approximately 09:34 UTC, the execution trace records using `WHISPER_DONT_GENERATE_BINDINGS` to avoid libclang. The dependency's `whisper-rs-sys` 0.15.0 build script copies its bundled `src/bindings.rs` when this environment variable is present.

The failing test-profile artifact at `apps/client/src-tauri/target/debug/build/whisper-rs-sys-1473db9a0d5da169/out/bindings.rs` is byte-for-byte identical to the dependency's bundled file. Both have SHA-256 `7be784d3f55dff7ffc92e5f86b8c7a5065bc2618522fab3ae12bdeaaeb5612b1`.

That file contains Linux/glibc structures `_G_fpos_t`, `_G_fpos64_t`, and `_IO_FILE`. Its layout assertions fail on the current `x86_64-pc-windows-msvc` target with `12_usize - 16_usize` and `208_usize - 216_usize` overflows. This is not a failure in the changed Workspace Run code.

Four baseline checks and ten candidate checks encountered these ABI errors. Nine of those candidate checks were subsequently routed as `SUCCESS` through baseline equivalence, as described below.

Remove this workaround from verification execution and regenerate the affected dependency artifacts with the correct native toolchain. The current process does not have the override set; the invalid test-profile artifact still exists. Do not reuse it as evidence of a healthy baseline.

Evidence: [execution trace](../.machdoch/ralph/runs/2026-09-30T08-21-06-668Z/trace.jsonl), line 1470, plus the dependency build script and the hashed local artifacts.

### 4. Identical early build failures can become successful verification and completed tasks

**High; verification correctness defect.**

[Verification comparison](../apps/client/src/core/_helpers/ralph-verification.helper.ts) classifies identical nonzero exit codes and output fingerprints as `BASELINE_EQUIVALENT_FAILURE`. [Execution routing](../apps/client/src/core/ralph.ts), lines 5743–5762, maps that disposition to `SUCCESS`. [Outcome classification](../apps/client/src/core/_helpers/ralph-autonomy-outcome.helper.ts), lines 685–697, can then return `succeeded` with `verified: true` and a baseline-failure limitation.

Equality of an early dependency compilation failure does not establish that the changed project code compiled or that its tests ran. Arbitrary regressions behind that failed dependency remain invisible.

In this run, nine candidate checks returned `SUCCESS` despite exit code 101 and the bundled-bindings compilation error. Two Rust tasks were then marked completed:

- `settings-transfer-bounded-recovery-artifact-reads`
- `serialize-sequential-run-cancellation-with-child-start`

Their reviews acknowledged that Cargo verification was still blocked. `MARK_JSON_TASK` validates state transitions but does not require independent verification evidence before setting `completed`.

The final flow outcome correctly remains deferred. That does not repair the individual tasks' completed status. Completion must require evidence that reaches the changed code or an explicitly recorded, task-specific verification boundary. Unavailable compilation should remain unavailable verification.

Evidence: candidate results at zero-based block-result indexes 326, 341, 413, 428, 443, 458, 473, 495, and 510; completion records at indexes 353 and 522 in the [run record](../.machdoch/ralph/runs/2026-09-30T08-21-06-668Z/run.json).

### 5. Verification equivalence depends on unstable console output

**Medium; turns recurring environmental failures into inconclusive checks.**

[Observation fingerprinting](../apps/client/src/core/_helpers/ralph-verification.helper.ts), lines 75–78, hashes complete stdout and stderr. Process IDs, compilation progress, ordering, and other incidental output affect equality.

A direct domain-function reproduction using the same libclang failure with only the panic PID changed returns `INCONCLUSIVE`. Identical text returns `BASELINE_EQUIVALENT_FAILURE`. Fourteen candidate libclang failures in the recorded run were inconclusive.

Classify the actual process/diagnostic outcome before comparing failures. Normalizing incidental text alone must not turn an early compiler failure into proof that project behavior was verified.

### 6. Repeated-failure detection misses the recurring prerequisite failure

**Medium; amplifies unnecessary retries and repair work.**

[Failure signatures](../apps/client/src/core/_helpers/create-ralph-failure-signature.helper.ts) include result data and Markdown. The normalizer replaces timestamps, UUIDs, and durations, but does not normalize panic PIDs. The ten baseline libclang failures produce ten distinct signatures even though the missing prerequisite is the same.

The helper also excludes a completed result with output `INCONCLUSIVE` from repeatable failures. Candidate comparison failures therefore do not consume this repeated-failure budget. The run's final guard activated only after three identical bundled-bindings baseline failures.

Use a stable failure identity that includes the prerequisite or structured diagnostic category, and account for repeated inconclusive verification. Preserve distinct genuine source failures rather than grouping every exit code 101 together.

### 7. Unavailable baseline verification routes into implementation

**Medium; flow control allows work to continue without a usable verification boundary.**

The saved Code Improvement graph sends baseline `SUCCESS`, `FAILED`, `ERROR`, and `INCONCLUSIVE` to `count-improvement-pass`. Candidate `INCONCLUSIVE` continues to evidence/review. The engine distinguishes only process execution errors as `ENVIRONMENT_UNAVAILABLE`; a build-script panic caused by missing libclang is treated as an ordinary failed process.

The result was 14 failed baseline checks, 15 inconclusive candidate checks, 15 implementation-block executions, and 11 repair-block executions before the run stopped. Reviews repeatedly requested the same unavailable verification prerequisites, and the flow moved on to additional scopes and tasks.

Permit unrelated work only when it has its own usable verification plan. Gate the affected language/toolchain on prerequisite availability, retain its work, and resume after the prerequisite changes instead of repeatedly implementing or repairing around an unavailable check.

Evidence: [saved flow graph](../.machdoch/ralph/flows/0950d833-6eaf-4f05-b3cb-957013fac802.json), `baseline-verification` and `run-verification` edges; complete block-result counts in the run record.

### 8. Detected verification does not cover the selected Python work

**Medium; independent additional reason for deferrals.**

For the selected scope `apps/client/src-tauri/python/fizgig/minimax`, command discovery ascends to `apps/client/src-tauri/Cargo.toml` and selects `cargo test` or `cargo check`. There is no nearer supported manifest in this scope. Those checks do not exercise the modified Python loader, sampler, reference sizing, or embedding cache.

The task portfolios contain task-specific Python verification requirements, but the deterministic command selector chooses a detected tier command rather than executing the task's declared verification plan. Reviews correctly report that Python verification did not run. `python` resolves to an unavailable Store alias in this environment; the recorded `py` attempts were also unavailable.

Choose and validate verification for the actual language and task before claiming it. A parent Cargo manifest is repository context, not authoritative Python coverage. The same weakness applies to submodules whose tests are not represented by the nearest package manifest. Standard-tier JavaScript detection also prefers type checking plus linting when lint exists; that is insufficient evidence for a behavior change without a separately recorded business-logic check.

Evidence: `detect-project-commands` results with Python `requestedRootPath`, their Cargo `rootPath`, and four Python tasks retained in the [09:23 archived plan](../.machdoch/ralph/code-improvements/archive/active-improvement-plan-2026-09-30T09-23-44-240Z-35193caba0fd.json).

### 9. Scope-selection templates are silently discarded

**Medium; shared configuration defect in both flows.**

The starter definitions specify `strategy: "{{scopeSelectionStrategy:text=priority}}"`. [Configuration coercion](../apps/client/src/core/_helpers/coerce-ralph-utility-config.helper.ts), line 586, accepts only resolved enum values, so persistence drops the unresolved template. Both workspace flows and both user-scoped copies have no strategy on their scope utilities.

[Runtime selection](../apps/client/src/core/ralph.ts), lines 8627–8633, then uses `round-robin`. All four selections in the longer run report `round-robin`, while its variables specify `scopeSelectionStrategy: priority`.

Direct coercion preserves literal `priority` and drops its templated equivalent. Preserve the template until runtime resolution and validate the resolved value. The same parser affects every starter that uses a templated scope strategy.

Related weakness: [starter fingerprint normalization](../apps/client/src/core/ralph-starter-flows.ts), lines 106–140, deliberately erases strategy and numeric templates from the template snapshot. This can hide functional template-field changes from identity comparison. Numeric scan bounds did work in this run: 83 discovered scopes, depth limit 6, result limit 240. They should not be reported as a failed runtime control.

### 10. Terminal summaries and journals lose the concrete cause

**Medium; obscures diagnosis and recovery.**

The Refactor flow routes the registry error through its retained report to a deferred END block. Its final outcome says only `Work was explicitly deferred with durable state.` The actual unsupported-schema error is present in the block log but absent from the outcome evidence.

[Deferred outcome classification](../apps/client/src/core/_helpers/ralph-autonomy-outcome.helper.ts), lines 491–508, uses an autonomy-deferred reason or generic text. It does not use the error that caused an explicitly deferred terminal route.

The Code Improvement outcome is more specific but still reports only the block and exit code. Its last durable outcome journal entry contains only `{"outcome":"DEFER","scopeRoot":"."}`: no timestamp, run ID, task ID, diagnostic category, or concrete retry condition.

Retain a bounded structured cause on the outcome and journal entry, and carry it through reporting. Recovery guidance should identify the unavailable prerequisite or invalid state that must change.

### 11. Advisory scope checks are treated as positive scope evidence

**Medium; scope evidence overstates what was established.**

Both saved flows omit `enforce` on `CHANGE_SCOPE_GUARD`. [The guard](../apps/client/src/core/ralph.ts) therefore returns `IN_SCOPE` even when it finds changes outside its allowed paths, recording those files as advisory evidence. The outcome classifier treats the output as a successful scope gate.

Two Python-scope checks in this run returned `IN_SCOPE` while listing three advisory files outside the scope: the shutdown idle module, its hook, and its business-logic spec. This does not establish which task or agent authored those files; unrelated concurrent work can legitimately exist in the workspace.

Keep advisory repository context distinct from an affirmative scope assertion. Verify task-owned changes against the task's baseline rather than treating advisory output as proof that all relevant changes stayed in scope.

## Retained work and unresolved implementation risks

Across the current plan and four plans archived during this run, 17 tasks remain represented: 12 deferred, 3 completed, 1 implementing, and 1 planned. Two of the completed tasks have the verification limitation described in finding 4.

The current [Workspace Run plan](../.machdoch/ralph/code-improvements/active-improvement-plan.json) retains:

- `bound-workspace-health-probe-lifetime` as deferred after the repair limit.
- `serialize-sequential-run-cancellation-with-child-start` as completed, with native test execution still blocked.
- `reclaim-inactive-workspace-runtime-state` as implementing. It was claimed immediately before baseline verification stopped the flow; its implementation block did not run for that claim. Its retained task lease expires at 11:03:57 UTC.

The last health review identifies a cancellation race still visible in [manager.rs](../apps/client/src-tauri/src/workspace_run/manager.rs), around lines 1008–1075: cancellation can happen after the initial flag check; `update_health` can reject the update, but the caller still processes failure thresholds, terminates the process, and returns `Unhealthy`. `prepare_restart`, around line 1107, records restart state before its later cancellation check. This is a static finding; Rust compilation currently prevents deterministic execution verification.

[Health resolution](../apps/client/src-tauri/src/workspace_run/health.rs), around line 211, uses a bounded executor, which avoids the earlier unbounded per-probe resolver-thread design. Its blocking `to_socket_addrs` call still cannot be interrupted after it begins. A stalled resolver can retain one of the four slots beyond the probe deadline. The bounded pool and admission checks mitigate growth; they do not prove a bounded resolver lifetime or recovery from permanently stalled resolution.

## Historical repetitions and related failures

These are observed historical incidents, not claims that every old defect remains present today.

| Date / run | Observed problem | Current assessment |
| --- | --- | --- |
| 2026-07-29, both user runs | Cargo/linker failures including LNK1105/error 1224 and LNK1104 against the same native test executable; Refactor recorded 16 failed validation results. | Shared output/process lifetime contention is a related native verification failure. Attribution and current reproduction were not established. |
| 2026-07-29, both user runs | Persisted status still says `running`; leases expired in July. | Current run-summary code correctly reports both as `abandoned` and recoverable. These are retained old runs, not evidence that both flows are currently active. |
| 2026-08-06, `07-35-05-575Z` | Code Improvement failed in `UPDATE_SCOPE_REGISTRY` with the same unsupported scope-registry schema message. | Confirms that finding 1 recurs across flows and entry points. |
| 2026-08-06, `10-07-14-644Z` | Final validator returned `INVALID` after passing command verification; terminal report reduced it to generic deferred work. | Another instance of lossy causal reporting. The particular validator failure was not reproduced. |
| 2026-08-26, `05-54-56-626Z` | Baseline terminal tests failed; candidate descendant-process termination test failed; repair counter exhausted. | Native process-lifecycle tests are another historical source of verification failure. They were not rerun. |
| 2026-09-02, `05-46-49-202Z` | Invalid APPEND_JSONL operation ledger prevented both scope and final deferred-outcome recording, then triggered semantic-cycle stopping. | All three current journals have valid version-1 operation ledgers. This specific persisted-state problem was not reproduced in current data. |
| 2026-09-02, `09-42-49-632Z` | Independent review failed three times before launch because run-scoped instruction adaptation failed. Earlier candidate tests also failed in terminal/process lifetime behavior. | A separate provider-launch prerequisite failure. Persisted instruction diagnostics and delivery receipts are truncated, so the decisive lower-level adaptation cause cannot be reconstructed reliably from the stored record. |

The historical user records reside under `C:/Users/andreas-ehrhardt/AppData/Roaming/machdoch/ralph/runs`. Current persisted records and trace helpers cap nested data at depths 4 and 6 respectively. Essential error codes, diagnostic categories, and recovery prerequisites should have dedicated bounded fields rather than depending on deeply nested provider metadata surviving those caps.

## Verification performed

- Read and cross-checked the screenshot, both workspace records, their full block results, saved flows, retained/archived plans, relevant trace events, and all eight historical user records.
- Reproduced rejection of the Refactor registry; verified the Code Improvement registry parses successfully.
- Reproduced loss of a templated scope strategy while literal `priority` is retained.
- Reproduced PID-only verification inequality; confirmed that the ten recorded libclang baseline failures have ten distinct retry signatures.
- Verified the failing test-profile bindings match the dependency's bundled bindings by SHA-256.
- Reproduced the native prerequisite failure with `cargo check --locked`.
- Validated all three current APPEND_JSONL operation ledgers.
- Confirmed that current run-summary code reports the two old July runs as abandoned.
- Ran 10 targeted business-logic test files: **141 tests passed**. Coverage included scope registry parsing, utility configuration coercion, verification comparison, autonomy outcomes, starter definitions/upgrades, append ledgers, failure signatures, repository work yield, and autonomy integration.

No UI tests, browser automation, or development servers were run. No fixes were applied to production code or retained runtime state. The existing uncommitted application changes were preserved. Native compilation/tests, Python behavior, the health cancellation race, and successful post-repair flow execution could not be verified in the current environment. Passing the existing business-logic tests does not refute the recorded defects: several behaviors are deliberately accepted by the current implementation or lack assertions for these failure conditions.

## Recovery order

1. Preserve the failed records and archive the incompatible Refactor registry; regenerate its current scope state rather than relabeling old data.
2. Repair the Windows native toolchain and regenerate the affected whisper artifacts without the bundled-bindings override. Establish usable Python verification for Python tasks.
3. Fix the shared verification boundary: an early dependency failure must not count as completed task verification. Correct the two affected task dispositions or reverify them successfully before relying on their completed state.
4. Fix stable diagnostic identity, repeated inconclusive accounting, prerequisite routing, and task-specific command selection.
5. Preserve scope-strategy templates and concrete error causes; distinguish advisory scope observations from affirmative scope verification.
6. Resolve the retained health lifecycle concerns, then resume the saved work with the corrected execution boundary and verify actual completion.
