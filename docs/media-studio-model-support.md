# Media Studio model support

The canonical profile file contains 31 models, including AudioLDM 2. Profiles describe exact pipelines and sampling contracts. Installed models with an available runtime can be selected directly; loading and generation errors are reported when a request executes. Catalog coverage does not establish measured inference coverage.

| Models                                                                                                               | Acquisition                                                |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Z-Image Turbo / Base; Qwen-Image / 2512 / Edit-2511; SANA / Sprint; GLM-Image                                        | Managed downloads with pinned revisions and SHA-256 checks |
| Wan 2.2 T2V-A14B / I2V-A14B; Wan 2.1 T2V 1.3B; HunyuanVideo 1.5 T2V; CogVideoX 2B / 1.5 T2V / 1.5 I2V; Mochi; Helios | Managed downloads with pinned revisions and SHA-256 checks |
| FLUX.1 schnell / dev; FLUX.2 klein Base 4B / distilled 9B / Base 9B / dev; Krea 2 Raw; HiDream Full; Ideogram 4 NF4  | Import a complete Diffusers folder                         |
| LTX-2.5 distilled; LTX-2.3 dev; Sulphur 2 dev; Stable Video Diffusion XT                                             | Import a complete Diffusers folder                         |
| AudioLDM 2                                                                                                         | Managed download with pinned revision and SHA-256 checks   |

Existing MiniMax H3, Qwen-Image 2.1, Krea Turbo, FLUX.2 klein 4B, LTX-Video 0.9.8, FramePack, HunyuanVideo I2V, and Stable Diffusion paths remain part of the current catalog.

## Generation and library changes

- Native text-to-video no longer needs synthetic first and last image assets.
- Saved video workflows use the new profiles' sampling and input contracts; source-free video steps publish without image lineage.
- Image-to-video accepts an opening image; distinct closing images are checked against the chosen model's capabilities.
- LTX-2 audio is muxed into WebM and both tracks are decoded for verification.
- AudioLDM 2 produces standalone mono 16 kHz PCM WAV files. Basic and Advanced expose prompt, duration, negative prompt, steps, guidance, and seed. Advanced currently accepts one prompt, one audio generator, and one audio output; mixed audio/video graphs are rejected.
- Turbo and base variants use different steps and guidance. Frame counts and dimensions follow the selected pipeline.
- The Models tab includes uninstalled models with download or import actions. Downloads show size, progress, cancellation, and errors, and reconnect when their dialog is reopened.
- Model folders are inspected, copied, hashed, and registered. Missing shards, invalid weights, executable repository files, and symlinks are rejected.
- Slideshow is in the library toolbar and follows the current filters and sort order, with keyboard navigation and play/pause.

## Package requirements and outstanding runtimes

Folder import uses native Diffusers components and safetensors weights. Original single-file LTX/Sulphur or Krea Raw distributions need conversion and all companion components before import. HiDream Full needs its additional Llama encoder. Gated repositories must be obtained with the user's Hugging Face access outside this downloader; access tokens are not implemented here.

LongCat-Video, SkyReels V3, HunyuanImage 3.0, and Open-Sora are **not integrated**. The pinned runtime does not provide their native pipeline classes, and their upstream implementations require separate runtime/dependency and checkpoint conversion work. They are not advertised as executable models.

Only the modes listed by each profile are implemented. This change does not add MiniMax FL2VA, Wan Animate/S2V/VACE, quantized import formats, or every family derivative.

## Earlier profile implementation checks

- 571 Media Studio tests passed; TypeScript checks, lint, and desktop/fleet Media Studio production builds passed.
- 348 native Rust media tests passed with two test threads; 12 tests requiring external services, fixtures, or runtime installation were ignored. Normal Rust library and test compilation checks passed using the project's native build helper. A parallel run hit the existing one-second cancellation assertion at 1.041 seconds.
- 128 Python adapter/worker tests passed, with one skip. This includes 13 new adapter tests and a synthetic waveform/VP9 mux test that decodes both tracks.
- Two existing Wan tests could not import Diffusers in the command-line Python environment. That environment also reports an existing Torch/NumPy version mismatch.

The distilled LTX-2.5 adapter uses the explicit sigma schedule and unguided settings from the [official inference recipe](https://huggingface.co/Lightricks/LTX-2.5-Diffusers/blob/main/README.md). Pipeline call arguments were compared with the pinned Diffusers source for all 30 profiles.

The figures above describe earlier profile implementation checks. The [2026-10-03 verification report](media-studio-verification-2026-10-03.md) records subsequent SDXL/LoRA, Krea, CogVideoX, IntroSVG, and AudioLDM 2 requests, Codex, Playwright, and remaining gaps. IntroSVG produced a document but failed visual quality; audio evidence is scoped to the tested recipe. Manual model verification is no longer required. Full interactive inference coverage remains incomplete.

The canonical profiles are in `apps/client/src-tauri/python/open_media_models.json`; managed file manifests are in `apps/client/src-tauri/src/media/open_model_manifests.json`.

## Training

The Train view now exposes installed SDXL checkpoints and complete Krea 2 RAW folders through one local LoRA job API. SDXL has completed an eight-step GPU smoke job, native addon import, and actual Basic generation with the learned adapter. That short run does not establish custom-concept quality. Krea RAW has integration checks but no real training completion; full-weight finetuning and other families' training are not implemented. See [training routes](media-studio-training-research-2026-10-04.md) and the [continuation report](media-studio-verification-2026-10-04.md).
