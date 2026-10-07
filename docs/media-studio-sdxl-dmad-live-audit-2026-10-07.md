# SDXL DMAD live audit

October 7, 2026. Both SDXL DMAD students passed live generation through the production image worker using `D:\Models\machdoch\models\verification\sdxl-dmad`. The independent artifact audit passed for all eight saved 1024 × 1024 PNGs. The combined live harness also completed its two SDXL base generations and recorded `passed: true`. This closes the student-rendering gap recorded in the [October 6 verification](media-studio-sdxl-dmad-verification-2026-10-06.md).

The runtime used the Radeon RX 9070, Torch `2.12.0+rocm7.14.0`, Diffusers `0.41.0.dev0`, and Transformers `5.17.0`. `HIP_VISIBLE_DEVICES=1` selected the discrete GPU, and Hugging Face and Transformers offline mode prevented model downloads during inference. Both student files retain the pinned revision and checkpoint identities in [the model profiles](../apps/client/src-tauri/python/open_media_models.json).

| Live check | Four-step student | One-step student |
| --- | --- | --- |
| Saved 1024 × 1024 PNGs | 4 valid images | 4 valid images |
| Repeated prompt and seed | Identical pixels | Identical pixels |
| Changed prompt, unchanged seed | Different image | Different image |
| Changed seed, unchanged prompt | Different image | Different image |
| Direct recipe pixel agreement | Exact | Exact |
| Observed UNet timesteps | `[999, 749, 499, 249]` | `[399]` |
| Guidance | 0 | 0 |
| Peak allocated GPU memory | 5,730,349,568 bytes | 5,730,087,424 bytes |
| Peak reserved GPU memory | 6,318,718,976 bytes | 6,318,718,976 bytes |

The audit independently reopened each PNG, verified its format and dimensions, recomputed its pixel and file SHA-256 hashes, and checked its request, response, seed, profile identity, decoder mode, and direct-recipe evidence. Cat and red-teapot samples from both students were visually inspected. The one-step teapot has a thin stray curved detail near its handle; these samples establish usable rendering, not broad image quality.

The working tree enables overlapping 512-pixel VAE tiles for SDXL and its DMAD students when this ROCm device uses native convolution. The earlier full-frame four-step image reached 13,033,847,808 allocated GPU bytes, and its following run was interrupted during decoding under memory pressure. Tiled decoding reduced the measured student peaks to approximately 5.34 GiB. A regression exercises actual Diffusers VAE decoding and checks that decoder inputs stay within 64 × 64 latent pixels. The verifier now tests prompt and seed changes separately and checks output dimensions.

All 20 spectral convolutions in the real four-step checkpoint independently matched the retained publisher conversion function exactly after FP16 conversion. The Python worker/student regressions passed 85 tests, the profile and sampling-control suite passed 46 tests, and the DMAD licensing/resource audit passed one test.

Evidence is retained under `D:\Models\machdoch\verification\2026-10-07`:

- [Student artifact audit](D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-independent-completed-audit.json): passed, eight images, file and pixel hashes, timings, memory, and recipe checks.
- [Live run and images](D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-tiled/results.json): production requests and responses; the combined harness also runs a separate SDXL base comparison.
- [Real spectral-weight audit](D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-independent-spectral-audit.json).
- [Python regression log](D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-tiled-regression.log) and [profile test log](D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-independent-profile-tests.log).
- [Native import rerun result](D:/Models/machdoch/verification/2026-10-07/sdxl-dmad-independent-native-import-result.json).

The fresh native import test could not execute: the desktop test binary failed to link with unresolved Whisper/ggml and `OrtGetApiBase` symbols. The earlier native import success was inspected but is not a fresh result. Desktop interaction, worker transport, fleet execution, installer behavior, cancellation during student inference, other devices, and other resolutions remain unverified in this audit. Generation ran alongside background native builds, so the recorded timings are observations rather than an isolated performance benchmark.
