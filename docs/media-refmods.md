# MiniMax H3 RefMods

The integration targets Machdoch's `local:minimax-h3-ref2va` runtime. It stores and reuses native H3 image, video and audio conditioning. Completion requires both software checks and a licensed real-model generation comparison; synthetic tensor tests alone do not establish generation quality.

## Workflow

Choose MiniMax H3 in Video. Add RefMod files, browse a folder, or create references from images, video and audio. Imported files are copied into the workspace's `models/refmods` library so their sources can be removed. Inspect lists members and token costs; optional previews show a selected video frame, an image or two seconds of audio, with a strength comparison. The frame picker excludes decoder padding and resets when the selected member changes.

Each slot supports enablement, ordering, modality selection, independent visual/audio strengths, copies, and curves over denoising steps or reference frames. Use the numbered prompt buttons to insert the mapping used by the encoder. References can accompany one image or supply all conditioning without an image. Settings survive saved recipes and flow revisions.

Creation supports per-source masks and clip offsets, dimensions, full or compressed visual latents, spatial grid size and temporal length, optional latent refinement, video frame limits, audio duration, names and descriptive metadata. Compression reduces video to at most three latent frames by default; the advanced controls allow 1–107. Source folders collect supported files in filename order. The creator saves only after all extraction and token checks succeed. Existing destinations are preserved; choose a new name to save another version.

Export saves the selected modalities and copies, with the static strength and reference-frame curve baked into each latent. Denoising curves remain recipe/flow settings; export does not bake a dynamic curve into a single latent. Preserve a flow to share the complete run configuration. Remote creation keeps a library copy before downloading and removing its transfer file.

RefMod creation and preview commands can be canceled and have a thirty-minute worker timeout. Cancellation stops queued or running workers; native operations own their temporary reservations so cancellation and errors can remove them. Cancellation requested during runtime preparation is applied when preparation returns.

## Coverage and boundaries

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Image, video and audio files | Standalone v4 and ordered v5 safetensors bundles, including independent shapes | CPU round trips and header/shape validation |
| Native H3 conditioning | Video patch projection; channel-major stereo audio projection; native positions, tags and clean timesteps | Tiny DiT joint denoising on CPU and AMD GPU with finite audiovisual outputs |
| Prompt references | Picture, Video and Audio numbering follows active members and copies, with audio after visuals | Mapping tests; real-model binding still needs comparison |
| Usable editor | Create/import/browse/batch inspect/export, strengths/copies/curves, optional previews | Editor interaction and recipe/flow tests |
| Creation and compression | H3 VAEs, masks, bounded clips/audio, pooling and optional latent MSE refinement | Compression, preflight, FFmpeg extraction and preview format tests; real VAEs still need verification |
| Persistence and transport | Recipes, flows, typed Rust request fields, worker command, fleet dispatch and permanent imports | Persistence tests; live native/fleet execution still needs verification |
| Reliability | Finite tensors, strict shapes and metadata, resource caps, pre-load token checks, stable-file checks, atomic publication without overwrite, cancellation and owned temporary files | Invalid data, interrupted save, restart, selection and native process cancellation tests |
| Research and attribution | Primary upstream formats and code studied; full MIT licences, modification notice and model terms retained | Exact licence hashes and both release bundles verified; model authorization and GPL provenance remain unresolved |

Limits: at most 256 slots/active blocks, 1–8 copies, 512 MiB per file and accumulated fp32 conditioning, 1 MiB of exported metadata, and a configurable token budget (65,536 by default; zero disables the token cap). Visual shapes are `[1,24,T,H,W]` with even spatial dimensions; audio shapes are `[1,32,2,T]`. Visual token cost is `T*(H/2)*(W/2)`; audio cost is `2*T`. The optional image contributes to the total conditioning budget.

Video creation reads a bounded contiguous segment at 24 fps, starting at the requested offset. Frame limits follow `17n+5`. It does not silently subsample the entirety of a longer movie. Audio is normalized stereo at 32 kHz, encoded in bounded ten-second chunks; chunk boundaries can affect continuity. Input masks use the same center crop as their visual source.

Qwen receives up to eight representative frames reconstructed with the temporal decoder, spanning a video's saved sequence. Compressed video may have any positive temporal length; presentation pads its final latent to a decoder clip boundary and uses the native frame clock to exclude the padding from its sample range. The DiT receives the original selected latent, including its temporal sequence. This bounded presentation is an approximation, not exact native preprocessing of the original source. Visual presentation/preview requires a latent grid of at most 128 per axis (2048 decoded pixels). Decoder and GPU paths still need real-model testing.

Compression refines only the small latent against its enlarged reconstruction, without training the DiT or learning an identity. A zero slot strength skips its modality; a zero curve value keeps blurred conditioning and its tokens. Curves describe the reference sequence or denoising progress, not events on the generated video's timeline. No claim is made for reliable voice cloning, identity isolation or exact motion reproduction.

## Research

Checked on 2026-10-06:

- [ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod): modality controls, pooling/refinement, bounded extraction, strengths and curves, and failure reporting. [Bundle schema](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod/blob/main/BUNDLE_FORMAT.md).
- [Fantastic MiniMaxH3 PromptBuilder RefMods](https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder/blob/main/REFMODS.md): reference prompting, native workflow comparisons and quality limitations.
- [ComfyUI's native H3 model](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/ldm/minimax/model.py) and [reference nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py): packed reference order, stereo positions, modality tags and conditioning timesteps.
- [Diffusers' native H3 integration](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3): ordered mixed references, separate video/audio schedules, component loading and offloading. Its full checkpoint and Qwen3-VL conditioner differ from this runtime's pruned INT8 transformer, smaller conditioner and turbo adapters. The inspected local Diffusers 0.39.0 installation does not expose `MiniMaxH3Transformer3DModel`. A backend replacement needs checkpoint/adapter compatibility and real-model verification; upstream documentation alone does not establish those or resolve this runtime's existing GPL provenance.

This integration implements the native conditioning path directly. ComfyUI-specific graph bridges, signed axis widgets, scrambling, legacy sidecars and graph-PNG preset formats are not implemented. Order, selection and saved flows provide Machdoch's corresponding workflow controls; this is not a claim of one-to-one node parity.

## Licensing and release blockers

[NOTICE-RefMod.txt](../apps/client/src-tauri/python/NOTICE-RefMod.txt) identifies the inspiration and the modified Fizgig model. The full upstream MIT texts are retained and included by the release licence generator. The downloaded [MiniMax-H3 licence](../legal/third-party/MiniMax-H3/LICENSE) has SHA-256 `59b99642b95ea21630e311198ddbfffbfe05aadba0c2f5d884cbdf4efcc90f44`; its required [NOTICE](../legal/third-party/MiniMax-H3/NOTICE) is retained separately.

The model licence grants rights within its applicable territory, excluding the EU, UK, US and South Korea. Separate MiniMax authorization is necessary outside that territory and for commercial revenue above its threshold. It also imposes redistribution, downstream-use, safeguards and commercial UI obligations. Installing this integration does not establish permission to obtain, test or use H3 weights. A deployment's location, authorization and downstream terms have not been verified.

The existing Fizgig MiniMax code has unresolved ComfyUI GPL provenance, as recorded in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and [legal/README.md](../legal/README.md). MIT inspiration notices do not resolve that issue. Treat model authorization and the code-distribution provenance review as release blockers rather than asserting unrestricted commercial redistribution.

## Validation

Results on 2026-10-06:

- 36 Python checks passed: 24 RefMod/H3 checks, three source/preview checks and nine existing sampling/reference/embedding checks. These include tiny-model joint denoising, compressed video temporal round trips, native frame-clock planning, selecting the last logical preview frame for both comparison strengths, rejecting invalid indices before GPU/model loading, actual FFmpeg segment extraction, stereo sample clocks, portable previews, mixed-success batch inspection, owned temporary reservations and prevention of partial or oversized exports. Creation accumulation, presentation and video-frame preview tests use substituted VAEs; they do not validate real VAE behavior.
- Eighteen focused editor, persistence and remote transport checks passed, including creation/preview cancellation, cancellation when the preview unmounts, keeping Cancel usable during parent operations, recovery from a stale asynchronous preview, and selecting the last logical video frame/resetting it on member changes. The broader media suite passed 680 of 682 checks; its two failures exposed the missing RefMod protocol entry, which was corrected and verified by the focused rerun. TypeScript, Oxlint and the final production UI build passed.
- A separate synthetic mixed-reference generation check passed on the AMD Radeon RX 9070 using the current video convolution configuration: finite video latents `[1,24,7,4,4]` and finite audio `[74,32]`. It included three-frame compressed video, two visual copies and dynamic visual/audio curves, and preserved the original reference tensors. This loaded random tiny-model weights, not pretrained H3 components, and establishes neither VAE correctness nor generation quality.
- The fleet protocol's 440 TypeScript and 28 Rust checks passed. Five isolated checks of the actual native sources passed: RefMod validation, workspace cancellation scope, temporary ownership and stopping/reaping queued and active processes. The harness substitutes the database and cutout hooks; its cancellation path uses the real worker manager and Windows process supervision. The final desktop `cargo check --tests` passed with `DOCS_RS=1` and a temporary empty Tauri resource configuration. These source checks do not establish a normal native build or live desktop execution. The normal check encountered missing Vulkan SDK and speech bundle assets. A final environment check found the speech bundle present, but no configured Vulkan SDK or SDK directory under `C:\VulkanSDK`.
- Three licence packaging checks passed, including both exact upstream MIT hashes and the complete model agreement/notice. The refreshed headless and Windows desktop bundles passed their verifiers against the workspace manifests, with 504 and 1,048 dependency notice sets respectively. All five RefMod/H3 legal files in each bundle matched their sources exactly. Packaging verification does not establish model-use authorization or resolve the recorded GPL provenance.
- No required MiniMax H3 component filenames were found under this workspace's resolved model directory. Real VAE/DiT quality comparisons and live desktop/fleet execution remain unverified. Usage authorization and the recorded GPL provenance review remain unresolved.

Run the Python suite from `apps/client/src-tauri/python`:

```powershell
& .\runtime\Scripts\python.exe -m unittest test_media_refmods test_media_refmod_sources test_media_minimax_h3_sampling test_media_minimax_h3_addons -v
& .\runtime\Scripts\python.exe -m unittest fizgig.minimax.test_sampling_contracts fizgig.minimax.test_reference_contracts fizgig.minimax.test_embedder_cache -v
```

Run editor checks from the repository root:

```text
pnpm --filter @machdoch/media-studio typecheck
pnpm --filter @machdoch/media-studio check
pnpm --filter @machdoch/media-studio exec vitest run fleet-transport.spec.ts core/media/refmods.spec.ts components/media-refmod-controls.spec.ts --pool=threads --maxWorkers=1
pnpm build:ui
node --test scripts/licensing/media-refmods.test.mjs scripts/licensing/media-distillation.test.mjs
```

Before declaring the full goal complete, verify the desktop Rust build with its required SDK/resources, execute native and remote workflows, and run licensed real-VAEs/DiT comparisons for image-only, video-only, audio-only and mixed references at fixed seeds. Compare full versus compressed references, strengths, curves and copies; test cancellation/error recovery and evaluate audiovisual quality independently. No development server was started for this implementation.
