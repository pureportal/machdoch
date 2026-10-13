# Image engine verification — 2026-10-13

The full image-quality goal remains incomplete. The earlier implementation and UI checks passed; several outputs still miss the reference aesthetic, and SD3.5 Large Turbo weights have not been acquired. This report records local findings for the changes included in 30.5.0.

Nine profiles were added: Anima, Illustrious XL, NoobAI XL, Juggernaut XL, RealVisXL, DreamShaper XL, SDXL Turbo, SD-Turbo and SD3.5 Large Turbo. The SDXL derivatives share the current loader and adapter capabilities. Anima has a dedicated modular loader with validated local components. SD-Turbo has pinned publisher components; both SD Turbo recipes preserve trailing timesteps and zero guidance. HiDream gained a loader that stages quantized components on CPU before loading the next component, avoiding simultaneous GPU allocation of its transformer and encoders.

Basic and Advanced mark compatible recommended samplers. Highlighted steps/guidance ranges and warning icons cover 40 sampling profiles. Illustrious follows its published 20–28 steps and CFG 5–7.5; NoobAI targets Epsilon 1.0; RealVis targets V5.0; DreamShaper's acquired checkpoint is Alpha 2. Juggernaut XI was reclassified through a full native import and uses XI's pinned recipe and licence. HiDream recommends published UniPC flow sampling; optional Flow Euler retains the publisher's shift of 3. Practical ranges do not guarantee a perfect image.

Worker 1.99.0 reuses loaded weights across canvas changes with the same VAE decode budget and across sampler changes. A change across the tiling boundary still reloads the pipeline. Cache tests verify distinct prompts, seeds, output dimensions, scheduler changes and boundary invalidation.

Worker 1.100.0 additionally budgets streamed group offloading against twice the pipeline's weight size, following [Diffusers' memory guidance](https://github.com/huggingface/diffusers/blob/main/docs/source/en/optimization/memory.md). The observed FLUX run exhausted nearly all physical RAM and slowed warm renders to six–fifteen minutes. The new policy passes 150 Python checks, including shared-weight accounting and the 32/64 GB boundary. Its effect on real large-model renders remains pending. The isolated desktop's Python resource has been updated to the same source hash; its compiled frontend and Rust code are unchanged.

Worker 1.101.0 loads FLUX.1 Dev and Schnell transformer and T5 components with NF4 quantization and offloads them as complete models. Full image-quality verification of that final worker change remains pending.

| Engine               | Remaining verification or refinement                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| SDXL                 | Six current renders complete; street is near-reference, five subjects need refinement                  |
| Illustrious XL       | Twelve renders inspected; tag retries improve subjects but remain below reference                      |
| Anima                | Refine collage, horror, photo framing and color                                                        |
| Pony                 | Six current renders below reference; concise prompts and compatible style LoRA queued                  |
| Stable Diffusion 1.5 | Six base renders below reference; DreamShaper 8 follow-ups queued                                      |
| Z-Image Turbo        | Current regression reproduces accepted PNG; six prior subjects have quality evidence                   |
| FLUX.1               | Complete current comparisons                                                                           |
| Krea 2               | Complete current comparisons and RAW follow-ups                                                        |
| Krea 2 Turbo         | Current regression; six prior subjects have quality evidence                                           |
| Z-Image              | Complete current comparisons                                                                           |
| NoobAI XL            | Twelve renders inspected; tag retries improve subjects but remain below reference                      |
| Juggernaut XL        | Six XI comparisons queued                                                                              |
| FLUX.2               | Current Klein 4B comparisons; three unsupported-negative cases queued for correction                   |
| SDXL Turbo           | Refine four subjects; street and swimwear assessed near-reference                                      |
| Qwen-Image 2.1       | Remaining quality/composition comparisons                                                              |
| Qwen-Image 2.1 Turbo | Current portrait assessed near-reference; six prior subjects have quality evidence                     |
| RealVisXL            | Refine four subjects; street and swimwear assessed near-reference                                      |
| DreamShaper XL       | Refine four subjects; street and swimwear assessed near-reference                                      |
| FLUX.1 Schnell       | Six renders reviewed; ruins, street and horror near-reference; three subjects need refinement          |
| Qwen-Image           | Complete current comparisons                                                                           |
| Stable Diffusion 3.5 | Complete current comparisons; Nekofantasia's adaptive recipe is not implemented                        |
| SD3.5 Large Turbo    | Official package returns HTTP 401; searched Civitai distributions do not supply verified Turbo weights |
| HiDream-I1           | Native NF4 import passed; full-model execution and quality comparisons queued                          |
| SD-Turbo             | First six renders below reference; exact 512-square canvases and concise prompts queued                |

Earlier verification: 813 Media Studio tests and 150 Python tests passed, with type checking, static and licensing checks. Native folder-import tests passed 30 checks; nine full-size import checks passed, including Juggernaut reclassification and HiDream. [Playwright results](validation/image-engines/ui-2026-10-13-recipe-final/playwright-results.json) cover all 40 sampling profiles, recommendations, ranges, warning clearing, Basic-to-Advanced persistence and incompatible-sampler recovery. The compiled worker 1.99.0 desktop passed [native Playwright checks](validation/image-engines/native-ui-2026-10-13-runtime-final/playwright-results.json) against all 30 installed image models through real Tauri IPC, with no page errors. The large external import temporarily locked the database; refresh cleared the error and a page reload hydrated the expanded catalog before the passing check. Actual Basic/Advanced generation checks remain pending. The installed desktop has not been replaced.

All 42 first-pass subjects across the seven newly acquired engines rendered successfully. [Direct visual review](validation/image-engines/research-2026-10-13/first-visual-review.json) now records 83 inspected images, eighteen near-reference judgments and matching file digests, including baseline and tag retries. Technical checks remain separate from visual judgments. Anima approaches the portrait, ruins, street and swimwear references; its collage is faceless and its horror figure is too small. Other missed compositions and anatomical/style defects are recorded individually.

Forty-two historical quality images were checked against their recorded hashes. Z-Image Turbo's current horror regression reproduces the accepted PNG exactly. Qwen Turbo's current portrait differs in hash; visual inspection confirms comparable painterly detail, warm doorway light and reaching-hand perspective. [The 24-engine matrix](validation/image-engines/research-2026-10-13/requested-engine-coverage-current.json) records implementation, installations, technical runs and assessed subjects without claiming complete quality coverage.

Seven missing checkpoints and Anima's encoder/VAE companions were downloaded from Civitai to `D:\Models\machdoch`, hash-verified and imported. HiDream's eighth checkpoint was also downloaded from Civitai and its complete 25.14 GB package passed native import. Its public quantized companions are pinned to szwagros revision `a26dcad3a4f184c3ade9304ee385192c00d655ec` and hash-verified. All 1,615 expected HiDream transformer tensors match the Civitai checkpoint layout; a small NF4 operation passes on the RX 9070. This does not establish successful full-model execution. Model licences, contributor notices and the Llama agreement accompany the package. Anima used the pinned Apache-2.0 Diffusers converter; no GPL ComfyUI source was copied. [Third-party notices](../THIRD_PARTY_NOTICES.md) retain attribution.

The installed-engine manifest contains 85 cases, including focused regressions for the three families with prior complete quality evidence and twelve tag refinements. Separate follow-ups cover Juggernaut, Anima, SD-Turbo, DreamShaper 8, Animagine, corrected Klein conditioning and Pony style conditioning. HiDream has a one-step smoke case and six quality cases. Queued work is not completed evidence. Raw render logs, images and machine-specific acquisition scripts remain local; the coverage matrix and visual-review records retain their findings and image digests.

SD3.5 Large Turbo's official package returns HTTP 401. Its historical Civitai model, version 983611, file-hash lookup and direct download return 404. A public Hugging Face mirror was found, but no checkpoint was downloaded from it because the requested model source is Civitai. [Direct distribution probes](validation/image-engines/research-2026-10-13/sd35-turbo-direct-distribution-probe.json) retain the results.

D: is an external Toshiba USB drive. Startup measurements found file-opening delays; a verified runtime mirror in the workspace cache improves imports while weights remain on D:. Further quality comparisons and resolution of acquisition gaps are required before completion.

Primary recipes: [Anima](https://huggingface.co/circlestone-labs/Anima), [Illustrious](https://huggingface.co/OnomaAIResearch/Illustrious-xl-early-release-v0), [NoobAI](https://huggingface.co/Laxhar/noobai-XL-1.0), [Juggernaut XI](https://huggingface.co/RunDiffusion/Juggernaut-XI-v11), [RealVis V5](https://huggingface.co/SG161222/RealVisXL_V5.0), [DreamShaper](https://huggingface.co/Lykon/dreamshaper-xl-1-0), [SDXL Turbo](https://huggingface.co/docs/diffusers/main/api/pipelines/stable_diffusion/sdxl_turbo), [SD-Turbo](https://huggingface.co/stabilityai/sd-turbo), [HiDream](https://huggingface.co/HiDream-ai/HiDream-I1-Full), [NF4 source](https://github.com/hykilpikonna/HiDream-I1-nf4) and [SD3.5 Large Turbo](https://huggingface.co/stabilityai/stable-diffusion-3.5-large-turbo). Publisher revisions are pinned in the model profiles; raw metadata, component digests, provenance and logs remain in the local evidence directory.
