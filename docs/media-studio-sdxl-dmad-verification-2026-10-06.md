# SDXL DMAD verification

October 6, 2026. The SDXL one-step and four-step integrations are implemented. Both real student checkpoints passed native package review. The attempts recorded below were interrupted by concurrent training and produced no verified render. Both students subsequently passed real image generation, determinism, and sampling checks; see the [October 7 live verification](media-studio-sdxl-dmad-live-verification-2026-10-07.md) for current results and the VAE memory fix.

## Implementation

The two SDXL DMAD profiles use the released full UNets, the SDXL base 1.0 text encoders and VAE, and `LCMScheduler`. Four-step sampling uses `[999, 749, 499, 249]`; one-step sampling uses `[399]`. Both fix guidance to zero and accept text prompts. The model selector and sampling controls use those profile settings. Unsupported conditioning, add-ons, negative prompts, and sampling overrides fail validation.

The worker replaces the teacher UNet directly. The prepared package therefore needs the base `unet/config.json`, but not duplicate teacher UNet weights. Folder import accepts the published `.bin` students only at their known paths with the exact pinned size and SHA-256; arbitrary binary checkpoints remain rejected. Both worker modules are included in the desktop bundle resources.

Live loading found two errors that mocked loading had missed. The four-step download still contains 20 spectral-normalized convolutions, despite the model card describing folded weights. The loader now folds those parameters using the publisher's first-forward power iteration and gain calculation, in FP32 before returning to the checkpoint dtype. The first conversion used inference tensors, which PyTorch refused to assign to the meta UNet; conversion now uses ordinary tensors under `no_grad`. Regression coverage performs actual parameter assignment.

The sampling recipe is from the [pinned DMAD model card](https://huggingface.co/ZhengmingYu/DMAD/blob/b1fa1f8745fd6563bf922e6be4b4b03125aaabdd/README.md). Export behavior was checked against the publisher's [SDXL evaluation source](https://github.com/Yzmblog/DMAD/blob/83df6746cfa1c5ee4f67e0bacfef7a8611e6b0f3/train/image/main/sdxl/eval_sdxl.py). Image-training source was inspected separately and is not bundled with the worker. The students retain the [SDXL CreativeML Open RAIL++-M terms](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/462165984030d82259a11f4367a4eed129e94a7b/LICENSE.md), with attribution in `THIRD_PARTY_NOTICES.md`.

## Local models

Prepared folder: `D:\Models\machdoch\models\verification\sdxl-dmad`.

| Component | Identity |
| --- | --- |
| SDXL base 1.0 | Revision `462165984030d82259a11f4367a4eed129e94a7b`; official single-file checkpoint, 6,938,078,334 bytes |
| DMAD students | Revision `b1fa1f8745fd6563bf922e6be4b4b03125aaabdd`; 5,135,837,515 bytes each |
| Four-step file | `distillation/dmad_sdxl_4step_unet_fp16.bin` |
| One-step file | `distillation/dmad_sdxl_1step_unet_fp16.bin` |

The teacher SHA-256 matches its published identity: `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`. Both student SHA-256 values are pinned in [the model profiles](../apps/client/src-tauri/python/open_media_models.json). The complete prepared folder is 12,081,847,817 bytes and contains both students, base components, the SDXL licence, and the publisher's model card. Import this folder through Models and choose the matching SDXL DMAD architecture. This verification did not modify the application's model database.

## Verification

| Check | Result |
| --- | --- |
| Final SDXL, H3, and shared Python regressions | 40 passed, including spectral conversion and meta-parameter assignment |
| Profile/compiler and sampling-control tests | 30 passed |
| Media Studio type checking and linting | Passed |
| Native package-import tests | 20 passed; 2 live tests ignored in the ordinary run |
| Explicit live native package review | Passed for both actual students and the prepared base folder |
| DMAD attribution/resource audit | Passed |
| Real four-step worker loading | Passed strict UNet assignment and complete pipeline loading; entered prompt encoding and GPU transfer |
| Rendered student images, determinism, exact live timesteps, and speed | Not verified |

The installed runtime uses Torch `2.12.0+rocm7.14.0`, Diffusers `0.41.0.dev0`, and Transformers `5.17.0`. The accelerator is the Radeon RX 9070 with 17,095,983,104 bytes of memory; the host has 32,830,408 KiB of usable RAM. Tests isolate the discrete adapter with `HIP_VISIBLE_DEVICES=1` before Torch imports and run model loading offline.

During the final attempt, Windows reported 8,669,863,936 bytes of dedicated GPU memory plus 5,003,710,464 bytes of shared memory for a separate SDXL training process. The verification process itself had reached 5,411,880,960 bytes dedicated GPU memory. The host had only 458,288 KiB of free physical RAM and 1,085,288 KiB of free virtual memory. Checkpoint hashing and GPU transfer were consequently very slow. These measurements show contention, not the model's standalone capacity or performance. After stopping only the verification process, free physical RAM recovered to 3,973,264 KiB.

Logs are retained under `D:\Models\machdoch\verification\2026-10-06`: `sdxl-dmad-regression-final.log`, `sdxl-dmad-assignment-tests.log`, `sdxl-dmad-native.log`, `sdxl-dmad-native-live.log`, and `sdxl-dmad-final.log`. `sdxl-dmad-blocked.json` records the interruption and memory observations. Earlier failed-load logs are retained separately.

## Recovery attempt

The retry preserved the existing integration, model packages, and earlier test results. The previous logs and output folders contained no successful student render to resume. The explicit native live test had already reviewed both students and the complete 12,081,847,817-byte folder; it was not repeated.

At preflight, Torch reported 16,937,648,128 free GPU bytes and Windows reported 15,087,196 KiB of free physical RAM. The offline 1024×1024 verifier started at 11:49 local time. While it checked the four-step student's identity, the existing training sequence began its final Pony model. At 11:57:56, Windows reported only 517,692 KiB of free virtual memory and 4,523,084 KiB of free physical RAM. Only the verifier's identified process was stopped, at 11:58:26; the training process was left running. No checkpoint downloads, base conversion, or model imports were repeated.

The training process still held 14,018,162,688 dedicated GPU bytes and 664,178,688 shared GPU bytes at 12:04:27, with both training steps completed but checkpoint saving still in progress. Windows then reported 6,382,256 KiB of free physical RAM and 7,739,028 KiB of free virtual memory. A standalone student benchmark could not be run under these conditions. These observations do not establish the student's standalone memory requirement.

Retry evidence is retained in `D:\Models\machdoch\verification\2026-10-06\sdxl-dmad-retry-20261006-1150.log` and `sdxl-dmad-retry-interruption.json`. The retry output directory contains no rendered image.

The verifier now writes `passed: false` before inference and preserves the error if a worker call fails. It also accepts an empty `--architectures` list with `--baseline` so the teacher benchmark can run separately, and rejects an entirely empty selection. The following checks were run during recovery; the earlier Python, UI, and native test counts above were inspected, not rerun.

| Recovery check | Result |
| --- | --- |
| DMAD attribution/resource audit | Passed, 1 test |
| Verifier syntax | Passed |
| Empty model selection | Rejected with the expected exit code 2 |
| Injected worker failure without GPU use | Failure propagated, `passed: false` and error retained, cache cleanup performed |
| Live student rendering | Interrupted during checkpoint identity verification; 0 images |

## Live rerun

[verify_media_sdxl_runtime.py](../apps/client/src-tauri/python/verify_media_sdxl_runtime.py) exercises production `generate` and its pipeline cache at 1024×1024. It checks repeated-seed pixels, a changed prompt and seed, and direct recipe agreement while observing actual UNet timesteps. It can also render the original SDXL teacher at 24 steps. Results and images are written to a new output folder; a completed run records `passed: true` in `results.json`.

Run from the workspace with the managed Python after GPU and host memory are free:

```powershell
$env:HIP_VISIBLE_DEVICES = '1'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
& 'D:\Models\machdoch\runtime\environment\Scripts\python.exe' -B -u `
  'apps/client/src-tauri/python/verify_media_sdxl_runtime.py' `
  --model-root 'D:\Models\machdoch\models\verification\sdxl-dmad' `
  --output-root 'D:\Models\machdoch\verification\2026-10-06\sdxl-dmad-rerun'
```

Desktop interaction, worker transport, fleet execution, installer behavior, cancellation during real student inference, other model families, and broad quality evaluation remain unverified by this SDXL pass.
