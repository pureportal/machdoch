# Media Studio verification — 2026-10-04

The complete studio goal remains **incomplete**. This continuation adds SDXL LoRA training and repairs its export/import/generation path. The [previous report](media-studio-verification-2026-10-03.md) retains the image, mask, Krea, CogVideoX, SVG, AudioLDM 2, editor, download, and real Codex evidence. Those earlier measurements have not been rerun for every modality here.

## Changes

- One local training API and runner replaces the Krea-specific commands. SDXL selects an installed managed checkpoint; Krea RAW selects a complete Diffusers folder. Jobs retain their model identity, seed, architecture, captions, and trigger phrase.
- SDXL trains UNet attention adapters with frozen base weights, text encoders, and VAE. Cached conditioning retains VAE posterior mean/deviation and SDXL crop/size conditioning. Latents are sampled during training. Gradient checkpointing and mixed precision limit memory; loss and gradients must remain finite.
- Atomic checkpoints retain adapter tensors, optimizer, scaler, and random state. Resume rejects changed dataset/model/settings. The native resume action requires complete checkpoint files, and cancellation terminates the launcher and descendants.
- The loader accepts an explicit training dtype rather than loading inference FP16 and recasting a large model to BF16. Native submission starts the job before the expensive GPU initialization, allowing the user to see and stop startup.
- SDXL exports current PEFT tensors directly with the pipeline's UNet prefix. The initially converted Diffusers keys were rejected by the importer. No legacy importer path was added.
- Automatic LoRA import records the correct architecture and trigger. “Use in Basic” converts retained SVG output settings to PNG when switching to image generation. Advanced training controls live in a separate component.

## Real SDXL evidence

Artifacts are retained under `D:\Models\machdoch\verification\2026-10-04`. Models and managed assets use `D:\Models\machdoch`.

The actual production desktop WebView selected the installed SDXL 1.0 base checkpoint through the training form. Playwright operated the native Windows image chooser and supplied three existing generated teapot images with captions. The job used resolution 512, rank four, eight optimizer steps, learning rate 0.0001, and seed 271828. It ran on the discrete AMD Radeon RX 9070 and trained 5,806,080 adapter parameters. All eight recorded losses were finite; the last was 0.0138188573. This short, mixed-style dataset is a functional smoke test, not evidence of a well-learned custom concept.

Initial job: `training-1791101108049-19716`. The first export failed native inspection because of its older key dialect. Its original output/checkpoints remain in `native-trained-output`. The unchanged learned step-eight PEFT tensors were re-exported using the corrected prefix; `native-training-peft-export.json` records the operation and hashes. Inspection then accepted 1,120 tensors across 560 rank-four target modules. Every up matrix contains nonzero learned values and all tensors are finite. Automatic native import registered digest `770073179d2f3adb93741cf963bbffd02f5b2be1eb755210e183b0a178350a02`, architecture SDXL, and trigger `mdteapot ceramic style`.

Actual Basic Generate image run `9f8f9424-75ac-4646-b784-fc83c35f0a8c` completed in 135.45 seconds of harness time at 1024 × 1024, 30 sampling steps, guidance five, and seed 314159. Its provenance records the trained adapter digest, all 560 modules, strength one, and loaded denoiser. The PNG digest is `1e9e3a9a7100e51de139e8e91ed57dc35632240ecb827f38f97eca50d245cd55`. Visual inspection shows a coherent red teapot and white cup, but a pale tabletop and large gray background; the dark-wood request remains unmet. There is no trained-concept quality claim.

The corrected built desktop completed a second actual job, `training-1791103882812-24572`, in a 1,485.911-second Playwright cycle. Stop terminated its real worker while the screen reported step four. The paused job retained complete checkpoint two and an unfinished temporary checkpoint four. Resume recovered checkpoint two, repeated steps three/four, and finished step eight. Its six resumed losses match the corresponding uninterrupted losses exactly. The final checkpoint adapter digest `dfc976698625a76fbe521d01c6c3fd5b1065a25a0dd156cbab08b9997bdbdaae` and exported adapter digest both match the first job byte for byte. This establishes reproducible resume for this exact GPU/recipe; it does not establish determinism across other devices or recipes.

Native automatic inspection/import succeeded directly from that trainer's output, and the job's temporary files were removed after import. Playwright switched through SVG during training and verified that “Use in Basic” returned to PNG with Generate image enabled. The native chooser, stop/resume, final import, trigger, architecture, and transition passed without page errors. Evidence is in `native-resume/`: paused status and job files, final output, training summary, addon descriptor, screenshots, `checkpoint-repeatability.json`, and `playwright-training-result.json`. The slow cycle includes startup, model reload, checkpoint copying, and UI work; it is not an eight-step sampling benchmark. Captured stacks show both Python imports and model/tensor loading. Earlier interrupted startup attempts remain separate and are not counted as successes.

## Checks

- 619 studio tests passed. After extracting the training settings component, its 21 view tests passed again; studio typecheck and lint passed.
- 362 native media tests passed; 12 external fixture/service/runtime checks were ignored. All nine training checks passed, including actual descendant-process cancellation.
- 289 Python tests passed, including the SDXL CPU UNet/PEFT checkpoint and export/reload tests, Krea runner arguments, and explicit training dtype selection.
- The rebuilt desktop with embedded production assets passed the real lifecycle check, and its bundled trainer hash matches the source. Client UI and core typechecks passed. No development server was started. The normal desktop configuration will be rebuilt after verification cleanup.

## Full goal coverage

| Requirement | Evidence | Outstanding result |
| --- | --- | --- |
| Current model breadth, including SDXL, Krea and MiniMax | [Model inventory](media-studio-model-support.md); earlier real SDXL/Krea/CogVideoX/AudioLDM 2 requests | Most profiles lack real execution; MiniMax H3 remains narrowly implemented and unexecuted; additional families/modes remain unintegrated |
| Beginner and advanced conditioning | Real Basic image/LoRA/audio actions and prior painted-mask worker measurement | Real pose/reference/endpoint combinations and broad beginner/advanced coverage remain unverified |
| All media with real models on D | Image, video, SVG document, audio and now trained SDXL adapter have concrete artifacts | SVG quality failed; audio listening quality and most model variants remain unverified |
| Image quality, stability and speed | Previous SDXL exact repeat/export; current trained-adapter generation inspected | Content/geometry defects remain; fast performance and universal output quality are not established |
| Asset management, acquisition and keywords | Prior real downloads, library/editor checks, trigger recognition; current automatic trained-LoRA import | Broad asset acquisition and semantic keyword-quality evaluation remain incomplete |
| Custom full-weight models | [Training research](media-studio-training-research-2026-10-04.md) establishes several upstream routes | No full-weight finetuning implementation or real job |
| Custom LoRAs across open families | Actual SDXL smoke job; Krea RAW integration checks; upstream route inventory | Krea real training, other families, longer concept learning, and video/audio adapter training remain unverified or unimplemented |
| Multi-scene, lip sync, user audio and video LoRAs | Upstream [Wan S2V](https://github.com/Wan-Video/Wan2.2) and [LTX conditioning](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/pipelines.md) reviewed | No usable native multi-scene timeline/audio-driven lip-sync workflow; no complete real song request |
| Codex enhancement | Prior actual accepted image/audio flow requests | Basic field filling and complex song/multi-scene/lip-sync requests remain unexecuted |
| No manual verification gate | Prior UI, installation and real generation evidence; training selects installed SDXL directly | No manual gate introduced |
| Typed cross-model flow | Prior compiler/editor tests and Playwright graph operations | Full image → postprocess → variant → first/last frames → actual video chain remains unexecuted |
| Editor clarity and operations | Prior real typed-port, valid/invalid drag, grouping, rename, collapse, add/remove checks | Complete workflow interaction coverage remains incomplete |

The available test machine has approximately 16 GiB GPU memory and 32 GiB system memory. Publisher recipes for every researched model cannot be verified on that hardware: for example, [HunyuanImage 3.0](https://github.com/Tencent-Hunyuan/HunyuanImage-3.0) recommends at least three 80 GB GPUs for its base and eight for Instruct variants. This is a hardware constraint on those official recipes, not a claim that every alternative deployment is impossible. No suitable external execution resource was established in this run. Missing integrations are recorded separately from that verification constraint.

Cleanup and final lifecycle results will be recorded after the owned verification desktop stops. The user's release desktop is outside this test session.
