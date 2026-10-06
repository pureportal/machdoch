# Media Studio model support

The canonical profile file contains 37 models, including AudioLDM 2. Profiles describe exact pipelines and sampling contracts. Installed models with an available runtime can be selected directly; loading and generation errors are reported when a request executes. Catalog coverage does not establish measured inference coverage.

| Models                                                                                                               | Acquisition                                                |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Z-Image Turbo / Base; Qwen-Image / 2512 / Edit-2511; SANA / Sprint; GLM-Image                                        | Managed downloads with pinned revisions and SHA-256 checks |
| Wan 2.2 T2V-A14B / I2V-A14B; Wan 2.1 T2V 1.3B; HunyuanVideo 1.5 T2V; CogVideoX 2B / 1.5 T2V / 1.5 I2V; Mochi; Helios | Managed downloads with pinned revisions and SHA-256 checks |
| FLUX.1 schnell / dev; FLUX.2 klein Base 4B / distilled 9B / Base 9B / dev; Krea 2 Raw; HiDream Full; Ideogram 4 NF4  | Import a complete Diffusers folder                         |
| LTX-2.5 distilled; LTX-2.3 dev; Sulphur 2 dev; Stable Video Diffusion XT                                             | Import a complete Diffusers folder                         |
| AudioLDM 2                                                                                                           | Managed download or native Diffusers folder import         |

Existing MiniMax H3, Qwen-Image 2.1, Krea Turbo, FLUX.2 klein 4B, LTX-Video 0.9.8, FramePack, HunyuanVideo I2V, and Stable Diffusion paths remain part of the current catalog.

## Generation and library changes

- Native text-to-video no longer needs synthetic first and last image assets.
- Saved video workflows use the new profiles' sampling and input contracts; source-free video steps publish without image lineage.
- Image-to-video accepts an opening image; distinct closing images are checked against the chosen model's capabilities.
- LTX-2 audio is muxed into WebM and both tracks are decoded for verification.
- AudioLDM 2 produces standalone mono 16 kHz PCM WAV files. Basic and Advanced expose prompt, duration, negative prompt, steps, guidance, and seed. Connected Advanced workflows can generate audio alongside image/video steps.
- Advanced can import WAV audio and WebM video, join up to eight ordered scenes, preserve scene audio, or replace the soundtrack with a supplied audio asset and start offset. MuseTalk 1.5 applies lip sync using separate vocals and soundtrack inputs.
- Turbo and base variants use different steps and guidance. Frame counts and dimensions follow the selected pipeline.
- The Models tab includes uninstalled models with download or import actions. Downloads show size, progress, cancellation, and errors, and reconnect when their dialog is reopened.
- Model folders are inspected, copied, hashed, and registered. Missing shards, invalid weights, executable repository files, and symlinks are rejected.
- Slideshow is in the library toolbar and follows the current filters and sort order, with keyboard navigation and play/pause.

## Package requirements and outstanding runtimes

Folder import uses native Diffusers components and safetensors weights. Original single-file LTX/Sulphur or Krea Raw distributions need conversion and all companion components before import. HiDream Full needs its additional Llama encoder. Gated repositories must be obtained with the user's Hugging Face access outside this downloader; access tokens are not implemented here.

LongCat-Video, SkyReels V3, HunyuanImage 3.0, and Open-Sora are **not integrated**. The pinned runtime does not provide their native pipeline classes, and their upstream implementations require separate runtime/dependency and checkpoint conversion work. They are not advertised as executable models.

Only the modes listed by each profile are implemented. This change does not add MiniMax FL2VA, Wan Animate/S2V/VACE, quantized import formats, or every family derivative.

Audio generation coverage remains limited to AudioLDM 2. The [audio research](media-studio-audio-research-2026-10-05.md) identifies ACE-Step 1.5, Stable Audio Open, and MiniMax Speech/Music as unintegrated publisher routes. MuseTalk provides supplied-vocal lip sync, not song generation.

## Earlier profile implementation checks

- 571 Media Studio tests passed; TypeScript checks, lint, and desktop/fleet Media Studio production builds passed.
- 348 native Rust media tests passed with two test threads; 12 tests requiring external services, fixtures, or runtime installation were ignored. Normal Rust library and test compilation checks passed using the project's native build helper. A parallel run hit the existing one-second cancellation assertion at 1.041 seconds.
- 128 Python adapter/worker tests passed, with one skip. This includes 13 new adapter tests and a synthetic waveform/VP9 mux test that decodes both tracks.
- Two existing Wan tests could not import Diffusers in the command-line Python environment. That environment also reports an existing Torch/NumPy version mismatch.

The distilled LTX-2.5 adapter uses the explicit sigma schedule and unguided settings from the [official inference recipe](https://huggingface.co/Lightricks/LTX-2.5-Diffusers/blob/main/README.md). Pipeline call arguments were compared with the pinned Diffusers source for all 30 profiles.

The figures above describe earlier profile implementation checks. The [2026-10-03 verification report](media-studio-verification-2026-10-03.md) records subsequent SDXL/LoRA, Krea, CogVideoX, IntroSVG, and AudioLDM 2 requests, Codex, Playwright, and remaining gaps. IntroSVG produced a document but failed visual quality; audio evidence is scoped to the tested recipe. Manual model verification is no longer required. Full interactive inference coverage remains incomplete.

The [Basic assistant continuation](media-studio-basic-assistant-verification-2026-10-04.md) adds Codex field filling to all four Basic forms and records native SDXL generation and AudioLDM 2 folder import. That importer recognizes the native `audioldm2` projection/UNet components and requires vocoder weights; it continues to reject arbitrary repository classes.

Of the 31 exact profiles in `open_media_models.json`, recorded real inference covers CogVideoX 2B through the worker and AudioLDM 2 through worker and desktop requests. The other 29 profiles lack real execution evidence in these reports. Krea 2 RAW is among those 29: the measured Krea checkpoint was the separate scaled-FP8 Turbo path. SDXL and IntroSVG also live outside that profile file. Their successful requests do not establish execution of other profiles or variants. IntroSVG's completed document failed visual quality, and SDXL's image composition and cold speed remain deficient.

The [October 5 scene continuation](media-studio-verification-2026-10-05.md) verifies native scene composition and soundtrack playback using actual earlier outputs and Codex 6.1 Sol. The subsequent [startup continuation](media-studio-startup-verification-2026-10-05.md) records fresh LTX inference after runtime and sampling fixes; motion quality and speed remain deficient. The [SVG and lip-sync continuation](media-studio-svg-lipsync-verification-2026-10-05.md) records a real Codex-created native MuseTalk graph, a generated human-face clip, original-byte export, and bundled desktop playback. Teeth softness, limited mouth variation, and cold latency remain; singing and perceptual synchronization are unverified.

The canonical profiles are in `apps/client/src-tauri/python/open_media_models.json`; managed file manifests are in `apps/client/src-tauri/src/media/open_model_manifests.json`.

## Training

The Train view provides LoRA, denoiser finetuning, and input-vector embeddings for SD1/2, SDXL/Pony, SD3, FLUX.1, four FLUX.2 Klein variants, SANA, Z-Image Base/Turbo, and CogVideoX 2B / 1.5 T2V / 1.5 I2V. Krea 2 RAW has a separate LoRA route. Basic selects the base, method, and dataset; Advanced exposes optimizer, precision, batching, scheduling, target layers, aspect buckets, and checkpoints.

Full-size SD1, SDXL, Pony, and SANA have recorded training and artifact reuse. Publisher FLUX.2 Klein Base 4B and Z-Image Base LoRAs trained, passed native import, and generated inspected images. Reduced-model checks cover additional variants and methods. These checks do not establish learned-concept quality or faster generation. The audited 52 generation architecture identifiers include 20 with training routes, counting the Krea RAW alias; 32 still lack trainers. See the [training verification](media-studio-training-verification-2026-10-06.md), [FLUX.2 continuation](media-studio-flux2-training-verification-2026-10-06.md), [CogVideoX continuation](media-studio-cogvideo-training-verification-2026-10-06.md), and [complete coverage inventory](validation/training-flux2/coverage.json).
