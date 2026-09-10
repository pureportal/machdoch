# Shell-state partial persistence verification

## Implementation pass 3: implementation retained, verification blocked

The implementation, atomic writer, and persistence tests match the engine snapshot captured at `2026-09-10T04:04:40.285Z` byte for byte. All recorded baseline file hashes matched before this verification-record update. No executable source, assertions, dependencies, schemas, public APIs, or task lifecycle fields changed. The existing frozen failure matrix and historical behavioral comparisons below remain intact; this pass does not substitute Git HEAD for the supplied dirty baseline.

From `apps/client/src-tauri`, `cargo test shell_state` passed all 16 tests, including all seven persistence cases. `rustfmt --edition 2021 --check src/shell_state.rs src/shell_state_persistence_tests.rs src/atomic_file.rs` and scoped `git diff --check` passed. `cargo test --all-targets` exited 101: 668 passed, 3 failed, 3 ignored in 119.95 seconds. All shell-state cases passed. Failures:

- `media::provider_local_diffusers::tests::worker_timeout_terminates_descendant_processes`: the worker's descendant survived its process-tree timeout (`provider_local_diffusers.rs:4275`). This test passed in the supplied engine baseline and remains an unresolved differing outcome.
- `runtime_snapshot::model_catalog::command_tests::agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers`: descendant PID file missing (`command_tests.rs:70`); also failed in the supplied baseline.
- `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`: final numbered stress line truncated (`terminal.rs:2413`); also failed in the supplied baseline.

The baseline mixed-shell failure passed in this run. These observations neither establish the causes of differing results nor constitute an authoritative regression disposition. Full command output and source/log hashes are retained under `target/shell-state-review/implementation-pass-3-*`.

Resume checkpoint: the shell-state repair is present and its focused tests pass, but required broad verification remains incomplete. No engine comparison/registration tool is exposed in this invocation. The supplied shortcut review requests changes to engine verification outside this selected shell-state task; no such changes were made. Resume the engine-owned comparison using its frozen artifacts and resolve the differing broad outcome before completion. Native Unix durability behavior and native Tauri command invocation remain unverified. No servers were started.

## Implementation pass 2: existing repair verified, broad checks unresolved

The selected task's implementation is already present in the engine snapshot captured at `2026-09-10T03:09:14.517Z`. SHA-256 checks match that snapshot for `shell_state.rs`, `atomic_file.rs`, and `shell_state_persistence_tests.rs`. No executable source, test expectations, dependencies, schemas, public APIs, or task lifecycle fields changed in this pass. The earlier frozen failure matrix and baseline/candidate behavioral evidence remain intact. The supplied managed-prompt review finding concerns a different task.

`cargo test shell_state` passed all 16 tests, including all seven persistence regressions. `rustfmt --edition 2021 --check src/shell_state.rs src/shell_state_persistence_tests.rs src/atomic_file.rs` and scoped `git diff --check` passed. `cargo test --all-targets` exited 101: 658 passed, 2 failed, 3 ignored in 158.70 seconds. All shell-state tests passed in the broad run. The failures were `workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions` at `terminal.rs:2092` and `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit` at `terminal.rs:2413`. Both test names also failed in the supplied engine baseline (650 passed, 10 failed, 3 ignored); the output-draining assertion differs from that baseline. This does not establish the cause of the failures or resolve the required engine-owned comparison.

Resume checkpoint: production repair and focused verification are complete; overall verification remains incomplete. This invocation has no engine comparison tool. Native Unix durability behavior and native Tauri command invocation remain unverified. Preserve the frozen snapshots and resume authoritative verification through the engine. New logs and source/log hashes are retained under `target/shell-state-review/implementation-pass-2-*`. Only this verification record was changed in the source tree.

## Latest validation resume: supplemental broad suite passes

No executable source or task lifecycle state changed in this attempt. `cargo test shell_state` passed all 16 tests. `cargo test --all-targets` exited 0: 656 passed, 0 failed, 1 ignored in 64.96 seconds. Both failures named in the supplied candidate result passed, as did the previously unresolved terminal cases. Scoped `git diff --check` passed. Full output and source/log SHA-256 hashes are retained in `target/shell-state-review/validation-resume-broad.{log,json}`.

This passing rerun does not establish the cause of prior intermittent failures. The required engine-owned matched comparison is still unavailable through this invocation's tools; its INCONCLUSIVE disposition is unchanged. Preserve the existing frozen baseline/candidate artifacts for that comparison. Task completion remains blocked on authoritative verification; native Unix behavior remains unverified. No assertions were weakened and no speculative production repair was made.

## Fix-validation attempt: engine verification unavailable

No executable source or task lifecycle state changed in this attempt. `cargo test shell_state` passed all 16 tests; scoped `git diff --check` passed. Working, frozen baseline, and frozen candidate `src/workspace_tools/terminal.rs` all have SHA-256 `7a54ee2fde3fc4ea83685b85a23c345d90dc35fb1dc94cb053b62dffaffcf3a0`. Identical source alone does not establish behavioral equivalence.

The supplemental `cargo test --all-targets` rerun exited 101: 651 passed, 5 failed, 1 ignored, in 168.95 seconds. Full output is retained at `target/shell-state-review/fix-validation-broad.log`. Failures: `workspace_run::manager::tests::keeps_fast_output_bounded_and_publishes_it_while_running`, `workspace_run::manager::tests::launches_from_the_configured_workspace_directory`, `workspace_tools::terminal::tests::long_running_command_continues_until_workspace_cleanup`, `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`, and `workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions`. The mixed-shell capture shows only partially echoed command input before its deadline. This is diagnostic evidence, not proof of the cause or a basis for relaxing assertions.

The invocation exposes no engine verification interface to execute or register the required authoritative baseline/candidate comparison. Existing frozen snapshots, engine evidence, and the resumable checkpoint remain intact. Broad verification therefore remains INCONCLUSIVE; this attempt does not establish completion or repair test nondeterminism. Native Unix behavior remains unverified. Resume with the engine-owned matched verification facility; do not substitute these supplemental results for its comparison.

## Review repair: frozen supplemental plan

Before further production edits: use engine baseline commit `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee` and isolated source archives. Add path-scoped deterministic post-replacement directory-sync failure injection to the atomic writer in test builds only. Retain the original before-replacement and revision-file cases. New warm/cold-cache and settings-transfer cases require an incomplete-persistence error, authoritative/cache revision agreement, stale CAS rejection, and successful recovery preserving saved changes. Run the same new cases on the review-entry implementation and repaired implementation.

Commands: `cargo test shell_state::persistence_tests -- --nocapture`, `cargo test shell_state`, `cargo test --all-targets`. For matching broad diagnostics run `cargo test --all-targets -- --test-threads=1` sequentially in baseline and candidate archives, retaining per-test statuses and native exit codes. Supplemental results do not replace the engine-owned comparison; unresolved comparison remains incomplete. All artifacts go under `target/shell-state-review`; no lifecycle fields are modified.

The repair marks atomic-file errors raised after successful Unix rename, including parent-directory open and sync failures. Shell-state persistence handles that marker as incomplete persistence and reconciles both asynchronous CAS and blocking settings-transfer caches before returning the existing string error. Before-replacement errors remain ordinary failures. The new deterministic tests simulate directory-sync failure after a real atomic replacement on Windows; native Unix execution remains unavailable on this host.

Review-entry behavioral result: 4 passed, 3 failed (exit 101). The failures are the new warm-cache, cold-cache, and settings-transfer directory-sync cases. All existing persistence cases pass. This run retains the unrepaired shell-state implementation and adds only the error classification and injection needed to reproduce the review finding.

The engine baseline archive was reconstructed from its commit plus all 20 recorded changed files; every changed-file SHA-256 matched the engine record. Evidence: `target/shell-state-review/baseline-hashes.json`. Toolchain: rustc 1.97.1 and cargo 1.97.1. A verification-only offline attempt failed to link ONNX Runtime because its build script skips native-library download in offline mode. That attempt is retained as `offline-link-blocker.{json,log}`; subsequent runs use the normal environment with only a shared `CARGO_TARGET_DIR` override. No dependency configuration was changed.

For the broad comparison, the baseline execution tree is preserved as `baseline-frozen` after its run. The separately frozen candidate files are then staged into the same isolated execution directory (`baseline/apps/client/src-tauri`). This keeps execution paths identical and reuses compilation artifacts. It does not modify the working repository or test expectations. The candidate Unix injection point is immediately before `directory.sync_all()`; its Windows simulation has the same error and replacement semantics as the review-entry run.

Serial baseline result: 646 passed, 3 failed, 1 ignored (exit 101; test time 640.96 seconds). All 650 top-level test statuses were parsed, excluding nested child-test output; counts agree with the harness summary. Failures: `child_process::tests::direct_process_group_configuration_does_not_suspend_child`, `desktop_task::ralph::tests::ralph_stop_preserves_cooperative_cancellation_window`, and `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`. Full evidence is retained in `baseline-serial.log`, `baseline-serial.json`, and `baseline-serial-parsed.json` under the artifact directory.

Candidate behavioral result: 7 passed, 0 failed (exit 0; test time 0.91 seconds). All three review regressions now pass, alongside the four existing persistence cases. The logs verify snapshot/cache agreement, unchanged authoritative bytes on stale CAS, incomplete-persistence error messages identifying saved revisions, and recovery preserving prior changes. Evidence: `candidate-behavior.{json,log}`.

`cargo test shell_state`: 16 passed, 0 failed (exit 0). `source-comparison.json` confirms exactly three executable-source differences against the frozen baseline: `src/atomic_file.rs`, `src/shell_state.rs`, and the added `src/shell_state_persistence_tests.rs`. The frozen candidate matches the working-tree versions byte for byte. Formatting and scoped whitespace checks pass.

`cargo test --all-targets`: 655 passed, 1 failed, 1 ignored (exit 101; test time 111.19 seconds). All shell-state cases pass. The only failure is `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`, asserting that the final numbered stress line should not be truncated at `terminal.rs:2413`. That exact assertion also fails in the isolated serial baseline. Evidence: `candidate-broad.{json,log}`. This is supplemental evidence, not a replacement for the engine-owned comparison.

Serial candidate result: 654 passed, 2 failed, 1 ignored (exit 101; test time 339.46 seconds). All 657 top-level statuses were parsed and agree with the harness summary. `serial-comparison.json` retains the complete comparison and log hashes; `candidate-serial-parsed.json` retains individual statuses. The baseline process-group and Ralph cancellation failures pass on the candidate. Terminal output draining fails in both. `workspace_supports_mixed_powershell_and_command_prompt_sessions` passes in the serial baseline but fails in the serial candidate with incomplete PowerShell command output. It passes in the default candidate broad run and in an isolated exact-test rerun of the same candidate executable (exit 0; `candidate-mixed-isolated.{json,log}`). The observed intermittency does not establish its cause or prove engine-level equivalence. No terminal or process code was changed.

### Current resumable checkpoint

The post-rename cache repair and all focused regression checks are complete. Broad verification remains incomplete: terminal-output draining fails in both source snapshots, the mixed-shell serial outcome differs intermittently, and the engine-owned comparison remains INCONCLUSIVE. All comparison records here are supplemental; no engine evidence or task lifecycle fields were modified. A future engine-owned run must resolve the comparison before this task is complete. Native Unix execution and native Tauri command invocation were not performed; Windows tests exercise the production persistence/cache helpers and simulate post-replacement directory-sync failure, with an actual pre-sync injection point provided for Unix test execution.

Retained artifacts: `target/shell-state-review/` contains reconstructed/frozen source snapshots, source hashes, exact commands, full logs, structured per-test results, comparison output, and diagnostic scripts. Resume from these results rather than repeating discovery or changing unrelated state.

## Historical first-pass verification

The following is the earlier implementation record; the review-repair section above supersedes its completion and coverage statements.

Task: reconcile-shell-state-after-partial-persistence.
Engine baseline: f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee, captured 2026-09-09T23:30:39.771Z.
The target file is unchanged against that baseline. Existing fleet-protocol and product-ui changes are preserved.

## Frozen plan (before production edits)

Use isolated temporary storage and the real atomic writer. Extract path-based storage and commit functions without changing behavior so identical tests exercise baseline and candidate independently of a native Tauri application.

| Failure | Expected result | Authoritative snapshot and cache | Recovery |
| --- | --- | --- | --- |
| Before snapshot replacement: on Windows hold the snapshot open with read/write sharing but no delete sharing | Error; no publication of proposed state | Previous state/revision remain authoritative; proposed state never cached | Release handle; commit with previous revision succeeds |
| Revision replacement: revision destination is a directory | Error explicitly says snapshot was saved and revision persistence failed | Snapshot and cache both contain proposed state and incremented revision | Old revision rejected; current revision accepted; after removing obstruction, next patch preserves saved change and fresh load agrees |

Baseline tests must retain candidate expectations and record failures rather than accepting old behavior. Collect observations before final assertions so baseline evidence includes disk, cache, stale CAS, and recovery outcomes.

Exact commands, from apps/client/src-tauri (PowerShell):

```powershell
cargo test shell_state::persistence_tests -- --nocapture
cargo test shell_state
cargo test --all-targets
rustfmt --edition 2021 --check src/shell_state.rs src/shell_state_persistence_tests.rs
git diff --check
```

Each cargo command propagates its native exit code. Run the focused behavioral command before the fix and unchanged after it. Run the two required suites after the fix. The engine-owned broad baseline is 643 passed, 6 failed, 1 ignored (exit 101); its six process/timing failures remain unresolved unless candidate verification establishes otherwise. No servers or real user state are involved.

## Results

Baseline behavioral run: 1 passed, 2 failed. The Windows snapshot replacement failure preserved the exact original bytes and cache at revision 7; recovery committed revision 8. Both revision-file failures wrote revision 8 but left the warm cache at 7 or the cold cache empty. Stale CAS correctly rejected revision 7 using disk revision 8. A current CAS wrote revision 9 but left cache at 8. Recovery reached revision 10 and preserved both saved changes. Both failing cases reported `cache_matches=false, current_cache_matches=false, accurate_error=false`.

The baseline run used only mechanical extraction of existing path-based I/O and commit code plus tests; the supplied engine snapshot remains the source baseline. Path resolution moved before blocking dispatch, and the revision path is resolved before writing, so the supplemental run establishes filesystem failure behavior rather than path-resolution failure behavior. No engine evidence or lifecycle fields were rewritten.

The candidate represents successful snapshot replacement with a separate complete/revision-failed outcome, publishes that snapshot to cache, and then returns incomplete persistence through the existing string error. The three settings-transfer writers share cache reconciliation; an additional candidate regression exercises their blocking persistence helper and recovery.

Candidate behavioral run: 4 passed, 0 failed (exit 0), including the same three frozen baseline cases and the additional settings-transfer regression. Warm and cold caches match the saved snapshot after each revision-file failure, and errors identify saved revisions 8 and 9. Recovery reaches revision 10, preserving original and previously saved fields. The snapshot replacement denial continues to preserve original bytes, state, and revision.

`cargo test shell_state`: 13 passed, 0 failed (exit 0).
`rustfmt --edition 2021 --check src/shell_state.rs src/shell_state_persistence_tests.rs` and `git diff --check`: passed.
All 20 pre-existing changed files match the engine snapshot's SHA-256 hashes.

At final status review, additional changes appeared in frontend/Ralph files under `apps/client/src` and `apps/client/scripts`. They were not made by this task and were preserved. The workspace-presence tool returned an empty agent list; this does not establish attribution. This task changed only `src/shell_state.rs`, `src/shell_state_persistence_tests.rs`, and this record. Final `git diff --check` passed.

`cargo test --all-targets`: 646 passed, 7 failed, 1 ignored (exit 101; 445.00 seconds). All 13 shell-state tests passed in this run. Failures:

- `runtime_snapshot::model_catalog::command_tests::agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers`: descendant PID file missing.
- `workspace_git::tests::discovers_deep_repositories_submodules_and_gitfile_worktrees`: Git submodule checkout timed out after 120 seconds.
- `workspace_run::manager::tests::stop_terminates_descendant_processes`: descendant PID deadline exceeded.
- `workspace_tools::terminal::tests::long_running_command_continues_until_workspace_cleanup`: delayed output missing.
- `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`: captured output empty.
- `workspace_tools::terminal::tests::terminal_starts_resizes_streams_and_stops`: captured output empty.
- `workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions`: PowerShell startup output incomplete.

These are different failures from the six in the supplied engine baseline. They remain unresolved; passing persistence tests does not establish a green broad suite or prove why unrelated tests failed.

Native Tauri commands are not launched; the tests exercise their extracted production commit/storage functions and the cache consumed by their read fast paths. Windows replacement-denial coverage is platform-specific; revision-destination obstruction tests are portable. Unix post-rename directory-sync failure behavior is outside these injected cases.

## Resumable checkpoint

Implementation and focused verification are finished. Broad verification is incomplete due to the seven failures above. Resume with the frozen all-targets command and investigate those failures within separately authorized scope; do not change task lifecycle fields here. No dependency, schema, or public API changes were made.

Supplemental isolated diagnostic: 0 passed, 1 failed (exit 101; 2.24 seconds), again because the descendant PID file was missing. This failure reproduces without the broad suite; its cause remains unresolved.

```powershell
& '.\target\debug\deps\machdoch_lib-f6c6923f0dfee549.exe' --exact runtime_snapshot::model_catalog::command_tests::agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers --nocapture
```

## Validation repair: parallel test storage isolation

Frozen before edits: retain all persistence expectations and failure injection. Run `cargo test shell_state -- --nocapture` up to 30 times with `RUST_BACKTRACE=full`, stopping on failure, then run the same 30 repetitions after the repair, followed by `cargo test shell_state` and `cargo test --all-targets`. Logs: `target/shell-state-review/repeat-before-N.log`, `repeat-after-N.log`, and `isolation-{focused,broad}.log`. No production changes are planned.

Before repair: runs 1-6 passed; run 7 aborted with native exit -1073740791 (0xc0000409). Full backtrace identifies duplicate path insertion at atomic_file.rs:297, followed by cleanup NotFound at shell_state_persistence_tests.rs:61. Warm/cold tests share a clock-derived directory, so clock collisions cause shared storage, duplicate fault registration, and double cleanup. Add a process-local atomic sequence to the directory identity and require exclusive creation. Preserve cleanup and fault-registration assertions.

Engine comparison remains unavailable through this invocation's tools. Frozen baseline/candidate trees and prior matched results remain preserved; supplemental checks cannot establish the required authoritative comparison. This is a concrete blocker for completion even if the local repair passes.

### Parallel isolation repair results and resumable checkpoint

Changed only the shell-state test directory allocator in this attempt: retain timestamp/process identity, append a process-local AtomicU64 sequence, and use exclusive create_dir. Production persistence code and all behavioral assertions remain unchanged. The duplicate-path failure and cleanup double panic were reproduced before this edit, as recorded above.

All 30 identical post-repair parallel `cargo test shell_state -- --nocapture` runs passed (480 shell-state cases, native exit 0 for each). Separate `cargo test shell_state` passed all 16 cases. Rustfmt checks for the three task source files and scoped `git diff --check` passed. Logs retain full persistence observations and native abort diagnostics.

Required `cargo test --all-targets` exited 101: 654 passed, 2 failed, 1 ignored in 130.81 seconds. All shell-state tests passed. Remaining failures are `workspace_run::manager::tests::failed_health_checks_stop_at_the_restart_limit` (manager.rs:2811, missing RestartLimit in recent_failures) and `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit` (terminal.rs:2413, missing final numbered line). Mixed-shell test passed in this run. Full log: `target/shell-state-review/isolation-broad.log`. No manager or terminal source was changed, and these outcomes do not establish equivalence or causation.

Focused review finding is repaired with reproduced diagnostics and repeated passing verification. Task remains incomplete: authoritative engine baseline/candidate comparison cannot be invoked with the available tools, broad failures remain unresolved, and native Unix execution remains unverified. Resume with preserved engine checkpoints and the engine verification facility; no task lifecycle state or engine evidence was modified. The prior frozen trees remain unchanged; `isolation-before-shell_state.rs` preserves this attempt's entry source and the working source contains the allocator repair.
