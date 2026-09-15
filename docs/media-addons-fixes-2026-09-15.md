# Media Studio add-on fixes and verification — 15 September 2026

## Results

Implemented the embedding, prompt, warning, dependency and video LoRA integration fixes from the [earlier review](media-addons-review-2026-09-15.md). Image generation now passes real Basic and Advanced tests with a strong style LoRA and an eight-vector negative embedding. Video LoRAs import, persist and reach the correct transformers. **WAN output quality remains unresolved on the tested runtime:** both baseline and LoRA clips have corrupted middle frames. Hunyuan clips are coherent and the adapter changes motion, but neither control performs the requested robot grasp correctly.

| Capability                  | Result                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SD1.5 embeddings            | EasyNegative uses all eight vectors without the previous CPU/GPU failure; Monet changes positive-prompt output.                                           |
| Strong image LoRA           | Pixel M produces conspicuous style and composition changes. Strength and trigger controls were compared.                                                  |
| Basic/Advanced image parity | Pixel M 0.5 plus EasyNegative produces byte-identical PNGs.                                                                                               |
| Trigger warnings            | Visible beside submission in both modes; Add appends once. Embeddings no longer get the wrong missing-trigger action.                                     |
| Prompt resolution           | Compiler, warnings, recipes and submission resolve the same connected prompt and variables.                                                               |
| Model dependencies          | SD1.5/SDXL single-file imports provision pinned configuration/tokenizer files automatically. A fresh SD1.5 dependency download and verified reuse passed. |
| Video LoRA integration      | Import, discovered models, pickers, saved flows, queue, native requests, loading and provenance implemented for WAN, Hunyuan, FramePack and LTX.          |
| Hunyuan video output        | Matched baseline/RobotWin15 renders are coherent and visibly differ in object motion; action fidelity fails.                                              |
| WAN video output            | Real Basic baseline and Advanced Loomis renders complete with correct provenance, but both fail visual inspection.                                        |
| LTX/FramePack               | Actual small transformer/PEFT and FP8 layer tests pass; full model renders remain unverified.                                                             |

Evidence is in [the local evidence directory](../apps/client/.cache/media-addons-fixes-2026-09-15/), ignored by Git. This report retains the settings, run IDs and key findings independently of those files. Downloads, imported add-ons and real generation history remain available locally. Existing workspace changes were preserved.

## Changes

### Image loading and embeddings

- Load add-ons before final GPU offload so text-encoder resizing cannot leave new embedding weights on the CPU.
- Register case-sensitive tokenizer aliases for every vector and verify their actual encoded presence after prompt expansion and truncation. Reject missing or partially truncated vectors with a recovery instruction.
- Preserve punctuation without duplicate insertion; insert embeddings into the selected positive, negative or both channels. Reject negative embeddings when guidance would leave the negative prompt unused.
- Load CLIP LoRAs using the current Transformers module names. Pixel M exposed an additional loader failure here. A further real-layer test exposed stale module names inside PEFT metadata; the fix maps explicit/regex targets and rank/alpha patterns as well as tensor keys, preserving denoiser/CLIP strengths.
- Store edited embedding tokens and LoRA trigger phrases in the native add-on record. Invalid embedding aliases are blocked. Existing selections retain their saved aliases; new selections receive the edited default.
- Classify the underlying worker error before incidental log text, avoiding false safety rejections from unrelated safety-checker messages.

### Prompts and warnings

One resolver follows the prompt connected to each generation node and expands its variables. It is shared by compilation, warnings, saved recipes and generation. Tests include a graph with an unrelated earlier prompt and a different connected prompt.

Warnings appear beside Basic and Advanced submission, including with Advanced's inspector closed. Matching respects word boundaries and case. Disabled and zero-effect selections do not create trigger warnings. Add preserves the editable variable expression and appends a missing phrase once. Embeddings use their selected channel automatically; verified EasyNegative defaults to Negative.

### Video LoRAs

Video selections are separate from add-ons used to generate a starting image. All supported video model registrations expose their LoRA capability, including workspace-discovered models and the `local-wan` provider. Saved video flows accept validated LoRA selections and preserve them through queue snapshots and native submission.

The worker loads adapters before offloading, verifies immutable file digests and every target shape against the actual transformer, preserves PEFT rank/alpha/dropout metadata, and disables training dropout for inference. FP8 base layers retain adapters in BF16 compute precision. Stored output evidence includes the adapter digest, targets and effective strength. Video accepts up to eight distinct Diffusers PEFT LoRAs with whole-clip strength; other tensor formats, embeddings, separate text strengths and denoising schedules are rejected at this boundary.

Live testing found and fixed three additional integration defects: empty add-on capability lists on discovered video models, omission of `modelAddons` from native saved-video configuration, and repeated native lookups for queued jobs that did not exist yet. Queued views now read the queue snapshot; the queue continues observing native state once generation starts.

## Downloaded and imported assets

| Asset                                                                                                                         | Source revision                            | SHA-256                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| [Pixel M](https://huggingface.co/zenafey/pixel_f2), SD1.5 LoRA/LoCon with CLIP; trigger `pixel`                               | `08d566d9fbdb5af7290cdc72ac42cda7a36641e3` | `dc9de8c8bae899466df0340a29ff79cf86765a8be77975ee57eb438bbcfea433` |
| [Monet](https://huggingface.co/tymasf/textual_inversion_monet), positive SD1.5 embedding, one vector                          | `58546ed180fe0b6ef49927a067da380f273e738a` | `32d918591e5d563d7c241fe3240e3d32ccc499215868711c6f831bebccf3898b` |
| [RobotWin15](https://huggingface.co/RoMALab/hunyuanvideo-1.5-robotwin15-i2v-lora), Hunyuan 1.5, 324 targets                   | `a8e76d7e71df99d06e04198dc1b169abd2541ec2` | `dc0638e379179eb9a1c82118094f73ab4ab1e0c3373257ac6aa9713f7691aa53` |
| [Loomis Painter](https://huggingface.co/Markus-Pobitzer/wlp-Wan2.2-TI2V-5B-lora), WAN TI2V 5B, 300 targets, reused/reimported | `7d85f8180d6b72a5adfab1457d68596a60ca1b85` | `38df0780f572a9f91073057501ec0091cd816d144c946bfd1a391164f977c0fb` |
| [EasyNegative](https://huggingface.co/gsdf/EasyNegative), negative SD1.5 embedding, eight vectors, reused                     | Exact file pinned by digest                | `c74b4e810b030f6b75fde959e2db678c268d07115b85356d3c0138ba5eb42340` |

Pixel M, Monet and RobotWin15 were downloaded during this task. Sources remain under workspace `models`; native import creates immutable managed copies. Only Safetensors assets were loaded. RobotWin15 uses `checkpoints/ffn-r32-gate75-step-015000/lora/pytorch_lora_weights.safetensors` from the pinned revision.

Pixel M's card declares MIT and Monet's declares CreativeML OpenRAIL-M. The tested video adapter cards do not establish clear adapter license terms; their base-model licenses were not assigned to the adapters. Neither video adapter declares a mandatory trigger. Loomis testing uses its publisher's example prompt, `Painting process step by step.`

## Real image comparisons

### Embeddings and substantial styles

SD1.5 baseline/EasyNegative/repeat: 512×512, 20 steps, guidance 7.5, seed 9152026. EasyNegative and its repeat are byte-identical; mean absolute RGB change from baseline is **35.64/255**. Provenance confirms all eight vectors are encoded. [Comparison](../apps/client/.cache/media-addons-fixes-2026-09-15/embedding-comparison.jpg), [measurements](../apps/client/.cache/media-addons-fixes-2026-09-15/embedding-comparison.json).

Seven matched style controls at 512×512 and 28 steps cover Pixel absent/0.5/1, Pixel 0.5 with/without its trigger, Monet absent/present and Pixel plus EasyNegative. Pixel visibly changes the image into a blocky retro style and changes composition. Mean RGB differences from baseline are **52.75/255** at 0.5 and **82.41/255** at 1. Removing `pixel` changes the result by **19.40/255** from the triggered 0.5 case; the adapter still has an effect without it. Trigger warnings indicate a publisher cue, not proof that an adapter is inactive without the word.

Monet changes its matched output by **25.61/255**. Its baseline also contains the literal `<monet>` artist cue, so the comparison does not establish that all style originates in the learned vector. These difference scores measure change, not quality. [Style comparison](../apps/client/.cache/media-addons-fixes-2026-09-15/style-comparisons.jpg), [settings and measurements](../apps/client/.cache/media-addons-fixes-2026-09-15/style-comparisons.json).

### Basic and Advanced

Actual UI submissions used Pixel M 0.5 plus EasyNegative, 512×512, 20 steps, guidance 7.5, seed 9152026:

`a fantasy castle on a hill beside a river, colorful flowers, blue sky, pixel`

| Mode     | Native run                             | Output                                                                                     |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Basic    | `23eeee87-a6d8-4bfb-b49f-54c7ae85caa7` | [PNG](../apps/client/.cache/media-addons-fixes-2026-09-15/basic-pixel-easynegative.png)    |
| Advanced | `2afcac59-5807-4813-aa56-1b74945f7722` | [PNG](../apps/client/.cache/media-addons-fixes-2026-09-15/advanced-pixel-easynegative.png) |

Both have SHA-256 `84d415ddb2f5525a799b9e3ba98e7c3d87bbb8d10c0dc7a9feac588454b7d16d`. The inspected images show a coherent, strongly stylized castle. Native provenance confirms the LoRA's denoiser and CLIP components and all eight negative embedding vectors. [Captured native requests/results](../apps/client/.cache/media-addons-fixes-2026-09-15/live-generation-evidence.json).

After the final CLIP metadata fix, both captured UI requests were replayed through native generation with worker **1.66.0** and new run IDs:

| Request         | Native run                             | Output                                                                                          |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Basic replay    | `507ab308-ef72-4f2a-919f-52957e2d2eb6` | [PNG](../apps/client/.cache/media-addons-fixes-2026-09-15/basic-pixel-easynegative-1.66.png)    |
| Advanced replay | `25b76543-f71b-41f8-ac9b-ff06439e7db4` | [PNG](../apps/client/.cache/media-addons-fixes-2026-09-15/advanced-pixel-easynegative-1.66.png) |

Both retain the same SHA-256 above and encode all eight negative vectors. These are fresh native renders of the recorded submissions, not new UI interactions. The first replay was blocked before sampling because the worker update invalidated cached model verification; an offline SD1.5 verification passed before both successful replays. [Verification](../apps/client/.cache/media-addons-fixes-2026-09-15/sd15-probe-1.66.json), [final requests/results](../apps/client/.cache/media-addons-fixes-2026-09-15/native-images-1.66-evidence.json), [output checks](../apps/client/.cache/media-addons-fixes-2026-09-15/native-images-1.66-comparison.json).

Live warning checks: [Basic](../apps/client/.cache/media-addons-fixes-2026-09-15/basic-trigger-visible.png), [Advanced with inspector closed](../apps/client/.cache/media-addons-fixes-2026-09-15/advanced-warning-without-inspector.png), [Add cleared the warning](../apps/client/.cache/media-addons-fixes-2026-09-15/advanced-warning-cleared.png). No incorrect EasyNegative warning appeared. Monet's token was edited to `<MonetStyle>`, persisted through reload, validated on reselection and restored to `<monet>`; whitespace aliases were blocked. [Token validation](../apps/client/.cache/media-addons-fixes-2026-09-15/token-validation.png).

## Real video comparisons

### Hunyuan RobotWin15

Production worker baseline and strength-1 adapter: 672×384, 17 frames, 8 fps, seed 9152026, guidance 1, no looping. The request specified 4 steps; the existing Hunyuan path selects **8 effective steps**. The source is a pinned RobotWin training-dataset frame, recorded in [source evidence](../apps/client/.cache/media-addons-fixes-2026-09-15/robot-reference.source.json).

Prompt: `The left robotic arm grasps the green bottle on the table, lifts it and holds the bottle upright. Fixed camera.`

Both videos decode coherently. In the baseline, the bottle floats upward without a grasp. With RobotWin15, it stays on the table and the arm moves differently. **Neither performs the requested grasp.** The adapter changes a meaningful object trajectory, while the static background keeps the global pixel difference small: 6.80/255 at frame 8 and 8.29/255 at frame 16. Stored evidence confirms all 324 targets and preserved rank/alpha settings.

[Baseline video](../apps/client/.cache/media-addons-fixes-2026-09-15/hunyuan-baseline/video/output-0000.webm), [LoRA video](../apps/client/.cache/media-addons-fixes-2026-09-15/hunyuan-robotwin/video/output-0000.webm), [frame comparison](../apps/client/.cache/media-addons-fixes-2026-09-15/hunyuan-baseline-comparison.jpg), [live picker](../apps/client/.cache/media-addons-fixes-2026-09-15/hunyuan-lora-picker-live.png). This verifies loading and a visible effect, not robot-action fidelity or the publisher's four-step workflow.

### WAN Loomis Painter

Actual native Basic baseline and Advanced strength-1 LoRA used the same source, prompt, 384×384 dimensions, 17 frames, 20 steps, guidance 1, 8 fps, seed 9152026, opaque lossless WebM and no looping.

| Mode            | Native run                             | Output                                                                                             |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Basic baseline  | `81eda5a5-ae8b-45cd-b493-a5d7f7b7c9aa` | [WebM](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-native-basic-baseline/output.webm)  |
| Advanced Loomis | `e47e7df8-de6d-449c-9fb7-a1b6601b3449` | [WebM](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-native-advanced-loomis/output.webm) |

Both native runs used worker 1.65.0 and the isolated RX 9070 as CUDA device 0. The adapter reaches all 300 targets at strength 1. Queuing Advanced and changing Basic settings afterward did not change the captured Advanced request. [Requests/results](../apps/client/.cache/media-addons-fixes-2026-09-15/live-video-evidence.json), [verified exports/provenance](../apps/client/.cache/media-addons-fixes-2026-09-15/native-video-exports.json).

**Both clips fail visual inspection.** Middle frames contain bright geometric bands or painterly smears. Baseline jumps are especially large at frames 5, 9 and 13. The adapter changes the output but does not make it usable. Technical completion, valid encoding and correct LoRA provenance are not visual-quality evidence. [Decoded frame comparison](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-native-basic-baseline-comparison.jpg).

#### WAN diagnostics

- All nine installed WAN Safetensors weight files match the publisher's SHA-256 values at revision `b8fff7315c768468a5333511427288870b2e9635`. Installed configuration, index and tokenizer files also match that revision. [File verification](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-base-weight-evidence.json).
- Standalone baseline/LoRA renders also reproduce corruption before encoding.
- Using the unmodified upstream first-frame conditioning still produces corruption. Custom endpoint conditioning is therefore not sufficient to explain this failure. [Raw frame 8](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-upstream-first-only/frames/008.png), [latent statistics](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-upstream-first-only/latent-statistics.json).
- Actual WAN VAE CPU/GPU round trips at 224×128 and five frames agree within approximately 6.4e-7 decoded mean absolute error in normalized units.
- Isolated-GPU 384×384 round trips at both five and **17 frames** remain finite and visually coherent with and without tiling. At 17 frames, tiled/untiled decoded error is 0.00957 in [-1,1] units; encoded latents match exactly. [17-frame evidence](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-vae-17-tiling-evidence.json), [last frame](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-vae-17-tiled-16.png).
- A BF16 attention probe matching the small render's head size and sequence lengths agrees with the math backend within 0.00390625 maximum error. This bounded probe does not validate every model activation or rule out a runtime defect.
- A diagnostic kept the denoiser on the GPU for the entire 20-step sampling sequence, then released it before decoding. Its final latents are **exactly identical** to the group-offloaded control, and both clips remain corrupted. Group offloading does not explain this pair's failure. An earlier all-resident attempt was aborted after approximately 7.7 GB spilled into shared GPU memory during decoding; that aborted attempt provides no visual result. [Latent comparison](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-offload-latents.json), [frames](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-upstream-first-only-comparison.jpg), [pixel measurements](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-upstream-first-only-comparison.json).
- A fresh-process **50-step, guidance-5** control completed sampling with upstream first-frame conditioning. Its original decode stalled for over five minutes, so that diagnostic process was stopped after preserving the final latents. A fresh GPU decoder completed both the 20-step and 50-step outputs; **both still contain severe corruption**. [Sampling log](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-resident-50-isolated.log), [fresh decoding evidence](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-fresh-decoder-evidence.json), [frame comparison](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-resident-denoise-20-comparison.jpg). An earlier sequential diagnostic exhausted host memory before the 50-step sampling began and was stopped; it is not counted as a rendered control.
- Decoding the actual 20-step generated latents on the **CPU** reproduces the same corruption. The first nine decoded CPU/GPU frames differ by only **0.000118/255** mean RGB error. The failure therefore persists independently of GPU decoding for this sample; the sampled latents or an earlier stage remain suspect. [CPU/GPU frames](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-generated-cpu-gpu-decode-comparison.jpg), [measurements](../apps/client/.cache/media-addons-fixes-2026-09-15/wan-generated-cpu-gpu-decode-comparison.json).

The cause remains unproven; these controls do not establish that a particular library or GPU is at fault. A [ComfyUI report on Windows RX 9070 XT](https://github.com/Comfy-Org/ComfyUI/issues/11574) describes corruption with the same model on an older ROCm runtime, but provides no verified fix or causal explanation for this installation. The [base-model example](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers) uses 50 steps and guidance 5 at a larger resolution; the [Loomis example](https://huggingface.co/Markus-Pobitzer/wlp-Wan2.2-TI2V-5B-lora) uses a longer clip and guidance 1. The 50-step diagnostic still uses 384×384 and 17 frames, so the short comparisons above are not reproductions of either full workflow. WAN generation quality is a remaining blocker to declaring the complete task successful.

## Checks

| Check                                         | Result                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Client media suites                           | 362 passed, 53 files                                                                                                                  |
| Native media suite                            | 227 passed, four ignored                                                                                                              |
| External native import/dependency integration | Explicitly run separately: one passed, covering all four supplied external asset fixtures and a fresh SD1.5 dependency download/reuse |
| Python worker suites                          | 129 passed, including actual CLIP tokenization and actual PEFT transformer layers for four video families                             |
| TypeScript                                    | Core, UI and test projects passed                                                                                                     |
| Media lint                                    | Passed                                                                                                                                |
| Formatting                                    | Changed media TS/TSX and new Python modules passed; a broader media check reports 18 existing deviations in untouched files           |
| Live queue regression                         | Advanced submission waited 78 seconds with zero queued native-detail requests and no alerts; cancellation cleared all queued work     |

The queue regression uses a controlled held task with a supplied running record to delay the real UI submission; it is a queue test, not additional video-generation evidence. Initial harness setup errors are retained separately. [Queue evidence](../apps/client/.cache/media-addons-fixes-2026-09-15/queue-live-evidence.json), [activity screenshot](../apps/client/.cache/media-addons-fixes-2026-09-15/queue-fixed-activity.png).

Logs: [client](../apps/client/.cache/media-addons-fixes-2026-09-15/client-final.log), [native](../apps/client/.cache/media-addons-fixes-2026-09-15/native-video-save.log), [external assets](../apps/client/.cache/media-addons-fixes-2026-09-15/native-four-assets.log), [Python](../apps/client/.cache/media-addons-fixes-2026-09-15/python-final-clip-metadata.log), [typecheck](../apps/client/.cache/media-addons-fixes-2026-09-15/typecheck-final-all.log), [formatting](../apps/client/.cache/media-addons-fixes-2026-09-15/format-changed-final.log).

At completion, no task generation jobs or diagnostic Python processes remain active, and the browser harnesses are closed. The 100 most recent native runs contain no pending work. [Native status](../apps/client/.cache/media-addons-fixes-2026-09-15/final-native-status.json), [process status](../apps/client/.cache/media-addons-fixes-2026-09-15/final-process-status.json).

## Environment and limits

Windows, AMD Radeon RX 9070 16 GB, 32 GB RAM; Torch 2.12.0+rocm7.14.0, Diffusers 0.39.0, Transformers 5.13.0, PEFT 0.19.1, Accelerate 1.14.0. Final production worker: `media-diffusers-worker/1.66.0`, schema 5.

Source and staged development worker/add-on modules have identical SHA-256 hashes. [Source evidence](../apps/client/.cache/media-addons-fixes-2026-09-15/final-source-evidence.json).

Playwright drove the production React Media Studio through the existing Vite service and real Tauri commands/events. File-picker selections were supplied; the Windows picker window itself was not tested. No development service was started or restarted by this task. Existing managed rebuilds caused some bridge interruptions; those logs are not counted as clean UI passes.

Full LTX/FramePack model renders, other GPUs/operating systems, SD2/SDXL/FLUX.1 embeddings and packaged publication remain unverified. The earlier FLUX.2 Dog comparisons were not repeated here. No universal model-quality, action-fidelity or seamless-loop claim is made.
