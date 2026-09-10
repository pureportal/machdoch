# Model-install cancellation checkpoint

## Current review repair checkpoint (2026-09-10)

The supplied FIX review was confirmed against the working diff: `model_install.rs` only registers the preparation test module; the production cancellation improvement is unimplemented. The supplied baseline and candidate general suites both passed, but do not verify cancellation during network waits or the activation race. The supplied clipboard validation is unrelated and was excluded from this task.

This invocation inspected the available tool catalog and queried `mcp__machdoch__mcp_search_tools` for `verification`; the result was zero tools. No engine-owned task-specific freeze is supplied or callable. The explicit requirement to obtain that freeze before production edits remains a concrete blocker. No production or test source, task state, install records, or partial downloads were changed. No servers were started. Tests were not rerun in this invocation because the blocker precedes implementation and the supplied passing suites do not resolve it.

Resume from the proposed freeze and scenario matrix below: obtain the engine-owned baseline identity, exact commands, one-second acceptance-to-settlement bound, and activation-race expectations; complete and run identical deterministic fixtures on baseline and candidate; implement cancellation coordination only after the required freeze. All transport timing, retained-byte/resume, concurrent executor, and activation-race acceptance criteria remain unverified. This checkpoint is not engine-owned completion evidence.

Task: `bound-model-install-cancellation-latency`

Plan: `improvement-58e46c97e12aa204d6d12eb4a70e27a1`

Run: `2026-09-09T23-30-29-571Z`

## Blocking prerequisite

Production code is unchanged. The task explicitly requires an engine-owned freeze of the cancellation baseline, commands, timing measurement points, and activation-race expectations before production edits. The supplied engine observation covers only the general `cargo test` suite (671 passed, 18 ignored). It does not establish the cancellation scenarios. No callable tool in this invocation creates a Ralph verification freeze or executes a verification block with a baseline role. Ordinary shell execution is available, but does not establish that engine-owned record.

This document is a proposed verification plan and resumable checkpoint, not a frozen engine plan or completion evidence. Task lifecycle fields have not been changed. Existing unrelated changes, including import-integrity work, remain untouched. No servers were started.

## Baseline identity

- HEAD: `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`.
- Supplied workspace snapshot: `2026-09-10T05:44:20.654Z`, with pre-existing changes preserved.
- Unmodified `src/media/model_install.rs` Git blob: `168cbc315fb967ad372a92f2f4d650744e9e313b`.
- File SHA-256: `27b5d235cf71746238c0d240cd8c57cc096282d3775c6d802723ac25895b7f4b`.
- Supplied engine general-suite fingerprint: `cd1d42b465f53ceaa63a2d59f1ec012238473d952f85884f4fc8b9da1465c356`.

## Proposed freeze for the next engine pass

Working directory: `C:\Development\machdoch\apps\client\src-tauri`.

Commands, each with its process exit code retained:

1. `cargo test media::model_install::cancellation_tests -- --nocapture --test-threads=1`
2. `cargo check`
3. `cargo test`

The focused module now contains three preparation tests against unchanged production behavior: cancellation before execution, cancellation before activation, and repeated cancellation with database job isolation and terminal-state preservation. Transport fixtures, explicit resume, and concurrent executor coverage remain outstanding. Freeze the fixture and instrumentation diff separately from production edits. Run identical focused cases on baseline and candidate. All candidate regression cases must be enabled, with no ignored cancellation regressions. Preserve raw outputs and measured elapsed times for both runs.

Use an in-process controlled transport, temporary SQLite database, and temporary model staging directory; no credentials, external requests, or listening servers. Ensure any test seams leave baseline cancellation behavior unchanged. Use a 65,536-byte payload repeating byte values 0 through 255, with its independently calculated SHA-256 pinned in the fixture. Every test transfer remains below the 33,554,432-byte persistence threshold. Coordinate waits through explicit barriers, not guessed sleeps.

Measure using a monotonic clock from immediately after `request_cancellation` returns an accepted `canceling` job until the executor has returned and SQLite reports `canceled`. The candidate bound is at most 1,000 ms for each network-wait scenario. Record the cancellation call duration separately. Release fixture barriers after recording a baseline timeout so pending baseline work is drained; inspect its eventual terminal state and activation artifacts as well. Never label a timeout as a pass.

| Scenario | Required observation |
| --- | --- |
| Before request start | Accepted cancellation settles as canceled without a transport request or activation. |
| Headers pending | Cancel after the request is observed but before headers are released; executor settles within the bound while headers remain withheld. |
| Body pending | Release headers and 4,096 bytes, then withhold the next body chunk; cancellation settles within the bound. |
| Slow transfer | Release 256-byte chunks every 100 ms; cancel after the first write. Settlement meets the bound without reaching the progress threshold. |
| Restarted request headers | Begin with retained partial bytes, return a response that causes the existing full-download restart, and withhold restart headers; cancellation interrupts that wait too. |
| Before final verification | Pause after the final body write, accept cancellation, then release verification; the job cannot become installed. |
| Immediately before activation | Pause before the activation transition, accept cancellation, then release it; no staging-directory activation rename or active pointer is published. |
| Activation wins | Complete the atomic activation claim before requesting cancellation; the request must not report acceptance, and normal activation retains its correct terminal state. |
| Explicit resume | After cancellation, compare actual retained bytes, per-file progress, total job progress, and verified-file counts. Reopen SQLite, resume explicitly, verify the requested range and final digest, and finish successfully. |
| Isolation and repetition | Run two jobs with separate staging paths; cancel one twice while the other completes. The first remains canceled, the second installed. Repeated cancellation of a terminal job preserves its state. |
| Ordinary completion | Complete the same fixture without cancellation, checking final bytes, activation artifacts, and installed database state. |

For canceled transfers, assert that the partial file is an exact payload prefix, persisted per-file and job byte counts equal retained bytes, and no quarantine/discard occurs. Exercise both a fresh partial and an existing resumable partial. A subsequent explicit resume must be independent of the prior cancellation signal and must not launch a second executor for an unfinished attempt.

## Implementation boundary after the freeze

Keep one cancellation coordination path per install. Make initial and restarted header waits and each body wait interruptible independently of progress persistence. Preserve and persist the bytes already written when settling cancellation through the existing canceled state. Coordinate verification and the activation claim with cancellation acceptance so a stale stage write cannot reopen cancellation after activation has begun. Keep dependency, schema, and public API changes out unless demonstrated necessary.

Review synchronous partial-file hashing and final verification as part of that coordination; a canceled worker must not continue into publication. Retain existing crash-recovery behavior and explicit resume semantics. Do not reset or delete user install records or partial downloads when reverting this task.

## Local checks

- `cargo check`: passed, exit 0. Existing `desktop_task_activity_elapsed` dead-code warning only.
- `cargo test`: passed, exit 0; 671 passed, 0 failed, 18 ignored, 56.94 seconds. Main and doc-test targets also passed with zero tests. Raw output is retained in `target/model-install-cancellation-baseline.log`. These counts match the supplied general baseline; no tests were added or ignored in this pass.
- Cancellation timings, controlled transport behavior, activation races, partial-byte consistency, and resume: not executed or verified.

Resume by obtaining the engine-owned preparation/freeze and task-specific baseline described above, then implement the cancellation changes, run the identical candidate cases, and retain engine-owned comparison evidence before declaring completion.

## Fix-validation preparation

The current invocation inspected the callable tool catalog: no Ralph verification-freeze operation is exposed. `mcp__machdoch__mcp_search_tools` with query `verification` returned `count: 0`. No engine-owned task-specific freeze has been created or asserted.

The engine shell command `cargo test media::model_install::cancellation_tests -- --nocapture --test-threads=1` initially returned exit 0 with **zero tests** (689 filtered out). After adding test-only fixtures, the same engine tool returned `isError: true` during compilation without an exit code or test result. This is inconclusive, not a passing baseline. Local preparation logs are retained separately under `target/model-install-cancellation-*-preparation.log`; these do not substitute for the required engine-owned freeze or comparison.

Only a `cfg(test)` module declaration and the separate test file change Rust source. Network waits, progress persistence, verification, and activation production behavior are unchanged. No task state or server was changed. The clipboard validation remains outside this task.

Preparation results:

- Focused local command: exit 0, 3 passed, 0 ignored. Before-start request duration 112.2913 ms; acceptance-to-settlement duration 39.4054 ms.
- Engine shell retry after compilation: exit 0, 3 passed, 0 ignored. Before-start request duration 50.9356 ms; acceptance-to-settlement duration 40.2542 ms. The response contains ordinary command output, no frozen plan identifier, baseline role, or behavioral comparison.
- `cargo check`: exit 0, existing `desktop_task_activity_elapsed` warning only. Raw output: `target/model-install-cancellation-check-preparation.log`.
- `cargo test`: exit 0, 674 passed, 0 failed, 18 ignored, 62.31 seconds; main and doc-test targets passed. Raw output: `target/model-install-cancellation-suite-preparation.log`. This adds the three preparation tests to the supplied 671-test passing baseline without changing ignored tests.

The preparation tests do not establish stalled-header/body latency, slow-transfer latency, cancellation during final verification, a concurrent activation race, retained partial-byte consistency, explicit resume, or ordinary download completion. The selected task remains incomplete; the next pass needs the engine freeze plus the remaining transport fixtures before production edits.

## Reported suite failure repair (2026-09-10)

The supplied failure was a missing descendant PID file in `agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers`. Its 1.5-second command timeout also covered starting the test executable and spawning the descendant. The unchanged test passed in isolation (1 passed, 2.15 seconds including cleanup), consistent with a startup scheduling failure under suite load rather than demonstrated cancellation-related production regression.

Changed only that test's command timeout to 10 seconds, matching neighboring command tests. Descendant-exit and timeout-error assertions remain intact. This increases scheduling tolerance; it does not make process startup deterministic or change production timeouts.

Local verification after the repair:

- `cargo test`: exit 0; 674 passed, 0 failed, 18 ignored, 66.18 seconds. Main and doc-test targets also passed. Log: `target/model-install-cancellation-repair-suite.log`.
- `cargo check`: exit 0; existing `desktop_task_activity_elapsed` warning only. Log: `target/model-install-cancellation-repair-check.log`.
- `cargo test media::model_install::cancellation_tests -- --nocapture --test-threads=1`: exit 0; 3 passed, 0 ignored. Before-start cancellation request: 75.8832 ms; acceptance-to-settlement: 48.4759 ms. Log: `target/model-install-cancellation-repair-focused.log`.

The callable catalog was checked again; `mcp__machdoch__mcp_search_tools` with query `verification` returned zero tools. The explicit engine-owned freeze prerequisite remains unavailable. These local results do not constitute an engine freeze or baseline/candidate cancellation comparison. Model-install production behavior and task state remain unchanged. Resume with the engine-owned freeze and identical transport scenarios specified above; the cancellation improvement is still incomplete.
