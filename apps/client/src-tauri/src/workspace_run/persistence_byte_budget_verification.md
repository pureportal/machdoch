# Persistence byte budget verification

Task: `enforce-exact-run-document-byte-budget`.

## Frozen local plan (before production edits)

Baseline: HEAD `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`, preserving the supplied dirty workspace. Original persistence SHA-256: `5D763BE2087E14968641120F55FE6FC5BF388723F24F84EEE11B61D85D6AC2A3`.

Evidence directory: `.machdoch/ralph/runs/2026-09-09T23-30-29-571Z/code-improvements/persistence-byte-budget/` at repository root. It retains the original source, status, unrelated-file hashes, baseline harness source, and command logs.

Fixtures: eight valid current-schema tasks, each with 24 environment entries. Fill values with ASCII `x` or UTF-8 `é`, using ASCII remainder bytes, to obtain complete pretty-printed output plus one LF of exactly 1,048,575, 1,048,576, and 1,048,577 bytes. The last fixture has a serialized body of exactly the old limit. Each value remains at most 8,192 bytes and each task remains below the environment aggregate limit.

Save and load cases use the same fixtures on baseline and candidate. Accepted saves must match all expected bytes, end with LF, and reload identically. Rejected saves must preserve an existing ordinary valid document byte-for-byte. Direct loads accept the first two sizes and reject the third before parsing.

A private reader seam will first extract the baseline's existing unbounded read-to-string behavior without changing its size policy or parse handling. The identical counting-reader harness then exercises that seam on baseline and candidate with short reads and inputs of limit minus one, limit, limit plus one, and limit plus 8,192 bytes. It checks both the result and consumption of at most 1,048,577 bytes. Additional cases cover an invalid UTF-8 detection boundary, malformed JSON, invalid UTF-8 below the limit, missing files, ordinary round trips, and propagated I/O errors. No filesystem timing races are used.

Commands from `apps/client/src-tauri`, with exit codes retained:

1. `cargo test workspace_run::persistence`
2. `cargo test`
3. Candidate: `rustfmt --edition 2021 --check src/workspace_run/persistence.rs src/workspace_run/persistence_byte_budget_tests.rs`
4. Candidate: `git diff --check -- src/workspace_run/persistence.rs`

The supplied engine baseline full suite passed 682 tests, with 18 ignored. Run both Cargo commands with the unchanged regression harness before and after the fix; baseline regression failures are expected.

## Local execution results

Frozen test-source SHA-256: `5D8C15F1B7CF4EE45C8C5BE023EF7A3E19F818DD94E978C1B8CA11CB33147F5F`. This source is unchanged between baseline and candidate.

| Run | Exit | Result |
| --- | --- | --- |
| Baseline `cargo test workspace_run::persistence` | 101 | 18 passed, 5 failed |
| Baseline `cargo test` | 101 | 693 passed, 8 failed, 18 ignored |
| First candidate focused attempt | 101 | No tests executed: Windows LNK1104 while the baseline executable was still running |
| Candidate focused retry | 0 | 23 passed, 0 failed |
| Candidate `cargo test` | 101 | 691 passed, 10 failed, 18 ignored; all 23 persistence tests passed |
| Supplemental candidate `cargo test -- --test-threads=1` | 101 | 698 passed, 3 failed, 18 ignored; all 23 persistence tests passed |

The five baseline persistence failures are both ASCII/UTF-8 saves at 1,048,577 persisted bytes, reader acceptance at limit plus one, consumption of 1,056,768 bytes instead of at most 1,048,577, and consumption of 1,048,578 bytes at the split UTF-8 boundary. Both oversized saves replaced the previous valid document.

The baseline full-suite binary was compiled from the frozen reader-seam baseline before the size-policy changes. The additional three baseline failures were `terminal_starts_resizes_streams_and_stops`, `workspace_supports_mixed_powershell_and_command_prompt_sessions`, and `discovers_deep_repositories_submodules_and_gitfile_worktrees` (Git timed out after 120 seconds). These files were not changed by this task. The first candidate link overlapped baseline test execution; subsequent verification waits for that executable to exit.

Formatting and scoped `git diff --check` passed. All 89 pre-existing dirty/untracked files matched the saved hashes. No dependencies, schemas, public APIs, task lifecycle fields, or servers were changed.

The candidate default-concurrency full run failed in auxiliary CLI, Ralph stop, model-catalog child-process, Workspace Run manager, and terminal tests outside the changed persistence code. A supplemental `cargo test -- --test-threads=1` run is used to investigate concurrency-sensitive failures after the first full run has exited. Its result does not replace the original command's recorded failure.

The serial run completed in 816.59 seconds. Its remaining failures are `workspace_tools::terminal::tests::long_running_command_continues_until_workspace_cleanup`, `terminal_drains_high_line_count_output_before_natural_exit`, and `workspace_supports_mixed_powershell_and_command_prompt_sessions`. No persistence test failed. Main-target and doc-test execution for the full runs was prevented by the library test failures; the focused candidate command also executed the main target with zero tests successfully.

Implementation and focused local regression verification are complete. Full-suite verification is not green. Resume by resolving or establishing the terminal test failures outside this task, rerunning the recorded Cargo commands with this unchanged harness, and obtaining engine-owned capture/validation. Do not mark this checkpoint as fully verified based only on the passing focused run or the unrelated supplied validator feedback.

## Subsequent validation recheck, 2026-09-10

No Rust source or test changes were made in this recheck. The existing byte-budget implementation and unique temporary-workspace counter remain in place. The boundary harness SHA-256 still matches the frozen local source above.

`cargo test workspace_run::persistence` exited 0: 23 passed in 0.83 seconds; the main target passed with zero tests. The recorded rustfmt and scoped whitespace checks also exited 0.

The exact supplied `cargo test` command with its PowerShell exit guard exited 101: 692 passed, 9 failed, 18 ignored in 413.36 seconds. All 23 persistence tests passed. Captured test output is retained at `target/persistence-validation-recheck-full.log`. Failures were the auxiliary CLI success-output test; manager fast-output, configured-directory, retained-output, sequential rapid-exit, and descendant-stop tests; and terminal background-output, mixed-shell, and high-line-count tests. The Git discovery, Ralph stop, manager crash recovery and concurrent-start, and terminal start/resize/stop tests passed this time. The high-line-count test received output but exceeded its 120-second exit deadline.

These results do not establish a causal connection between the remaining process/terminal failures and the persistence change. No timeouts were relaxed and no unrelated implementation was changed. Full-suite main-target and doc-test execution remains blocked by library failures. Engine-owned validation remains pending; retain this checkpoint. The supplied health-probe review and settings-recovery validation concern different tasks and cannot adjudicate this task.

## Evidence ownership checkpoint

No engine freeze/verification operation is exposed by the available tools. This document and local command logs are reproducible agent evidence, not a claim of engine-owned verification. Engine capture/validation remains pending; task lifecycle fields are left to SELECT_JSON_TASK and MARK_JSON_TASK. Non-Windows execution is not available in this workspace.

## Current validation-failure recheck, 2026-09-10

No Rust source or test changes were made. `cargo test workspace_run::persistence` exited 0: 23 passed in 1.06 seconds, followed by a successful main target with zero tests. Log: `target/persistence-budget-current-focused.log`. Both persistence files passed rustfmt checking, scoped `git diff --check` passed, and the boundary harness SHA-256 remains `5D8C15F1B7CF4EE45C8C5BE023EF7A3E19F818DD94E978C1B8CA11CB33147F5F`.

The supplied `cargo test` command with its PowerShell exit guard exited 101: 699 passed, 2 failed, 18 ignored in 239.06 seconds. Log: `target/persistence-budget-current-full.log`. All persistence tests and the supplied failing `terminal_drains_high_line_count_output_before_natural_exit` test passed. Failures were `media::provider_local_diffusers::tests::worker_timeout_terminates_descendant_processes` (descendant survived timeout) and `workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions` (captured only partial command input). Neither failure establishes a causal connection to the byte-budget change. No unrelated code or test deadlines were changed.

Full-suite main-target and doc-test execution remains blocked by library failures. Retain this checkpoint pending engine adjudication of the process-test failures and engine-owned verification. Task state remains unchanged.

## Validation failure repair, 2026-09-10

The initial focused rerun exited 101: 21 passed and 2 failed. Concurrent boundary cases reused the same `load-boundary` workspace label with timestamp-only uniqueness. One case failed removing its workspace with access denied; another loaded the missing-file default instead of its fixture. The shared persistence test helper now adds a process-local atomic counter to each directory name, preventing concurrent cases from sharing a directory even when clock readings coincide. Production persistence code and the frozen boundary test source are unchanged by this repair.

Commands ran from `apps/client/src-tauri`. Logs are retained under `target/`:

| Command | Log | Exit | Result |
| --- | --- | --- | --- |
| `cargo test workspace_run::persistence` before repair | `persistence-validation-focused.log` | 101 | 21 passed, 2 failed |
| `cargo test workspace_run::persistence` after repair | `persistence-validation-focused-repaired.log` | 0 | 23 passed; main target passed with zero tests |
| `cargo test` after repair | `persistence-validation-full-repaired.log` | 101 | 693 passed, 8 failed, 18 ignored in 584.58 seconds |

The full run passed all persistence cases. Its remaining failures were manager tests `recovers_once_from_a_crashed_process`, `repeated_concurrent_starts_launch_one_process`, and `retains_stdout_and_stderr_after_successful_exit`; terminal tests `long_running_command_continues_until_workspace_cleanup`, `terminal_drains_high_line_count_output_before_natural_exit`, `terminal_starts_resizes_streams_and_stops`, and `workspace_supports_mixed_powershell_and_command_prompt_sessions`; and Git test `discovers_deep_repositories_submodules_and_gitfile_worktrees`. These failures report process-output timeouts, missing process markers, missing PTY output, or a Git timeout. Their relationship to the persistence change has not been established; their implementations were not modified in this repair.

The existing rustfmt command and scoped `git diff --check` passed after the helper change. The boundary source still hashes to `5D8C15F1B7CF4EE45C8C5BE023EF7A3E19F818DD94E978C1B8CA11CB33147F5F`. Full-suite main-target and doc-test execution remains blocked by library failures. This checkpoint remains resumable pending resolution or engine adjudication of the remaining suite failures and engine-owned validation; no task state was changed.

## Latest scoped failure recheck, 2026-09-10

No production or test source changes were needed or made. The existing implementation counts the trailing LF before atomic writing and reads one opened file through a budget-plus-one bounded reader. The boundary harness hash still matches the frozen local source.

`cargo test workspace_run::persistence` exited 0 with 23 passed in 1.36 seconds; the main target passed with zero tests. Log: `target/persistence-budget-fix-focused.log`. Rustfmt for both persistence Rust files and scoped `git diff --check` passed.

`cargo test` exited 101 with 699 passed, 2 failed, and 18 ignored in 251.15 seconds. Log: `target/persistence-budget-fix-full.log`. All persistence cases passed. Remaining failures were `workspace_run::manager::tests::repeated_concurrent_starts_launch_one_process` (missing start-marker file) and `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit` (120.0177493-second deadline, 187,301 output bytes). The supplied failing start/resize/stop and mixed-shell terminal cases passed this time.

The remaining failures do not establish a persistence regression. No unrelated code or timeout changes were made. Full-suite main-target and doc-test execution remains blocked by library failures. Engine-owned freeze and adjudication are unavailable through this invocation's tools, so this checkpoint remains pending engine verification and resolution or attribution of the process-test failures. Task state was not modified.
