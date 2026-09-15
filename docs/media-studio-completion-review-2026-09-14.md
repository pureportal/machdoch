# Media Studio completion review — 14 September 2026

## Changes

The [15 September loop review](wan-loop-review-2026-09-15.md) found that the WAN output below is not seamless. This pass verified generation and playback, but missed a visible fire/smoke reset across the last two and first two frames.

- Generation cards, Advanced, and Activity show remaining-time estimates. The estimator learns from successful persisted runs and individual workflow nodes, groups observations by hardware/runtime and generation settings, weights recent observations, and rejects large outliers. New workflows can reuse measured node costs; sampling progress supplies a step estimate before matching history exists. Queue time and human review waits do not train execution estimates. Unknown or stale estimates remain indeterminate.
- Fixed a native validation mismatch that rejected WAN renders with identical endpoint images. The worker reports `first-anchor+mobius-latent-shift-v2`; native validation previously expected `first-last-temporal-context-lock-v3` and rejected the completed render. The native expectation now follows the actual endpoint strategy, with a specific mismatch diagnostic. Output, loop, alpha, model, runtime, and memory-release checks remain intact.
- Local model/add-on inspection reads the safetensors header before configuration. Full hashing and copying start only after Import. Imports run in a shared queue, survive navigation, and show completion, failure, retry, and View actions in Assets. Metadata writes preserve concurrent edits and serialize persistence. Retrying a metadata failure reuses the imported resource. Unsettled imports prevent automatic shutdown.
- Basics includes custom local image/video dimensions, sampling steps, compatible guidance controls, seed, memory settings, image format/quality, video frame rate/count/encoding/duration, and SVG canvas/candidate/output/text controls. The converted flow retains these values. Distilled-model constraints are enforced. Compatible image LoRAs and embeddings remain selectable; videos that generate a starting image expose its model and add-ons explicitly.
- Removed empty reference sections, show custom dimensions in collapsed settings, reset sampling when selecting an image quality preset, and select PNG when enabling transparency on JPEG output. Aspect-ratio controls are disabled while custom dimensions apply.

## Verification

- Client core/UI/test TypeScript checks and lint passed. The complete media test run passed 295 tests across 46 files; follow-up tests passed after the final changes, including two additional estimator tests for composed workflows and execution timestamps.
- Native media tests: 213 passed, 3 intentionally ignored. Rust formatting checked for changed files. Unrelated formatting changes were removed.
- Python suite: 84 tests run, 83 passed and 1 skipped.
- Playwright used the existing Vite server. Checked real application navigation and conversion, and component fixtures for installed local models and native import callbacks. Verified custom image/video/SVG values and LoRA strength in converted flow configurations, invalid-dimension blocking, configure-before-import, background navigation, failure/retry, completion/View, time-estimate display/removal, JPEG-to-PNG transparency handling, and layouts at 1440, 430, and 320 pixels.
- The original failed WAN request was replayed against the current worker using the managed Python runtime and existing model weights on the AMD Radeon RX 9070. It completed successfully in 775.27 seconds. Output: VP9 WebM, 512 ? 288, 16 decoded frames, 8 fps, 2 seconds. No exact duplicate frames or duplicate closure frame. Decoded loop boundary continuity ratio: 1.1066, within the native 1.25 limit. GPU allocations were released. Playwright loaded and played the resulting video without a media error.

## Evidence and limits

Local evidence is in `apps/client/.cache/media-refinement-2026-09-14/`: screenshots and accessibility snapshots, `wan-request.json`, `wan-probe.json`, `wan-response.json`, `wan-stderr.log`, and `wan-output-1789419115/output-0000.webm`. The directory is ignored by Git. Browser fixture setup errors and HMR-related locator retries were corrected before the successful checks; they were not native application failures.

The live replay exercised the actual GPU worker. Desktop IPC publication of that replay and a packaged installer build were not rerun. Native import integrity is covered by Rust tests; the browser import check used a controlled copy callback. Full-size imports, other GPUs, paid SVG providers, and every custom-resolution/model combination were not exercised live. Estimates require comparable history or observed progress and remain approximate under changing load. Import queues continue while the app is open; they do not resume after application restart. Native changes require a rebuilt desktop application.
