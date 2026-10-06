# DMAD and PDMD

Research checked on October 6, 2026 against the publishers' papers, inference repositories, model cards, and MiniMax-H3 licence.

## Methods and integration boundary

[DMAD](https://arxiv.org/abs/2610.02188) means Distribution Matching as Adversarial Distillation. It trains a student using two discriminator heads and density-ratio losses, replacing the auxiliary score-fitting process of DMD. [PDMD](https://arxiv.org/abs/2609.35768) means Projected Distribution Matching Distillation. It removes the component of the DMD training update parallel to the student–critic endpoint residual to reduce accumulated critic error.

Both are **training methods**. Reducing the step count of an arbitrary existing model does not implement either method. Inference requires a student checkpoint trained for that architecture, conditioning mode, and sampling rule.

The [DMAD release](https://github.com/Yzmblog/DMAD) publishes two rank-128 MiniMax-H3 text-to-audio-video LoRAs: the paper's `lora_critic` student and a `full_critic` student. Both use four evaluations, video shift 12, audio shift 2, and stochastic re-noising between evaluations. Its official Euler pipeline example produces different samples; it is not the sampler used for the paper's results. The paper also reports SDXL and Wan2.1 experiments, but this does not establish availability of compatible checkpoints for the suite's SDXL and Wan models.

The [PDMD release](https://github.com/ZeamoxWang/pdmd) publishes a four-evaluation full MiniMax-H3 transformer and rank-128 LoRAs for four and two evaluations. The [four-evaluation model card](https://huggingface.co/pdmd2026/pdmd_4NFE_lora) specifies video/audio shifts 12/3. The [two-evaluation model card](https://huggingface.co/pdmd2026/pdmd_2NFE_lora) specifies video shift 12 and recommends audio shift 6; shift 3 is used for paper metrics. The publisher records remaining texture, saturation, and audio quality problems in the two-evaluation variant.

The suite's existing MiniMax-H3 path uses a pruned Ref2VA transformer, a projected small text encoder, and an eight-evaluation reference-video adapter. The released students target the full `transformer/` partition and original Qwen3-VL conditioner. They must not be applied to Ref2VA, FL2VA, or an unrelated family solely because its name includes H3. Separate profiles preserve this distinction and can use the existing model picker, folder import, workflow compiler, worker transport, and asset publication path.

| Suite model family | Evidence for these released students |
| --- | --- |
| Full MiniMax-H3 text-to-audio-video | Released DMAD and PDMD checkpoints |
| Pruned MiniMax-H3 Ref2VA | Different partition and conditioner; no verified compatibility |
| Stable Diffusion 1, 2, and 3 | No matching release identified |
| SDXL/Pony and Wan | DMAD research results do not supply matching released checkpoints |
| FLUX, Krea, Qwen Image, Z-Image, SANA, GLM, HiDream, Ideogram | No matching release identified |
| LTX, FramePack, HunyuanVideo, CogVideoX, Mochi, Helios, Stable Video Diffusion, Sulphur | No matching release identified |
| AudioLDM, SVG, remote image/video APIs | No applicable released student or controllable denoiser |

## Licensing and attribution

The [DMAD inference code licence](https://github.com/Yzmblog/DMAD/blob/main/LICENSE) is Apache-2.0. Its [NOTICE](https://github.com/Yzmblog/DMAD/blob/main/NOTICE) explicitly distinguishes code from student weights: the students are MiniMax-H3 model derivatives governed by the MiniMax-H3 Community License Agreement. Adapted inference code must retain the Apache terms, relevant NOTICE, attribution, and a modification notice.

PDMD model cards declare Apache-2.0, but explicitly say that their checkpoints are distilled from MiniMax-H3 and need its base components. That metadata does not remove the base model agreement's derivative conditions. The conflicting declarations require publisher clarification before treating PDMD as unrestricted Apache weights.

The [MiniMax-H3 agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) excludes the European Union, United Kingdom, United States, and Republic of Korea. Its definition of model derivatives expressly includes distillation. It also requires accompanying terms and notices, imposes downstream use restrictions, requires a separate commercial grant above $20 million annual revenue, and requires MiniMax-H3 branding in commercial interfaces. The public agreement does not establish permission to use or redistribute these derivatives in an excluded territory without a separate grant.

Code integration and tests using synthetic tensors do not establish permission to download, execute, host, or redistribute the weights. Do not bundle checkpoints or mark their commercial use as unrestricted. Licence acceptance is not a substitute for obtaining a separate grant where the public agreement does not apply.

## Implemented inference profiles

The implementation uses the existing folder import, model selection, Basic generation, Advanced workflow, worker progress, and WebM publication paths. Each profile fixes guidance to 1, output to 24 fps, and sampling to its released evaluation count. Audio is generated with the video. Image references, negative prompts, additional LoRAs, transparency, and looping are rejected for these profiles.

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

- `python -m unittest test_media_h3_distillation test_media_h3_output test_media_open_models`: 34 tests passed in the installed managed media runtime with Torch 2.12.0 and PEFT 0.19.1. Checks exercise real tensor arithmetic, adapter files, unfused DMAD execution and PDMD fusion, finite-output validation, exact step counts, seeds, profile constraints, RGB/stereo decoding with synthetic VAEs, and actual FFmpeg encoding, muxing, and decoding of both output tracks. They do not generate a released H3 sample.
- Differential checks against pinned publisher functions: three tensor-packing cases and all four student sampling profiles matched exactly after the publisher's BF16 output rounding, using synthetic velocities. The DMAD adapter also matched the pinned publisher's parameter states and forward outputs exactly on FP32, BF16, and mixed-precision synthetic models. These checks establish packing, solver, and adapter agreement; they do not establish rendered video quality.
- `vitest run --config vitest.config.ts --maxWorkers 2 --pool threads`: 86 files and 682 tests passed. The preceding unconstrained run had seven worker-startup timeouts; the limited-concurrency run completed without errors. Model-editor tests also cover retaining the student terms when saving a renamed model.
- Media Studio type checking and linting passed. Desktop and fleet UI builds passed. The DMAD resource/attribution test passed and validates the complete upstream legal-file hashes, modification notices, bundled Python files, and licence-generator inputs; the existing licensing suite also passed 31 tests.
- `cargo check --tests --lib` passed after correcting fleet command/domain references. This compiles the native import, licence-retention, package-inspection, and generation-contract tests; it does not execute them. The test-only bundle-resource override does not establish desktop packaging readiness.
- The installed managed runtime reports Torch `2.12.0+rocm7.14.0`, Diffusers `0.41.0.dev0`, and Transformers `5.17.0`, and exposes all three H3 model classes. Accelerator selection chose the Radeon RX 9070 with 17,095,983,104 bytes of device memory, and a real GPU matrix product passed. An initial probe using the integrated default adapter crashed in HIP; the discrete-adapter probe succeeded. This is an accelerator/API check, not a student inference benchmark.
- A real one-layer, randomly initialised H3 transformer was saved and loaded through Diffusers with BF16 and FP32-sensitive modules. A synthetic rank-128 adapter was attached without fusion for DMAD and fused for PDMD, then every student sampler ran on the RX 9070, both resident and with the production CPU group-offload settings. All eight runs had finite outputs, the expected modality shapes and evaluation counts, and identical BF16 outputs between residency modes. No released base, student, text encoder, or VAE weights were used.

The GPU API check is retained as `apps/client/src-tauri/python/verify_media_h3_runtime.py`. Run it with the managed media Python and the worker's GPU visibility settings; hybrid AMD systems need the discrete adapter isolated before Torch imports.

Native test execution and full packaging remain unverified: two `cargo test media:: --lib` runs reached linking but failed on 85 unresolved Whisper and ONNX Runtime symbols. The retry confirmed that documentation-build and native-library skip flags were unset. Their test-only `TAURI_CONFIG` override omitted bundle resources; it did not validate a distributable desktop bundle. Standard resource staging also encountered a missing speech model.

Full desktop licence publication remains blocked by changing release inputs. After both speech inventories became available, two complete generator attempts copied the dependency notices but rejected publication at final input validation. The client package manifest, speech asset manifest, and speech native inventory changed during the latest run. The DMAD attribution/resource checks pass; the complete release bundle still needs generation against stable inputs.

Read-only inspection found no full H3 installation or DMAD/PDMD checkpoint in the configured model store. No restricted weights were downloaded. Real H3 prompt conditioning, VAE rendering, native/fleet execution, cancellation, cold/warm latency, peak memory, audiovisual quality, and compatibility with other model families therefore remain unverified. The full goal is not complete.
