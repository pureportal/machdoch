# Basic image generation verification

October 10–11, 2026. All four installed text-to-image models in `D:\Models\machdoch` passed real Basic/Quality generation on the Radeon RX 9070. Their responses also passed the production native sampling validator. The final verifier records `passed: true`.

## Live results

The [2026-10-11 source audit](media-studio-image-engines-verification-2026-10-11.md) subsequently identified the BF16 SNOFS checkpoint as Krea RAW. Its eight-step run below proves technical completion, but uses distilled settings rather than RAW's published 52 steps and CFG 3.5. The current implementation and installed classification are corrected; RAW quality verification is tracked in that report.

| Model and image                                                                                                                                              | Resolution | Steps | Elapsed     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----- | ----------- |
| [SNOFS Krea 2 Raw v1.4, BF16](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified/01-krea-2-8a50afe6a29e/images/output-0000.png)               | 1056×576   | 8     | 59 min 40 s |
| [StableYogi v30 FP8](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified/02-krea-2-3ec3c673d467/images/output-0000.png)                        | 1056×576   | 8     | 28 min 3 s  |
| [CyberRealistic Pony Catalyst v5.0](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified/03-pony-b5e68becf7cf/images/output-0000.png)           | 1344×768   | 32    | 17 min      |
| [Stable Diffusion XL 1.0 Base](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified/04-stable-diffusion-xl-31e35c80fc48/images/output-0000.png) | 1344×768   | 32    | 15 min 12 s |

Each PNG decoded successfully and visually depicted the requested red teapot on a wooden table beside a window. FP8 Krea and SDXL produced byte-identical PNGs to their earlier successful renders with the same prompt and seed. The loading changes preserved those outputs.

Times include fresh worker startup, loading, transfers, sampling, decoding, and saving. BF16 Krea also built its disk offload cache; FP8 reused its existing cache. Loading and disk-backed inference remain slow on this 32 GB host, and these timings do not establish a consistent speedup.

## Changes

Krea's Basic presets already used eight sampling steps in Python and the interface. Native validation expected ten for Balanced and twelve for Quality, rejecting completed images as inconsistent sampling evidence. Native validation now agrees on eight for Fast, Balanced, and Quality; explicit sampling overrides still take precedence.

Windows Diffusers checkpoint reads and Krea offload-cache reads now use owned per-tensor buffers. This replaces the mapping path implicated in native access violations. Opening the large BF16 Krea checkpoint with safetensors' `pread` backend also produced Windows error 1455 before reading weights: the backend still creates a private whole-file mapping at open. The replacement reader validates the header, shapes, dtypes, offsets, and complete tensor layout without mapping the payload. [Safetensors implementation](https://github.com/huggingface/safetensors/blob/main/bindings/python/src/lib.rs).

Krea transformer weights are deferred until each disk offload group is written. A valid cache can be reused without loading the original transformer into RAM. Profiles that require resident weights, and the native non-Windows disk offloader, receive materialized tensors before offload setup. FP8 values, scale metadata, and LoRA attachment are preserved.

## Verification

| Check                                                                   | Result                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Python worker, tensor reader, loading, conditioning, memory regressions | 107 passed                                                      |
| Basic options, generation, model profiles, compiler                     | 120 passed                                                      |
| Native local Diffusers provider tests                                   | 16 passed                                                       |
| Real worker responses through native sampling validation                | 1 passed, covering all four models and incorrect-step rejection |
| Installed-model inventory, final source hashes, retained image hashes   | Passed, all four models                                         |

Loading tests exercise real Diffusers checkpoint loading and group offload, BF16 and FP8 tensor values, one-block-at-a-time reads, cache reuse, LoRA injection, and malformed headers and shapes. The seven loading-specific tests passed again after making the Windows-hook test explicitly simulate Windows.

The live sweep uses the production worker in a fresh process for each installed text-to-image model: Basic defaults, Quality, 16:9, one PNG, automatic memory profile, seed 41791, and a red-teapot prompt. Requests, responses, logs, images, timings, and source hashes are retained in [the verification directory](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified). [Results](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified/results.json), [artifact audit](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified/artifact-validation.json), and [native validation log](/D:/Models/machdoch/verification/2026-10-10/basic-images-verified/native-sampling-validation.log) all passed.

All four runs used worker `media-diffusers-worker/1.78.0` and the final source hashes. The audit independently reread the installed-model inventory and confirmed complete coverage. Fast and Balanced presets are covered by regression tests; the live sweep uses Quality.

## Replay

From the workspace, select a new output directory:

```powershell
& 'C:\Users\ehrha\AppData\Roaming\com.machdoch.desktop\media-studio\runtime\environment\Scripts\python.exe' -B -Xutf8 -u `
  'apps/client/src-tauri/python/verify_media_basic_images.py' `
  --storage-root 'D:\Models\machdoch' `
  --output-root 'D:\Models\machdoch\verification\2026-10-10\basic-images-replay' `
  --hip-device 1
```

The verifier selects every installed local text-to-image model from the storage database. It checks worker evidence, PNG decoding, dimensions, seed, output count, and nonuniform pixels. Replay native sampling validation with the completed output root:

```powershell
$env:MACHDOCH_BASIC_IMAGE_VERIFICATION = 'D:\Models\machdoch\verification\2026-10-10\basic-images-replay'
node 'apps/client/scripts/run-cargo.mjs' test `
  --manifest-path 'apps/client/src-tauri/Cargo.toml' --lib `
  'external_basic_image_generations_pass_native_sampling_validation' -- --ignored --nocapture
```

Verification uses repository source and the existing managed runtime without downloading models or changing runtime pins. The installed desktop executable has not been rebuilt or replaced; applying these source changes to that installation requires a desktop rebuild. Desktop interaction, persistent-worker model switching, other output formats, image editing, other operating systems, and live generations with add-ons are outside this pass; LoRA attachment is covered by a regression test. This prompt sample is not a broad image-quality evaluation.
