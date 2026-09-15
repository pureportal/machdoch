# Media Studio video review — 15 September 2026

Hunyuan produced working transparent video and transparent Ping-pong loops in Basic and Advanced. A final fresh Basic run verified the lossless alpha correction through generation, preview, and export. The new WAN seamless attempt failed its visual boundary check. Forward seamless generation therefore remains unverified on this runtime.

| Model / path                    | Transparency                  | Ping-pong + transparency       | Forward seamless + transparency                                           |
| ------------------------------- | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| HunyuanVideo 1.5 Step Distilled | Verified in Basic             | Verified in Basic and Advanced | Unsupported by the installed first-frame adapter; blocked in both editors |
| WAN 2.2 TI2V 5B                 | Untested in a delivered video | Untested                       | Attempted in Basic; generated seam rejected before matting or publication |
| FramePack / LTX                 | Untested: weights missing     | Untested: weights missing      | Untested: weights missing                                                 |

These results cover representative clips, not every prompt, resolution, matte mode, or model configuration.

Fresh generation checks used a supplied starting image. Prompt-only first-frame generation was inspected in code and covered by the client suites; its earlier opaque live result is documented in the [preceding fixes review](media-studio-fixes-2026-09-14.md). It was not repeated with transparency here. Animated-background encoding received automated coverage, but no fresh model-generated composite graph was rendered.

## Changes

- Basic and Advanced disable Seamless for a model without endpoint conditioning. An explicit incompatible or missing video model now blocks compilation instead of silently selecting another model. Automatic model selection remains available when no model is selected.
- Transparent previews use a checkerboard. Preview repetition follows the saved asset's loop mode, so a non-looping shot stops even when the editor has since changed to Ping-pong.
- Temporal alpha stabilization now uses the actual neighbors at a seamless wrap or Ping-pong turnaround. Non-looping endpoints and large moving edges retain their existing treatment.
- Transparency validation checks every delivered source frame and every decoded WebM frame. A single opaque frame or an empty subject is rejected, and frame coverage is retained in output provenance.
- Lossless transparent encoding keeps alpha separate during RGB-to-YUV conversion and verifies exact alpha preservation after decoding. An all-values ramp exposed a one-level error in the former automatic conversion for alpha values 128–254; the corrected path preserves all 256 values.
- VP9 encoding streams RGB/RGBA frames directly to FFmpeg, including animated composites. It no longer writes and rereads a PNG sequence. RGB round-trip verification processes one frame at a time instead of constructing additional full-video integer arrays. Encoder failures and timeouts include Windows pipe cleanup.
- Video generation releases the cached image cutout session before loading its model, reducing avoidable memory overlap after image generation.
- Advanced duration shortcuts only show durations that the model can actually produce at the selected frame rate. The 24 fps shortcut no longer promises smoother motion merely from a playback-rate setting.

The final worker is version `1.62.0`; its new `media_video_io.py` helper is included in desktop resources. Existing WAN boundary validation from the preceding review remains in place. This review does not attribute those earlier checks or experiments to the changes above.

## Real output inspection

### Basic: Hunyuan transparency, no loop

Run `349f4616-f9d1-4c52-9864-330d4f62ff44` generated a blue ceramic teapot from a real transparent source image, seed `8152026`, at 512 × 512, 17 source/output frames, 8 fps, 8 distilled sampling steps, Balanced matte and Balanced encoding. The worker took 641.479 seconds; 503.349 seconds were denoising and decoding, and 6.706 seconds were postprocessing and encoding.

All 17 exported frames decoded with alpha ranging from 0 to 255. Inspection found an intact subject and handle opening, consistent blue glaze and shape, and a gradual tilt/translation. This is a non-looping shot: the end pose differs from the start. The actual Basic preview played to its 2.125-second end, reported no media error, displayed the checkerboard, and had `loop=false` despite the editor having subsequently changed to Ping-pong.

The actual **Save video** action exported [`hunyuan-alpha-basic.webm`](../apps/client/.cache/media-video-review-2026-09-15/hunyuan-alpha-basic.webm). Its SHA-256 matches the native asset digest exactly: `50dbac653e5621fc604b0160700b8be4eed6c40c7613f04d22b9a78a373dea8e`. See the [frame contact sheet](../apps/client/.cache/media-video-review-2026-09-15/hunyuan-alpha-basic.frames.jpg), [all-frame measurements](../apps/client/.cache/media-video-review-2026-09-15/hunyuan-alpha-basic.inspection.json), and [preview evidence](../apps/client/.cache/media-video-review-2026-09-15/basic-alpha-playback.json).

Video transparency here is chroma generation plus temporal matting and VP9 alpha delivery. It is not a native alpha-generating Hunyuan model. Successful image cutouts alone were not counted as video verification.

An initial fresh run was interrupted by the running desktop's automatic native rebuild while source changes were being applied. Startup recovery marked it failed before publishing any output. That interruption is not counted as a model-quality failure; subsequent native source edits were completed before starting the next render.

### Advanced: Hunyuan transparency with Ping-pong

Run `06fb5e7a-79dd-445a-bf21-faddf95f18d4` exercised Basic-to-Advanced conversion, saved revision 2, and the graph's **Run** action using the same teapot, prompt and seed. It generated 17 source frames and delivered 32 frames at 8 fps, with Balanced matte and Lossless encoding. Worker time was 690.065 seconds, including 13.394 seconds for postprocessing and encoding.

All 32 saved frames have both transparent background and visible subject. Every reverse frame matches its corresponding forward frame exactly in the decoded RGBA video. There are no adjacent duplicate frames and no duplicate closing frame. Inspection covered the wrap **30 → 31 → 0 → 1** and the other turnaround **14 → 15 → 16 → 17**, including alpha edges and the handle opening. This is a working reversed-motion loop, not evidence of forward seamless generation.

The preview has `loop=true`, retains the checkerboard, and repeats. The native asset, preview bytes, and file saved through the actual **Save video** action all have SHA-256 `45aa126c85039623c16e70f1396a9532a1268793f87e88be1cf893f8289038c7`. The file is 1,395,791 bytes. See the [saved video](../apps/client/.cache/media-video-review-2026-09-15/hunyuan-alpha-ping-pong-advanced.webm), [turnaround contact sheet](../apps/client/.cache/media-video-review-2026-09-15/ping-pong-turnarounds.jpg), and [measurements](../apps/client/.cache/media-video-review-2026-09-15/ping-pong-summary.json).

This run used worker 1.61.0, before the final lossless alpha-conversion correction. The final correction was also verified in a fresh generation below.

### Final Basic run: lossless alpha and Ping-pong

Run `79c26c83-3f9c-4f52-aa7b-a0b9948c56c5` reused the Advanced result's settings in Basic and generated a fresh video with worker **1.62.0**. It retained the same source, prompt, seed, 512 × 512 dimensions, 17 source frames, 8 fps, 8 sampling steps, Balanced matte, Lossless encoding, and Ping-pong mode. Worker time was 751.653 seconds, including 161.376 seconds for model loading and prompt encoding, 556.251 seconds for denoising/decoding, and 14.319 seconds for postprocessing/encoding. End-to-end native run time was 784.641 seconds. These complete-run timings were not an isolated performance comparison.

The worker verified every delivered alpha sample against the source matte and recorded `losslessAlphaVerified=true`. Independent decoding of the saved 32-frame video confirmed transparent background and visible subject in every frame, exact forward/reverse RGBA matches, no adjacent duplicates, and no duplicate closing frame. The turnarounds retain the blue teapot's shape, handle opening, and alpha edges.

The prior and final same-seed generations have **identical decoded RGB pixels**. Exactly 9,642 alpha samples differ by one level, matching the independently measured conversion correction. This comparison does not establish a change in diffusion quality or generated motion.

The actual Basic **Save video** action produced a 1,395,769-byte WebM. Native asset, saved file, and preview bytes all have SHA-256 `ced67f1e4f27be3b4cabad07df71ca1350e073598965a033053f96ccee73b869`. Preview inspection observed three wraps and 97 frame callbacks; every observed frame retained alpha, the checkerboard remained visible, and no media error or dropped frames were reported. A separate lightweight idle timing check completed four wraps with 129 callbacks, zero reported drops, and wrap presentation intervals of 138–146 ms. See the [final playback timing](../apps/client/.cache/media-video-review-2026-09-15/final-basic-playback-timing.json).

Evidence: [saved final video](../apps/client/.cache/media-video-review-2026-09-15/hunyuan-alpha-ping-pong-final.webm), [complete native run](../apps/client/.cache/media-video-review-2026-09-15/hunyuan-final-completed.json), [all-frame measurements](../apps/client/.cache/media-video-review-2026-09-15/hunyuan-alpha-ping-pong-final.inspection.json), [same-seed and export comparison](../apps/client/.cache/media-video-review-2026-09-15/final-output-summary.json), [turnaround contact sheet](../apps/client/.cache/media-video-review-2026-09-15/final-ping-pong-turnarounds.jpg), and [preview capture](../apps/client/.cache/media-video-review-2026-09-15/final-basic-playback.json).

The same native preview bytes were also played inside the running desktop's Edge/WebView 152 engine. A temporary video element completed three wraps and 97 frame callbacks, with alpha present in every observed frame, zero reported drops, no media error, and the same SHA-256. The probe was removed afterward. This checks the desktop decoder and playback path; full interface interaction was exercised in Chrome. See the [WebView evidence](../apps/client/.cache/media-video-review-2026-09-15/native-webview-playback.json).

### Playback under load

The Advanced clip completed four repeats in an idle, freshly opened browser: 129 frame callbacks, 130 decoded frames, no reported dropped frames, and no media error. The four wrap presentation intervals were 137–147 ms at a nominal 125 ms per frame. While WAN was generating, a separate four-repeat check received only 77 callbacks and showed wrap intervals of 291–2,134 ms, despite the browser again reporting zero dropped frames. System RAM was under substantial pressure during model loading and generation. This observation does not isolate the cause, and smooth playback during heavy generation remains a limitation. See the [idle timing](../apps/client/.cache/media-video-review-2026-09-15/advanced-playback-idle.json) and [timing during generation](../apps/client/.cache/media-video-review-2026-09-15/advanced-playback-timing.json).

### Basic: WAN seamless with transparency requested

Run `29e4d7af-2847-4b5d-95bf-8fa22e9819da` used the real Basic queue after the Advanced run. It requested the same transparent teapot at 512 × 512, 17 source frames, 8 fps, seed `8152026`, guidance 5, **30 sampling steps**, Seamless, transparency, and Lossless encoding. The motion prompt explicitly requested a repeating rocking cycle returning to the original pose.

After 1,292.585 seconds, the worker rejected the generated pixels for an abrupt visual boundary. No video asset was published. This happened before video matting and export, so it does **not** verify WAN alpha delivery or its combination with seamless motion. The runtime did not retain this rejected candidate's frames; its [complete run and diagnostics](../apps/client/.cache/media-video-review-2026-09-15/wan-seamless-alpha-progress.json) are retained. The earlier retained WAN video and failed trials remain separate visual evidence, as described below.

The concrete remaining blocker is a generated sequence that passes the motion and appearance requirements. Increasing this attempt to 30 steps did not establish a usable seamless result. FramePack and LTX weights are absent, so neither their loop nor alpha paths received live generation coverage in this review. Hunyuan's installed first-frame adapter does not support seamless endpoint conditioning and is blocked in both editors.

## Automated verification

- Client Media Studio suites: 313 tests passed across 48 files.
- Native media suites, serial execution: 219 passed, three model/runtime-dependent tests skipped.
- Existing Python worker suite: 66 passed; WAN boundary suite: six passed.
- New video-delivery suite: nine passed, including actual FFmpeg RGB/RGBA encoding, lossless alpha, one-frame transparency failures, frame ordering, matte stabilization at wraps and turnarounds, animated composition, codec failure diagnostics, and timeout cleanup.
- Core, UI, test, and logic-test TypeScript checks passed. Focused lint and formatting checks passed.

The Advanced browser check confirms that Hunyuan retains its selected model and offers None and Ping-pong while disabling Seamless. Compiler regression cases confirm that an explicitly incompatible or missing model cannot silently resolve to an available WAN model. Duration shortcuts show only the achievable 4-second option at the tested 8 fps Ping-pong setting.

## Delivery benchmark

The exact worker present at the start of this review was retained as `worker-before.py`. Three alternating before/after trials encoded and verified the same real 17-frame, 512 × 512 Hunyuan clip at 8 fps, with identical Balanced VP9 settings.

| Measurement                                       |    Before |                 After |
| ------------------------------------------------- | --------: | --------------------: |
| Median encoding plus verification                 |   2.647 s |               1.849 s |
| Intermediate PNG bytes per trial                  | 4,598,189 |                     0 |
| Maximum decoded pixel difference between versions |         — | 0 in all three trials |

Elapsed time for the measured delivery stage fell by about 30%. This is not a diffusion-generation speedup. A GPU render was active during the benchmark, so these are local indicative timings, not an isolated performance study. The optimization preserves the decoded result and avoids intermediate disk traffic; it does not lower sampling quality or skip denoising steps.

### Transparency quality comparison

The same 32 decoded RGBA frames from the real Advanced clip were re-encoded using each quality setting with the final encoder. This holds the input pixels constant and isolates delivery quality. These single-trial timings were recorded with no generation running.

| UI encoding setting | File bytes | Encoding time | Mean alpha error, 0–255 | Maximum alpha error |
| ------------------- | ---------: | ------------: | ----------------------: | ------------------: |
| Balanced            |    353,965 |       1.099 s |                0.055970 |                  45 |
| High                |    424,079 |       2.123 s |                0.021489 |                  26 |
| Lossless            |  1,418,872 |       2.739 s |                       0 |                   0 |

High reduced compression error around alpha edges at about 20% more storage than Balanced. Lossless preserved every alpha sample at roughly four times the file size. The former lossless conversion altered 9,642 alpha samples by one level in this sequence; the corrected conversion altered zero. The comparison establishes encoding quality, not a change in generated motion or subject detail. See the [former conversion](../apps/client/.cache/media-video-review-2026-09-15/alpha-encoding-comparison.json), [final encoder comparison](../apps/client/.cache/media-video-review-2026-09-15/alpha-encoding-candidate-comparison.json), and [all-values conversion probe](../apps/client/.cache/media-video-review-2026-09-15/alpha-conversion-probe.json).

## Research and tradeoffs

Current upstream implementations were inspected on 15 September 2026. Source snapshots are retained with the evidence; upstream code was not copied into Machdoch.

- [ComfyUI VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/blob/main/videohelpersuite/nodes.py): examined `ffmpeg_process`, raw RGB/RGBA delivery, and `to_pingpong`. Its streaming approach informed the focused encoder helper. Machdoch retains its own frame validation, timeout handling, alpha decoding, and continuity checks. Ping-pong shares each turnaround frame once and reverses motion; it does not create forward circular motion.
- [ComfyUI WanVideoWrapper cache nodes](https://github.com/kijai/ComfyUI-WanVideoWrapper/blob/main/cache_methods/nodes_cache.py): examined TeaCache, MagCache, and EasyCache parameters, model calibration, step windows, and cache-device placement. These techniques trade computation for approximation and memory use. The implementation warns that aggressive or early skipping can harm motion. They were not added without a successful quality baseline for the installed WAN model.
- [ComfyUI Frame Interpolation / RIFE](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation/blob/main/vfi_models/rife/__init__.py): examined cached model loading, inference mode, pair batching, compilation options, and frame assembly. Interpolation requires additional weights and computation; RGB interpolation also needs a deliberate alpha treatment. It was not added as an unverified fix for a discontinuous generated loop.
- [HunyuanVideo 1.5](https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5): checked the current distilled model and acceleration guidance. Hardware-specific sparse-attention speed claims do not establish a benefit on the installed AMD GPU. The existing distilled sampling and offload path were retained.
- FFmpeg's [alpha extraction](https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavfilter/vf_extractplanes.c) and [alpha merge](https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavfilter/vf_alphamerge.c): inspected their direct component/plane copying. The final lossless filter extracts alpha before color conversion and merges it back afterward, avoiding the observed automatic-conversion rounding. Both direct alpha extraction and RGBA decoding confirm the correction; enabling accurate-rounding scaler flags alone did not fix it.

Lossless VP9 preserves the alpha samples and uses more storage and encoding work. Transparent WebM still uses YUVA 4:2:0 color conversion, so “lossless” does not mean an exact original RGB round trip. More frames cost generation time and memory; changing fps alone changes playback speed and does not add temporal detail. Releasing the cutout session means a later cutout must reload that model; its memory benefit was established by code inspection, not a separate resident-memory benchmark.

## Environment and evidence

Verification reused the running Vite service at port 4173 and the real desktop debug backend through its existing WebSocket bridge. Playwright exercised Media Studio's actual React UI in Chrome and native generation/export commands. The desktop WebView received the separate decoder/playback check above. File-picker destinations were supplied by the harness; native file-picker interaction was not tested. No development server was started.

Hardware: AMD RX 9070, approximately 16 GiB VRAM and 32 GiB system RAM. Runtime: Torch 2.12.0 with ROCm 7.14, Diffusers 0.39, OpenCV 4.13, and imageio-ffmpeg 0.6. Model loading caused substantial system-memory pressure. Results do not establish equivalent behavior on CUDA, Linux, other browsers, or packaged release builds.

Original WebM export preserves the encoded sequence and alpha. Automatic repetition is a player setting; the exported WebM does not make every external player repeat. Native alpha was decoded with `libvpx-vp9`; a decoder that ignores WebM alpha is not evidence that the file lost transparency.

Artifacts are under [`apps/client/.cache/media-video-review-2026-09-15`](../apps/client/.cache/media-video-review-2026-09-15/), which is ignored by Git. They include real outputs, full run provenance, all-frame alpha measurements, contact sheets, browser evidence, upstream snapshots, and the before/after encoder benchmark.

The earlier [WAN loop review](wan-loop-review-2026-09-15.md) remains relevant: successful playback and a permissive global continuity score did not establish seamless motion. Its retained burning-car video was re-inspected here and still shows the fire/smoke reset. The local seam appearance ratio is 1.865 and the speed ratio is 2.480. The new delivery optimization does not repair that content.
