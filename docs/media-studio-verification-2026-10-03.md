# Media Studio verification — 2026-10-03

The [2026-10-04 continuation](media-studio-verification-2026-10-04.md) adds real SDXL LoRA training and records its additional checks. The evidence below remains scoped to the earlier run.

The full studio goal is **not complete**. Work includes removal of manual model verification, repaired flows and downloads, actual Codex/image/video requests, and a standalone AudioLDM 2 workflow. A subsequent IntroSVG request now completes, but its output fails the requested shape and composition. Catalog coverage remains broader than measured inference coverage.

## Changes

- Installed models can be selected and run without a stored model probe. Runtime setup no longer probes every installed checkpoint, and the library has no Verify model action. Runtime availability, package completeness, and content integrity still determine whether a request can execute. Internal diagnostic probes are not a generation prerequisite.
- Connected image transformations compile as workflow inputs even with a single generation task. Shared source ports retain their identity, temporary task graphs do not mutate the original flow, and masked tasks select models with mask support.
- Model pickers account for pose, mask, multiple references, and distinct video endpoints. Native text-to-video does not acquire synthetic frame requirements. Video recipes ignore an old image-edit mask.
- Codex receives the node field constraints and returned resource selections are checked for valid model IDs, asset kinds, addon kinds, and variables. CLI failures now show the actual failure ahead of incidental warnings.
- A stale download poll cannot replace a canceled job and hide Retry.
- Basic SVG offers the IntroSVG installation action for text and reference-image requests instead of offering an unrelated matting model.
- Krea Turbo defaults to eight steps for every quality policy. CogVideoX 2B quality presets use eight frames per second.
- Video dimensions use the selected model's grid in Basic controls, flow controls, compilation, native validation, and the worker. CogVideoX accepts 720 × 480; HunyuanVideo 1.5 and FramePack accept multiples of 16; Wan retains its multiple-of-32 constraint.
- Isolated Python startup resolves sibling worker modules, and open video sampling reports progress through the shared progress wrapper.
- Text-only IntroSVG allocation keeps the unused vision encoder on CPU and sizes the decoder against free GPU memory with a token-cache reservation. Draft/Balanced/High use 8,192/16,384/32,768 generated-token budgets. Inputs go to the embedding device rather than the first module's device. Real verification is recorded below.
- Removed internal explanations from the canvas organization panel.
- Added Basic audio generation and typed Advanced audio flows, managed AudioLDM 2 downloads, durable runs, cancellation, WAV playback, original-file export, and resolved model/seed reuse. Only the base AudioLDM 2 profile is advertised; unimplemented audio prototypes and a duplicate model profile were removed.
- Basic model installation now opens acquisition for uninstalled catalog entries. Previously its recovery action could open an empty library because it searched only installed resources.
- Audio progress targets its audio task. The worker monitor retains an idle database connection during generation to avoid concurrent last-connection WAL cleanup while the library polls.

## Functional coverage

| Area | Evidence from this run | Remaining work |
| --- | --- | --- |
| SDXL | Native checkpoint inspection/import; real image/mask worker runs; Basic UI generated baseline, pixel-art LoRA, and matching repeat images; export preserves the original hash | Geometry/composition/content failures remain; pose and other conditioning need real execution |
| Krea 2 | Real imported scaled-FP8 checkpoint generated a visually inspected 512 × 512 PNG on RX 9070 | Repeated/warm generations, editing, masks, references, pose, and real LoRA inference remain unmeasured |
| MiniMax | H3 Ref2VA image-reference video/audio path exists | No real H3 execution; FL2VA and user audio conditioning remain absent |
| Other modern models | Existing exact profiles and adapters reviewed; see [support inventory](media-studio-model-support.md) and [landscape research](open-media-model-research-2026-10-02.md) | Most profiles have no real execution evidence; LongCat, SkyReels V3, HunyuanImage 3, Open-Sora, and several Wan modes remain unintegrated |
| Basic generation | Actual Basic controls triggered SDXL, real LoRA, and AudioLDM 2 native runs; audio additionally passed full playback, export, repeat, and Advanced conversion | Video/SVG/conditioning need complete UI coverage |
| Flow editing | Actual editor passed Playwright selection, groups, collapse/expand, rename, ungroup, add/remove, typed ports, valid drag connections, and rejection of invalid connections | Other graph operations need broader browser coverage |
| Cross-model graphs | Regression tests cover transformed inputs, separate prompts, same-source endpoints, and mask-compatible selection | The full image → postprocess → image variant → first/last frame → real video sequence has not executed |
| Image quality and speed | Krea and SDXL output inspected; painted-mask pixel preservation measured | Cold Krea exceeds 30 minutes; SDXL geometry/content failures remain; stable fast performance and comparative quality are not established |
| SVG | Complete IntroSVG package; real resident-decoder request produced a renderable SVG in 888.953 seconds; output visually inspected | Earlier requests timed out; latest document has malformed teapot geometry, wrong viewBox, and slightly overflowing bounds; quality and fast generation fail |
| Video | Real CogVideoX 2B produced a fully decoded 49-frame clip with changing blade orientation | Blade deformation remains; other families, endpoints, loops, alpha, and video LoRAs need real execution |
| Audio | Standalone and native AudioLDM 2 generated identical five-second WAVs; Playwright passed native download, Basic generation, sampling progress, playback, original export, repeat, typed conversion, and execution of a Codex-created Advanced graph | Listening quality, dedicated music/speech models, audio LoRAs, user-audio conditioning, and broader audio coverage remain unverified |
| Multi-scene and lip sync | No usable scene timeline or audio-driven lip-sync task found in the native graph | Requires implementation, model packages, and real synchronized-output testing |
| Assets and downloads | Earlier library/slideshow and SDXL/LoRA evidence; actual native AudioLDM 2 managed download passed Playwright, including license action and progress | Broader asset operations and model acquisition coverage remain unverified |
| Keyword detection | Actual imported LoRA shows a missing-trigger warning and recognizes its publisher words; existing trigger/Civitai/search/tag paths have automated coverage | No real caption/tag model or semantic keyword-quality evaluation |
| Finetuning and LoRA creation | Krea RAW LoRA job validation, dataset preparation, and trainer integration exist | General finetuning, SDXL training, and training for every open family are not exposed; no real training job completed |
| Codex enhancement | Earlier image flow; actual desktop Codex assistant returned an accepted runnable audio graph in 24.52 seconds | Basic-field filling and complex multi-scene/song/lip-sync requests have not executed |

## Real Krea request

Model ID: `local:user:3ec3c673d467e0832ad1324fafa8eed5cde9e9f2e250b399d07245e63c904191`.

The installed checkpoint is 14,128,290,360 bytes and uses the installed Krea encoder/VAE bundle. The worker generated one PNG with seed 314159, eight steps, zero guidance, and a 512 × 512 canvas. The prompt requested a red ceramic teapot on a wooden table in natural window light. The output contains that subject with visible ceramic highlights, table texture, and coherent window illumination. One image cannot establish repeatability or universal quality.

The worker exited successfully on AMD Radeon RX 9070, reporting 17,095,983,104 bytes of GPU memory and 33,618,337,792 bytes of physical memory. Auto selected block-level disk offload. It built 29 cache files totaling 13,485,103,400 bytes. The cold run exceeded 30 minutes including encoder/model loading and sampling; a warm-cache benchmark has not run.

Artifacts under `D:\Models\machdoch\verification\2026-10-03`:

- `krea-image-request.json`, `krea-image-result.json`, and `krea-image.log`.
- `krea-image/output-0000.png` — 345,190-byte inspected output.

The repeated timeout labels in the log are periodic diagnostic stack dumps from the test wrapper, not failed generation deadlines. An earlier malformed request without an aspect ratio failed before sampling and was corrected. Generation uses the real worker and installed weights, outside the native desktop bridge.

## Real SDXL and painted-mask requests

The official SDXL 1.0 base checkpoint and companion configurations were downloaded at revision `462165984030d82259a11f4367a4eed129e94a7b`. The 6,938,078,334-byte checkpoint has SHA-256 `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`. The complete acquisition was 6,941,254,440 bytes and took 236.516 seconds.

The isolated worker generated two 1024 × 1024 PNGs in 208.812 seconds, using 30 steps, guidance five, and seeds 314159/314160. Both were visually inspected. The first depicts a plausible red teapot and white cup, but its pale table and large empty background differ from the dark-wood prompt. The second has an extra malformed spout/handle and omits the requested cup. These are quality failures, despite successful execution.

The second image was edited through the real painted-mask path with 512 × 512 crop sampling, 30 requested steps, edit strength 0.95, and mask strength one. Execution took 408.875 seconds. The saved result retains the 1024 × 1024 source dimensions. Full-image comparison against the actual rasterized mask measured 974,491 unpainted pixels and 74,085 painted pixels: **zero unpainted channels changed**, while the painted region's mean absolute difference was 56.51467. However, the model generated a small window inside the mask instead of the requested wood texture. Pixel preservation passes; semantic editing quality does not.

Artifacts: `sdxl-download-result.json`, `sdxl-image-request.json`, `sdxl-image-result.json`, `sdxl-execution.json`, `sdxl-image/output-0000.png`, `sdxl-image/output-0001.png`, `sdxl-mask-request.json`, `sdxl-mask-result.json`, `sdxl-mask-inspection.json`, and `sdxl-mask/output-0000.png`.

## Real video request

CogVideoX 2B was acquired at pinned revision `1137dacfc2c9c012bed6a0793f4ecf2ca8e7ba01` from the native managed-download manifest. Its 15 files total 13,775,539,179 bytes. Every file matched its recorded byte size and SHA-256. Acquisition took 357.079 seconds.

The request follows the [publisher's](https://huggingface.co/zai-org/CogVideoX-2b) 720 × 480, 49-frame, eight-FPS, 50-step, guidance-six recipe. The worker produced `cogvideo/output-0000.webm` in 1,309.286 seconds; total harness time was 1,329.453 seconds. The clip lasts 6.125 seconds. All 49 frames decoded successfully in both the worker and an independent FFmpeg inspection. All frames are unique, with no adjacent duplicates; consecutive RGB mean absolute difference averages 12.2173 and remains nonzero through the last quarter.

The spanning-frame contact sheet shows changing pinwheel blade orientation/shape against a mostly stationary blue background. This establishes subject animation rather than only a zoom or a still image. Blade shapes deform and the stick drifts slightly, so the motion is not a perfect rigid rotation. Artifacts include `cogvideo-result.json`, `cogvideo-execution.json`, `cogvideo-inspection.json`, `cogvideo-contact-sheet.png`, and the request/download manifests.

## Real SVG attempt

The [IntroSVG 7B](https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B) package was acquired at revision `5da60d628d226361fb0a8210dc021782e5ee484a`. All 16 files, totaling 16,600,362,059 bytes, matched the native download manifest. Acquisition took 442.5 seconds.

The first real request for a flat red-teapot icon exceeded its 1,800-second deadline. Stack inspection showed repeated decoder weight transfers through Accelerate's CPU-offload hooks. The checkpoint contains 15,231,233,024 bytes of language weights and 1,353,100,288 bytes of vision weights. Keeping the unused vision encoder on CPU for text-only requests can free space for the decoder on this GPU. The initial test of that change exposed an invalid constructor API call; it was corrected before the separate final retry. Image-conditioned requests retain automatic allocation for their required vision encoder.

The corrected retry loaded in 155 seconds and advanced to at least 1,183 sequence tokens, but returned no document in 1,237.656 seconds. It was stopped after the token-cache reservation change superseded that worker version. This establishes ongoing decoding, not a valid SVG or acceptable speed. An allocation inspection with a hypothetical 16.6 GB free-memory budget maps the text model to GPU and the unused visual model to CPU; it is not a measurement of the already running model's allocation.

The final code was tested separately with a minimal teapot prompt, one candidate, and the Draft 8,192-token budget. It loaded in approximately 146 seconds and continued decoding, but exceeded the same 1,800-second deadline without a completed SVG. Its worker and launcher were confirmed stopped afterward. The allocation changes have regression coverage but have not resolved real generation latency on this machine. No SVG generation is counted as passing.

Original and revised-attempt logs remain separate: `svg-generation.log`, `svg-execution.json`, `svg-text-only/`, `svg-text-only-final/`, `svg-budgeted/`, and `svg-budgeted-verification.log`. The final folder records the request, source digest, stack inspection, and timeout result. Image-conditioned allocation, long-prompt cache requirements, and generated SVG quality remain unverified.

## SVG continuation

A subsequent request uses the same pinned IntroSVG weights with a GPU-resident text decoder whenever its actual weight size plus cache reservation fits free memory. The earlier Accelerate placement reserved the largest decoder layer again and unnecessarily offloaded weights. The language model uses its generation cache and stops at the closing SVG tag. Text-only requests keep the unused vision encoder on CPU; image-conditioned allocation remains unverified.

The observed worker completed in 888.953 seconds, including 201.703 seconds loading. Its measured allocation places the text decoder on `cuda:0`, vision on CPU, with 15,231,235,072 bytes allocated and 1,629,749,248 bytes free after loading. The rendered SVG digest is `c5b4ec7f3caf3b91fc9eb7f4f30f6a592fb2550b98bff304be9ed1e056449ca3`. Decoding slowed as its sequence grew; this does not establish acceptable speed.

Playwright rendered the returned document and recorded five paths with viewBox `0 0 200 200`, despite the requested 256 canvas. The bounding box extends to width 200.1875. Visual inspection shows a disconnected red/orange pot shape without coherent teapot handle or spout. A valid document is now demonstrated, but requested geometry and visual quality fail. Evidence is in `svg-resident-observed/`: request, source digest, allocation, token log, result, execution timing, `teapot.svg`, rendered screenshot, and DOM measurements. Earlier timeout evidence above remains valid for those worker versions.

## Standalone audio continuation

The canonical audio profile is [AudioLDM 2](https://huggingface.co/cvssp/audioldm2), revision `c8e7e189d324425c05c4c2f81214041ef4107983`, licensed CC-BY-NC-SA-4.0. Its 26 runtime files total 4,480,952,551 bytes; the managed package also retains the 5,376-byte publisher README. The standalone download verified publisher LFS hashes and config Git blob hashes. The actual desktop managed-download dialog subsequently acquired and activated all 27 files under the isolated D-drive library in 592.494 seconds. Playwright checked the license action, download progress, installed/ready catalog state, and absence of a manual Verify action. Artifacts: `playwright-audio-install-result.json`, `native-audio-installed.png`, and `playwright-audio-install-final.log`.

The loader supplies `GPT2LMHeadModel` from the pinned language-model weights, matching the [current Diffusers pipeline constructor](https://huggingface.co/docs/diffusers/main/en/api/pipelines/audioldm2). The publisher package's `GPT2Model` component lacks the generation mixin required by the pinned Transformers runtime. This uses the current component directly, without maintaining a second loader path.

The real standalone worker generated five seconds of mono 16 kHz PCM16 WAV: 80,000 frames and 160,044 bytes. Prompt: ocean waves on a sandy beach with distant seagulls; negative prompt: music, speech, distortion, clipping; 100 steps, guidance 3.5, seed 48623. SHA-256 is `9f2aff23dd762aff77cccc3ac60f28d876a1b97019ba9028b2cac357bd3cf3ba`. Total wall time was 70.547 seconds, with worker load 34.651 seconds and generation 32.081 seconds. Peak is 0.23938 and RMS 0.042535; no normalization gain was needed. Evidence: `audio-real/request.json`, `result.json`, `execution.json`, generation log, and `output/output-0000.wav`.

A separate pinned CLAP assessment ranks seashore waves highest among ten fixed descriptions (cosine 0.373734), narrowly above wind (0.363765). Seagulls alone score 0.193570. This supports a broad ambience match, does not establish all prompt details, and does not replace listening or perceptual quality assessment. Assessment weights and scores remain under D-drive verification storage; `audio-clap-assessment.json` identifies the model revision and exact tested WAV digest.

The first native generation failed while progress polling opened the library database: `database is locked`. Its durable failure is retained as run `164bb0d0-74f0-4583-a64b-de021621fa63`. Audio progress also targeted image node types. The shared monitor now retains a connection for the worker lifetime and selects audio node types. Last-connection WAL cleanup can return busy to concurrent opens, as described by [SQLite](https://sqlite.org/wal.html#sometimes_queries_return_sqlite_busy_in_wal_mode); that mechanism is a diagnosis consistent with the observed error, not a captured lock trace. A regression concurrently polls the library while an isolated test worker emits audio progress; it checks the actual audio node's progress.

The corrected real native run `bdaa6bab-211e-4df1-b3c6-1fdcd9194280` completed with the same standalone WAV hash. Worker load took 304.464 seconds, generation 42.542 seconds; the full durable run lasted 364.342 seconds. The actual WebView audio element played all five seconds and reached `ended` without error. The real Windows Save audio dialog exported the original file with its default filename into Downloads; its native export record and independent SHA-256 match the generated asset. The test chooser's programmatic filename replacement did not take effect, so no custom export-destination claim is made.

Basic repeat `0aa4091d-288d-4a51-a625-129891012b05` completed in 89.928 seconds with identical WAV bytes, the same saved revision, and no fixture assets. Advanced conversion produced prompt → audio generator → WAV output, with separate labelled prompt and audio handles. Evidence: `native-audio-run-1.json`, `native-audio-run-2.json`, `playwright-audio-generation-result.json`, and native screenshots. The test harness was corrected for the flattened run-detail contract and asynchronous conversion; these were automation errors, not model generation failures. Loading latency remains unresolved, and audio pipelines are currently loaded once per run.

The actual Flow assistant returned an accepted three-node audio flow named Ocean ambience in 24.52 seconds. Native internal-model settings identify `codex-cli`, `gpt-6-sol`, and `xhigh`; only those non-secret selection fields were recorded. This is a real desktop assistant request, with no injected response. Its actual Advanced Run action then saved the returned flow and completed run `bfb7eaba-c21b-4112-9493-02d1ca12efc8` in 112.393 seconds, producing the same WAV hash. Evidence: `playwright-audio-flow-assistant.json`, `audio-assistant-model.json`, `native-audio-advanced-history.json`, `native-audio-advanced-run.json`, and `playwright-audio-advanced-result.json`.

Advanced cancellation was clicked during real Sampling 2/100 at progress 0.262. Run `6ec85350-3750-4c07-901b-3f5c2a9a3bc7` reached `canceled` and published no assets. No media worker remained under the owned desktop process afterward. Reuse settings was then tested after replacing the Basic prompt, duration, seed, and automatic model selection; the original completed run restored all fields, including its resolved `local:audioldm2` model and seed 48623. Evidence: `native-audio-canceled-run.json`, `playwright-audio-cancellation-result.json`, `playwright-audio-reuse-result.json`, and screenshots.

The final loading-state copy distinguishes initialization from browser-only execution. Audio's loading progress no longer moves backward after input resolution, and a separate Preparing audio stage precedes sampling. The Basic audio view is a focused component sharing the generation header, rather than adding a second large body to the existing image/video view. Those last presentation changes passed the generation-view regressions, typecheck, lint, and targeted Python checks; the real native runs above precede those last presentation changes.

The owned test desktop was stopped. Its developer-profile storage configuration was restored to the original absent state, and only the Media Studio state key was restored, preserving other shell keys. View preferences were not restored. The original exported WAV was moved unchanged from Downloads to `D:\Models\machdoch\verification\2026-10-03\native-exported-audio.wav`; models, saved runs, and generated assets remain on D. Cleanup is recorded in `audio-desktop-cleanup.json`. The user's installed release desktop was not stopped or replaced.

## Native desktop evidence

Built and launched the desktop with embedded production assets; no development server was started. The developer profile initially lacked SciPy. The actual Set up Media Studio action installed the missing dependency and completed with phase `ready`, without eager checkpoint probes. Native runtime initialization reports the discrete RX 9070 and ready worker dependencies.

Native SDXL inspection found 2,515 tensors and accepted the architecture. Import copied the checkpoint into the managed D-drive library and returned model ID `local:user:31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`. The Basic model picker lists it as selectable, and the configured Generate image button is enabled without a verification action. `native-desktop-evidence.json` and `native-basic-sdxl-ready.png` record this state. The import was executed through native IPC; selection and form configuration used the actual webview controls.

The actual Basic Generate image action created native run `07a7945a-526e-4a3e-ba7c-0153dc3907c5` at 02:18:38 UTC. Its saved plan contains prompt, seed, image-generation, and asset-output nodes and proceeds directly to local generation. It completed in 205.429 seconds and published a real 1,278,331-byte 1024 × 1024 PNG with digest `1c8988777e9a1ba2dc38491f8c4c224e60c4b13262408a262d99ca0ce8b10f87`. The Basic view displays the result and Save image/Edit image/Animate/View in Assets actions. The inspected image has coherent red-teapot/white-cup geometry, but again uses a pale table and a large gray background. Artifacts: `native-basic-run.json`, `native-sdxl-image.png`, and `native-basic-sdxl-completed.png`.

The [PixelArtRedmond SDXL LoRA](https://huggingface.co/artificialguybr/PixelArtRedmond) was downloaded at revision `33cbdd147b152f816b0b3ac2ba250848fef83576`: 170,540,052 bytes, SHA-256 `84e915e2936cd20f98d3391609ddd474d0268b0bc1d2edd7bdeeb5fec2252ab7`. Native inspection found 722 rank-32 Kohya modules and import registered the immutable addon. The actual Basic addon dialog selects it and exposes strength. With no trigger in the prompt, the form shows Missing “Pixel Art” and offers Add. Publisher trigger words were imported explicitly because this checkpoint's inspected metadata contains none.

With Pixel Art and PixArFK in the prompt, that warning disappears. Basic run `8ed7614a-8b79-437b-8a7a-7013f45bc902` completed in 187.378 seconds and published a 466,622-byte 1024 × 1024 PNG. Provenance records the LoRA digest, all 722 rank-32 modules, loaded denoiser, and strength one. Visual inspection confirms a strong pixel-art effect and recognizable teapot/cup subjects. The image is not a composition-quality benchmark. Artifacts: `native-lora-inspection.json`, `native-lora-import.json`, `native-lora-run.json`, `native-lora-trigger-warning.png`, and `native-sdxl-lora-image.png`.

Removing the LoRA and restoring the exact original prompt produced Basic run `bf0858f4-f9f9-4b54-a81b-a50b5038aa3e` in 193.689 seconds. Its PNG digest and compiled flow fingerprint match the baseline exactly, and provenance contains no addons. Each of the three native runs records 30 sampling events and non-fixture output. This passes repeatability and addon removal for this particular recipe, rather than establishing repeatability for every model or a warm-cache performance benchmark.

Native original-file export saved `native-exported-sdxl.png`; its byte size and independently calculated SHA-256 match the baseline. The actual Assets image filter and Slideshow displayed six entries, and Pause/Next advanced from entry four to five. Native inspection is recorded in `native-run-inspection.json`, `native-repeat-run.json`, and `native-library-verification.json`.

Native automation used observed webview controls and the Tauri bridge. The bridge's snapshot/interaction helpers were incompatible with the installed plugin version; JavaScript execution and screenshots worked. This is separate from Playwright browser coverage. Both owned test desktops and generation workers were stopped, and the temporary developer-profile storage setting was restored to its original absent state. Real downloaded weights and generated assets remain under the D-drive test storage root. `desktop-cleanup.json` records cleanup.

## Codex and browser evidence

`codex-result.json` records a real request using the application's Codex default, `gpt-5.6-sol`. It returned an editable flow that compiled to `ready` in 15.791 seconds. The request used the installed Krea model ID. This verifies assistant graph generation; it does not mean Codex ran the native image worker. The initial explicitly chosen `gpt-6` was rejected by the signed-in account; the application's configured default succeeded.

Playwright used headless Edge and production Vite bundles served through intercepted browser requests. No development server was started. The library and flow editor were actual components with seeded records; the flow harness used the real core graph mutation functions and production stylesheet. Dragging an image output into Resize creates an edge; a seed output cannot connect to an image input. Deleting Resize removes its edge. Selecting CogVideoX 2B changes Width/Height controls to step eight and preserves 720 × 480 without an HTML step mismatch. Native desktop testing is separate from these Playwright harnesses.

Playwright also exercised the actual Basic SVG form with no installed generator. Both text-only and reference-image states offer Install IntroSVG 7B, route recovery to that model, omit the unrelated BiRefNet installation action, and keep generation disabled until a model is ready. This checks recovery behavior, not a completed model download or real SVG generation.

Browser artifacts: `playwright-result.json`, `playwright-flow-result.json`, `playwright-svg-recovery-result.json`, `library-slideshow.png`, `flow-editor.png`, `flow-video-dimensions.png`, `svg-install-recovery.png`, and the corresponding harness scripts under the same verification directory.

## Automated checks

- Media Studio: 591 tests passed across 79 files, with one Vitest worker, in 166.66 seconds.
- After the final Basic SVG recovery fix, its 29 generation-view tests passed. The two new text/reference recovery regressions failed before the fix and passed afterward.
- Native media: 349 passed, 12 ignored, using two test threads. Ignored checks require external services, packages, or fixtures.
- Client inference/flow helpers: two files, ten tests passed.
- Pinned Python worker: broad discovery passed 272 tests in 183.905 seconds. After the final SVG allocation change, its nine targeted acquisition/loading tests passed, including four new regressions.
- Media Studio/client TypeScript checks, scoped lint, desktop UI production build, embedded native debug desktop build, and the final prepared native compile check passed. After the final Basic SVG recovery change, Media Studio TypeScript/lint checks, the UI production build, and the embedded native desktop build passed again. Native compilation retains an existing unused `RecoverySummary.recovered_runs` warning.

Parallel verification initially caused worker timeouts and exposed the download cancellation race. The corrected suite passed with one Vitest worker. Tests and artifacts are evidence for their stated scope, not substitutes for real model execution.

Subsequent audio/SVG checks:

- Complete Media Studio suite: 599 passed across 80 files, one worker, 140.40 seconds. After the final audio initialization message change, all 30 generation-view tests passed, including the new loading-state regression.
- Native media: 354 passed, 12 ignored, two threads, 57.44 seconds, including audio publication/export, saved settings, cancellation, and concurrent progress/library polling.
- Pinned Python discovery: 284 passed. The final audio progress-label change additionally passed its five targeted worker tests.
- Media Studio typecheck and scoped lint passed. Client UI/core and fleet protocol typechecks passed; the global client test typecheck remains blocked by two unrelated existing mock-call signature errors in `use-assistant-display-layout.spec.ts` at lines 87 and 108.
- Embedded desktop build with production UI passed. Native Playwright connected directly to the built desktop WebView, without a development server. After cleanup and the final presentation changes, the normal desktop build passed again without the temporary debug-port override; `native-desktop-build-final.log` records it. The temporary verification configuration lives outside the repository.

The default four-worker studio rerun stalled during worker startup and was stopped; its results are not counted. The explicit one-worker rerun above completed.

## Upstream training research

| Family | Primary evidence checked | Machdoch training status |
| --- | --- | --- |
| SDXL / Stable Diffusion | [Diffusers training overview](https://huggingface.co/docs/diffusers/main/en/training/overview) includes full training and LoRA examples | No studio trainer integrated for these families |
| Krea 2 | [Official Diffusers Krea DreamBooth recipe](https://github.com/huggingface/diffusers/blob/main/examples/dreambooth/README_krea2.md) trains LoRA on RAW and validates on Turbo | RAW LoRA job path exists; no complete RAW package or real training run on this machine |
| CogVideoX 2B | [Publisher model card](https://huggingface.co/zai-org/CogVideoX-2b) describes LoRA and supervised finetuning, with published single-device training footprints above this GPU's capacity | Generation adapter exists; no studio trainer |
| LTX-2 | [Official inference and LoRA trainer](https://github.com/Lightricks/LTX-2) | Generation adapters exist; trainer not integrated |
| Wan 2.2 | [Official project and supported modes](https://github.com/Wan-Video/Wan2.2) | Selected generation variants only; no studio training job |
| Music | [ACE-Step generation and training project](https://github.com/ace-step/ACE-Step) | ACE-Step and music training not integrated; standalone AudioLDM 2 generation is a separate implemented path |

This is not an exhaustive finetuning certification for every catalog derivative. Upstream availability does not establish a working native job, compatible local dependencies, or successful training on this hardware.

## Constraints

The machine has a 16 GB discrete GPU and approximately 32 GB of system RAM. Only two imported Krea checkpoints and their companion components were initially installed. Work acquired SDXL, CogVideoX, IntroSVG, SDXL LoRA, and AudioLDM 2 weights. CogVideoX and IntroSVG test packages are in the verification cache rather than registered native library installations; AudioLDM 2 was installed through the real native download dialog. There is still no complete RAW training package. Some published generation/training configurations require substantially larger devices. No remote paid-provider request was verified, and provider credentials were not read or exposed. Timings are measurements from this machine and the debug desktop, not release performance guarantees.

Broader real model testing and the missing timeline, lip-sync, user-audio conditioning, and general training implementations remain necessary before the full goal can be called complete. AudioLDM 2 does not close dedicated music, speech, or audio LoRA coverage. The generation paths attempt installed models directly and report execution errors at use; selection is not evidence that a model has run successfully on this device.
