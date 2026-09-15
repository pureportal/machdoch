# WAN loop review — 15 September 2026

**Seamlessness was not verified.** The original output is visibly discontinuous, and eight fresh GPU trials produced no acceptable replacement. The retained change adds stricter WAN boundary inspection and rejects the previously accepted video. A fix that generates convincing seamless motion remains unresolved.

## Original output

The previously reported WAN video is **not seamless**. Successful generation, playback, and the old continuity score did not establish a seamless loop.

The retained request uses Wan2.2 TI2V 5B, the burning-car reference, “Flames coming up”, seed 0, 8 sampling steps, 512 × 288, and 8 fps. It requests 17 source frames and delivers 16 frames over two seconds.

Inspection in playback order **14 → 15 → 0 → 1** shows the fire under the car disappearing abruptly, a smoke reset, and a sharp change in motion. The seam’s mean absolute pixel difference is 19.806, versus 11.180 immediately before it and 10.055 immediately after it. Its ratio to those neighboring changes is **1.865**. The old comparison used the 95th percentile of changes throughout the clip and reported **1.107**, passing its 1.25 limit despite the visible discontinuity.

Playwright played the original through four loop boundaries in Chrome using the existing Vite service. Presented-frame callbacks captured the crossings for inspection. The media element reported no dropped frames or playback error; the content still jumped.

The final replay captured all four boundary frames at each of four crossings, both with normal HTML looping and with five copies concatenated into a continuous WebM. The continuous file had no seek or waiting events, yet showed the same fire/smoke reset. Its boundary display intervals were 116.6–116.8 ms at an 8 fps source rate, consistent with display-refresh quantization. Normal looping added seek delay, with boundary intervals of 138.3–155.5 ms. Both final captures recorded 66 presented-frame callbacks, zero reported dropped frames, and no page or media errors. These measurements separate the content defect from browser seeking.

The harness displayed the actual videos in an overlay on the existing Vite page. An earlier harness version replaced React's DOM and caused capture errors; the final overlay preserves it. Desktop IPC publication was not exercised by these playback checks.

## Cause and retained change

The old path rotated the clean still-image anchor together with motion latents, decoded the result as an ordinary finite video, replaced the first and terminal images with the exact source image, and discarded the terminal image. These operations do not enforce continuity of movement or decoded appearance.

Correcting the anchor rotation and adding cyclic causal-decoder context did not produce an acceptable loop on this sample. Increasing sampling from eight to twenty steps made the discontinuity worse. A separate trial with fixed cyclic position shifts across attention layers also failed. These approaches were removed from the implementation.

The retained implementation:

- Inspects the last two and first two delivered frames before encoding and after decoding the WebM. Generated frames are converted to the same RGB representation used by the encoder.
- Compares the seam's appearance change with its immediate neighbors, using the existing 1.25 tolerance. It also screens for a sudden speed change, hold, or reversal using optical flow.
- Requires both measurements in native validation and records typed `loopBoundaryInspection` provenance. Invalid, nonfinite, inconsistent, or discontinuous measurements are rejected.
- Packages the focused WAN inspection helper, updates the worker to `1.60.0`, and aligns conditioning types with the worker's current identifiers.
- Corrects the earlier report's claim about fixing seamless generation.

The unsuccessful generation and overlap replacements were removed. The existing WAN sampler now runs through the stricter checks. These changes prevent the observed false acceptance; they do not establish a working seamless-motion generator.

## Generation trials

Rejected trials remain in the evidence folder:

| Trial                                                                          | Appearance ratio |    Speed ratio | Result                                                           |
| ------------------------------------------------------------------------------ | ---------------: | -------------: | ---------------------------------------------------------------- |
| Original delivered video                                                       |            1.865 |          2.480 | Visible fire/smoke reset                                         |
| `cycle-1`, cyclic decode with rotated image anchor                             |            1.569 |          1.088 | Flicker and artifacts                                            |
| `cycle-2`, fixed image anchor, 8 steps                                         |            1.438 |          1.173 | Artifacts; failed appearance check                               |
| `cycle-3`, fixed image anchor, 20 steps                                        |            1.796 |          3.305 | Visual and motion discontinuity                                  |
| `rope-1`, fixed position shifts across attention layers                        |            2.708 |          3.493 | Visual and motion discontinuity                                  |
| `overlap-1`, ordinary I2V, 8 steps                                             |            0.224 |          1.073 | Raw frames corrupted; velocity check rejected assembly           |
| `overlap-2`, ordinary I2V, 20 steps                                            |            0.413 |          0.545 | Raw frames corrupted; velocity check rejected assembly           |
| `anchors-1`, two image anchors with overlap, 8 steps                           |            1.025 | Not measurable | Raw frames corrupted; full-cycle cadence check rejected assembly |
| `shift-overlap-1`, original latent shifting with extra overlap frames, 8 steps |            0.103 |          0.098 | Raw frames corrupted; boundary hold and direction change         |

The first three rows measure decoded WebM frames. The remaining rows measure generated pixels because the quality check rejected those trials before delivery encoding. Inspection-only WebMs were subsequently created from their retained generated frames. A separate overlap trial on the retained original video passed the boundary screen; it is an experiment, not evidence of a fresh production run.

The first-image-only overlap trials produced a correct first still followed by dark, corrupted raw frames, before any blending. Raising sampling from eight to twenty steps did not resolve this. Both were rejected for changes in motion direction (ratios 2.617 and 1.904, respectively). A standalone comparison of the RX 9070's default attention with PyTorch's math implementation, at both tested sequence lengths, found a maximum absolute difference of 0.001953 in BF16. This narrow diagnostic does not establish the cause of the corruption.

Using both image anchors also produced corrupted raw frames. Its dark boundary frames passed the local screen, but the existing full-cycle cadence check rejected 18.8% near-hold transitions and normalized jerk of 1.149 in the generated pixels. An inspection-only encode also failed that cadence check. This is another example of why a boundary score alone cannot establish a usable seamless loop.

The final trial combined the original sampler with additional overlap frames. It also produced corrupted raw motion and failed the boundary screen (velocity-change ratio 2.198). Its 22-minute duration included substantial memory pressure: Windows reported approximately 1.6 GB free RAM during the run. Numerical checks of the real WAN patch-embedding and query-projection weights found finite results and approximately 0.14% mean relative error against FP32 CPU calculations at both temporal sizes. Those narrow checks did not explain the corruption.

## Regression checks

- Existing Python worker suite: 65 passed, including the existing sampler test.
- New WAN boundary suite: six passed, covering continuing motion, reversal and hold rejection, brightness discontinuity, incomplete boundaries, and inspection of actual encoded WebM frames.
- The final inspector rejected the original video and both retained encoded cyclic trials. Their measured appearance ratios were 1.865, 1.569, and 1.438.
- Client media compiler, video quality, and Basics conversion: 67 tests passed across three files.
- Core, UI, test, and logic-test TypeScript checks passed. Lint, formatting, Python compilation, and whitespace checks passed for the affected files.
- Native media suite: 217 passed, three model/runtime-dependent tests skipped, using one test thread. An earlier concurrent run reported an ingest test failure and then terminated with Windows `0xc0000409`; the isolated ingest test and complete serial suites passed. The cause of that concurrent-process failure was not established.

## Research

These sources informed the implementation; their code was not copied:

- [Mobius, section 3.3](https://arxiv.org/html/2502.20307v1#S3.SS3), [ComfyUI-WanVideoWrapper sampler](https://github.com/kijai/ComfyUI-WanVideoWrapper/blob/main/nodes_sampler.py), and [decoder](https://github.com/kijai/ComfyUI-WanVideoWrapper/blob/main/nodes.py): researched and tested latent shifting with special handling for causal decode startup. The tested variants were rejected.
- [Loopy](https://arxiv.org/html/2608.23090v1): motivated the fixed attention-position trial. Its reported backbones and tuned models do not establish support for the installed TI2V 5B model; the local trial failed.
- [WhiteRabbit loop assembly](https://github.com/Artificial-Sweetener/WhiteRabbit/blob/main/whiterabbit/services/loop_frames.py): inspected preparation of the last/first pair and assembly without repeated interpolation endpoints. An original overlap implementation was tested locally and removed after its generated outputs failed review.
- [ComfyUI optical-flow nodes](https://github.com/seanlynch/comfyui-optical-flow/blob/main/optical_flow.py), [OpenCV optical flow](https://docs.opencv.org/4.13.0/d4/dee/tutorial_optical_flow.html), and [remapping](https://docs.opencv.org/4.13.0/da/d54/group__imgproc__transform.html): reviewed motion estimation and image warping using the existing OpenCV dependency.
- [Diffusers 0.39 WAN pipeline](https://github.com/huggingface/diffusers/blob/v0.39.0/src/diffusers/pipelines/wan/pipeline_wan_i2v.py) and [WAN VAE](https://github.com/huggingface/diffusers/blob/v0.39.0/src/diffusers/models/autoencoders/autoencoder_kl_wan.py): checked first-image conditioning, latent normalization, temporal expansion, and decoder behavior.

## Evidence

Local artifacts are retained under `apps/client/.cache/wan-loop-review-2026-09-15/`, which is ignored by Git. They include requests, generated latents, output videos, decoded frames, boundary contact sheets, per-transition optical-flow measurements, browser frame captures, and playback timing logs. The original video remains under `apps/client/.cache/media-refinement-2026-09-14/wan-output-1789419115/`.

- [Original boundary frames](../apps/client/.cache/wan-loop-review-2026-09-15/before/boundary.png)
- [Four normal loop crossings](../apps/client/.cache/wan-loop-review-2026-09-15/before-idle/loop-final/presented-boundaries.png)
- [Four crossings without seeking](../apps/client/.cache/wan-loop-review-2026-09-15/before-idle/continuous-final/presented-boundaries.png)
- [Final boundary rejection measurements](../apps/client/.cache/wan-loop-review-2026-09-15/boundary-validation.json)

## Limits

Boundary metrics are screening checks, not a proof of perceptual quality. Visual inspection is still necessary, including the blended transition inside the cycle. Optical-flow overlap can soften detail or produce warping/ghosting when motion, occlusion, or scene changes are difficult to match. Model quality, prompt, sampling steps, and clip length can affect results. This review uses the installed WAN 5B model on the RX 9070; other GPUs, transparent WAN generation, and packaged desktop publication need separate live verification.

The unresolved blocker is the absence of an acceptable generated candidate: cyclic variants flickered or jumped, and all additional-frame overlap variants produced corrupted raw motion. The cause of that corruption was not isolated. Trials used 512 × 288, 17 or 25 generated frames, and eight or twenty sampling steps. The publisher's full-size, 50-step workflow was not exercised, so these results do not establish failure of WAN or the researched techniques in general. [WAN model card](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers)

HTML video looping also performs a seek. Browser scheduling under load can add delay at the wrap even when the encoded frame sequence is continuous; the captured timing logs distinguish this from a discontinuity in the generated content.
