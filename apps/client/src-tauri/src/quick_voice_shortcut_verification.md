# Quick Voice shortcut recovery verification

Task: recover-quick-voice-shortcut-update-failures.
Baseline: engine snapshot captured 2026-09-10T03:22:36.378Z, HEAD f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee. Both selected production files are unchanged from HEAD; existing unrelated changes are preserved.

## Frozen plan (before production edits)

Introduce mechanical dependency seams for registration operations and desktop settings load/save/sync. Run the same deterministic assertions before and after the behavioral fix. Baseline seams retain take-before-unregister, ignored recovery results, and reloading persisted settings during shortcut restoration. No real registrations, settings, or autostart operations are used by the added tests.

| Controlled case | Required outcome |
| --- | --- |
| Unregister fails | Remember previous registration; do not register replacement; retry unregisters previous first |
| Replacement register fails | Remember no registration after confirmed unregister; retry can register |
| Successful replacement / disable / unchanged | Remember confirmed registration or none; unchanged performs no operations |
| Replacement fails, recovery succeeds | Save previous settings, register previous shortcut, report original failure and successful recovery |
| Settings recovery fails before write | Still restore previous shortcut independently; retain persistence error; persisted settings remain replacement |
| Settings recovery fails after write | Still restore previous shortcut; retain persistence error despite restored file values |
| Shortcut recovery fails | Settings restored, remembered registration empty; retain shortcut error |
| Both recovery operations fail | Attempt both; retain original and both recovery errors |
| Initial unregister fails during update | Recovery preserves previous registration; retry performs correct unregister/register sequence |
| Initial persistence fails | Return persistence error without attempting registration |

Assert operation order, remembered and actual fake registrations, stored settings, exact returned error text, and retry behavior. Recovery success claims must correspond to successful operations.

Commands from apps/client/src-tauri, for baseline and candidate: `cargo test shortcut`, `cargo test runtime_snapshot`, `cargo test`. Each command's exit code and named per-test outcomes are retained. The supplied engine baseline already reports 658 passed, 2 failed, 3 ignored (terminal mixed-shell and output-drain failures). Do not weaken unrelated assertions or modify task lifecycle data.

Native shortcut integration is not exercised by deterministic tests. No dev servers will be started. Engine-owned comparison and task completion remain the flow engine's responsibility.

## Results

The dependency seams were introduced without fixing baseline behavior, then the frozen tests were run before the behavioral changes. Candidate changes retain remembered state until unregister succeeds and independently restore the shortcut from previous settings. Both restoration results are evaluated before constructing the returned error.

| Command | Baseline with frozen tests | Candidate with identical tests |
| --- | --- | --- |
| `cargo test shortcut` | 4 passed, 7 failed; exit 101 | 11 passed; exit 0 |
| `cargo test runtime_snapshot` | 52 passed, 6 failed; exit 101 | 58 passed; exit 0 |
| `cargo test` | 662 passed, 9 failed, 3 ignored; exit 101 | 669 passed, 2 failed, 3 ignored; exit 101 |

The focused filters execute all 11 new cases and all 8 desktop settings recovery cases respectively. The full runs contain 674 tests: the engine baseline's 663 plus 11 new tests. Seven regression failures become passes. The remaining failures match the engine baseline and the local baseline:

- `workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions`
- `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`

The Machdoch shell tool independently reproduced the baseline's seven shortcut failures and the candidate's 11 shortcut passes and 58 runtime snapshot passes. Its baseline runtime snapshot run additionally failed both descendant PID-file tests, although both passed in the local baseline and candidate runs. No unrelated test assertions or implementation were changed. The Machdoch shell tool has a 30-second timeout; an attempted combined baseline invocation timed out waiting for Cargo, so resumable shell commands collected the complete local runs.

Copied baseline executable launches returned 3221225785 before running tests, including attempts beside the dependency DLLs and with Rust runtime directories in PATH. Those launches provide no behavioral evidence. The descendant failure's exact cause and an engine-owned full-suite equivalence decision remain unresolved; no success claim is inferred from matching aggregate exit codes.

Local artifacts are retained in `target/quick-voice-shortcut-verification/`: baseline/candidate logs for each command, command exit records, baseline seam source copies, frozen hashes, and structured named per-test comparisons. The comparison reports no existing passing test regressing. These local artifacts supplement the supplied engine evidence and do not replace the engine's verification decision.

Frozen test SHA-256 values (unchanged between runs):

- `desktop_shell/shortcut_tests.rs`: `45a6f805963f71686d735a05cac18801edcea8f95093d630fa01cf12c6eaccb2`
- `runtime_snapshot/desktop_settings_update_tests.rs`: `0f188d84db0a16eeda67f4ca82efa3c330dc638b85e642a8622fd2ac514e60f9`

Targeted rustfmt checks and `git diff --check` passed. All 57 pre-existing file hashes in the supplied engine snapshot still match. Only this task's three existing production files, one extracted production module, two test modules, and this record were changed or added. No dependency, schema, public API, task lifecycle, or server changes were made.

Native Quick Voice registration, callbacks, autostart, and real user settings storage were not exercised. Persistence failures are deterministic doubles, including failure before and after writing values. Remaining checkpoint: engine validation of the retained evidence and resolution or explicit disposition of the pre-existing full-suite failures. Do not mark verification fully passing from this record.

## Validation repair checkpoint

The validation-repair pass verified both frozen test hashes and independently matched every named result in `per-test-comparison.json` against the six retained logs. Counts matched exactly: 11 shortcut, 58 runtime snapshot, and 674 full-suite tests per role. All 662 passing tests in the local full-suite baseline also passed in its candidate; seven failures became passes, and the same two terminal failures remained. This establishes no observed regression in that retained local pair, not an authoritative disposition for the separately supplied engine runs.

`target/quick-voice-shortcut-verification/validation-evidence-manifest.json` records artifact SHA-256 hashes, command comparisons, improved test names, persistent failure names, and the submission blocker. Existing logs, frozen hashes, and comparison files were preserved. No production code or tests were changed, and tests were not rerun during this evidence-only pass.

Engine submission is blocked by a missing interface. Available Machdoch tools expose no verification-evidence submission operation; cached MCP discovery for `verification` returned no tools. Inspection of `apps/client/src/core/_helpers/ralph-verification.helper.ts` confirms that observations accept exactly command, cwd, process outcome, and output fingerprint. The comparator has no input for test names, frozen hashes, or artifact logs. When both processes fail with different fingerprints, it returns `INCONCLUSIVE`. Calling the shell tool to print the manifest cannot supply that missing input.

The terminal failures are pre-existing observations in both supplied engine baseline and retained local baseline; their cause and equivalence remain unadjudicated by the engine. No terminal changes, test exclusions, verification-command changes, or task-state edits were made. The existing engine checkpoint remains `INCONCLUSIVE`. Resume by providing an engine-supported evidence ingestion/comparison operation for the retained artifacts and supplied run fingerprints. Any required identical isolated reruns must be captured through that operation; further local reruns alone cannot resolve the missing submission capability.
