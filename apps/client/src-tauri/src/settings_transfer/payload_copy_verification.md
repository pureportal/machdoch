# Prepared payload copy verification

Task: `remove-unused-settings-transaction-payload-copy`.

Frozen before production edits on 2026-09-10, against HEAD
`f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee` plus the supplied workspace baseline.
Preserve the prerequisite rollback representation and all unrelated edits.
Evidence directory: `.machdoch/ralph/runs/2026-09-09T23-30-29-571Z/code-improvements/remove-payload-copy-evidence/`.

## Frozen verification plan

Run `cargo test settings_transfer::transaction` and `cargo test` from
`apps/client/src-tauri` against baseline and candidate with identical tests.
Baseline must fail only the new prepared-directory assertion; candidate must pass.
The supplied engine full-suite baseline passed 678 tests with 18 ignored.

- Prepare a staged envelope containing synthetic API credentials. Assert staging
  contains its payload until finish, verifies digest and length, parses identical
  data, and removes its directory. Assert prepared storage contains only
  `rollback.json` (use the actual BACKUP_FILE constant), and load its persisted backup.
- Commit the staged credentials and global MCP selection, verify selected values
  and preserved unselected user settings, and check journal/transaction cleanup.
- Cancel partial staging and discard a prepared transaction; verify cleanup and
  successful reuse of the transfer ID. Reject incomplete, bad-digest and malformed
  staging inputs without retaining their payloads.
- Fail preparation at backup and journal persistence using the existing atomic
  durability fault hook. Check no journal or transaction remains and retry succeeds.
- Reuse the existing 79-case persisted recovery matrix, removing only its fake
  prepared payload and updating the corresponding absence assertion before both
  runs. Preserve orphan staging cleanup, all journal phases, absent/empty/present
  file states, selection validation, repeated recovery and failure/retry checks.

Tests use subprocess-local configuration roots and synthetic values; assertions
must not print payload contents. No servers, dependency, schema or public API
changes are needed. Keep the test source identical across baseline/candidate.

No callable engine plan-freezing API is exposed. This document and local command
logs provide a resumable verification checkpoint; the surrounding Ralph engine
owns acceptance and task lifecycle updates. Do not represent local logs as an
engine-owned freeze or candidate decision.

## Results checkpoint

Original transaction SHA-256:
`42b5b536f7638be672657b156b1c0a1628f3be7f59b877cbd8a8ac2e171ff60e`.
Frozen payload regression SHA-256:
`f0c2e30ee0629b341816a848049969807ebe11e59af40a902640da31748521b1`.
Frozen recovery regression SHA-256:
`4c66a4775dd6ab8885c1c41c859212e71442fe9d0e87f135f05731737476a684`.

Local baseline focused run exited 101: 22 passed, one expected failure. The
prepared directory contained `payload.json` and `rollback.json` rather than
only `rollback.json`. All other checks passed, including the 79 recovery cases
without a prepared payload. Log: `baseline-focused.log`.

Local full baseline exited 101: 681 passed, one expected directory assertion
failure, 18 ignored, in 65.92 seconds. Log: `baseline-full.log`.

The production change deletes only the redundant envelope serialization/write.
The in-memory envelope, incoming stage, journal ordering and rollback backup
remain unchanged. Test source hashes are unchanged between baseline and candidate.
Formatting and scoped `git diff --check` passed.

Local candidate focused run exited 0: 23 passed in 10.15 seconds. Local candidate
full run exited 0: 682 passed, zero failures, 18 ignored in 70.15 seconds; main
and doc-test targets passed. Logs: `candidate-focused.log`, `candidate-full.log`.
The only compiler warning was the pre-existing unused
`desktop_task_activity_elapsed` function.

All 83 pre-existing files outside the two edited source/test files match the
supplied snapshot hashes (`scope-check.json`). The task adds this document and
`transaction_payload_tests.rs`; it changes `transaction.rs` and removes the fake
prepared payload from `transaction_recovery_tests.rs`. No dependency, lockfile,
schema, public API or task lifecycle field changed. Candidate source hashes and
local command records are saved with the logs.

Local implementation and verification are complete. Engine acceptance remains
pending independently of local verification: the surrounding Ralph flow must
record its candidate evidence and assess the locally frozen plan before closing
the task. This checkpoint remains resumable until then. Physical power loss and
non-Windows behavior are untested. No live transaction data was modified.

To revert this task, restore only the two removed preparation lines and remove
its tests/documentation changes; preserve the prerequisite recovery fix and
unrelated workspace edits. Do not recreate payload files for pending transactions.
