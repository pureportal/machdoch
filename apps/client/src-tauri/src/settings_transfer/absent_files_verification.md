# Absent configuration rollback verification

Task: `preserve-absent-files-in-settings-rollback`.

Frozen before production edits on 2026-09-10. Baseline HEAD is
`f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`; existing workspace edits are retained.
The supplied engine baseline reports `cargo test`: 674 passed, 18 ignored.
Original transaction source and command logs are retained under
`.machdoch/ralph/runs/2026-09-09T23-30-29-571Z/code-improvements/preserve-absent-files-evidence/`.

## Frozen commands and fixtures

Working directory: `apps/client/src-tauri`.

1. `cargo test settings_transfer::transaction::persisted_recovery_tests`
2. `cargo test settings_transfer::transaction`
3. `cargo test`

Run the identical new behavioral tests before and after changing the backup representation.
Tests use a Tauri mock application and subprocess-local `MACHDOCH_USER_CONFIG_DIR`;
no live settings or servers are used. Enable the existing Tauri dependency's test
feature as a dev dependency for these tests (`allowDependencyChanges=true`).
The selected task requires changing the private rollback JSON shape
(`allowSchemaChanges=true`); no public API change or legacy decoder is planned.

Fixture matrix: each file (`user-config.json`, `mcp.json`) independently takes
unselected, selected-absent, selected-empty, or selected-populated state: 16 pairs.
The both-unselected case selects GlobalPrompts to keep category metadata valid.
Populated fixtures include whitespace, CRLF, Unicode, and non-UTF-8 bytes.

- Persist through `write_private_json`, reload through `load_backup`, and compare
  the complete captured backup and its fingerprint for every pair.
- Exercise `recover_pending_transaction` for every pair in Prepared, Committing,
  and Committed phases. Only Committing restores selected files. Absent originals
  are removed; present originals are restored byte-for-byte; unselected files
  retain their post-capture contents. Prepared/Committed retain live edits.
- Recover twice. Success removes the journal, retirement marker, rollback data,
  transaction payload, and orphan staging payload.
- For each resource, mismatch its selected category and backup state in both
  directions. Recovery rejects before touching either file and retains its
  journal and backup. Also reject a journal/backup category mismatch.
- For each resource and absent/empty/populated original, replace its target with
  a directory to force restoration failure. Recovery retains exact journal and
  backup bytes and payload. Remove the blocker and retry successfully, then
  recover again safely.

Expected baseline: absent-state reload and Committing recovery fail metadata
validation; present-state and unrelated selection checks continue to pass.
Expected candidate: every matrix case passes; focused and full suites pass with
no new failures. No external engine verification tool is exposed to this agent;
local command evidence will be recorded separately from supplied engine evidence.

## Checkpoint

Baseline original transaction SHA-256:
`1f578260e2a0a4e7b9136092e7d63d06745ebf27851b613ffd825e247f3e8158`.
Frozen regression source SHA-256:
`f5292571192c148bbf89c7c1210e541e4f0e1075211d3bf08856c48fcd04e17a`.

Local baseline regression command exited 101: all four test groups failed,
with 18 failures among 79 subprocess cases (61 passed). Seven round-trip cases
and seven Committing recovery cases lost an absent original; two failure/retry
cases failed metadata validation before reaching restoration. Two inconsistent
selected-absent cases lost their selection mismatch and reached restoration,
then failed fingerprint verification. This is additional observed impact of the
same ambiguous representation, beyond the initially expected baseline failures.
The focused baseline exited 101: all 15 existing tests passed, the four new
regression groups failed. Logs: `baseline-regressions.log`, `baseline-focused.log`.

Candidate replaces nested options with a tagged `ConfigFileBackup` enum and
updates capture, validation, restoration, and zeroization together. The 79-case
regression source remains unchanged. Local candidate regression command passed
all four groups (79/79 subprocess cases); focused command passed all 19 tests.
Both exited 0. Logs: `candidate-regressions.log`, `candidate-focused.log`.
The full candidate `cargo test` exited 0: 678 passed, 18 ignored, zero failures;
main and doc-test targets also passed. Log: `candidate-full.log`. The only compiler
warning was the pre-existing unused `desktop_task_activity_elapsed` function.
Formatting and scoped `git diff --check` passed; all 81 unrelated
modified/untracked files matched their saved hashes. No lockfile change occurred.

Local implementation and verification are complete. Interruption is simulated
with persisted journals and real filesystem mutations; physical power loss and
non-Windows platforms were not tested. The old private backup format is not
decoded. Existing old-format transactions must be resolved using their matching
implementation before switching formats; no live transaction data was touched.
Engine acceptance remains owned by the surrounding Ralph flow. Do not change
task lifecycle fields. Before reverting the format, resolve any candidate-written
pending transactions with candidate recovery; preserve retry data and unrelated edits.
