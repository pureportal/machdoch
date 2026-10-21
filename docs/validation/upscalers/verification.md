# Upscaler verification

For the subsequent layout and shared-component improvements, see the [UI review](ui-review/verification.md).

Verified on Windows with an AMD Radeon RX 9070, 16 GB VRAM, using the built desktop app and its local ROCm/PyTorch runtime. The installed release was not replaced.

| Requirement                           | Implementation and evidence                                                                                                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple local, open-source upscalers | SPAN, ai-forever Real-ESRGAN and official lightweight SwinIR; custom Spandrel files. [Ten GPU runs](gpu-results.json) cover all three architectures, 2×/4× images, 2× video for all three, and 4× SPAN video.                                                                 |
| Studio menu                           | Upscale navigation item and Alt+6 command. [Native UI](ui-image-span-4x.png).                                                                                                                                                                                                 |
| Video                                 | Streams frames through one loaded model, preserves frame count/rate and audio, exports VP9 WebM. [Native video run](ui-video-realesrgan-2x-run.json), [playback](ui-video-playback.png), [export checks](export-verification.json).                                           |
| Chain with generation                 | Typed image/video operations, compiler and backend execution support, image/video templates. [Compiler tests](../../../packages/media-studio/src/core/media/upscale.spec.ts), [fresh generation chains](generation-chains.json), [Advanced canvas run](ui-advanced-run.json). |
| Generated-media context actions       | Basic results, library menus, asset details and upscale results open the selected media in Upscale. [Image menu](ui-library-images-context.png), [video menu](ui-library-videos-context.png), [context checks](playwright-results.json).                                      |
| Basic/advanced controls               | Source, model, 2×/4× scale; tile size, custom model file and Open in Advanced. Source selection collapses after choosing media. [Basic page](ui-image-span-4x.png), [Advanced flow](ui-advanced-video.png).                                                                   |
| Stability and recovery                | Tile validation, model-file preflight, failed-job recovery, cancellation of a running job and supervised worker cleanup. [Missing model](ui-missing-model.png), [canceled run](ui-canceled-run.json). No upscaler Python or FFmpeg child process remained after cancellation. |
| Research and licensing                | [Research](research.md), [pinned model downloads](model-downloads.json), [attribution](../../../THIRD_PARTY_NOTICES.md), full licenses in `legal/third-party/upscalers/` and installed model folders.                                                                         |

The native Playwright checks exercise the real import, model install, inference, queue, export and asset handlers. File-dialog paths are supplied by the test; the operating system's picker dialogs are not automated. The checks cover one final result per job, video playback, errors, cancellation, context actions and a 1000×740 layout without horizontal page overflow. Renderer checks recorded no page errors or external upload requests. [Results](playwright-results.json).

Exports match the asset SHA-256 digests byte for byte. The exported video decodes fully at the expected dimensions, frame count, rate and duration, with audio. All frames in the synthetic moving clip were compared; the checks do not infer motion from a single frame. Python tests additionally cover fractional rates, transparent WebM, unchanged decoded audio, odd image dimensions, non-finite model output and alpha resizing.

The small image comparison shows stronger sharpening/texture changes from Real-ESRGAN than SPAN or SwinIR, with no obvious tile boundaries in these fixtures. [Comparison](image-comparison.png). This is a functional and visual smoke test, not a perceptual-quality ranking.

Fresh generation chains completed: SD-Turbo → SPAN produced 512×512 → 1024×1024; LTX-Video 2B → SPAN produced 512×512 → 1024×1024 while retaining 17 frames, 8 fps and 2.125 seconds. The LTX source has very little visible subject motion; successful chaining does not establish good animation quality. Motion preservation was checked separately using the moving test-chart clip: all eight output frames matched the corresponding source frame, in order, for each upscaler. [Frame analysis](generation-video-verification.json).

Validation commands and logs:

- Media package: **819 tests passed**; [log](media-tests.log).
- Rust media: **439 passed, 26 ignored**, no failures; [log](rust-tests.log).
- Python: **19 tests passed**; [upscaler](python-upscale-tests.log), [existing workflow](python-workflow-tests.log).
- Licensing: **34 tests passed**; [log](licensing-tests.log).
- Media/product UI lint and type checks passed; [media](media-check.log), [product UI](product-ui-check.log), [type checks](typecheck.log), [final media type check](typecheck-final.log).
- Production UI assets and debug native desktop build passed; [UI](build-ui.log), [native](build-native.log). `build-native.mjs` builds without starting a dev server.

Reproduction scripts are `run-gpu.py`, `build-native.mjs`, `verify-native.mjs`, `verify-library.mjs`, `verify-advanced.mjs` and `verify-generation-chains.mjs`. The last script runs through `pnpm exec oxnode` and uses the existing local SD-Turbo and LTX-Video fixture models. `prepare-generation-fixture.py` creates a separate model workspace using hard links, including the original revision metadata and licenses.

Limits: input videos use the studio's WebM format; video presets operate on individual frames and do not implement temporal restoration. SeedVR2, VOSR, FlashVSR and other research candidates are not selectable runtimes. NVIDIA, Linux, macOS and large/long-video performance were not benchmarked. Imported weights retain their own model terms.

Earlier intermediate artifacts remain because automatic approval review blocked their cleanup. The linked reports describe the final results.

Completion audit: invalid NaN and positive/negative infinity outputs are rejected before clipping; finite out-of-range colors still clip normally. The audit reproduced the infinity defect before the fix and added regression coverage. [GPU revalidation](gpu-audit-results.json) compares all ten image/video cases with the preceding results, pixel for pixel. Native Playwright validation was repeated with the corrected worker resource.

The [completion audit](completion-audit.json) maps each objective requirement to current code, native results and artifacts.
