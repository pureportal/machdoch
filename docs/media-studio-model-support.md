# Media Studio model support

The catalog now contains 30 additional model profiles. Profiles describe exact pipelines and sampling contracts; a model becomes runnable after its package loads successfully in the pinned offline runtime.

| Models                                                                                                               | Acquisition                                                |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Z-Image Turbo / Base; Qwen-Image / 2512 / Edit-2511; SANA / Sprint; GLM-Image                                        | Managed downloads with pinned revisions and SHA-256 checks |
| Wan 2.2 T2V-A14B / I2V-A14B; Wan 2.1 T2V 1.3B; HunyuanVideo 1.5 T2V; CogVideoX 2B / 1.5 T2V / 1.5 I2V; Mochi; Helios | Managed downloads with pinned revisions and SHA-256 checks |
| FLUX.1 schnell / dev; FLUX.2 klein Base 4B / distilled 9B / Base 9B / dev; Krea 2 Raw; HiDream Full; Ideogram 4 NF4  | Import a complete Diffusers folder                         |
| LTX-2.5 distilled; LTX-2.3 dev; Sulphur 2 dev; Stable Video Diffusion XT                                             | Import a complete Diffusers folder                         |

Existing MiniMax H3, Qwen-Image 2.1, Krea Turbo, FLUX.2 klein 4B, LTX-Video 0.9.8, FramePack, HunyuanVideo I2V, and Stable Diffusion paths remain part of the current catalog.

## Generation and library changes

- Native text-to-video no longer needs synthetic first and last image assets.
- Saved video workflows use the new profiles' sampling and input contracts; source-free video steps publish without image lineage.
- Image-to-video accepts an opening image; distinct closing images are checked against the chosen model's capabilities.
- LTX-2 audio is muxed into WebM and both tracks are decoded for verification.
- Turbo and base variants use different steps and guidance. Frame counts and dimensions follow the selected pipeline.
- The Models tab includes uninstalled models with download or import actions. Downloads show size, progress, cancellation, and errors, and reconnect when their dialog is reopened.
- Model folders are inspected, copied, hashed, and registered. Missing shards, invalid weights, executable repository files, and symlinks are rejected.
- Slideshow is in the library toolbar and follows the current filters and sort order, with keyboard navigation and play/pause.

## Package requirements and outstanding runtimes

Folder import uses native Diffusers components and safetensors weights. Original single-file LTX/Sulphur or Krea Raw distributions need conversion and all companion components before import. HiDream Full needs its additional Llama encoder. Gated repositories must be obtained with the user's Hugging Face access outside this downloader; access tokens are not implemented here.

LongCat-Video, SkyReels V3, HunyuanImage 3.0, and Open-Sora are **not integrated**. The pinned runtime does not provide their native pipeline classes, and their upstream implementations require separate runtime/dependency and checkpoint conversion work. They are not advertised as executable models.

Only the modes listed by each profile are implemented. This change does not add MiniMax FL2VA, Wan Animate/S2V/VACE, quantized import formats, or every family derivative.

## Verification

- 571 Media Studio tests passed; TypeScript checks, lint, and desktop/fleet Media Studio production builds passed.
- 348 native Rust media tests passed with two test threads; 12 tests requiring external services, fixtures, or runtime installation were ignored. Normal Rust library and test compilation checks passed using the project's native build helper. A parallel run hit the existing one-second cancellation assertion at 1.041 seconds.
- 128 Python adapter/worker tests passed, with one skip. This includes 13 new adapter tests and a synthetic waveform/VP9 mux test that decodes both tracks.
- Two existing Wan tests could not import Diffusers in the command-line Python environment. That environment also reports an existing Torch/NumPy version mismatch.

The distilled LTX-2.5 adapter uses the explicit sigma schedule and unguided settings from the [official inference recipe](https://huggingface.co/Lightricks/LTX-2.5-Diffusers/blob/main/README.md). Pipeline call arguments were compared with the pinned Diffusers source for all 30 profiles.

Full GPU inference, model loading with real weights, memory limits, quality, and performance have not been measured. No model weights were downloaded. Models remain unavailable for generation until their local runtime probe succeeds.

UI changes were checked through component tests and production builds; the desktop application was not launched for an interactive check.

The canonical profiles are in `apps/client/src-tauri/python/open_media_models.json`; managed file manifests are in `apps/client/src-tauri/src/media/open_model_manifests.json`.
