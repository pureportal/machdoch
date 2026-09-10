# Health probe lifetime checkpoint

Task: `bound-workspace-health-probe-lifetime`.
Run: `2026-09-09T23-30-29-571Z`.

Production implementation is blocked by the task's explicit requirement to have
the engine freeze baseline and candidate commands, timeout tolerances, worker
limits, restart counts, and expected transitions before production edits. The
supplied engine baseline covers the existing suite, without these probe-specific
parameters or a controlled regression harness. Available tool metadata and cached
MCP searches for `verification` and `freeze` expose no freeze capability. This
checkpoint is a proposal for resumption, not an engine freeze or acceptance.

## Preserved baseline

- HEAD: `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`.
- `health.rs` SHA-256:
  `daf24f4a199b2d29690923715f6f40e77f5cc81a3ee687d76ea551089650e934`.
- Dirty `manager.rs` SHA-256:
  `5cd20d01d14189a15521315f4cf216d76509bbac1b4023699acbc63a8577e49c`.
- Existing manager test edits and the separate sequential cancellation checkpoint
  are preserved. No production or test source was changed for this task.
- Supplied engine baseline: `cargo test --all-targets`, exit 0; 682 passed,
  18 ignored. This does not establish deadline or worker bounds.

## Proposed verification parameters for engine freeze

Use the same controlled-operation harness and assertions against the dirty
baseline and candidate. Freeze the completed harness hash before production
edits. Compilation errors and zero executed cases are inconclusive, never
behavioral baseline failures.

- Probe deadline: 200 ms; scheduling tolerance: 300 ms. Observe the result by
  500 ms while resolution or request completion remains explicitly blocked.
- TCP fixture: four failing addresses, each consuming up to 120 ms or its
  remaining budget, whichever is smaller. Require one shared deadline.
- Process-wide admission ceiling: four probe operations and four resolver
  operations, including abandoned attempts; zero waiting replacement jobs.
- Repeat 32 stop/restart cycles while admitted work remains blocked. Instrument
  active operations, retained worker handles, and queued work independently.
- Harness acknowledgement bound: 10 seconds. Completed process shutdown bound:
  the existing five-second budget plus one second of scheduling tolerance.
- Release blocked operations explicitly; require reclamation within two seconds
  and a subsequent successful probe. Release and clean up fixtures before
  assertions can unwind.
- Use channel/barrier acknowledgements to establish ordering. Do not use sleeps
  to infer whether resolution, connection, or cancellation has started.

Required cases: delayed TCP resolution; delayed HTTP resolution; several failing
TCP addresses; stalled HTTP response; ordinary TCP and HTTP success and failure;
deadline expiry followed by late success; saturation across stopped and replaced
attempts; capacity reclamation and recovery. Use controlled operations and local
test fixtures without external network dependencies or development servers.

Preserve the existing transitions: Checking during startup; Healthy and Running
on success; Failed with incremented consecutive failures; Unhealthy at the
configured threshold; recovery to Healthy and Running with failures reset to
zero. Explicit stop must leave Stopped with no PID. Releasing an old probe must
not change the stopped or replacement attempt's health, failure count, or state.
Cover restart-on-failure and the existing restart limit.

Commands from `apps/client/src-tauri`, recording native exit codes:

```powershell
cargo test workspace_run
cargo test --all-targets
```

The proposed controlled regression harness has not been implemented or run.
Include its cases in the focused command before freezing the harness.

## Implementation and review checkpoint

Replace the detached per-probe execution path with explicit operation ownership
and process-wide bounded admission. Start the deadline before admission and
resolution. Carry its remaining budget through every connection and HTTP phase;
do not restart the timeout for each address. Cancel supported network operations
when the attempt ends. Non-cancellable platform resolver work must retain its
capacity ownership until it actually exits, independently of timeout publication
or receiver disposal. Saturation must reject immediately without queue growth.

Strict review must cover resolver work created inside HTTP clients, redirects,
proxy resolution, worker-handle reclamation, cancellation during admission,
deadline/result races, and generation isolation. A timed-out or cancelled receiver
alone does not prove worker reclamation. No dependency, schema, or public API
change is presumed necessary. Task lifecycle fields remain engine-owned.

## Local verification, 2026-09-10

- `cargo test workspace_run`: exit 0; 43 passed, zero failed or ignored.
- `cargo test --all-targets`: exit 0; 682 passed, zero failed, 18 ignored;
  finished in 69.82 seconds. Log: `target/health-probe-baseline-all-targets.log`.
- Scoped `git diff --check`: exit 0. Both source hashes above remain unchanged.
- Existing warning: unused `desktop_task_activity_elapsed`.
- Candidate behavior, controlled regression cases, strict implementation review,
  and non-Windows behavior remain unverified. The original probe defects remain.

Resume after the engine supplies the required freeze. Retain this checkpoint
until baseline/candidate evidence and strict review establish completion.

## Fix-validation-failures resumption, 2026-09-10

Source inspection and SHA-256 checks reconfirmed both preserved source hashes.
The overall deadline and bounded worker ownership remain unimplemented. The
supplied passing suites do not exercise those requirements; the supplied DONE
validation concerns settings-transfer recovery and is not evidence for this task.

Available tool metadata exposes no engine verification freeze operation. Fresh
cached MCP searches for `freeze` and `verification` each returned zero tools.
The required engine-owned freeze remains a concrete blocker before production
edits. No production or regression-test source or task lifecycle state was changed
during this resumption. Tests were not rerun against the unchanged source.

Resume with an engine mechanism to freeze the completed controlled harness and
the parameters above before production edits, then capture behavioral baseline
and candidate results and run both required suites. This checkpoint does not
claim a freeze, successful repair, or acceptance.
