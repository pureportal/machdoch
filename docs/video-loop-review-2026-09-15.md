# Video loop review — 15 September 2026

## Result

Added **Crossfade** to every supported video model in Basics and Advanced. It overlaps the tail and head with motion compensation, preserves forward playback, and shortens the delivered clip. Existing Seamless and Ping-pong choices remain distinct.

A fresh HunyuanVideo run and a reprocessed Hunyuan clip passed the shared Python encoder's checks. Their four repeated browser crossings showed no obvious pose reset. The original WAN fire/smoke clip, a fresh WAN trial, and a saved FramePack clip still failed. This improves loop support; it does not establish reliable seamless generation across models.

## Model coverage

| Model                               | Crossfade | Native Seamless conditioning               | Verification in this review                                                                             |
| ----------------------------------- | --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| FramePack I2V HY 13B                | Added     | Existing first/last conditioning           | Compiler coverage; saved generated clip rejected for an interior motion discontinuity                   |
| HunyuanVideo 1.5 I2V step distilled | Added     | Unavailable; first-frame conditioning only | Fresh GPU generation, alpha encode/decode, saved-clip comparison, repeated browser playback             |
| LTX-Video 0.9.8 distilled 2B FP8    | Added     | Existing keyframe conditioning             | Compiler coverage and shared frame-contract tests; model package unavailable locally                    |
| LTX-Video 0.9.8 distilled 13B FP8   | Added     | Existing keyframe conditioning             | Compiler coverage and shared frame-contract tests; model package unavailable locally                    |
| WAN 2.2 TI2V 5B                     | Added     | Existing cyclic latent shifting            | Fresh GPU trial completed sampling but returned corrupt raw frames; saved fire/smoke clip also rejected |

“Conditioning” describes what the pipeline accepts; it is not evidence that its output is seamless. Fresh FramePack and LTX generation was not verified. The FramePack package was also unavailable locally.

## Implementation

- Added the mode to the client contract, saved recipes, Basics/Advanced conversion, flow schema, compiler, native request validation, preview playback, and generation metadata.
- Duration controls use the delivered frame count. Crossfade overlaps `min(24, floor((sourceFrames - 1) / 2))` frames. For example, 33 source frames become 17 output frames; at 8 fps that is 2.125 seconds. The displayed duration accounts for this reduction.
- The shared Python implementation uses a quintic blend and bidirectional Farneback optical flow to align the overlapping frames. It preserves source order without reverse playback or temporal resampling. The unchanged middle is followed by the blended tail/head segment; playback begins at the corresponding point in the cycle.
- Transparent generation extracts the source alpha before overlap. Premultiplied-alpha blending prevents invisible RGB pixels from introducing colored fringes. Animated composites receive their own checks.
- Renamed the WAN-only Python/native inspection modules to `media_video_loop.py` and `video_loop.rs`, and updated the packaged resource entry. Worker version is `1.64.0`.
- Fixed a real WAN callback failure: non-Seamless modes included a `None` callback in the sampling callback chain. A regression test invokes the actual callback selected for each of the four modes.
- Invalid/nonfinite raw frame arrays are rejected before conversion to byte pixels. This does not diagnose the previously observed finite-pixel WAN corruption.

### Loop acceptance

Every loop mode now requires generated and decoded transition measurements, regardless of model. The native layer checks the required windows, frame counts, finite values, derived ratios, and acceptance limits. Missing or inconsistent evidence fails generation.

The file boundary is measured using the last two and first two frames. Crossfade also checks every transition throughout the overlap; Ping-pong checks both turnarounds. This catches a discontinuity moved into the clip by blending. Checks include visible RGB appearance, alpha changes, optical-flow speed, and velocity changes along the estimated motion path. The real encoded RGB/RGBA frames are decoded for the second inspection.

Appearance rejection requires both a ratio above 1.25 and an excess above one intensity level relative to the neighboring transitions. Measurable motion rejects speed ratios above 2 and velocity-change ratios above 1.5. A speed ratio below 0.4 is allowed only for a smooth turnaround with opposing neighboring motion and bounded velocity change. This prevents a natural rocking turnaround from being mistaken for a hold. Ping-pong permits its intended reversal. Exact duplicate/closure holds and the existing cadence checks still reject Seamless/Crossfade outputs.

These are screening heuristics, not a perceptual guarantee. Motion below the measurement floor is inconclusive. Optical flow can misread smoke, occlusion, changing shapes, and large movement; crossfades can morph details or create ghosting. The visual review remains necessary.

## Real output evidence

Evidence is under [the review directory](../apps/client/.cache/video-loop-review-2026-09-15/). These are local review artifacts, not published Media Studio assets.

### Fresh HunyuanVideo

Generated on the AMD Radeon RX 9070 with the managed ROCm runtime: 512 × 512, 33 source frames, 8 sampling steps, seed 0, 8 fps, transparent background, balanced matte, lossless VP9. The prompt asks a blue teapot to rock gently with a fixed camera.

- Delivered 17 frames, 2.125 seconds, with nonempty alpha in every frame and lossless alpha round-trip verification.
- All 17 generated and 17 decoded inspection windows passed. Ten windows in each phase had measurable motion; their maximum velocity-change ratios were 1.084 and 1.081.
- Browser captures show no obvious pose reset across four crossings. All decoded frames were also reviewed for changes inside the overlap. Motion is gentle; this is a limited example, not a test of vigorous movement or the full-size 50-step workflow.
- Normal looping and a five-copy continuous file each completed four crossings, with zero dropped frames or playback errors. The continuous file had zero seeking events.

Files: [video](../apps/client/.cache/video-loop-review-2026-09-15/hunyuan-fresh-final/output-0000.webm), [all decoded frames](../apps/client/.cache/video-loop-review-2026-09-15/fresh-all-decoded.jpg), [four boundary crossings](../apps/client/.cache/video-loop-review-2026-09-15/fresh-boundaries.jpg), [continuous-playback captures](../apps/client/.cache/video-loop-review-2026-09-15/fresh-continuous-boundaries.jpg), [request](../apps/client/.cache/video-loop-review-2026-09-15/hunyuan-fresh-request.json), [generation result](../apps/client/.cache/video-loop-review-2026-09-15/hunyuan-fresh-request.result.json), [final encoding evidence](../apps/client/.cache/video-loop-review-2026-09-15/hunyuan-fresh-final-evidence.json).

The final encoding corrected a metadata label from source passthrough to motion-compensated overlap. Its decoded RGBA pixels are identical to the browser-reviewed output; the WebM container bytes differ.

### Saved clips

| Source                  | Frames before → after | Boundary appearance ratio before → after | Boundary velocity-change ratio before → after | Result                                                               |
| ----------------------- | --------------------- | ---------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Hunyuan teapot          | 17 → 9                | 9.174 → 1.072                            | 2.956 → 0.353                                 | All overlap windows passed; four browser crossings reviewed          |
| Original WAN fire/smoke | 16 → 9                | 1.865 → 1.124                            | 1.641 → 2.075                                 | Rejected for boundary motion discontinuity                           |
| FramePack               | 25 → 13               | 4.871 → 0.829                            | 2.762 → 0.699                                 | File boundary passed, but an interior transition near frame 3 failed |

The saved transparent Hunyuan clip was decoded with libvpx and composited on black before opaque reprocessing. The FramePack and WAN attempts produced no accepted replacement videos. The WAN input here was the already encoded original, not a new raw generation.

Files: [saved-clip measurements](../apps/client/.cache/video-loop-review-2026-09-15/saved-clips.json), [Hunyuan before](../apps/client/.cache/video-loop-review-2026-09-15/before-boundaries.jpg), [Hunyuan after](../apps/client/.cache/video-loop-review-2026-09-15/after-boundaries.jpg), [reprocessed video](../apps/client/.cache/video-loop-review-2026-09-15/hunyuan/output-0000.webm), [review harness](../apps/client/.cache/video-loop-review-2026-09-15/review_saved.py), [browser harness](../apps/client/.cache/video-loop-review-2026-09-15/playback.mjs).

### Fresh WAN trial

The fixed-callback trial ran on the same RX 9070 at 512 × 288, 17 source frames, 8 steps, seed 0, and 8 fps. All eight sampling callbacks completed. It used Crossfade with normal WAN first/last conditioning; cyclic latent shifting was not enabled for this mode.

Raw decoded frames 1–12 visibly contained repeated distorted structures. The corruption was already present in the captured model output before overlap or WebM encoding. This places it upstream of the new postprocessing; it does not establish the underlying cause. The assembled boundary had a speed ratio of 0.091 and a velocity-change ratio of 2.600. The shared check rejected it before creating a WebM.

An earlier attempt exposed the `None` callback bug. A subsequent load was cancelled before sampling when concurrent compilation exhausted available RAM; it is not counted as a completed quality trial. The final trial above ran after compilation and completed normally through sampling. No failed replacement was published.

Files: [raw frame contact sheet](../apps/client/.cache/video-loop-review-2026-09-15/wan-final-request.frames.jpg), [request](../apps/client/.cache/video-loop-review-2026-09-15/wan-final-request.json), [result](../apps/client/.cache/video-loop-review-2026-09-15/wan-final-request.result.json), [measurements](../apps/client/.cache/video-loop-review-2026-09-15/wan-final-measurements.json), [run log](../apps/client/.cache/video-loop-review-2026-09-15/wan-final-log.txt).

### Corrected alpha comparison

An initial saved-Hunyuan comparison used an RGB decoder that ignored WebM alpha. Its apparent pass exposed hidden RGB and was invalid. Those outputs and playback captures are isolated in `discarded-alpha-review` and do not support the results above. The comparison was repeated with correct alpha decoding, and the final browser capture canvas was cleared before drawing each transparent frame.

## Research

The supplied [Reddit discussion](https://www.reddit.com/r/StableDiffusion/comments/1o23hf2/whats_the_best_approach_or_workflow_to_get_a/) reports that matching one endpoint image can suppress motion and still leave an unnatural join. Its useful suggestions include multiple frames of VACE context, avoiding duplicate endpoints, interpolation, and limited color matching. These are workflow reports rather than controlled evidence.

- [ComfyUI WAN/VACE nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_wan.py) show that VACE requires its own temporal conditioning path. The current TI2V/Hunyuan/FramePack/LTX pipelines do not acquire VACE support by adding a loop flag. No VACE checkpoint or unverified pipeline was added.
- [WanVideoWrapper sampler](https://github.com/kijai/ComfyUI-WanVideoWrapper/blob/main/nodes_sampler.py) and [Mobius](https://arxiv.org/html/2502.20307v1#S3.SS3) informed the distinction between cyclic sampling and a later join. This review does not newly validate the existing WAN latent-shift implementation.
- [WhiteRabbit loop-frame service](https://github.com/Artificial-Sweetener/WhiteRabbit/blob/main/whiterabbit/services/loop_frames.py) makes the endpoint-duplication issue concrete: its seam assembly excludes the two already present endpoints. Machdoch's overlap implementation is independent and adds no interpolation model.
- [Diffusers LTX-Video documentation](https://huggingface.co/docs/diffusers/api/pipelines/ltx_video) describes keyframe conditioning. Existing architecture-specific conditioning remains separate from the shared output assembly.
- [OpenCV optical-flow documentation](https://docs.opencv.org/4.13.0/dc/d6b/group__video__track.html) defines the Farneback flow coordinate relationship used to compare motion along its path.

The discussion's [VACE Pastebin](https://pastebin.com/RNVqP39f), [interpolation Pastebin](https://pastebin.com/JvQKMjMQ), and [Civitai example](https://civitai.com/images/93886436) could not be retrieved. Their workflow JSON was not inspected or executed.

## Automated verification

- **121 Python media tests passed**, including real VP9 RGB/alpha/composite encoding and decoding, discontinuity rejection, smooth turns versus holds, malformed frames, and WAN callback execution. The final metadata correction was followed by another passing run of the 14 delivery tests.
- **223 native media tests passed; three existing tests ignored.** Coverage includes missing/inconsistent evidence, omitted interior windows, frame-count contracts, and acceptance limits.
- **338 client media tests passed** across 51 files. Coverage includes all five model variants, Crossfade selection with Hunyuan's Seamless disabled, saved settings, Basics/Advanced round-trip, preview looping, and duration fitting.
- TypeScript core/UI/test checks, client lint, formatting of the touched client/native files, Ruff for the shared loop helper and video tests, and `git diff --check` passed.

## Remaining limits

- Live Media Studio UI interaction and native publication were not verified. The existing Desktop configuration had crashed with exit code 101 before this review; ports 4173 and the native browser bridge were unavailable. No development service was started or restarted. Standalone browser video playback does not establish working desktop integration.
- FramePack and both LTX model packages were unavailable locally. Their shared assembly and settings paths are covered, but successful fresh generations are unverified.
- Other GPUs, large/high-motion scenes, the full-size 50-step workflow, packaged resources in an installed build, and packaged publication remain unverified.
- The original WAN seamless-generation failure and the cause of prior corrupted raw frames remain unresolved. The [earlier WAN report](wan-loop-review-2026-09-15.md) has not been rewritten as a success.
