# Managed prompt case-only rename verification

Task: `preserve-managed-prompts-on-case-only-renames`.

## Frozen plan (before production edits)

Baseline: engine snapshot captured 2026-09-10T02:05:15.935Z, HEAD
`f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`. The target module has no existing
diff; its SHA-256 is `088B8330251BC69CC16254386A205F0ABAAB252C11BAAF9482B89EA314BC3DE2`.
Preserve all existing uncommitted files, including atomic-file and shell-state
changes. A byte-for-byte module copy and hashes of existing changed files are
retained in `%TEMP%/machdoch-managed-prompts-verification-20260910`.

Run identical regression tests before and after production edits in disposable
directories. Cases cover `One.prompt.md` to `one.prompt.md`,
`Reviews/one.prompt.md` to `reviews/one.prompt.md`, and both components changing
case together, each with unchanged and changed content. Include an obsolete
file to verify cleanup. After synchronization require one readable desired
prompt with exact content. On case-sensitive storage require the exact desired
listing and removal of the old file and obsolete directory. On case-insensitive
storage either stored spelling is acceptable. Mark the file's modification time
before the repeat and require identical listings, content, and modification time
after the second synchronization. Also verify unchanged-content synchronization
preserves the initial modification time on case-insensitive storage.

Keep existing replacement and traversal tests; add same-path content replacement
and case-insensitive duplicate-path rejection using distinct prompt IDs.
The tests are moved into `managed_prompts_tests.rs`; the frozen test-file SHA-256
is `033526BB2BB565E18EC5D6954F191D155960F086FF509829BAAE1209EB5A35FB`.

Commands, from `apps/client/src-tauri`, for baseline and candidate:

```powershell
cargo test managed_prompts -- --nocapture
cargo test managed_prompts -- --ignored --nocapture
```

The second command explicitly runs two Windows tests that enable case sensitivity
with `fsutil.exe file setCaseSensitiveInfo <disposable-manager-directory> enable`.
They fail if setup or the case-sensitivity probe fails; there is no silent skip.
The ordinary tests probe and report their filesystem mode. Both content variants
must run in both modes. Before production edits the native case-insensitive
rename tests should fail with missing desired files; the case-sensitive tests
should pass. Windows case-sensitive directory setup was successfully probed.

Candidate suite and formatting checks:

```powershell
cargo test
rustfmt --check --edition 2021 src/fleet/managed_prompts.rs
git diff --check -- src/fleet/managed_prompts.rs src/fleet/managed_prompts_verification.md
```

The supplied engine baseline `cargo test` passed 656 tests with one ignored.
Record actual candidate counts and failures. Unavailable filesystem or native
platform coverage stays unresolved. The review feedback concerning shell-state
reconciliation belongs to a different task; this change is limited to managed
prompts. Lifecycle fields and engine evidence files are not edited.

## Observations

Baseline focused run: exit 101, four passed, two failed, two explicitly ignored.
Both native rename cases reported `case_sensitive=false` and failed because the
desired file had been deleted (Windows error 2). They failed on the first
filename fixture; subsequent directory fixtures in those tests were not reached.
Replacement, exact-set synchronization, duplicate validation, and traversal
rejection passed.

Baseline explicit case-sensitive run: exit 0, two passed. Both content variants
completed all three filename/directory fixtures and their repeat checks with
`case_sensitive=true`.

Logs are retained beside the baseline module copy as `baseline-focused.log` and
`baseline-sensitive.log`. Production code was compared byte-for-byte with the
saved baseline before these runs; only the test module declaration had changed.

Candidate focused run: exit 0, six passed, two explicitly ignored. Candidate
explicit case-sensitive run: exit 0, two passed. All three rename fixtures and
both content variants passed in both NTFS modes, including exact file listings,
obsolete-directory cleanup, and repeat modification-time checks. The test-file
hash remained identical to the frozen baseline tests.

Candidate module SHA-256:
`35D9F25DA6CA624A58499697B2A60B83EAB5BF3CC09DF94E33D805C73EBFC54D`.
Candidate source, test source, `candidate-focused.log`, `candidate-sensitive.log`,
and structured per-test/fixture results in `regression-observations.json` are
retained in the same temporary evidence directory. These local observations
supplement the engine's baseline and subsequent candidate verification.

Native Linux/macOS execution was not performed. Both required filesystem case
modes were exercised using actual Windows filesystem operations, not test doubles.

Full-suite verification via the Machdoch shell tool returned `isError=true` with
output truncated at 12,000 characters and no recoverable test summary. This
observation is inconclusive. Repeating `cargo test` with complete output retained
in `candidate-full.log` exited 101: 657 passed, three failed, three ignored.
The failures were outside managed prompts:

- `agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers`: missing
  descendant PID fixture at `model_catalog/command_tests.rs:70`.
- `agent_cli_command_reaps_descendants_after_successful_parent_exit`: CLI model
  discovery timed out at `model_catalog/command_tests.rs:306`.
- `terminal_starts_resizes_streams_and_stops`: PTY captured only a cursor-position
  query at `workspace_tools/terminal.rs:2563`.

Diagnostic command:

```powershell
cargo test --lib -- agent_cli_command_reaps_descendants_after_successful_parent_exit agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers terminal_starts_resizes_streams_and_stops --test-threads=1
```

All three diagnostic cases passed (exit 0); see `candidate-failure-probes.log`.
No assertions or unrelated implementations were changed. These isolated passes
do not resolve the full-suite comparison. A repeat of the original `cargo test`
command is recorded separately in `candidate-full-repeat.log`.

The full-suite repeat exited 0: 660 passed, zero failed, three ignored in 82.14s;
main and doc-test targets also passed. This adds four ordinary passing tests to
the engine baseline's 656, plus the two explicitly executed case-sensitive tests.
The initial process/PTY failures remain recorded as intermittent suite risk;
the passing repeat does not erase the earlier failing observation. Automated
baseline/candidate adjudication remains owned by the Ralph verification flow.

Final `rustfmt --check` and scoped `git diff --check` passed. All 54 pre-existing
changed files retained their initial SHA-256 hashes. Only the managed-prompt
module, its extracted/extended test file, and this verification record changed.
No servers were started and no task lifecycle fields were edited.

## Unix identity review repair: frozen verification plan

Preserve the prior engine baseline and all existing workspace edits. The reviewed
candidate and unchanged regression tests are saved in
`%TEMP%/machdoch-managed-prompts-unix-review-20260910` before production edits.
Run the existing frozen filename/directory, content, cleanup, and repeat cases
with `cargo test managed_prompts -- --nocapture` and
`cargo test managed_prompts -- --ignored --nocapture`, before and after the repair.
Run `cargo test` and scoped rustfmt/diff checks on the repaired candidate.
On Unix replace canonical pathname identity with device/inode identity collected
after writes, so atomic replacement cannot leave stale identities.
Attempt native Linux execution through the installed WSL distribution; unavailable
Linux execution or case-insensitive storage remains unresolved, not a pass.

The repair baseline command was consolidated to
`cargo test managed_prompts -- --include-ignored --nocapture`: eight tests passed,
covering both NTFS modes and all frozen cases. No regression tests were changed.
The production repair uses Unix `(dev, ino)` metadata identity and keeps the
Windows canonical-path implementation. Desired and existing identities are read
after all writes. Validation and containment logic remain unchanged.

Native Linux attempt: `wsl -d rancher-desktop -- sh -c 'command -v rustc; command -v cargo; command -v mount; command -v mkfs.ext4; uname -a'`
failed with `Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_PATH_NOT_FOUND`:
the installed distribution's `ext4.vhdx` is missing. Linux case-sensitive and
case-insensitive runtime coverage, including the baseline reproduction, remains
unresolved. The extracted, unchanged Unix identity function successfully compiled
with `rustc --edition 2021 --crate-name managed_prompt_identity --crate-type lib --emit metadata --target x86_64-unknown-linux-gnu`
using the saved `unix-identity.rs` source. This is only a compile check, not a
Linux runtime test or a full application cross-build.

Repair candidate focused results: `cargo test managed_prompts -- --nocapture`
passed six tests with two explicitly ignored; `cargo test managed_prompts -- --ignored --nocapture`
passed both case-sensitive tests. Both content variants completed all three
filename/directory fixtures and repeat checks in both NTFS modes. The frozen
test source hash is unchanged. Scoped rustfmt and `git diff --check` passed.
Logs are retained as `baseline-focused.log`, `candidate-focused.log`,
`candidate-sensitive.log`, and `candidate-full.log` in the repair evidence folder.

The repair's first `cargo test` exited 101: 659 passed, one failed, three ignored.
`workspace_run::manager::tests::keeps_fast_output_bounded_and_publishes_it_while_running`
timed out with state Running at `workspace_run/manager.rs:2062`.
The isolated diagnostic command
`cargo test --lib workspace_run::manager::tests::keeps_fast_output_bounded_and_publishes_it_while_running -- --exact`
also exited 101 with the same timeout (one failed). This is outside the selected
managed-prompt repair; no workspace-run code or test assertions were changed.
The full-suite failure remains unresolved and is not counted as a passing
baseline/candidate comparison. A full repeat is retained separately in
`candidate-full-repeat.log`.

The full repeat exited 101: 658 passed, two failed, three ignored in 108.84s.
The earlier output-streaming case passed in this run. Failures were instead
`workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`
(cursor-key output captured only ESC[6n at terminal.rs:2353) and
`workspace_tools::terminal::tests::long_running_command_continues_until_workspace_cleanup`
(delayed output missing at terminal.rs:2213). These process/PTY results remain
unresolved; the repair cannot be reported as full-suite verified. All managed
prompt cases passed. No further unrelated code changes or test retries were made.

Resumable checkpoint: the Unix identity repair and unchanged frozen regressions
are present in the working tree; native Linux storage verification and a clean
engine full-suite comparison remain outstanding. Only managed_prompts.rs and
this verification record were edited during this repair. Existing task changes
and task lifecycle state were preserved.

## Hard-link review repair: frozen plan

Before production edits, save the reviewed module and tests in
`%TEMP%/machdoch-managed-prompts-hardlink-review-20260910`.
Retain all earlier engine baseline evidence and existing workspace changes.
Add a Unix regression creating distinct `One.prompt.md` and `one.prompt.md`
hard links on case-sensitive storage. Synchronize only the latter twice; after
each call require exactly that entry, original content, and unchanged modification
time. Run the test on Unix when available; unavailable runtime coverage remains
unresolved. The reviewed inode-only implementation is expected to retain both.
Keep all case-only rename regressions unchanged. Before and after the repair run
`cargo test managed_prompts -- --include-ignored --nocapture`; after repair also
run `cargo test`, `rustfmt --check --edition 2021 src/fleet/managed_prompts.rs`,
and scoped `git diff --check`. Probe native execution using
`wsl -d rancher-desktop -- uname -a`. If unavailable, compile the extracted Unix
identity function for `x86_64-unknown-linux-gnu` as a limited compile check.

Hard-link repair observations: the reviewed candidate passed all eight focused
Windows tests before edits, including both NTFS case modes. The repair now keys
Unix entries by parent device/inode and stored filename, preferring an exact
filename over an ASCII case alias with matching file device/inode. Separate hard
links therefore remain distinct even when they share file identity. Windows
identity and all earlier rename cases are unchanged.

Added `removes_obsolete_differently_cased_hard_link`, requiring the exact desired
listing, content and modification time after each of two synchronizations.
On macOS it is explicitly ignored by default because it requires case-sensitive
temporary storage; run it with `cargo test removes_obsolete_differently_cased_hard_link -- --include-ignored`
with TMPDIR on such storage. It runs normally on other Unix targets.

`wsl -d rancher-desktop -- uname -a` failed with
`Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_PATH_NOT_FOUND` (missing ext4.vhdx).
The new Unix regression could not run against either reviewed or repaired code;
Unix runtime verification remains unresolved. The extracted repaired identity
function compiled successfully for x86_64-unknown-linux-gnu using the frozen
rustc command. This does not establish runtime behavior or a full Unix build.

Repair candidate focused command exited 0: eight passed, none ignored, all
filename/directory and content variants exercised on case-insensitive and
case-sensitive NTFS with repeat checks. Scoped rustfmt and diff checks passed.
Candidate source/test snapshots are retained in the hard-link repair evidence
folder. Only the managed-prompt implementation, regression tests and this record
were edited in this repair; no task state or servers were touched.

Full `cargo test` exited 101: 654 passed, six failed, three ignored in 109.30s.
All managed-prompt cases selected by this command passed. Complete output is in
`%TEMP%/machdoch-managed-prompts-hardlink-review-20260910/candidate-full.log`.
Failures were outside this repair:

- child_process::tests::natural_parent_exit_stops_residual_descendants
- child_process::tests::supervised_child_termination_stops_descendants
- desktop_task::cli_commands::tests::bounded_auxiliary_cli_command_captures_success_output
- desktop_task::ralph::tests::ralph_stop_preserves_cooperative_cancellation_window
- workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit
- workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions

No unrelated code or assertions were modified and no passing full-suite result
is claimed. Resumable checkpoint: the hard-link cleanup repair and Unix regression
are implemented; native Unix baseline/candidate regression execution and a clean
full-suite comparison remain unresolved. The supplied engine baseline/candidate
evidence remains unchanged.

## Validation checkpoint resumed 2026-09-10

The existing hard-link repair and Unix regression were already present on entry;
no production or test edits were needed. Advisory workspace presence reported
no other active agents. Existing workspace changes were preserved.

`cargo test managed_prompts -- --include-ignored --nocapture` passed all eight
Windows tests, covering both NTFS case modes and all repeat checks.
Scoped rustfmt and diff checks passed. The native Unix probe still fails because
rancher-desktop's ext4.vhdx is missing; Unix regression execution remains blocked.

The exact isolated terminal stress test reproduced the final-line assertion
failure (one failed, 662 filtered out). The terminal module has no workspace diff;
no causal relationship to managed-prompt synchronization was established.

`cargo test` exited 101: 658 passed, two failed, three ignored in 105.60s.
Failures were `workspace_run::manager::tests::keeps_fast_output_bounded_and_publishes_it_while_running`
(timed out Running) and `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`
(missing final numbered line). Complete output is retained in
`%TEMP%/machdoch-managed-prompts-validation-resume-full.log`.

The selected code repair remains implemented. Unix runtime coverage and the
full-suite verification remain unresolved; this checkpoint is not a completion
claim or a passing engine comparison. Only this verification record was updated
in this resumption. No task state was changed and no servers were started.

## Current validation resumption

The entry state already contained the directory-entry identity repair and Unix
hard-link regression. No production or test changes were made in this resumption.
Advisory workspace presence returned no active agents.

`cargo test managed_prompts -- --include-ignored --nocapture` passed all eight
Windows tests across both NTFS case modes. Scoped rustfmt and diff checks passed.
`wsl -d rancher-desktop -- uname -a` again failed with missing ext4.vhdx
(ERROR_PATH_NOT_FOUND); native Unix regression coverage remains unresolved.

`cargo test` exited 101: 658 passed, two failed, three ignored in 145.62s.
The failures were terminal_drains_high_line_count_output_before_natural_exit
(missing final numbered line) and workspace_supports_mixed_powershell_and_command_prompt_sessions
(PowerShell captured only ESC[6n). The supplied stale-presence failure passed in
this run. Full output is retained at
`%TEMP%/machdoch-managed-prompts-validation-current-full.log`.

No causal link to the selected managed-prompt change was established for these
terminal failures. The repair remains present; Unix runtime verification and a
passing full-suite comparison remain blocked. Only this verification record was
updated, preserving the existing code and task state.

## Selected baseline resumption: 2026-09-10T03:55:58.823Z

The engine snapshot already contains the complete directory-entry identity fix
and regression tests. Their SHA-256 hashes match the captured baseline:

- `managed_prompts.rs`: `6f992a58c1076606f93d142201f8efaeebdc6f7f8e075d509a079d55c78ea8f9`
- `managed_prompts_tests.rs`: `f27219ff56decdc204e5bab558ff929d734baff6910105350d37893e1ee7063d`

No production or test changes were needed. Before verification, the existing
module, tests, record, all 64 baseline file hashes, and exact commands and
filesystem expectations were saved to
`%TEMP%/machdoch-managed-prompts-selected-20260910-035558`. The baseline and
candidate implementation are identical in this resumption; this is validation
of the existing repair, not a new failing-baseline/passing-candidate comparison.

`cargo test managed_prompts -- --nocapture` passed six tests, with two explicitly
ignored. `cargo test managed_prompts -- --ignored --nocapture` passed those two
case-sensitive tests. Both content variants completed all filename, directory,
and combined-case fixtures in both NTFS modes, including desired content,
obsolete cleanup, and repeat listing/mtime checks. Logs are `focused.log` and
`sensitive.log` in the evidence directory. Scoped rustfmt and diff checks passed.

The required `cargo test` exited 101: 667 passed, four failed, three ignored in
111.64 seconds. Complete output and exit code are retained as `full.log` and
`full-exit.txt`. The failures were:

- `runtime_snapshot::model_catalog::command_tests::agent_cli_command_reaps_descendants_after_successful_parent_exit`
- `runtime_snapshot::model_catalog::command_tests::agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers`
- `workspace_tools::terminal::tests::terminal_drains_high_line_count_output_before_natural_exit`
- `workspace_tools::terminal::tests::workspace_supports_mixed_powershell_and_command_prompt_sessions`

The model-catalog tests lacked their descendant PID fixtures; the terminal tests
missed expected output. The supplied engine baseline passed 671 tests with three
ignored. This local failing run does not establish a passing authoritative
comparison, and no causal connection to the managed-prompt repair was established.
The supplied shortcut review's engine-capture repair is outside this selected task.
Engine evidence and lifecycle fields were not modified.

`wsl -d rancher-desktop -- uname -a` exited 1 with
`Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_PATH_NOT_FOUND` because its
`ext4.vhdx` is missing. Unix runtime and hard-link regression coverage remains
unresolved. Before this documentation update, all 64 baseline files still matched
their entry hashes. Only this record changed during the resumption.

Resumable checkpoint: the implementation and regressions remain intact; a passing
engine full-suite comparison and Unix runtime verification remain outstanding.
No servers were started. This checkpoint is not a completion claim.
