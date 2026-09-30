# RALPH reliability repairs — 2026-09-30

Both failed flows have repaired source definitions and repaired saved copies. The Code Improvement and Refactor flows now continue through healthy coverage cycles, wait for temporarily ineligible scopes, and preserve real blockers with actionable causes. Completion requires a fresh passing verification command. This follows the [failure investigation](ralph-failure-investigation-2026-09-30.md), which records the state before these repairs.

## Repairs to the eleven findings

| Finding | Repair |
| --- | --- |
| Obsolete scope registry rejected before scanning | Removed the redundant scope-registry schema ID/version gates. Retained structural validation. Backed up and rebuilt the obsolete Refactor registry from current repository evidence. Refreshed the Code Improvement registry without discarding its history. |
| Missing native prerequisites | Added one Windows toolchain preparation path shared by Tauri and Cargo verification. It validates libclang, an installed MSVC x64 toolset, CMake, and Ninja before compilation. Installed usable libclang on this machine. |
| Incorrect bundled native bindings | Windows builds reject `WHISPER_DONT_GENERATE_BINDINGS`. Cleaned the affected whisper dependency artifacts and regenerated bindings for the actual Windows target. Selected Ninja to avoid the broken MSBuild post-build path observed during recovery. |
| Failed compilation accepted as successful verification | Matching nonzero failures remain inconclusive. Known unavailable prerequisites cannot establish verification. Zero-test unittest/Cargo runs cannot establish passing task verification. `MARK_JSON_TASK` requires fresh passing candidate evidence and records its exact command, working directory, plan, fingerprint, timestamp, run, and operation. |
| Unstable verification equality | Diagnostic categories and normalized incidental console text produce stable fingerprints. Normalization does not turn a failed command into success. |
| Repeated inconclusive failures escaped retry accounting | `INCONCLUSIVE` participates in repeated-failure accounting. Prerequisite signatures ignore panic PIDs and incidental compilation output; different source diagnostics remain distinguishable. |
| Unavailable baselines entered implementation | Bundled starters route baseline errors/inconclusive checks and candidate inconclusive checks to deferred handling. A source-level failed baseline can still be repaired against its frozen command, but a missing execution prerequisite cannot enter implementation. |
| Wrong verification language/boundary | Python scopes take precedence over a parent Cargo manifest. Python discovery finds a usable interpreter and discovers actual test files. Task planning requires an executable verification command and working directory. Command selection honors that task boundary. Standard JavaScript verification includes tests. |
| Lost templated strategies | Persistence and starter normalization preserve templated strategies and numeric scan bounds. Literal task selection strategies are retained; invalid strategies fail explicitly. Starter fingerprints and discovered variables survive persistence/upgrade round trips. |
| Missing concrete causes | Deferred journals and outcomes retain bounded causes, diagnostic categories, retry conditions, timestamps, and run/block identities. Journal timestamps remain stable during operation reconciliation. |
| Advisory scope checks counted as proof | Advisory scope results use their own output and cannot establish affirmative scope verification. Bundled starter guards enforce scope against the pre-change Git snapshot while excluding unchanged pre-existing edits. |

## Continuous operation and related fixes

The two primary starters default `continuous` to `true`. Completed coverage waits 60 seconds and begins another scope cycle. With all scopes cooling down, the flow waits for `nextEligibleAt`, checking every 30 seconds, then refreshes coverage. `continuous=false` completes one coverage cycle. The primary starters have no default total transition ceiling; explicit caller budgets, cancellation, per-check deadlines, repair budgets, repeated-failure limits, and stagnation guards still apply.

Two additional cycle defects were corrected: boolean variable conditions compared persisted strings against JSON booleans, and scope availability treated historical completion as completion in the new cycle. Scope selection and cycle renewal now count as coverage progress, so a healthy repeated scan does not trip semantic stagnation protection. Refactor counters distinguish successive coverage cycles.

Native checks from concurrent flows serialize against an isolated `target/ralph-verification` directory. Waiting for ownership remains cancellable and consumes the same verification deadline as the command. Checks no longer contend with the desktop development target by default. An explicit `CARGO_TARGET_DIR` remains authoritative.

Runtime histories, events, logs, operation indexes, completed operation receipts, counter groups, and repeated final-report registrations are bounded. JSONL queries and execution-history recovery stream the file instead of loading the entire history. Queries validate discarded records as well as selected records. Durable history remains available on disk; malformed terminated history is rejected, while an unterminated crash tail can be recovered.

Workspace health resolution uses cancellable asynchronous DNS instead of an uninterruptible blocking resolver pool. HTTP and TCP use the bounded resolution path. Late health results, restart accounting, and child admission require the active generation and cancellation state. Cancellation also wins over late supervisor terminal failures. State mutation finishes under the manager mutex before callbacks run.

## Schema decision

The scope registry did not need a separate schema identity/version framework. Those fields and gates are gone. It has one current structure and one validator; the obsolete saved registry was rebuilt, without adding a legacy reader or migration shim. The append-operation ledger's unversioned compatibility branch was also removed.

JSON validation is still necessary at model-output and persisted-file boundaries. TypeScript types cannot validate JSON supplied by a model or read from disk. Task/output schemas prevent missing commands and ambiguous decisions from reaching mutating blocks. Checkpoint integrity and operation receipts protect recovery and idempotency. These responsibilities remain; removing them would reintroduce the false-completion and unsafe-replay problems. No general-purpose replacement schema framework was introduced.

## Saved-state recovery

| Scope | Flow ID | Starter version |
| --- | --- | --- |
| Workspace | `0950d833-6eaf-4f05-b3cb-957013fac802` | Code Improvement 25 → 27 |
| Workspace | `f2567574-eb30-4c07-8d3a-17b1af1661d3` | Refactor 22 → 24 |
| User | `12e3366c-38ab-4956-8451-b5c37ad31370` | Code Improvement 25 → 27 |
| User | `dde589e0-f53f-4ce1-9405-b5052275e4c1` | Refactor 22 → 24 |

The upgrades preserved flow identities and user defaults, had no merge conflicts, passed flow validation, and survived fingerprint checks after being written. All four saved copies include continuous mode, cooldown waiting, prerequisite routing, and preserved scope strategies.

Both scope registries now contain 84 active scopes from the current repository layout. The Code Improvement registry retained 34 history entries. Both previous registries, their Markdown companions, all four saved flow files, and the corrected plans are backed up under `.machdoch/ralph/repair/2026-09-30T13-41-26-691Z`. The complete file hashes and recovery actions are in [the recovery manifest](../.machdoch/ralph/repair/latest-recovery.json).

The two incorrectly completed Rust tasks were successfully reverified. `bound-workspace-health-probe-lifetime` was also verified and marked completed. Their plans now record explicit native verification commands and working directories. The expired `reclaim-inactive-workspace-runtime-state` claim was released back to `planned`; that unrelated unfinished implementation remains available to the flow. Failed historical run records and logs were preserved. Start a new run using the upgraded definition; an old checkpoint is tied to its original graph fingerprint.

On this machine, libclang 18.1.1 is installed under `%LOCALAPPDATA%/machdoch/toolchains/llvm`; the runner discovers its `bin` directory, and the user `LIBCLANG_PATH` is set. Python 3.12.10 and the dependencies needed by the retained minimax business tests were installed. These are local prerequisites, not bundled dependencies or speculative compatibility paths.

## Verification

| Check | Result |
| --- | --- |
| RALPH domain regression suite | 467 tests passed across 24 files, including real engine state transitions, durable completion reconciliation, saved-flow upgrades, repeated coverage cycles, cooldown conditions, streaming history, and scope enforcement. |
| Native Workspace Run business logic | 77 tests passed with the isolated verification target, including DNS cancellation/deadlines, health result admission, sequential child cancellation, and late supervisor failure suppression. |
| Native Settings Transfer business logic | 99 tests passed, including the previously falsely completed recovery-artifact task's verification boundary. |
| Retained minimax Python business logic | 14 tests passed. |
| Native compilation | `node ../scripts/run-cargo.mjs check --locked` passed. Native test compilation also passed in the isolated verification target. Existing dead-code warnings remain. |
| Core production and core-test TypeScript | Both type checks passed. |
| UI production TypeScript | Type check passed; no UI tests ran. |
| Scoped static analysis | Core and the three native-runner scripts passed oxlint. |
| CLI bundle | Build passed; the generated CLI successfully executed `--help`. |
| Diff integrity | `git diff --check` passed. |

The passing business suites total 657 tests. No UI tests, browser automation, or development servers were run. Existing unrelated working-tree changes were preserved. Full UI-test type checking remains blocked by existing assistant-bubble-shell, surface-geometry, and assistant-display-layout test errors; those files were not changed to accommodate this work.

## Remaining limits

Long-running live model/provider executions and a packaged desktop release were not run. Deterministic engine tests establish repeated cycling, budget/cancellation behavior, and correct verification routing; they cannot establish that an external provider will remain available indefinitely. The historical instruction-adaptation failure cannot be reconstructed from its truncated old diagnostic record, so its original provider-launch cause remains unverified. New failures retain their available execution cause and stop or defer within configured limits.

Durable audit files and archived work continue to consume disk space over time. In-memory bounds do not constitute disk retention. Continuous operation still depends on available storage, a healthy verification toolchain, valid provider credentials, and commands that exercise the selected task. A genuine unavailable prerequisite remains a blocker rather than a reason to report successful work or retry forever.
