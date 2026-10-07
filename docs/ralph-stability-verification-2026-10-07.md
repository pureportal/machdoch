# RALPH stability verification — 2026-10-07

RALPH recovery preserves one run identity and committed progress through worker, desktop, watcher, output-pipe, and initialization failures. Selected tests and 19 recovery/lifecycle scenarios passed on Windows and Linux, including all nine desktop scenarios on the rebuilt standard Windows release. Its LTO, optimization, codegen, panic, and strip settings match the repository release profile. Installer extraction, Linux headless execution, source hashes, historical records, and process cleanup passed independent checks.

## Findings and repairs

| Observed failure | Repair |
| --- | --- |
| Three crashes exhausted recovery despite objective progress between them. | Limit consecutive failures at unchanged durable progress; new progress renews recovery. Retain consumed execution limits and bounded error history. |
| A resumed wait executed before acquiring its independent lease. | Acquire and persist ownership before executing resumed work; reject competing owners. |
| Lost execution responses, interrupted inspection, failed capture, and hung inspectors stopped recovery. | Inspect saved identity and outcome before resuming; retry interrupted read-only inspection with finite cancellation-aware limits; return saved completion without replay. |
| Actual Windows inspection termination returned exit 1 without a response or diagnostic. | Treat missing responses as interruption, including silent conventional exit codes. Reported CLI errors and cancellation remain explicit. Both failing process cases passed after repair. |
| Windows sharing locks made intact saved records temporarily unreadable. | Retry transient file errors within a bounded window; avoid false corruption reports. |
| Desktop loss ended its Windows job and stopped the flow. | Persist recovery intent before launch; an independent watcher observes the owned process handle and creation time, restarts the desktop, and restores that session. |
| An exited watcher left an active desktop unsupervised. | Monitor the owned child or restored parent handle and replace exited watchers within a progress-renewed budget. |
| Unix restoration abandoned a surviving CLI after repeated refused resumes. | Observe the live owner until terminal completion or abandonment; retain Stop during observation. |
| Closed desktop pipes produced EPIPE before initial or resumed workers saved cancellation. | Keep supervised execution alive through pipe loss and skip flushing errored streams. The retained cancellation path identifies both execution modes. Other stream failures remain explicit. |
| Interruption before the first record selected a suffixed folder and repeated an append. | Preserve explicit run IDs and reserve initialization exclusively. |
| Host and worker loss after mkdir left an empty canonical folder without a record. | Persist an initialization claim before mkdir; reclaim only a proven dead initializer for the same run and flow; retire the claim after the first record commits. |
| Pruning could remove an old live-initialization directory. | Preserve claimed folders and exclude private initialization-lock directories from listing/pruning. |
| The standard release could not launch its embedded Node executable at a 262-character cache path. | Canonicalize materialized runtime paths before launching. A regression test reproduces the original Windows error and passes with an executable beyond 280 characters. |

Cancellation and normal shutdown remove durable intent before stopping work. Startup restores persisted active intent.

## Current verification

CLI SHA-256: `a6473e28b769004b3f69a5cb336fdf85038acf5b5e97327702f18b3aebd7c00e`.
Native controller source SHA-256: `acb6f46a91a9242430b3980e478a8d4f4b8b2aff328e208d559a00e8b0f16bbd`.
Shared runtime source SHA-256: `f92b174fee030e3d657a8a4336caff01f78001f414274cf76692f88a93ef31a1`.
Standard Windows executable SHA-256: `f1fe59e3f0ba7e881ba90a0cb76e140fcb4661571fcf3eaeef33bbca12b2515a`.

| Check | Result |
| --- | --- |
| RALPH, goals, output lifecycle | All 1,534 cases passed across recorded runs. Initial campaign: 1,530 passed, four timed out at 30 seconds. Those four passed isolated rechecks with finite 120- or 300-second test limits; production limits were unchanged. |
| Initialization, storage, ownership | 44 focused cases passed, including nine initialization cases and two new pruning/listing regressions. These overlap the broader campaign. |
| Windows native | Full campaign: 98 passed, one child-launch timing failure, one provider case ignored. The failed test passed unchanged in isolation in 0.10 seconds. All 99 distinct cases passed across recorded runs; the original failure remains retained. |
| Linux native | All 96 passed, one provider case ignored; source hashes unchanged. The prior attempt's 11 failures came from the fixture shell missing node (exit 127). The corrected PATH retains the private Node runtime. |
| Unix process faults | Seven current-source scenarios passed with independent saved-state readback: reservation loss, surviving worker, owner loss, startup loss, startup Stop, restored Stop, and Stop after two host losses and worker loss. Records are healthy, leases released, canonical folders unique, claims retired, and owned processes absent. Startup Stop wrote no append; other cases wrote one. This fixture imports production controller/watcher/monitor/manifest code with application and Tauri adapters; it is not the full Linux GUI. |
| Current Windows desktop | All nine scenarios passed on the rebuilt standard release: utility recovery, initialization loss before the first record, four crashes separated by task progress, watcher loss, watcher-budget exhaustion and renewal, unchanged-progress crash limit, Stop, normal quit, and real Codex interruption during prompt two. Six scenarios completed with verified outcomes and released leases; Stop and quit saved stopped records and released leases. The crash-limit case retained a healthy checkpoint with effective status abandoned and an explicit desktop failure result. Appends were exact, recovery intent cleared, owned processes absent, and scoped browser policies removed. The initialization case launched the embedded Node executable at 262 characters. Restored CLI and browser dependency bytes match the package at paths over 320 characters. |
| Real Codex | Three exact LF output files, three single appends, and the same canonical instruction digest across successful prompts before and after restoration. The interrupted prompt attempt remains recorded before its successful retry. Verification used Codex CLI 0.159.1 and the existing elevated Windows token. |
| Standard Windows release profile | Compilation and desktop verification passed with LTO enabled, one codegen unit, optimization level three, panic abort, and symbol stripping. All 2,751 frozen inputs match; compiler observations started after the final source refresh and captured the LTO/codegen flags. The embedded CLI bytes and isolated application identifier match. Four delayed compiler-observation queries remain recorded. |
| Shared runtime path repair | All 11 Windows and ten Linux shared-runtime cases passed. The Windows regression fails on the prior implementation. The rebuilt desktop also passed initialization and host recovery with the embedded Node executable beyond MAX_PATH. |
| Windows installer | Current standard-release NSIS packaging succeeded. Extraction matches every byte of the tested executable except the expected three-byte Tauri bundle marker, UNK to NSS. Installation and signing were not performed. |
| Linux headless package | Archive structure, executable LF shell entry, and current CLI bytes passed. Actual Linux completion, SIGKILL followed by resume with preserved transition consumption and lease generation, and cancellation with exit 130 passed. Independent terminal-record readback found healthy records, released leases, unique run folders, one append per case, and no owned processes. |
| Static checks | Core and test/logic TypeScript checks and scoped lint passed after the JavaScript repair. Final whitespace and Rust-format checks passed for the changed files, excluding unrelated child modules. Current operational sources match the tested snapshot. |
| Historical records | Read-only comparison verified all 60 baseline records unchanged: eight workspace, 52 user. None was resumed or rewritten. |

The full client suite is **not green**: 4,289 passed, 26 failed, three skipped. Failures include missing UI mocks, unavailable DOM state, scheduler/file-capture timeouts, Unicode-log readiness, and provider-sync timing. A lower-concurrency recheck retained eight failures. A later isolated scheduler campaign passed all five cases, including discovery, triggering, cancellation, retries, and due RALPH jobs in 5.04 seconds. The original broad failures remain retained.

Compact evidence is retained in [acceptance](validation/ralph/acceptance.json), [tests](validation/ralph/tests.json), [standard Windows desktop](validation/ralph/windows-standard-desktop.json), [runtime repair](validation/ralph/runtime.json), [Unix processes](validation/ralph/unix-processes.json), [headless package](validation/ralph/headless.json), [standard installer](validation/ralph/standard-installer.json), [sources](validation/ralph/sources.json), and [history](validation/ralph/history.json). The acceptance manifest hashes each receipt. Earlier optimized-build evidence remains in [Windows desktop](validation/ralph/windows-desktop.json) and [installer](validation/ralph/installer.json); that build precedes the shared-runtime path repair.

Raw receipts and packaged artifacts reside under `C:/Users/ehrha/AppData/Local/Temp/machdoch-ralph-stability-ViFe18`. Main integration verified all 2,751 source hashes and 66 receipt hashes, then removed the release snapshot, both build targets, and both temporary build directories under `C:/ralph-128e6933`; release provenance remains there. Failed initialization, pruning, inspection, fixture setup, readback, and build attempts remain separate from acceptance. Progress-flow prototypes omitted selection routing or final repository evidence; the accepted fixture includes both. The first provider verifier counted its interrupted attempt as a successful prompt; the corrected verifier passed a fresh run and retained that attempt. The earlier report is archived as `stability-report-before-closeout.md`. Missing older temporary receipts are not presented as retained current evidence.

The first standard release compiled and packaged successfully, then failed desktop initialization before creating a run record. Direct Rust launch reproduced Windows error 3 for the existing embedded Node executable at 262 characters; the same file launched using its extended-length path. The original executable, installer, and failed attempt are archived under `standard-before-long-path`. The follow-up snapshot changes only `shared_cli.rs` among operational sources. The fresh initialization case retained that long path and passed.

Two verifier corrections were required after rebuilding. The initialization injector delayed every record-directory check; limiting it to the first matching call produced a passing fresh case. Independent readback initially counted private lock/quarantine folders as extra runs in the crash-limit case; the corrected check matches production listing, verifies one canonical run, and records the private artifacts. Those interrupted guard folders remain retained. The eight remaining desktop cases resumed from the first unfinished case, preserving the passing utility result. All nine execution receipts and corrected independent readback passed; failed campaign and readback attempts remain separate.

## Historical investigation

The review covered the [September investigation](ralph-failure-investigation-2026-09-30.md), [September repairs](ralph-reliability-repairs-2026-09-30.md), October 2 hardening, later recovery reports, and the 60-record cohort. Established categories include provider transport loss, instruction/capability probing, unavailable native prerequisites, obsolete scope state, misleading verification success, Windows contention, interrupted Git preparation, lost responses, long paths, and disk exhaustion. Existing repairs were exercised through the RALPH campaign.

Earlier compiled Windows releases passed worker recovery, automatic desktop restoration, watcher replacement, four progress-separated crashes, unchanged-progress limits, cancellation, normal quit, and real Codex interruption during its second prompt. They retained exact committed outputs and released ownership. Earlier installer extraction and Linux headless checks passed. Their hashes precede the latest repair and do not verify the current release.

The historical native fast-fail call site and truncated instruction-probe diagnostic cannot be reconstructed from retained artifacts. No matching dump was retained. A bounded Application-event audit found no matching Machdoch entry among inspected crash/report/hang events; it does not establish the absence of every crash. Injected termination demonstrates recovery, not the historical exception's cause.

## Research applied

[AWS idempotency guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) supports one request identity and reconciliation before repeating uncertain work. [Microsoft's retry pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry) supports bounded delays and separate handling of permanent errors. [Temporal retry guidance](https://docs.temporal.io/encyclopedia/retry-policies) distinguishes retrying failed work from restarting an entire workflow. Progress-based budget renewal is the application-specific policy verified here.

[Node's EPIPE documentation](https://nodejs.org/api/errors.html#common-system-errors) identifies a closed pipe consumer; [writable.errored](https://nodejs.org/api/stream.html#writableerrored) exposes an errored stream. [Windows process handles](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers) support watching owned handles; [job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) explain the worker/desktop failure boundary. [Anthropic's harness investigation](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) supports persistent progress and end-to-end verification. Applying these ideas is an architectural inference; external guidance does not verify Machdoch.

[Microsoft's path guidance](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) documents extended-length Windows paths. [Rust canonicalization](https://doc.rust-lang.org/std/fs/fn.canonicalize.html) resolves existing files to that form on Windows. The runtime launch repair uses this canonical path directly.

## Remaining limits

Whole-machine restart, simultaneous loss of every supervisor, and the full Linux desktop remain unverified. Verification is finite; uncommitted external operations may require reconciliation.

The installed application has not been replaced. Checks use isolated identifiers, configuration, and workspaces; no development server was started. Codex checks used the same Windows user's existing elevated token. Unelevated credential isolation previously failed its symbolic-link prerequisite with EPERM; authentication storage, credentials, Developer Mode, and system rights were not changed. The deliberately long-profile fixtures emitted Media Studio database and already-registered Quick Voice warnings; those subsystems were outside the RALPH checks.

Automatic approval review rejected removal of duplicate verification runtime folders with “blocked by policy.” Those folders were not removed. Verification moved to newly owned folders.
