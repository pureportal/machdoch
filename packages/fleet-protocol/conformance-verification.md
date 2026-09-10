# Shared protocol conformance verification

Task: `add-cross-language-protocol-conformance-fixtures`.
Baseline: `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`. The six pre-existing Product UI changes are outside this task and are preserved.

Before implementation, from `packages/fleet-protocol`:

| Command | Result |
| --- | --- |
| `pnpm test` | Passed, 13 tests |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed |
| `cargo test` | Passed, 25 unit tests, 0 doc tests |

## Frozen inventory and verification plan

Before production edits, the shared corpus contains 267 cases: accepted examples for all 53 command kinds, each required command field omitted individually, unknown fields and kinds, RALPH parameter and transition constraints, media format and count constraints, session and scheduler values, managed-settings deliveries, and snapshot shape and gateway-budget boundaries.

Corpus SHA-256: `d64f09b9f5227b2369eda88b9ef1bf110cce8dc02831c8af7a61bf373cb66d5e`.

Preflight corrected two authored payloads against the existing contract before production edits: prompt enhancement uses `off`, and a default model requires a provider (the reverse is permitted). The latter rejection case is named `settings/model-without-provider`. The hash above is the corrected, frozen corpus used for the baseline and candidate comparison; acceptance booleans did not change.

Both consumers read the same IDs, target, payload and acceptance boolean. They reject unknown fixture metadata, targets and versions, empty corpora and duplicate IDs. Rust collects mismatches until every case has run; TypeScript registers each case separately. Each emits `CONFORMANCE <id> accept|reject` so executed inventories and outcomes can be compared exactly.

`gatewayBytes` expands only snapshot fixtures with an empty first-session log array. Both consumers append logs with `createdAt: 0`, `stream: "stdout"` and ASCII `x` chunks of at most 12,000 characters. They use as many full chunks as fit while reserving one final log, then size its chunk to reach the declared compact UTF-8 JSON byte count. The three fixed sizes are 4,194,303, 4,194,304 and 4,194,305 bytes. Each consumer asserts the expanded byte length. Object key ordering does not affect these byte lengths or JSON payload values.

Run `pnpm test` and `cargo test -- --nocapture` with the consumers against unchanged baseline validators, retaining all failures. Correct only fixture-proven defects. Rerun the same commands with the unchanged corpus against the candidate and compare every emitted ID/outcome with the declared inventory. Run `pnpm typecheck`, `pnpm lint`, and `git diff --check`. Product UI typecheck is required if exported TypeScript contracts change.

## Results

| Target | Accepted | Rejected | Total |
| --- | ---: | ---: | ---: |
| Commands | 59 | 171 | 230 |
| Managed settings | 3 | 15 | 18 |
| Snapshots | 3 | 16 | 19 |
| Total | 65 | 202 | 267 |

With the frozen corpus and unchanged baseline validators, TypeScript passed all 280 tests (13 existing plus 267 shared cases). Rust passed its 25 existing unit tests, executed all 267 shared cases, and disagreed with 13 declared rejections:

- `settings/missing-profile`
- `snapshot/missing-enabled`
- `snapshot/missing-serverTime`
- `snapshot/missing-eventId`
- `snapshot/missing-sessions`
- `snapshot/missing-commands`
- `snapshot/null`
- `snapshot/wrong-enabled-type`
- `snapshot/negative-time`
- `snapshot/fractional-event`
- `snapshot/sessions-not-array`
- `snapshot/commands-not-array`
- `snapshot/unknown-snapshot-field`

Rust now requires the nullable `profile` field to be present and validates the product snapshot root during deserialization. The root retains the existing TypeScript field names and types, including nonnegative safe-integer timestamps and event IDs. Command validators, managed-settings content validators, gateway-budget validators, TypeScript exports and dependencies are unchanged. Existing Rust gateway-budget tests now build structurally valid snapshots with bounded log chunks instead of an arbitrary `payload` field; their byte boundaries and acceptance expectations are retained.

| Candidate command, from `packages/fleet-protocol` | Result |
| --- | --- |
| `pnpm test` | Passed, 280 tests; no skips |
| `cargo test -- --nocapture` | Passed, 25 unit tests and 1 integration test executing 267 fixtures; 0 doc tests |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed |
| `git diff --check` | Passed |

An initial candidate typecheck caught `assert.deepEqual(logs, [])` narrowing the test helper's array to `never[]`. It was replaced with an equivalent length assertion; the final TypeScript suite, typecheck and lint were rerun and passed.

The baseline and candidate logs are in the invocation's temporary directory as `fleet-conformance-baseline-final-{ts,rust}.log` and `fleet-conformance-candidate-{ts,rust}.log`. A comparison of their emitted `CONFORMANCE` lines confirmed that all four executions contain exactly the 267 declared IDs, once each. Both candidate outcome lists equal the declared outcomes, with no remaining fixture disagreement. SHA-256 of the sorted outcome lines, joined with LF and a trailing LF: `6be28e73b24f57895121549d987e39231bfa6d728a424267f4e57ad25fba8928`. The frozen corpus hash remained unchanged throughout production edits and candidate verification.

All six supplied Product UI baseline file hashes were checked and remain unchanged. Product UI typecheck was not repeated because no exported TypeScript contracts changed. No task lifecycle fields, dependency manifests or servers were changed.

## Verification limits

Agreement is established for this corpus, not every possible wire value. Rust still treats nested snapshot session, command and shell contents as opaque JSON; full nested snapshot validation and exhaustive numeric/string boundaries are outside this fixture inventory. Serialization normalization and raw JSON whitespace/escape equivalence are not compared by these acceptance tests; existing language-local tests remain in place.
