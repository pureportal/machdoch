# Open image and video models

Research date: 2026-10-02.

Add **Z-Image-Turbo**, **LTX-2.5**, and **Wan 2.2 A14B** first. Add **Qwen-Image-Edit-2511 / Qwen-Image-2512** next where Apache-licensed generation and editing matter. Machdoch already has execution paths for Qwen-Image 2.1, FLUX.2 klein, Krea 2, HunyuanVideo 1.5 I2V, FramePack, and MiniMax H3; these families should not be reported as wholly missing.

This is a support audit and implementation recommendation. No inference code, catalog entries, dependencies, or model installations were changed.

**Scope and evidence**

“Open” here includes downloadable weights with inference code. Permissive releases and releases with non-commercial, revenue, or territory restrictions are identified separately. Public API availability or an announcement alone does not establish local model availability.

Popularity uses Hugging Face's downloads in the last month, sampled from its public model API on the research date, plus official repository and integration evidence. Downloads are activity indicators, not unique users or a quality ranking. Quantizations, adapters, repackaged weights, and different task tags split a family's activity; their counts are not added together. Recommendations combine that evidence with capabilities, licensing, hardware burden, and Machdoch's existing architecture. Priority and implementation effort are judgments, not measured benchmarks.

The source inventory was checked across the Rust catalog, installers, import and discovery profiles, Python loaders and generation functions, and Media Studio's controls. “Supported” below means a concrete code path exists, subject to complete components and model verification. It does not mean every checkpoint in a family has passed inference on every device.

**Current image support**

| Model or architecture | Machdoch support | Material limit |
| --- | --- | --- |
| Stable Diffusion 1.x | Imported checkpoints; generation, editing, masks, references and add-ons | Exact checkpoint and component compatibility still needs verification. |
| Stable Diffusion 2.x | Manual import and a Stable Diffusion pipeline path | Civitai recognizes the family but does not enable checkpoint acquisition for it. |
| SDXL, Pony, Illustrious, NoobAI | SDXL/Pony execution and Civitai checkpoint paths | Compatible fine-tunes use an existing architecture; they do not each require another runtime. |
| Stable Diffusion 3 / 3.5 | Manual import and `StableDiffusion3Pipeline` path | Text-to-image is advertised; Civitai checkpoint acquisition is not enabled. This is not certification of every 3.5 variant. |
| FLUX.1 | Manual import and `FluxPipeline` path; Civitai labels include schnell, dev and Krea | No managed installer for those variants; do not infer Kontext support from the family label. |
| FLUX.2 klein 4B distilled | Managed installer and generation/editing path | All `flux-2` sampling is fixed to four steps. Dev, Base and 9B variants need exact profiles and validation. |
| Krea 2 | Imported single-file weights, shared components, reference conditioning and masks | Sampling defaults to 8–12 steps with fixed guidance, making the path Turbo-focused. Raw has no distinct sampling profile. |
| Qwen-Image 2.1 | Imported transformer plus pinned components; generation, multi-reference editing and native RGBA preservation | Single-file BF16 loading requires at least 48 GiB system RAM. Native masked editing and LoRA capability are not exposed for this architecture. |

The main image evidence is [model_import.rs](../apps/client/src-tauri/src/media/model_import.rs), especially `SUPPORTED_ARCHITECTURES`, `capabilities_for_architecture` and `prepare_model_config`; [civitai_compatibility.rs](../apps/client/src-tauri/src/media/civitai_compatibility.rs), especially `BASE_MODELS` and `supports_resource`; and [media_diffusers_worker.py](../apps/client/src-tauri/python/media_diffusers_worker.py), especially `_load_pipeline`, `_image_sampling`, `probe_model` and `generate`.

**Current video support**

| Exact implementation | Machdoch support | Missing variants or modes |
| --- | --- | --- |
| Wan 2.2 TI2V 5B | Managed package, image/start-end conditioning, local video generation and alpha/compositing delivery | A14B T2V/I2V, Animate, S2V, VACE and other Wan architectures are not covered by this profile. |
| LTX-Video 0.9.8 distilled FP8, 2B and 13B | Discovered packages, conditioned video generation and spatial refinement | LTX-2.x uses different pipelines and components; 0.9.8 support does not cover 2.3 or 2.5. |
| HunyuanVideo 1.5 I2V 8.3B step distilled | Exact pinned package and first-frame generation | Native T2V checkpoints and the rest of the family have no equivalent executable profile. |
| FramePack I2V HY 13B | Exact package discovery and FramePack generation path | This does not establish support for every FramePack variant or every HunyuanVideo checkpoint. |
| MiniMax H3 Ref2VA, pruned INT8 ConvRot + Turbo adapter | Dedicated runtime with one image reference, generated audio, opaque non-looping output, and a 2K refinement option | FL2VA prompt-only/endpoint modes and general multi-image, audio or video reference inputs are not exposed. |

The audited video entry point stages first and last image assets, and the Python worker requires their paths. The catalog advertises `text-to-video` for Wan, but this entry point does not expose native prompt-only generation. A workflow that creates an image before animating it is a separate capability.

Video evidence: [model_discovery.rs](../apps/client/src-tauri/src/media/model_discovery.rs), including exact profiles and rejection of other Wan variants; [provider_local_diffusers.rs](../apps/client/src-tauri/src/media/provider_local_diffusers.rs), including model IDs, `stage_wan_frame` calls and H3 restrictions; [media_diffusers_worker.py](../apps/client/src-tauri/python/media_diffusers_worker.py), including `_generate_minimax_h3_video` and `generate_video`; and [media_minimax_h3.py](../apps/client/src-tauri/python/media_minimax_h3.py), which decodes and muxes audio.

Managed generation downloads currently cover FLUX.2 klein 4B and Wan 2.2 TI2V 5B. Other implemented generation models rely on import or discovery. Generic Diffusers directories can be discovered with an unsupported status; a library knowing a pipeline class does not make it executable in Machdoch. GGUF is not an accepted executable checkpoint format in the audited import/acquisition paths. BiRefNet matting, image-quality utilities, upscalers and SVG models also exist, but are separate from this raster image/video generation comparison.

**Image landscape**

Counts below are per named repository, rounded from the live API sample. Each model link provides its primary model card or official repository.

| Prominent family or release | Monthly downloads sampled | Weights / license | Support decision |
| --- | ---: | --- | --- |
| [SDXL 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) | 4.19M | Open RAIL++ | Already covered through imports. Prioritize easy acquisition of proven checkpoints over another architecture. |
| [FLUX.1 dev](https://huggingface.co/black-forest-labs/FLUX.1-dev) | 710K | Custom non-commercial model license; schnell uses Apache 2.0 | Family path exists. Validate individual variants before advertising them. |
| [Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | 592K | Apache 2.0 | Highest-priority missing image architecture. 6B, eight denoiser evaluations; publisher documents a 16 GB consumer GPU configuration. |
| [FLUX.2 klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) | 401K | Apache 2.0 | Already managed. Other [FLUX.2 variants](https://github.com/black-forest-labs/flux2) need separate profiles; 9B/dev have non-commercial terms. |
| [Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) | 284K | Apache 2.0 | Missing; valuable editing addition with permissive model terms. |
| [Qwen-Image](https://huggingface.co/Qwen/Qwen-Image) / [2512](https://huggingface.co/Qwen/Qwen-Image-2512) | 276K / 47.8K | Apache 2.0 | Missing 20B architecture. Target 2512 for generation; current 2.1 is a different architecture and license. |
| [Krea 2 Turbo](https://huggingface.co/krea/Krea-2-Turbo) / [Raw](https://huggingface.co/krea/Krea-2-Raw) | 86.4K / 81.1K | Krea 2 Community License | Existing Turbo-focused path. Raw needs its own validated sampling contract. |
| [Qwen-Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) | 81.7K | Qwen Research License | Already implemented; default terms allow research/evaluation, with a separate license needed for commercial use. |
| [Z-Image Base](https://huggingface.co/Tongyi-MAI/Z-Image) | 58.1K | Apache 2.0 | Add after Turbo if fine-tuning, negative prompts and diversity are wanted. Edit/Omni releases are still listed as forthcoming in the official model zoo. |
| [HunyuanImage 3.0](https://github.com/Tencent-Hunyuan/HunyuanImage-3.0) | 3.4K for base weights | Tencent custom license | Missing, but defer desktop support. Official base recommendation is at least 3 × 80 GB; Instruct variants recommend 8 × 80 GB. |
| [Ideogram 4 NF4](https://github.com/ideogram-oss/ideogram4) | 2.4K for official NF4 weights | Non-commercial, gated | Consider for typography/design demand after the first additions. Requires structured prompt handling and license-aware acquisition. |
| [HiDream-I1](https://github.com/HiDream-ai/HiDream-I1) | 874 for Full | MIT for model/code; components have their own terms | Missing; lower priority given the 17B model and multiple encoders. |
| [SANA / SANA-Sprint](https://github.com/NVlabs/Sana) | Not a reliable family-wide count | Sprint model: Apache 2.0, plus Gemma encoder terms | Missing; a useful speed/small-model candidate. The [1.6B Sprint card](https://huggingface.co/Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers) documents one-step inference. |
| [GLM-Image](https://huggingface.co/zai-org/GLM-Image) | Not included in the live API sample | MIT, with Apache components | Missing; evaluate later for dense text and knowledge-oriented images. |

Qwen 2.1's commercial constraint is explicit in its [license](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE). That creates a reason to add the distinct Apache-licensed Qwen generation/editing architecture even though a newer Qwen model is already implemented. Ideogram's restrictions are explicit in its [model agreement](https://huggingface.co/ideogram-ai/ideogram-4-nf4/blob/main/LICENSE.md).

**Video landscape**

| Prominent family or release | Popularity evidence | Machdoch decision |
| --- | --- | --- |
| [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) | 3.57M monthly downloads of official repository | Already implemented narrowly. Expand modes only where licensing covers the intended deployments. |
| [Wan 2.2](https://github.com/Wan-Video/Wan2.2) | Comfy-Org repack: 6.32M; official A14B Diffusers T2V/I2V: 136K / 145K | Add A14B profiles first; Apache 2.0. Animate and S2V are separate later additions. |
| [LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) | 1.58M monthly downloads; LTX-2.3: 1.06M | Add current 2.5. Synchronized audio/video and multishot capabilities extend the implemented 0.9.8 family. Community terms permit commercial use below a $10M entity revenue threshold, subject to the full terms. |
| [Wan 2.1](https://github.com/Wan-Video/Wan2.1) | Official 1.3B T2V Diffusers pack: 254K monthly downloads | Recognized older ecosystem. Add a specific low-memory or VACE use case only if it offers value beyond current 5B and proposed A14B support. |
| [HunyuanVideo 1.5](https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5) | Official 1.5 model repository: 1,042 likes; exact packs split downloads | Extend native T2V after the first video additions. Existing I2V support is not blanket family support. |
| [FramePack](https://github.com/lllyasviel/FramePack) | Existing Machdoch runtime and broader Hunyuan ecosystem | Already implemented for the reviewed HY 13B package; validate additional variants only when needed. |
| [CogVideoX / 1.5](https://github.com/zai-org/CogVideo) | Established T2V/I2V ecosystem and Diffusers integration | Missing; lower priority. 2B is Apache 2.0, while 5B weights have separate model terms. |
| [Mochi 1](https://github.com/genmoai/mochi) | 8.7K monthly downloads; 1,360 likes | Missing; defer. Apache 2.0, but the official implementation targets about 60 GB VRAM and 480p output. |
| [LongCat-Video](https://github.com/meituan-longcat/LongCat-Video) | Official repository around 8.5K stars | Missing; evaluate for long-video/continuation or avatar demand. Model weights are MIT licensed. |
| [SkyReels V3](https://github.com/SkyworkAI/SkyReels-V3) | Official multimodal release, following the established V2 family | Missing; evaluate for a specific reference/extension use case before adding another large runtime. |
| [Helios](https://github.com/PKU-YuanGroup/Helios) | Official repository around 2.2K stars | Missing; interesting long-video option with Apache 2.0 terms. Publisher's realtime result is on H100, not a desktop performance guarantee. |
| [Open-Sora](https://github.com/hpcaitech/Open-Sora), [Stable Video Diffusion](https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt) | Established research releases | Missing; no first-wave recommendation given the more directly useful current candidates. |
| [Sulphur 2](https://huggingface.co/SulphurAI/Sulphur-2-base) | 184K monthly downloads | LTX-2.3 derivative, not a separate base architecture. Consider exact checkpoint support only after an LTX-2.x path and license/component review. |

MiniMax's default [community license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) excludes the EU, UK, US and South Korea from its applicable territory. Separate authorization may cover deployments there; none was established by this audit. Existing code or downloadable quantized derivatives do not establish that authorization.

**Recommended implementation order**

| Order | Addition | Useful result | Work required |
| --- | --- | --- | --- |
| 1 — image | Z-Image-Turbo | Popular, fast Apache-licensed local generation | Add a model profile, exact component manifest, importer/discovery support, `ZImagePipeline` generation, correct Turbo sampling, and measured hardware limits. Begin with generation; do not claim unreleased editing variants. |
| 1 — video | LTX-2.5 distilled | Modern local video with audio | Implement the LTX-2 pipelines and separate transformer, text encoder, video/audio VAEs and upscaler components. Validate audio muxing, memory and duration. The [official repository](https://github.com/Lightricks/LTX-2) documents about 66 GiB of downloads for its BF16 starting package; that is disk size, not VRAM. |
| 2 — video | Wan 2.2 I2V-A14B and T2V-A14B | Broader popular Wan coverage and native prompt-only video | Add both expert transformers, scheduler switching and variant-specific VAE/conditioning. Native T2V needs an entry point without mandatory image assets. Official full-precision examples require substantial VRAM; benchmark quantized/offloaded profiles separately. |
| 2 — image | Qwen-Image-Edit-2511 and Qwen-Image-2512 | Apache-licensed editing and generation | Add the distinct 20B generation/editing profiles, manifests and samplers. Current 2.1 components cannot be relabeled to serve these models. |
| 3 | Validated quantization profiles for the selected models | Reach more consumer GPUs | Implement explicit formats and loaders for measured configurations. Upstream GGUF support alone does not enable Machdoch import or execution. |
| 4 | SANA-Sprint; exact FLUX.2 Base/9B and Krea Raw profiles; HunyuanVideo T2V | Speed, customization or mode coverage | Select by user demand and license. FLUX.2 Base/dev and Krea Raw need different sampling from today's distilled paths. |
| Conditional | Ideogram 4; MiniMax H3 FL2VA and multimodal references | Typography or broader audio/video control | Establish applicable model terms, then implement exact components and inputs. H3 generated audio and 2K refinement already exist. |

The pinned [Diffusers export table](https://raw.githubusercontent.com/huggingface/diffusers/4295ee3ec58efa6577bc459e9b84ca3f63aa9a96/src/diffusers/__init__.py) already includes `ZImagePipeline`, `QwenImagePipeline`, `QwenImageEditPlusPipeline`, `Ideogram4Pipeline`, `LTX2Pipeline`, `LTX2ImageToVideoPipeline`, `HiDreamImagePipeline`, `SanaSprintPipeline`, and `GGUFQuantizationConfig`. Several additions can therefore build on the current dependency stack. Export presence does not verify checkpoint loading, the latest LTX-2.5 behavior, quantization, or Machdoch integration; inspect and test those contracts before deciding whether a dependency change is necessary.

**Verification and limits**

Primary model cards, licenses and repositories were checked online, and popularity was sampled through the public Hugging Face API. Local support was traced through import, acquisition, discovery and execution code, including the variant restrictions above. Six focused existing unit checks passed: Qwen component loading and its memory gate, FLUX.2's four-step contract, Krea reference/mask capabilities, mask architecture restrictions, and video dimensions. The additional Wan offline checkpoint test could not load because the command-line Python environment does not have `diffusers` installed; it was not verified by execution.

No model weights were downloaded and no GPU generation or quality/speed comparison was run. Installed models on a user's machine or fleet were not inventoried. Hardware figures from publishers are identified as such; they are not measured Machdoch requirements. API download counts and licensing can change after the research date.
