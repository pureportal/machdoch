# DMAD and PDMD

Research checked on October 6, 2026 against the publishers' papers, inference repositories, model cards, and MiniMax-H3 licence.

## Methods and integration boundary

[DMAD](https://arxiv.org/abs/2610.02188) means Distribution Matching as Adversarial Distillation. It trains a student using two discriminator heads and density-ratio losses, replacing the auxiliary score-fitting process of DMD. [PDMD](https://arxiv.org/abs/2609.35768) means Projected Distribution Matching Distillation. It removes the component of the DMD training update parallel to the student–critic endpoint residual to reduce accumulated critic error.

Both are **training methods**. Reducing the step count of an arbitrary existing model does not implement either method. Inference requires a student checkpoint trained for that architecture, conditioning mode, and sampling rule.

The [DMAD release](https://github.com/Yzmblog/DMAD) publishes two rank-128 MiniMax-H3 text-to-audio-video LoRAs: the paper's `lora_critic` student and a `full_critic` student. Both use four evaluations, video shift 12, audio shift 2, and stochastic re-noising between evaluations. Its official Euler pipeline example produces different samples; it is not the sampler used for the paper's results. The current [publisher's model card](https://huggingface.co/ZhengmingYu/DMAD) also lists pretrained SDXL and Wan2.1 students. The suite now has separate SDXL loading and sampling profiles; Wan2.1 still needs its own integration.

The [PDMD release](https://github.com/ZeamoxWang/pdmd) publishes a four-evaluation full MiniMax-H3 transformer and rank-128 LoRAs for four and two evaluations. The [four-evaluation model card](https://huggingface.co/pdmd2026/pdmd_4NFE_lora) specifies video/audio shifts 12/3. The [two-evaluation model card](https://huggingface.co/pdmd2026/pdmd_2NFE_lora) specifies video shift 12 and recommends audio shift 6; shift 3 is used for paper metrics. The publisher records remaining texture, saturation, and audio quality problems in the two-evaluation variant.

The suite's existing MiniMax-H3 path uses a pruned Ref2VA transformer, a projected small text encoder, and an eight-evaluation reference-video adapter. The released students target the full `transformer/` partition and original Qwen3-VL conditioner. They must not be applied to Ref2VA, FL2VA, or an unrelated family solely because its name includes H3. Separate profiles preserve this distinction and can use the existing model picker, folder import, workflow compiler, worker transport, and asset publication path.

| Suite model family | Evidence for these released students |
| --- | --- |
| Full MiniMax-H3 text-to-audio-video | Released DMAD and PDMD checkpoints |
| Pruned MiniMax-H3 Ref2VA | Different partition and conditioner; no verified compatibility |
| Stable Diffusion 1, 2, and 3 | No matching release identified |
| SDXL base | DMAD one- and four-step profiles integrated; real loading checked, rendering blocked by concurrent training ([verification](media-studio-sdxl-dmad-verification-2026-10-06.md)) |
| Pony | Compatibility with the released SDXL students is unverified |
| Wan2.1-T2V-1.3B and 14B | Released DMAD four-step full generators; not integrated or tested here |
| FLUX, Krea, Qwen Image, Z-Image, SANA, GLM, HiDream, Ideogram | No matching release identified |
| LTX, FramePack, HunyuanVideo, CogVideoX, Mochi, Helios, Stable Video Diffusion, Sulphur | No matching release identified |
| AudioLDM, SVG, remote image/video APIs | No applicable released student or controllable denoiser |

## Licensing and attribution

The [DMAD inference code licence](https://github.com/Yzmblog/DMAD/blob/main/LICENSE) is Apache-2.0. Its [NOTICE](https://github.com/Yzmblog/DMAD/blob/main/NOTICE) explicitly distinguishes code from student weights: the students are MiniMax-H3 model derivatives governed by the MiniMax-H3 Community License Agreement. Adapted inference code must retain the Apache terms, relevant NOTICE, attribution, and a modification notice.

PDMD model cards declare Apache-2.0, but explicitly say that their checkpoints are distilled from MiniMax-H3 and need its base components. That metadata does not remove the base model agreement's derivative conditions. The conflicting declarations require publisher clarification before treating PDMD as unrestricted Apache weights.

The [MiniMax-H3 agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) excludes the European Union, United Kingdom, United States, and Republic of Korea. Its definition of model derivatives expressly includes distillation. It also requires accompanying terms and notices, imposes downstream use restrictions, requires a separate commercial grant above $20 million annual revenue, and requires MiniMax-H3 branding in commercial interfaces. The public agreement does not establish permission to use or redistribute these derivatives in an excluded territory without a separate grant.

Code integration and tests using synthetic tensors do not establish permission to download, execute, host, or redistribute the weights. Do not bundle checkpoints or mark their commercial use as unrestricted. Licence acceptance is not a substitute for obtaining a separate grant where the public agreement does not apply.

The DMAD model card assigns family-specific terms: SDXL weights use CreativeML Open RAIL++-M, Wan2.1 weights use Apache-2.0, and ImageNet-64 weights use CC BY-NC-SA 4.0. The H3 terms must not be generalized to those other families. The DMAD image-training code separately inherits CC BY-NC-SA 4.0 from DMD2.

## Implemented inference profiles

The H3 implementation uses the existing folder import, model selection, Basic generation, Advanced workflow, worker progress, and WebM publication paths. Each H3 profile fixes guidance to 1, output to 24 fps, and sampling to its released evaluation count. Audio is generated with the video. Image references, negative prompts, additional LoRAs, transparency, and looping are rejected for these profiles.

| Profile | Evaluations | Video/audio shifts | Sampler | File inside the imported folder |
| --- | --- | --- | --- | --- |
| MiniMax H3 DMAD 4-step | 4 | 12 / 2 | Re-noising | `distillation/dmad_minimax_h3_4step_lora_critic.safetensors` |
| MiniMax H3 DMAD Full Critic 4-step | 4 | 12 / 2 | Re-noising | `distillation/dmad_minimax_h3_4step_full_critic.safetensors` |
| MiniMax H3 PDMD 4-step | 4 | 12 / 3 | Euler | `distillation/pdmd_4nfe.safetensors` |
| MiniMax H3 PDMD 2-step | 2 | 12 / 6 | Euler | `distillation/pdmd_2nfe.safetensors` |

Start with an authorised full MiniMax-H3 Diffusers folder containing `model_index.json`, `LICENSE`, and the `transformer`, `text_encoder`, `tokenizer`, `processor`, `vae`, `audio_vae`, `scheduler`, and `audio_scheduler` components. Place one matching released LoRA at its path in the table. Import the folder through Models and choose the matching architecture, then select the imported model for generation on a CUDA or ROCm worker. The suite's Ref2VA package cannot serve as this base. Import and execution check the student file's exact size and SHA-256. An imported student's architecture and model terms remain fixed when editing its details. These checks do not replace review of the base weights and their terms.

Source code was inspected at DMAD revision [`ec59de455b1a010331190fa19c1f643b9b20e350`](https://github.com/Yzmblog/DMAD/tree/ec59de455b1a010331190fa19c1f643b9b20e350), PDMD revision [`041b70b89f7a37c391140d84f68f9c4623f5cb00`](https://github.com/ZeamoxWang/pdmd/tree/041b70b89f7a37c391140d84f68f9c4623f5cb00), and the suite's pinned [Diffusers revision](https://github.com/huggingface/diffusers/tree/4295ee3ec58efa6577bc459e9b84ca3f63aa9a96). The model profiles record each release revision, LFS digest, and byte size from Hugging Face metadata. The PDMD LoRA filenames are renamed during folder preparation; their contents must remain unchanged.

The worker stages the original BF16 text encoder and transformer separately, streams their modules from CPU by default, and uses the original tiled FP32 video/audio VAEs. Maximum-speed mode keeps each active stage on the accelerator and needs substantially more device memory. DMAD uses the publisher's unfused PEFT adapter path with rank and alpha 128; PDMD fuses its adapters in FP32. Target and tensor validation run before attachment or fusion. These modifications are attributed in the module docstrings and distributed notices. Equivalence to the publisher's rendered videos still needs actual checkpoints.

The integration consumes released students; it does not add a student-training service or make unrelated checkpoints distilled. PDMD's separate full-transformer release and FP32 adapter variants are not selectable profiles here.

## Verification criteria

Check profile selection, checkpoint identity, tensor layout and rank validation, complete component import, fixed evaluation counts, modality shifts, deterministic seeds, and rejection of incompatible conditioning and add-ons. Test actual tensor updates and both encoded audio/video tracks, as well as the shared Basic and Advanced generation contracts. Record measured device, precision, memory, cold/warm latency, output quality, and cancellation separately from synthetic tests.

Full outcome verification additionally requires actual authorised student checkpoints, a suitable accelerator and host memory, native desktop/fleet execution, and model-by-model inference evidence. Publisher benchmark scores and a passing mocked pipeline call do not establish the suite's speed, quality, or reliability.

## Verification results

- `python -m unittest test_media_h3_distillation test_media_h3_output test_media_open_models`: 36 tests passed in the installed managed media runtime with Torch 2.12.0 and PEFT 0.19.1. Checks exercise real tensor arithmetic, adapter files, unfused DMAD execution and PDMD fusion, finite-output validation, exact step counts, seeds, profile constraints, RGB/stereo decoding with synthetic VAEs, and actual FFmpeg encoding, muxing, and decoding of both output tracks. Regression checks reject incompatible Qwen3-VL configurations before prompt encoding or checkpoint hashing. They do not generate a released H3 sample.
- Differential checks against pinned publisher functions: three tensor-packing cases and all four student sampling profiles matched exactly after the publisher's BF16 output rounding, using synthetic velocities. The DMAD adapter also matched the pinned publisher's parameter states and forward outputs exactly on FP32, BF16, and mixed-precision synthetic models. These checks establish packing, solver, and adapter agreement; they do not establish rendered video quality.
- `vitest run --config vitest.config.ts --maxWorkers 2 --pool threads`: 86 files and 682 tests passed. The preceding unconstrained run had seven worker-startup timeouts; the limited-concurrency run completed without errors. Model-editor tests also cover retaining the student terms when saving a renamed model.
- Media Studio type checking and linting passed. Desktop and fleet UI builds passed. The DMAD resource/attribution test passed and validates the complete upstream legal-file hashes, modification notices, bundled Python files, and licence-generator inputs; the existing licensing suite also passed 31 tests.
- `cargo test media:: --lib --locked -- --test-threads=1`: 383 tests passed, none failed, and 13 were ignored. This executes native import, student licence retention, package inspection, profile persistence, generation contracts, worker cleanup, and cancellation tests. The initial parallel run exposed two obsolete profile fixtures, a partial PID-file read in the training fixture, and worker startup timeouts. The fixtures were corrected and the serial run completed successfully. Tests used a short isolated Windows target and a test-only bundle-resource override; they do not establish desktop packaging readiness.
- After adding the encoder check, `cargo test media::model_package_import:: --lib --locked -- --test-threads=1` passed all 17 package-import tests. These include incompatible H3 conditioners, missing original encoder weights, checkpoint identity, audio components, safe component specifications, and the existing Stable Diffusion, FLUX, SD3, and audio folder imports.
- The installed managed runtime reports Torch `2.12.0+rocm7.14.0`, Diffusers `0.41.0.dev0`, and Transformers `5.17.0`, and exposes all three H3 model classes. Accelerator selection chose the Radeon RX 9070 with 17,095,983,104 bytes of device memory, and a real GPU matrix product passed. An initial probe using the integrated default adapter crashed in HIP; the discrete-adapter probe succeeded. This is an accelerator/API check, not a student inference benchmark.
- A real one-layer, randomly initialised H3 transformer was saved and loaded through Diffusers with BF16 and FP32-sensitive modules. A synthetic rank-128 adapter was attached without fusion for DMAD and fused for PDMD, then every student sampler ran on the RX 9070, both resident and with the production CPU group-offload settings. All eight runs had finite outputs, the expected modality shapes and evaluation counts, and identical BF16 outputs between residency modes. No released base, student, text encoder, or VAE weights were used.

The GPU API check is retained as `apps/client/src-tauri/python/verify_media_h3_runtime.py`. Run it with the managed media Python and the worker's GPU visibility settings; hybrid AMD systems need the discrete adapter isolated before Torch imports.

`cargo check --lib --locked` passed with `TAURI_CONFIG` unset and the standard bundle resources enabled. Windows verification used a short isolated target, MSVC 14.50.35717, Windows SDK 10.0.26100.0, and the installed LLVM/Vulkan SDKs. The repository's toolchain helper showed intermittent Visual Studio discovery/setup timeouts; the successful rerun used explicit compiler paths. No desktop installer was built or exercised.

The complete desktop licence generator published `apps/client/dist/legal-desktop` with 1,048 dependency notice sets. After release manifests changed, it was regenerated against the reconciled manifests and lockfile. The final audit confirmed the exact upstream DMAD licence and NOTICE hashes, DMAD attribution, included H3 terms, and all 15 current release-input hashes.

The initial H3 model-store check inspected ten readable model indexes and found no full H3 package or DMAD/PDMD checkpoint. No restricted H3 weights were downloaded. Real H3 prompt conditioning, VAE rendering, native/fleet student execution, cancellation during actual student inference, cold/warm latency, peak memory, audiovisual quality, and compatibility with other model families therefore remain unverified. The full goal is not complete.

The publisher's original [encoder configuration](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/text_encoder/config.json) has 64 layers and a hidden size of 5,120. Import and worker validation now reject another conditioner before weight loading. Real-model verification needs an authorised complete package and matching student on a suitable worker. The available worker has about 16 GiB of GPU memory and 32 GB of host memory; it is below the [PDMD publisher's tested low-memory configuration](https://github.com/ZeamoxWang/pdmd) of a 24 GB GPU and 128 GB of host memory. The synthetic GPU run does not establish that the released models fit this worker.

## Follow-up: hardware and released students

The October 6 follow-up confirmed the Radeon RX 9070 and 32,830,408 KiB of usable system RAM. Only 854,356 KiB of RAM was free during the probe. The system drive had about 56 GB free; D: had about 242 GB free. The original H3 base download needs about 170 GB before additional caches or outputs.

The current H3 integration loads each complete BF16 encoder or transformer into host memory before attaching group-offload hooks. Each large stage has roughly 60–66 GB of weights, exceeding this machine's physical RAM. Reducing output size or using two denoising steps does not reduce those weights. This implementation has not incorporated the DMAD publisher's separate disk-streaming path.

The [DMAD consumer path](https://github.com/Yzmblog/DMAD#on-consumer-gpus) reports peaks of 12.9 GiB during sampling and 14.2 GiB during FP32 decoding at 1344×768 and 124 frames. Those CUDA measurements suggest that GPU capacity alone might permit an adapted streaming implementation on a 16 GiB card, but do not verify ROCm support, Windows memory overhead, speed, or this suite's implementation. PDMD's published 24 GB / 128 GB setup exceeds both local capacities.

The live Hugging Face file API confirmed these additional [DMAD students](https://huggingface.co/ZhengmingYu/DMAD):

| Student | Evaluations | Download size |
| --- | --- | --- |
| SDXL base | 1 or 4 | About 5.1 GB per UNet |
| Wan2.1-T2V-1.3B | 4 | About 2.8 GB |
| Wan2.1-T2V-14B | 4 | About 28.6 GB |

These are trained students, so reproducing their inference does not require student training. SDXL has since been integrated and its real components loaded, but rendering is blocked by concurrent training; see the [SDXL verification report](media-studio-sdxl-dmad-verification-2026-10-06.md). Wan2.1-1.3B remains a candidate after freeing memory and adding its loading and sampling path. Other architectures still require a matching released student or separate distillation training.

The H3 student downloads remain [DMAD](https://huggingface.co/ZhengmingYu/DMAD), [PDMD 4-step](https://huggingface.co/pdmd2026/pdmd_4NFE_lora), and [PDMD 2-step](https://huggingface.co/pdmd2026/pdmd_2NFE_lora), each about 1.4 GB per adapter, plus the original H3 components. EU use of H3 and its derivatives requires a separate MiniMax grant under the published agreement; changing the host or training another H3 student does not establish that grant.

The follow-up reran `python -B -m unittest test_media_h3_distillation test_media_h3_output test_media_open_models` in the installed managed runtime: all 38 tests passed in 405.984 seconds. `node --test scripts/licensing/media-distillation.test.mjs` also passed its attribution and legal-resource check. Hardware enumeration confirmed Torch `2.12.0+rocm7.14.0`, the RX 9070's 17,095,983,104 bytes of device memory, and 16,937,648,128 bytes free before the GPU sampler probe. These are integration and hardware checks, not real-model speed or quality measurements.

`verify_media_h3_runtime.py` then passed all eight RX 9070 cases with the discrete adapter isolated by `HIP_VISIBLE_DEVICES=1`: four student profiles resident on GPU and the same four with CPU group offloading. Outputs were finite, had the expected shapes and evaluation counts, and matched exactly between residency modes. Peak Torch allocation was 85,957,632 bytes (about 82 MiB), reflecting the one-layer synthetic transformer and tiny spatial dimensions. This confirms GPU execution of the integrated loading, adapter, and sampler paths; it does not establish that the full released model fits. No pretrained student generation, quality comparison, or real-model latency benchmark was performed in this follow-up.
