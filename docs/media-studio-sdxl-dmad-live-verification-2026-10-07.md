# SDXL DMAD live verification

October 7, 2026. Both released SDXL DMAD students passed real 1024×1024 PNG generation on the Radeon RX 9070. The production worker and pipeline cache were exercised with the installed models in `D:\Models\machdoch`. The completed verifier records `passed: true` and retains ten images, including the SDXL teacher comparison.

The production worker's JSON protocol also passed a separate one-step render and memory query, retaining an eleventh image that exactly matches the verifier's one-step output.

## Results

| Model | Cold generation | Warm generation | Peak Torch allocation | Peak Torch reservation |
| --- | --- | --- | --- | --- |
| DMAD four-step | 294.453 s | 82.875–203.890 s | 5.337 GiB | 5.885 GiB |
| DMAD one-step | 363.906 s | 41.781–144.188 s | 5.337 GiB | 5.885 GiB |
| SDXL teacher, 24 steps, guidance 5 | 194.250 s | 59.984 s | 5.455 GiB | 5.992 GiB |

Cold measurements include checkpoint validation, loading, transfers, inference, and PNG saving. Warm measurements reuse the production pipeline cache. These observations do not establish a consistent end-to-end speedup. Loading and transfers were slow, and host memory pressure varied substantially during the run. Denoising evaluation counts were reduced successfully, but decoder and offload overhead remain significant on this setup.

Both students passed pixel-identical repeats of the cat prompt with seed 42, a red-teapot prompt with the same seed, and the cat prompt with seed 43. Each prompt or seed change produced a different image. Direct pipeline calls produced exactly the same pixels as production generation and observed these UNet timesteps:

- Four-step: `[999, 749, 499, 249]`.
- One-step: `[399]`.

The direct calls used the same configured pipeline, including its tiled decoder. This checks sampling-recipe agreement; it does not claim pixel equality with an unmodified upstream decoder.

All ten retained images were reopened, decoded, checked as 1024×1024 PNGs, and matched against their recorded pixel SHA-256. Visual inspection found coherent cat and red-teapot images. The teacher also produced a coherent cat and a pixel-identical repeated image. This small prompt sample is not a broad quality evaluation.

[Four-step cat](/D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-tiled/stable-diffusion-xl-dmad-4step-cold/output-0000.png), [one-step cat](/D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-tiled/stable-diffusion-xl-dmad-1step-cold/output-0000.png), [four-step teapot](/D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-tiled/stable-diffusion-xl-dmad-4step-warm-new-prompt/output-0000.png), [one-step teapot](/D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-tiled/stable-diffusion-xl-dmad-1step-warm-new-prompt/output-0000.png), [teacher cat](/D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-tiled/stable-diffusion-xl-cold/output-0000.png).

## Decoder change

The initial four-step render succeeded, but full-frame FP32 VAE decoding caused memory pressure. Its peak Torch allocation was 13,033,847,808 bytes and its reservation was 18,071,158,784 bytes, exceeding the GPU's 17,095,983,104-byte capacity. Windows reported about 6.1 GiB of shared GPU memory and less than 1 GB of free physical RAM. The repeat was stopped, and the first valid image and interruption evidence were preserved.

[The worker](../apps/client/src-tauri/python/media_diffusers_worker.py) now enables overlapping 512-pixel VAE tiles for the SDXL teacher and both SDXL DMAD profiles when ROCm uses native convolutions. The latent tile edge is 64; output dimensions and student sampling remain intact. A regression test decodes a real small-channel VAE at 1024×768 and observes that every decoder input stays within that tile bound.

The rerun reduced student peak allocation to about 5.3 GiB. The largest sampled shared GPU usage was 167.4 MiB. The observed process working-set peak was 12.72 GiB. Host memory still briefly became scarce during the sequential model tests, which limits interpretation of the latency comparison.

The first four-step cat was compared before and after tiling: mean absolute RGB difference was 1.016 on a 0–255 scale, with RMS difference 1.703. Both images appeared coherent without obvious tile seams. Tiling changes pixels, and this comparison covers one image.

## Verification

| Check | Result |
| --- | --- |
| Shared worker and SDXL Python regressions | 85 passed, including the real VAE tile test |
| DMAD attribution and bundled-resource audit | Passed, 1 test |
| Modified Python syntax and Git whitespace check | Passed |
| Both real student checkpoints | Pinned SHA-256 checked by the production loader |
| Student repeatability, prompt changes, seed changes, direct recipe | Passed for both profiles |
| Teacher cold and cached generation | Passed; repeated pixels match |
| Retained PNG integrity | Passed, 10 images |
| Production worker JSON protocol | Passed; 2 JSON responses, matching real one-step PNG, clean exit |

The protocol test invoked `media_diffusers_worker.py serve` with generation and memory request envelopes. It exited with code 0 in 306.801 seconds, returned a 600-second pipeline retention value, and reported `pressure: false` after generation. Its PNG decoded at 1024×1024 and matched the one-step pixel hash `34635d13a376e887ead73daeba9a2c338c905b933f4ad6ae1e836be6c64a7e01`. This exercises the worker protocol without starting a development server.

The existing model package and pinned revisions were reused without downloads or training. The managed runtime uses Torch `2.12.0+rocm7.14.0`, Diffusers `0.41.0.dev0`, and Transformers `5.17.0`. The models and licence provenance are documented in the [October 6 report](media-studio-sdxl-dmad-verification-2026-10-06.md).

## Evidence and replay

Evidence is retained in `D:\Models\machdoch\verification\2026-10-07`:

- `sdxl-dmad-tiled/results.json` and `artifact-validation.json`: complete requests, responses, timings, hashes, timesteps, and artifact checks.
- `sdxl-dmad-tiled.log`, `sdxl-dmad-tiled-regression.log`, and `sdxl-dmad-attribution.log`: live and regression logs.
- `sdxl-dmad-tiled-memory.jsonl` and `sdxl-dmad-tiled-memory-summary.json`: Windows memory observations.
- `sdxl-dmad-tiled-provenance.json`: source hashes and runtime selection.
- `sdxl-dmad-live`: the first full-frame image and interrupted verification record.
- `sdxl-vae-tiling-comparison.json`: full-frame versus tiled pixel differences.
- `sdxl-dmad-transport`: request and response JSON lines, worker diagnostics, execution timing, matching PNG, and `verification.json` with `passed: true`.

Run from the workspace with a new output directory:

```powershell
$env:HIP_VISIBLE_DEVICES = '1'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
& 'D:\Models\machdoch\runtime\environment\Scripts\python.exe' -B -u `
  'apps/client/src-tauri/python/verify_media_sdxl_runtime.py' `
  --model-root 'D:\Models\machdoch\models\verification\sdxl-dmad' `
  --output-root 'D:\Models\machdoch\verification\2026-10-07\sdxl-dmad-replay' `
  --baseline `
  --teacher-checkpoint 'D:\Models\machdoch\models\verification\sdxl-base-1.0\462165984030d82259a11f4367a4eed129e94a7b\checkpoint.safetensors' `
  --teacher-config 'D:\Models\machdoch\models\verification\sdxl-base-1.0\462165984030d82259a11f4367a4eed129e94a7b\config'
```

Verification uses the repository worker source in the managed runtime. Desktop interaction, native controller execution, fleet dispatch, installer behavior, cancellation during inference, other output formats, and other model families were not exercised by this pass.
