# Sequential cancellation checkpoint

Task: `serialize-sequential-run-cancellation-with-child-start`.
Run: `2026-09-09T23-30-29-571Z`.

Implementation is blocked before production edits. The selected task requires an
engine-owned freeze of the dirty baseline, identical regression harness, commands,
synchronization points, and shutdown bounds before production changes. The supplied
engine evidence covers the existing suite, but contains no such regression harness
or freeze. Exposed tool discovery and cached MCP search found no verification-freeze
capability. This document is a local resumption record, not engine acceptance.

## Preserved evidence

- HEAD: `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`.
- `manager.rs` SHA-256 matches the supplied dirty baseline:
  `5cd20d01d14189a15521315f4cf216d76509bbac1b4023699acbc63a8577e49c`.
- Baseline bytes and `checkpoint.json` are retained under the repository-relative
  `.machdoch/ralph/runs/2026-09-09T23-30-29-571Z/code-improvements/sequential-cancellation-checkpoint/`.
- Existing fast-output acknowledgement test changes remain untouched.
- Supplied engine baseline: `cargo test --all-targets`, exit 0, 682 passed,
  18 ignored, zero failed. These results do not exercise the proposed race cases.
- This invocation ran no tests and made no production changes.

## Proposed cases for engine freeze

Prepare one test-only harness for both preserved baseline and candidate. Use
per-manager channels to acknowledge and release each synchronization point. Use
real supervised child processes, record launch acknowledgements and PIDs, and
check termination after completion. Always release blocked workers and clean up
children before reporting assertion failures. Do not use sleeps to establish the
race ordering.

1. Pause the coordinator after its existing cancellation check but before child
   registration. Cancel, release the coordinator, and require zero child launches.
2. Pause startup after admission and after the supervisor's cancellation check,
   before process creation. Cancel, release startup, and require the admitted child
   to be terminated and reaped before shutdown completion.
3. Pause the old coordinator before admission, request stop followed immediately by
   restart, and release it. Require completion of the old coordinator before the
   replacement begins; record run identities to reject old registrations, cleanup,
   or state publication affecting the replacement.
4. Hold the first child in readiness waiting, cancel, and require its process to
   terminate without launching the second child.
5. Release first-child readiness explicitly and require the second child to launch
   only afterward. Retain existing rapid-successful-exit, parallel-composite,
   descendant-termination, and pending-health-check shutdown coverage.

Proposed bounds to freeze: 10 seconds for harness acknowledgements; 15 seconds for
configuration stop/restart completion after releasing instrumentation; the existing
5-second manager shutdown budget, with a separately recorded 1-second scheduling
tolerance. Instrumentation hold time must be recorded separately. No platform
exclusions are assumed; record actual target and any skipped cases.

Commands from `apps/client/src-tauri`, with native exit codes recorded separately:

```powershell
cargo test workspace_run::manager::sequential_cancellation_tests -- --nocapture
cargo test workspace_run
cargo test --all-targets
```

The first command names the proposed regression module; it does not exist yet.
Hash and freeze the completed harness before executing identical cases against
baseline and candidate. Do not reinterpret missing tests or a compilation failure
as a behavioral baseline failure.

## Resume implementation

After the engine freeze, serialize parent cancellation checks and child admission
under the same manager-state lock. Track coordinator completion through its last
cleanup and publication, and include it in stop/restart completion and reuse
decisions. Preserve the distinction between the current asynchronous stop request
and completed shutdown. Do not make coordinator progress depend on the workspace
operation lock held while restart waits.

Strict review must check lock ordering, cancellation during process creation,
coordinator ownership through final publication, generation isolation, and process
cleanup. Preserve this checkpoint until the engine records baseline/candidate
behavioral evidence and required checks. Task lifecycle fields remain engine-owned
and were not changed.

## Fix-validation-failures follow-up, 2026-09-10

No production or test source was changed. The manager hash still matches the
preserved dirty baseline above. Tool discovery again exposed no engine freeze
capability, so the pre-production blocker remains unresolved.

Local Windows verification from `apps/client/src-tauri`:

- `cargo test workspace_run`: exit 0; 43 passed, 0 failed, 0 ignored.
- `cargo test --all-targets`: exit 101; 681 passed, 1 failed, 18 ignored.
  Both terminal tests named in the supplied failure passed. The failure was
  `media::model_install::cancellation_tests::cancellation_before_execution_settles_within_one_second`:
  settlement took 1.0303009 seconds against its one-second assertion. No causal
  connection to the selected task was established; its source was left untouched.
- `git diff --check -- src/workspace_run/manager.rs`: exit 0.

Full logs are retained in the checkpoint directory above as
`fix-validation-workspace-run.log` and `fix-validation-all-targets.log`.
These are local observations, not engine baseline/candidate acceptance. No new
race cases were executed, non-Windows behavior remains unverified, and the
sequential cancellation defect remains unimplemented. The supplied payload-copy
review and absent-file recovery validation concern other tasks and do not prove
acceptance of this task. Resume from the existing engine-freeze requirement;
task state was not modified.

## Implementation pass 2 resumption, 2026-09-10

The new invocation supplies a git snapshot captured at 10:12:05.749Z and an
engine broad baseline with exit 101: 699 passed, 2 failed, 18 ignored. Failures
are `workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions`
and `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`.
This supersedes the earlier supplied broad baseline for this resumption; it does
not contain the required controlled cancellation cases or their engine freeze.

The manager SHA-256 still equals the preserved baseline above, including its
existing output-test edits. Scoped `git diff --check` completed with exit 0.
Exposed tool metadata contains no engine verification-freeze capability, and a
filename search of this run's `code-improvements` directory found no additional
verification, freeze, or sequential artifact. The existing local checkpoint was
read and retained; it is not engine-owned verification evidence.

No production or test source was changed and no tests were executed in this
resumption. The pre-production freeze requirement remains a concrete blocker.
Resume by supplying the engine-frozen baseline and regression harness, exact
commands, synchronization points, and shutdown bounds, then implement and run the
identical baseline/candidate cases described above. The cancellation defect,
behavioral verification, and strict implementation review remain outstanding.
No task lifecycle fields, dependencies, schemas, or public APIs were modified.

## Validation repair pass 2 checkpoint, 2026-09-10

Read-only inspection reconfirmed the preserved manager SHA-256 and both lifecycle
defects: admission remains separate from composite cancellation, and shutdown does
not wait for the sequential coordinator. Scoped `git diff --check` passed.
Exposed tool discovery and cached MCP searches for `freeze` and `verification`
found no engine freeze capability (both cached searches returned zero tools).
The required pre-production engine freeze remains unavailable. No production or
test code was changed, and no tests were rerun in this pass.

The supplied candidate broad run exited 101 with 700 passed, 1 failed, and 18
ignored. Its terminal output stress failure also occurred in the supplied baseline
(699 passed, 2 failed, 18 ignored). This overlap does not establish equivalent
behavior; the engine comparison remains INCONCLUSIVE. No concrete new or worsened
failure attributable to this task was established. The supplied DONE validation
describes absent-file recovery and is not evidence for sequential cancellation.

Retain the baseline bytes, logs, and proposed cases above. Resume when the engine
can freeze the completed identical regression harness, baseline, commands,
synchronization points, and shutdown bounds before production edits. Implementation,
controlled behavioral verification, broad comparison, and strict review remain
outstanding. Task state and unrelated source files were left untouched.

## Validation repair: supplied 13-failure candidate, 2026-09-10

Reconciled at HEAD `8a35f9823f460206b8eb62c5a8604b41c0d149b2`.
The manager SHA-256 remains
`5cd20d01d14189a15521315f4cf216d76509bbac1b4023699acbc63a8577e49c`,
identical to the preserved baseline. Commit
`ff8a91666dc2bca780fc53d6bcddfc69972d2ed1` contains only the existing
fast-output acknowledgement test changes in this file. There is no lifecycle
implementation or deterministic cancellation harness delta to identify. Source
inspection confirms the separate cancellation check and child registration, and
the stop waiter still checks only child supervisors.

Local Windows verification, without production or test source edits:

- `cargo test workspace_run`: exit 0; 62 passed, 0 failed, 0 ignored,
  658 filtered out. Both `sequential_composite_continues_after_a_successful_rapid_exit`
  and `stop_terminates_descendant_processes` passed. Test execution took 22.13 seconds.
- `cargo test --all-targets`: waited for the shared build-directory lock and was
  interrupted before test execution; command session exit 1. This is an interrupted
  observation, not a test failure or a completed broad verification result.
- Scoped `git diff --check` passed before this documentation update.

Full command output is retained alongside the existing checkpoint as
`repair-current-workspace-run.log` and `repair-current-all-targets.log`.
These observations do not establish equivalent baseline/candidate conditions or
explain the previously supplied failures. No assertions or timeout bounds were
weakened. The supplied absent-file recovery DONE validation is unrelated.

Available tool metadata exposes no engine baseline/harness freeze capability.
The required pre-production freeze is still absent, so implementation remains
blocked. Resume with the engine-frozen baseline, completed identical controlled
harness, commands, synchronization points, and bounds described above; execute
the race cases on baseline and candidate and complete broad verification when
the build lock is available. Strict lifecycle review, process cleanup evidence,
restart isolation, and non-Windows behavior remain unverified. No task state was
modified.
