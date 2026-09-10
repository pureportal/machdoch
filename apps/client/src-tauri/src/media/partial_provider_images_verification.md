# Partial provider image results checkpoint

Task: `retain-partial-provider-image-results`
Run: `2026-09-09T23-30-29-571Z`

## Blocker

Production implementation has not started. The task requires the engine to freeze the baseline, exact regression commands, registration boundaries, and expected batch states before production edits. The supplied engine evidence covers the existing `cargo test --all-targets` suite (674 passed, 18 ignored), but contains no task-specific fixture contract or baseline observations. This invocation exposes no Ralph verification-plan freeze operation. Machdoch cached MCP searches for `verification` and `freeze` each returned zero tools.

This document is a proposed verification contract and resumable checkpoint, not an engine-owned freeze or proof of completion. Do not mark the task complete from this document or the existing passing suite. Task lifecycle fields have not been modified.

## Preserved baseline

HEAD: `f4b3cf6256ecd1e25ebbd1c0c01d8bfc11433aee`.
The three selected production files have no Git changes. SHA-256 hashes observed before edits:

| File | SHA-256 |
| --- | --- |
| `provider_openai.rs` | `1711fabecf9c8b2ae2de1d3c92c3755dbe1fffab4bd5cd01788e0be532a7cece` |
| `database.rs` | `c8f89f74ba084ce9371164c067c6e17913ab7e70de4c1c7ca91daa0d514154e4` |
| `mod.rs` | `89a506e9fe4d8f9fdad2f51cffd8a2c7d40747d999ed16091a9394007439689f` |

Preserve all pre-existing workspace changes, including `ingest.rs`, `model_install.rs`, and their verification files. Supplied clipboard and import-integrity review feedback belongs to other tasks.

## Implementation boundaries

- `provider_openai::ingest_response` publishes validated output bytes before appending metadata to an in-memory vector. Later base64, image validation, or subject-cutout failures return without delivering earlier metadata to the caller.
- Commit each output's blob registration, asset record, output index, originating run, pinned flow revision, provider request ID, and applicable source lineage after final validation and CAS publication, before processing the next output. Never register raw or partially transformed outputs.
- The ingestion function is shared by generation and image editing. Wire both callers to the durable registration boundary; image edits must also preserve `asset_inputs` and the existing source manifest.
- Replace the registration loops in `complete_remote_image_generation` and `complete_remote_image_edit` with completion checks against registered outputs. Completion must verify the expected count, order, and identity before changing provider state. Keep one registration path and propagate transaction failures explicitly.
- Keep run/provider state non-complete until the entire batch succeeds. Preserve the existing `fail_remote_image_generation` review quarantine and startup recovery behavior. Previously committed assets must survive both paths, without automatic resubmission or automatic human-review approval.
- Account for cancellation between output registrations. Existing completion messages claiming that no outputs were published become inaccurate if earlier outputs were registered; preserve those outputs and keep terminal/review state accurate.
- Keep replay idempotent using the existing run/output identity. Reject conflicting output identity or metadata rather than silently accepting a different asset. Do not add schema, dependency, or public API changes unless required and independently verified.
- Leave execution-placement optimizations to `offload-provider-image-processing`.

## Proposed engine fixture contract

Freeze the final runnable fixture source and its hash before production edits. Run identical fixtures against baseline and candidate; do not report a zero-test filter as behavioral evidence. Suggested focused module: `media::provider_openai::partial_results_tests`.

Use deterministic PNG bytes for two distinguishable valid images. Freeze the actual encoded bytes and SHA-256 digests in the fixture contract. A response has two ordered outputs and a fixed provider request ID. A test-only transport/postprocessing seam must exercise the production submission and ingestion path without external credentials or a server. Count submissions at the actual transport boundary.

| Scenario | Required candidate observation |
| --- | --- |
| Valid first PNG, second base64 `%%%` | Explicit decoding failure; exactly the first asset and its bytes/lineage remain after reopen; run `needs-review`, provider `acceptance-unknown`, review required |
| Valid first PNG, second base64 `bm90IGFuIGltYWdl` | Explicit image validation failure; same persistence and state assertions; invalid bytes have no successful asset |
| First cutout succeeds, second cutout returns a deterministic error | Only the fully transformed and revalidated first output is registered; cutout error remains visible |
| Second cutout is paused after first durable commit, then ingestion is interrupted | Reopen and perform startup recovery; first bytes, digest, lineage and review gating survive; no batch completion |
| SQLite registration fails on the second asset | Inject a transactional failure; explicit registration error, first transaction retained, second transaction rolled back, no false completion |
| Recovery runs repeatedly | Stable asset IDs/counts and lineage, no duplicate registration events, one provider submission, review still required |
| Both images succeed | Exactly two assets in provider order with correct lineage; provider completes only after both registrations; pinned human review still waits for a human decision |
| Registration replay/conflicting replay | Identical replay creates no duplicate assets; conflicting metadata returns an explicit error |
| Image-edit response fails on second output | First asset retains its source manifest and `asset_inputs` through reopen and repeated recovery |
| Cancellation after first registration | Previously committed asset remains recoverable; cancellation cannot be reported as full batch success |

Assert no new generation claim can bypass an unresolved provider review. Exercise existing run detail retrieval and asset visibility so early registration cannot expose unreviewed outputs as approved assets.

Commands from `C:\Development\machdoch\apps\client\src-tauri`:

```powershell
cargo test --all-targets media::provider_openai::partial_results_tests -- --nocapture
cargo check
cargo test --all-targets
```

The focused module does not exist yet; its command is proposed, not executable verification evidence. The engine must freeze runnable fixtures before accepting that command. Require nonzero matching tests with no ignored task regressions. Capture exit status and full output for each baseline/candidate run.

## Verification performed during preparation

- `cargo check`: exit 0; existing unused `desktop_task_activity_elapsed` warning.
- `cargo test --all-targets`: exit 0; 674 passed, 0 failed, 18 ignored; 56.79 seconds. The main target has zero tests.
- `git diff --exit-code -- src/media/provider_openai.rs src/media/database.rs src/media/mod.rs`: exit 0; selected production files unchanged.

These checks cover the existing implementation only. They provide no candidate or task-specific persistence evidence.

## Resume

1. Supply or expose the engine-owned task verification freeze and capture baseline fixture results against the preserved source hashes.
2. Implement per-output durable registration and replace deferred batch registration, covering both shared-ingestion callers.
3. Run candidate fixtures, `cargo check`, and `cargo test --all-targets`; inspect persistence, submission count, review state, and final diff.
4. Retain this checkpoint for unresolved engine evidence or platform checks. Let the flow's lifecycle blocks update task state.

No new tests, production changes, servers, provider requests, schema changes, or dependency changes were introduced during preparation. Crash/power-loss behavior, actual provider transport, cutout failures, and candidate persistence remain unverified.
