# Media import integrity checkpoint

## Implementation pass 2 checkpoint: 2026-09-10

The supplied engine snapshot captured at `2026-09-10T06:17:31.779Z` and general-suite baseline (674 passed, 18 ignored) are available. They do not include the selected task's required pre-production freeze of regression commands, fixture bytes, publication races, and cleanup outcomes. The explicit verification-plan requirement remains unresolved; no production changes were made in this pass.

Direct callable-tool inspection and Machdoch cached searches for both `verification` and `freeze` found no freeze/comparison capability. These observations cannot substitute for engine-owned evidence. The supplied clipboard validator and model-download cancellation review concern different tasks and were not applied to media import integrity.

Read-only inspection confirmed that ingest.rs still differs from HEAD only by its test-module declaration. Database and transform hashes match the original hashes below; the regression source remains `3a6857fc4f90d23deae42d4973fcdaa8643594d27265de798f038006e88fcc2c`. The existing 15 ignored cases and prior baseline failure evidence remain available. Tests were not repeated because production and regression code are unchanged and the prerequisite is still missing.

Resume with an engine-owned task-specific freeze, including deterministic publication-window and failure-injection cases, then implement and compare the candidate using the contract below. All behavioral acceptance criteria and non-Windows verification remain unresolved. This pass changes only this checkpoint; unrelated edits, stored objects, asset records, and task lifecycle fields are preserved.

## Latest repair attempt: 2026-09-10, 05:41 UTC

The selected media task remains blocked before production edits by its explicit engine-owned baseline/fixture/command/outcome freeze requirement. Available tool inspection found no freeze or comparison operation; Machdoch cached MCP search for `verification` returned zero tools. The supplied general-suite baseline does not freeze the required behavioral cases. No task lifecycle state or production code was changed in this attempt.

Fresh agent-observed Windows checks from the crate directory:

- `cargo test media::ingest::import_integrity_tests -- --ignored`: 4 passed, 11 failed, 0 ignored. Invalid import, registration, and publication cases still fail; the review findings remain unresolved.
- `cargo test --lib workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions -- --exact`: 1 passed, 0 failed, 2.30 seconds. The supplied terminal failure did not reproduce in this focused run; this does not establish full-suite stability.

Only this checkpoint was updated. Cargo check and the full suite were not repeated in this attempt. Resume by providing the engine-owned task-specific freeze capability/evidence, completing and freezing deterministic publication cases before production edits, then implementing integrity verification and enabling all regression cases. Required candidate comparison and non-Windows verification remain unresolved. These local observations are not engine-owned verification.

Task: `verify-deduplicated-media-import-blobs`.
Run: `2026-09-09T23-30-29-571Z`.

Production implementation is blocked on the required engine-owned verification freeze. No callable freeze/verification-plan/comparison tool was exposed, and Machdoch cached MCP tool search for `verification` returned zero results. Shell observations and this document are agent-prepared evidence, not an engine freeze or engine-owned comparison. Task lifecycle fields were not changed.

## Baseline

Supplied engine snapshot: HEAD `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`, captured `2026-09-10T04:53:04.792Z`. The supplied engine `cargo test` baseline passed 671 tests with 3 ignored. Preserve all snapshot changes, including `atomic_file.rs`.

Before preparation, `git status --short -- src/media` was empty. SHA-256 of original workspace files:

| File | SHA-256 |
| --- | --- |
| ingest.rs | e66fd7af74f946814c77f691e5a1eff94d1663f4b1d3acfaf3515a3b257a2c71 |
| database.rs | c8f89f74ba084ce9371164c067c6e17913ab7e70de4c1c7ca91daa0d514154e4 |
| transform.rs | 57254d0ed70f19a32b84196b7d3b92cadab46a739b1545fa117ac184a89036d7 |
| Cargo.toml | 7b742bd830a1bd03f8903048c1183852730a0ec64e1e481a276f91d6d2db911e |
| Cargo.lock | 20f4748bc648a9ff9859c8693ce67ab47d7e6713dff19007f65540cee6970c26 |

Only a `cfg(test)` module declaration was added to ingest.rs. Production code remains at baseline. `import_integrity_tests.rs` contains 15 opt-in cases; they remain ignored in ordinary test runs until implementation and required comparison are complete.

## Fixture and proposed verification contract

Exact PNG fixture: 68 bytes, 1 by 1 pixels, SHA-256 `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`.

Base64:

```text
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=
```

Same-length corruption is 68 copies of byte `0x5a`; truncation removes the final PNG byte. Each test has an isolated temporary runtime and SQLite database. Missing means removing the previously published file; directory means replacing that file with an empty directory. Test teardown removes only its own temporary fixture directory.

| Boundary | Expected outcome |
| --- | --- |
| New publication, no existing record | Success, exact PNG stored, no staging file, zero asset records until registration |
| Valid duplicate import or registration | Success, same asset ID, one record, regular file with exact length and SHA-256 |
| Invalid duplicate import | Integrity error, existing record and stored object unchanged, terminal staging cleaned |
| Invalid duplicate registration | Integrity error, one existing record and stored object unchanged |
| Invalid pre-existing publication destination | Integrity error, stored object unchanged, valid staging retained for caller-owned cleanup |
| Valid pre-existing publication destination | Success, stored bytes unchanged, staging removed |

Missing bytes behind an existing asset must fail rather than silently repair the record during reimport. The current publication helper may publish a new blob when there is no existing asset. Preparation tests intentionally distinguish these scenarios.

Commands run from `C:\Development\machdoch\apps\client\src-tauri`:

```powershell
cargo test media::ingest::import_integrity_tests -- --ignored --nocapture
cargo check
cargo test
```

The owning engine must freeze these fixtures, source/test/configuration hashes, commands, and outcomes before production edits. Run the identical opt-in command against baseline and candidate snapshots with the same tests. After successful comparison, remove the temporary ignore attributes and rerun the full suite.

## Agent-observed baseline results

Regression source SHA-256: `3a6857fc4f90d23deae42d4973fcdaa8643594d27265de798f038006e88fcc2c`.

The opt-in command ran on Windows with unchanged production code: **4 passed, 11 failed**, exit code 1. Valid import, valid registration, valid duplicate publication, and new publication passed. Invalid import and registration cases failed because success was returned or a missing stored file was silently recreated. Corrupt, truncated, and directory publication cases failed because valid staging had already been removed. These are expected baseline failures, not candidate verification.

The output was observed through the delegated shell tool; the long debug output was truncated. The reported test summary and all 11 failing test names were retained in the tool response. No engine-owned behavioral comparison exists.

`cargo check` passed (exit 0). It reported the same `desktop_task_activity_elapsed` dead-code warning as the supplied baseline. Focused rustfmt validation and `git diff --check -- src/media` passed. The check populated the local build cache; no dependency manifest or lockfile edits were made.

The default `cargo test` unit suite passed **671 tests, 0 failed, 18 ignored** (59.51 seconds). The ignored count consists of the baseline's 3 ignored tests plus these 15 preparation cases. Existing ingest, database, and transform tests were included. This validates test-only preparation against the existing suite; it does not demonstrate the requested integrity fix.

## Resume work

1. Obtain the owning engine's task-specific freeze. The supplied general passing suite is not the required behavioral freeze.
2. Before production edits, finish deterministic publication-window instrumentation and freeze the corresponding tests. Coordinate a destination appearing between the existence check and filesystem publication, plus injected publication failure with valid, corrupt, truncated, missing, and directory destinations. The prepared cases cover pre-existing destinations only; they do not establish these race outcomes.
3. Verify the actual stored path and recorded length when returning an existing asset, including a record pointing to a different invalid path. Cover symbolic links where the platform supports their creation.
4. Implement regular-file, length, and SHA-256 verification for imports and duplicate registration. Preserve existing objects, use publication that cannot overwrite a competing object, and make staging cleanup errors explicit. Review SVG raster imports through transform publication as well as raster and downloaded imports. No dependency, schema, or public API changes are currently needed.
5. Run the frozen baseline/candidate cases and cargo checks through the owning engine. Record platform coverage and unresolved checks. Do not declare completion based solely on these agent-prepared tests or a passing general suite.

Rollback removes only the test module declaration and these task-specific preparation files. Do not delete stored media, database records, or unrelated changes.

## Validation failure repair, 2026-09-10

The supplied failing candidate contained only media test preparation, with all 15 added integrity cases ignored. The accompanying DOM and clipboard reviews concern other tasks and do not establish media results.

The reported `workspace_run::manager::tests::keeps_fast_output_bounded_and_publishes_it_while_running` timeout reproduced in isolation before edits (0 passed, 1 failed, 10.07 seconds). Independent stdout/stderr readers allow the stderr marker to enter the bounded log before enough stdout lines arrive to evict it. Requiring both final markers simultaneously therefore depends on stream scheduling.

Changed only that test and its child fixture in `src/workspace_run/manager.rs`: the parent acknowledges the final stdout line using a temporary-workspace marker before the child emits stderr. Existing bounded-log and live-event assertions remain. No runtime implementation changed. Candidate manager.rs SHA-256: `5cd20d01d14189a15521315f4cf216d76509bbac1b4023699acbc63a8577e49c`.

Agent-observed Windows checks from the crate directory:

- Identical focused command before and after repair: `cargo test workspace_run::manager::tests::keeps_fast_output_bounded_and_publishes_it_while_running -- --exact`; candidate passed 1 test in 1.05 seconds.
- `cargo check` passed with the existing `desktop_task_activity_elapsed` warning.
- Supplied full `cargo test` command with its PowerShell exit guard: 671 passed, 0 failed, 18 ignored (76.99 seconds); includes existing ingest, database, and transform tests.
- `rustfmt --check --edition 2021 src/workspace_run/manager.rs` and scoped `git diff --check` passed.

These shell observations are not an engine-owned comparison. This invocation exposes no callable engine freeze/comparison tool. The media implementation, deterministic publication cases, and engine behavioral comparison remain blocked at the resume checkpoint above; the 15 preparation cases remain ignored. Non-Windows execution is unverified. Rollback of this validation repair removes only the test synchronization changes in manager.rs and this added checkpoint section. Preserve all other workspace changes and task lifecycle state.

## Terminal stress validation repair, 2026-09-10

The supplied terminal stress failure reproduced before edits with `cargo test --lib workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit -- --exact`: 0 passed, 1 failed, 31.16 seconds. The original test inspected output after a fixed 30-second wait even when no exit event had arrived, reporting missing output as truncation without distinguishing a timeout.

With only an additional exit diagnostic, two focused runs with `--nocapture` passed, draining approximately one megabyte in 28.57 and 12.36 seconds. This shows substantial timing variation close to the original limit; it does not prove the original failed run's exact output state.

Changed only the stress test in `src/workspace_tools/terminal.rs`: allow ongoing output progress, fail after 30 seconds without output events, and cap total waiting at 120 seconds. Assert exit before inspecting the final lines, with elapsed time, byte/event counts, and the output tail on timeout. The 10,000-line fixture, final numbered line, completion marker, and backpressure assertions remain. No runtime or media production implementation changed. Candidate terminal.rs SHA-256: `b6f6159b361c3af72c5ad1e7995b8e880694b6798b8dee031138bb16ea7b7b2a`.

Agent-observed Windows verification from the crate directory:

- The supplied full `cargo test` command and PowerShell exit guard passed: 671 passed, 0 failed, 18 ignored, 119.58 seconds; binary and documentation tests also passed. The repaired stress test and existing ingest, database, and transform tests were included.
- `cargo check` passed with the existing `desktop_task_activity_elapsed` warning.
- `rustfmt --check --edition 2021 src/workspace_tools/terminal.rs` and scoped `git diff --check` passed.

The 18 ignored tests still include the 15 media preparation cases. Required media implementation and engine-owned freeze/comparison remain unresolved at the existing resume checkpoint; callable tool inspection again exposed no engine freeze/comparison capability. These observations do not replace engine evidence. Non-Windows behavior and the timeout branch itself were not exercised by the passing candidate run. Rollback removes only this terminal test change and this checkpoint section; preserve other edits and all media objects, records, and task lifecycle state.
