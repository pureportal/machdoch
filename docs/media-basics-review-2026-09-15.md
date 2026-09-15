# Basics image generator review — 15 September 2026

## Result

Improved the image setup, fixed confirmed submission and input-state bugs, and inspected 11 fresh generated outputs from all four runnable raster image models. One additional FLUX request failed while loading. One completed FLUX output failed the requested color transfer; a same-seed retry at higher edit strength succeeded.

This is representative coverage, not a claim that every model, setting, or combination works.

## Changes

- Ordered the form as Model, Prompt, Base image, Reference images, then More options. Moved the desktop add-on browser into its existing dialog and removed the empty selection text.
- Kept configured inputs when choosing models. Incompatible choices show the required correction instead of silently dropping references or sampling settings. Seed, guidance, memory, reference roles, and source limits follow the selected runtime.
- Added base-image replacement, recoverable missing-image states, duplicate prevention, and one open Assets picker at a time. Failed replacement preserves the previous base and mask.
- Checked import formats and reference counts before attaching inputs. A model or input change during an import keeps the imported asset in Assets and asks the user to choose it again. Corrupt-image errors now provide a useful recovery action.
- Preserved transparency when adding a full base image. Fixed the remote base-only submission guard, preserved supplemental reference roles instead of converting the first reference into a base, and fixed Basic cutout branch preparation and native remote edit snapshots. These bugs had prevented real base/reference/transparent submissions.
- Allowed an inverted mask with no strokes to select the entire image. Undo/redo includes inversion; a completely erased selection blocks generation. Kept mask and transparency mutually exclusive, and restricted masked output to PNG.
- Showed the original output dimensions for masked edits, distinguished edit resolution from output size, preserved custom dimensions when changing quality, and added sampling reset. Prevented a local edit strength that would schedule zero steps.
- Set new masks to edit strength 1.0 after the measured FLUX reference failure at 0.65. Existing masks retain their chosen strength. Mask previews now show loading/retry state, prevent drawing before the image loads, and fit within the viewport without stretching.
- Released the cached subject-cutout session before loading a local image model. This removed approximately 8.3 GB of retained desktop memory before the successful mask retry. The cause of the earlier worker exit remains uncertain.

Existing unrelated workspace changes, including WAN work, were retained.

## Method and environment

Playwright drove the production Media Studio component through the existing Vite service on port 4173. Its commands and events were bridged to the running Tauri desktop on port 9223. Imports, model verification, generation, history, immutable asset storage, previews, and exports used the real desktop backend. No generation fixtures or replacement servers were used. The existing desktop rebuilt automatically after native changes.

Only native file-dialog selection used predetermined local paths. Two race/loading checks delayed delivery of real native responses; they did not substitute successful import or generation results. The Windows dialog itself and the full desktop window chrome were not automated.

Local hardware: AMD Radeon RX 9070, 16 GB VRAM, 32 GB system RAM. Managed runtime: Diffusers 0.39.0, Torch 2.12 with ROCm 7.14, worker 1.60.0. OpenAI was configured. Google credentials were present, but the application exposes no Google raster image model. SVG and video models were excluded from this image review.

The [final catalog](../apps/client/.cache/media-basics-2026-09-15/final-model-catalog.json) contains GPT Image 2, FLUX.2 klein 4B, moodyKrea2Mix v50, and RedCraft 23 KREA 2. RedCraft was initially unverified; native verification and a real generation succeeded during this pass. No runnable SDXL, FLUX.1, SD1/2, or SD3 checkpoint was installed.

## Feature-by-model coverage

**Verified** means a generated output was inspected. **Unsupported** means the current Machdoch path does not implement the capability. **Untested** means implementation or upstream support is insufficient evidence of working output. **Failed** records a real request or output failure.

| Model / provider                | Prompt-only generation  | Base image                  | Reference image                                         | Mask                                                               | Transparent output | Combinations                                                                                                           |
| ------------------------------- | ----------------------- | --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| GPT Image 2 / OpenAI            | Verified                | Verified                    | Verified: subject                                       | Unsupported in Machdoch                                            | Verified: WebP     | Base + alpha; base + palette + alpha verified. Mask combinations unsupported.                                          |
| FLUX.2 klein 4B / local         | Untested this pass      | Verified                    | Verified: subject; palette with full mask at strength 1 | Verified: partial and full selection; first loading attempt failed | Verified: PNG      | Base + alpha verified. Base + full mask + palette failed at 0.65, succeeded at 1.0. Partial mask + reference untested. |
| moodyKrea2Mix v50 / local KREA2 | Verified, 8 steps       | Unsupported                 | Unsupported                                             | Unsupported                                                        | Verified: PNG      | Text + alpha verified; image-conditioned combinations unsupported.                                                     |
| RedCraft 23 KREA 2 / local      | Verified, 8 steps       | Unsupported                 | Unsupported                                             | Unsupported                                                        | Verified: PNG      | Text + alpha verified; image-conditioned combinations unsupported.                                                     |
| SDXL / local                    | Untested: no checkpoint | Untested                    | Untested: composition-only path                         | Untested                                                           | Untested           | Current path allows one source: base or composition reference. Base + supplemental reference unsupported.              |
| FLUX.1, SD1/2 / local           | Untested: no checkpoint | Untested                    | Untested: composition-only path                         | Untested                                                           | Untested           | Same one-source restriction; architecture validation covered by regression tests.                                      |
| SD3 / local                     | Untested: no checkpoint | Unsupported in current path | Unsupported in current path                             | Unsupported in current path                                        | Untested           | No live evidence.                                                                                                      |

All five verified transparent outputs used **Machdoch's BiRefNet cutout**, with no Border Matte fallback. They do not establish native model/provider alpha support. Mask + transparency is blocked throughout Basics because removing the background would also change pixels outside the selected edit region.

OpenAI accepts up to eight total sources in this application; a base consumes one slot. FLUX.2 permits up to seven supplemental references and eight total sources. Multiple-reference UI limits and imports were checked, but **no generation with more than one supplemental reference was performed**. Style, composition, detail, pose control, and promptless conditioning were not independently verified with outputs in this pass.

OpenAI's documented API includes guided mask editing; Machdoch does not currently wire that capability for GPT Image 2. This is an application limitation, not a claim that the provider lacks masks. See the [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation).

## Generated-output evidence

The evidence directory is [apps/client/.cache/media-basics-2026-09-15](../apps/client/.cache/media-basics-2026-09-15/). It is local and ignored by Git. Each basename below has a native run-detail JSON; mask and later combination runs also have the pinned flow revision. Image links are verified-original exports.

| Run                                    | Output                                                                                                                          | Inspection                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cc29a510-f9f9-4f0d-9a8f-abbbfa9f00a3` | [OpenAI baseline PNG](../apps/client/.cache/media-basics-2026-09-15/openai-baseline.png), 1024 × 1024                           | Coherent red ceramic teapot matching the requested body, spout, handle, and lid.                                                                                           |
| `937a1548-28a1-47f8-a5cb-b327d0c837d8` | [OpenAI base + alpha WebP](../apps/client/.cache/media-basics-2026-09-15/openai-base-alpha.webp), 1024 × 1024                   | Red base changed to blue while retaining its recognizable shape. Actual transparent background.                                                                            |
| `a960b675-f358-4a1e-967e-c599cf650e7f` | [OpenAI subject PNG](../apps/client/.cache/media-basics-2026-09-15/openai-subject.png), 1024 × 1024                             | Reference teapot retained on an outdoor wooden table; the subject role remained supplemental.                                                                              |
| `4e061265-9821-49c0-a8f5-4d7ae7aefefa` | [OpenAI base + palette + alpha WebP](../apps/client/.cache/media-basics-2026-09-15/openai-base-palette-alpha.webp), 1024 × 1024 | Blue teapot with the portrait base's shape and genuine alpha. The prompt also specified cobalt blue, so this does not isolate the palette reference's causal contribution. |
| `2159f1ec-987f-4b5b-b03c-6d21dd95338a` | [FLUX base + alpha PNG](../apps/client/.cache/media-basics-2026-09-15/flux-base-alpha.png), 512 × 768                           | Green teapot retained the odd-sized JPEG base's recognizable geometry; genuine alpha.                                                                                      |
| `1b3f35e2-3af4-4f14-b852-9eefd2fa79a2` | [FLUX partial mask PNG](../apps/client/.cache/media-basics-2026-09-15/flux-mask-retry.png), 513 × 769                           | Lid changed to yellow. All 361,869 pixels outside the selection were identical to the decoded JPEG base.                                                                   |
| `0399caa0-97d5-4ce8-abb7-1d73caf1f2c6` | [FLUX subject PNG](../apps/client/.cache/media-basics-2026-09-15/flux-subject.png), 512 × 768                                   | Watercolor retained the blue reference teapot's color and geometry. The prompt did not specify its color or shape.                                                         |
| `4027a932-8926-4437-9581-d7a4a55e590a` | [FLUX full mask, strength 0.65](../apps/client/.cache/media-basics-2026-09-15/flux-base-palette-full-mask.png), 513 × 769       | **Failed intended palette transfer:** output stayed burgundy despite a blue palette reference. Native completion/change validation did not detect this semantic failure.   |
| `3fd3c795-fc1e-4151-b8dc-3f84d719f63f` | [FLUX full mask, strength 1.0](../apps/client/.cache/media-basics-2026-09-15/flux-base-palette-full-mask-strong.png), 513 × 769 | Same prompt, source, reference, and seed `6865460431096891`; visibly transferred the blue glaze. Used four sampling steps instead of two.                                  |
| `0c69677d-7006-4ecb-afd2-bd1bbd4b692b` | [moodyKrea PNG](../apps/client/.cache/media-basics-2026-09-15/moody-krea-alpha.png), 512 × 512                                  | Coherent yellow teapot, actual alpha, confirmed in the app preview.                                                                                                        |
| `6f337aa0-40d9-4591-9ca1-bc376d5e8302` | [RedCraft PNG](../apps/client/.cache/media-basics-2026-09-15/redcraft-krea-alpha.png), 512 × 512                                | Coherent orange teapot, actual alpha, confirmed in the app preview.                                                                                                        |

The full masks selected all 394,497 source pixels with zero strokes and inversion enabled. Their lack of outside changes is not evidence of preservation: there were no outside pixels. The partial mask selected 32,628 pixels within bounds `(136, 141)–(356, 320)`; 29,964 selected pixels changed, and the maximum outside-channel difference was zero. Measurements used the actual worker rasterizer and pinned mask, after decoding the source and output.

### Alpha measurements

All outputs below decode as RGBA with alpha spanning 0–255. Soft-edge counts exclude fully transparent and fully opaque pixels. See [pixel-measurements.json](../apps/client/.cache/media-basics-2026-09-15/pixel-measurements.json) and [measure.py](../apps/client/.cache/media-basics-2026-09-15/measure.py).

| Output                        | Fully transparent pixels | Soft-edge pixels | Opaque pixels |
| ----------------------------- | -----------------------: | ---------------: | ------------: |
| OpenAI base + alpha           |                  719,224 |           17,216 |       312,136 |
| OpenAI base + palette + alpha |                  669,351 |           20,281 |       358,944 |
| FLUX base + alpha             |                  266,936 |           13,182 |       113,098 |
| moodyKrea                     |                  191,087 |            7,727 |        63,330 |
| RedCraft                      |                  202,792 |            6,907 |        52,445 |

The actual Save image button exported the moodyKrea result with SHA-256 `313d11585699e72e54b86744cf0c3333f113cb2077f309c3eca333c6fb71d806`, identical to the earlier verified-original export. Preview evidence: [moodyKrea](../apps/client/.cache/media-basics-2026-09-15/moody-alpha-result-card.png), [RedCraft](../apps/client/.cache/media-basics-2026-09-15/redcraft-alpha-in-app.png).

## Failures and recovery

The first FLUX mask run, `2cfc0aa5-a72b-4791-88f5-8da435d0f3a2`, exited during model loading without an output or useful Python traceback. The desktop retained about 8.3 GB in its cutout session. Releasing that session before local generation reduced observed desktop private memory to approximately 0.06 GB, and Activity → Reuse settings restored the base and mask for a successful real retry.

Memory pressure is a plausible contributor, not a proven diagnosis. A separate FLUX base/alpha run had succeeded before the release change, and Windows expanded its pagefile during the investigation. The worker exit's exact cause remains unresolved. One queued reference run was deliberately canceled for the backend change and later resubmitted; it is not counted as a model failure.

The palette failure at strength 0.65 remains valid evidence. Raising strength to 1.0 recovered that sample, but neither the new default nor a successful same-seed retry guarantees reference adherence across prompts or subjects. The new default was verified in the UI; the partial-mask pixel comparison used the earlier 0.65 setting.

## Edge-case checks

| Area                   | Real UI/backend result                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing input          | Empty unconditioned prompt blocks generation. Missing asset selections remain removable.                                                                                                                         |
| Formats and dimensions | Real PNG, JPEG, and WebP imports; 64 × 64 references and an odd 513 × 769 portrait JPEG. Invalid custom dimensions blocked and reset recovered. Mask output retained original dimensions.                        |
| Import failure         | Corrupt and nonexistent files produced recoverable errors. Failed base replacement retained the existing base/mask.                                                                                              |
| Import races           | A delayed real import followed by model switching did not attach stale inputs. The imported asset remained selectable in Assets. Pending imports blocked generation.                                             |
| Reference limits       | Two real references attached; duplicate import did not duplicate the selection; removal reindexed controls. Eight supplemental FLUX files were rejected before import, with a seven-image limit.                 |
| Mask lifecycle         | Empty, inverted full, painted, completely erased, clear, undo, redo, and base replacement checked. New strength 1.0 and four-step minimum strength 0.25 checked.                                                 |
| Incompatible options   | Mask/alpha exclusion, PNG-only masked output, JPEG-to-PNG transparency change, disabled KREA conditioning, role/source limits, remote seed/custom-sampling recovery, and distilled sampling constraints checked. |
| Navigation and retry   | Assets → Basic retained setup. Activity → Reuse settings restored a failed request and completed a real retry.                                                                                                   |
| Controls               | Output count normalized from 0 to 1 and 2.6 to 3. Quality preserved custom dimensions. Add-on Browse opened and closed.                                                                                          |
| Preview and layout     | Actual preview loading state, exclusive asset pickers, and layouts at 1440 × 960 and 960 × 720. No horizontal overflow; capped portrait canvas preserved its pixel aspect ratio within layout rounding.          |
| Save                   | Actual native export matched the generated file hash.                                                                                                                                                            |

Screenshots: [final Basics](../apps/client/.cache/media-basics-2026-09-15/final-basics-layout.png), [mask canvas](../apps/client/.cache/media-basics-2026-09-15/final-mask-canvas-fit.png), [960-pixel layout](../apps/client/.cache/media-basics-2026-09-15/final-basics-960.png). Native bridge calls and browser errors are retained in the evidence JSON files; some early harness timeouts and stale locators were corrected before the final checks.

## Regression and previous claims

- Final client media suite: **306 tests passed across 48 files** (`vitest run src/core/media src/tauri/ui/media`).
- Native media suite: **219 passed, 3 intentionally ignored**. After the cache-release change, the 16 local-provider tests passed again; these are a subset, not 16 additional tests.
- Managed Python worker suite: **66 passed**, including empty/full mask rasterization.
- UI and test TypeScript checks passed. Lint passed for the changed client implementation files; formatting passed for the 17 changed client files checked. The final mask loading/coordinate tests passed within the complete media run.

The [earlier fixes report](media-studio-fixes-2026-09-14.md) established particular FLUX mask/reference and KREA generations, not universal model coverage. The fresh odd-sized JPEG mask output revalidates outside-region preservation, and fresh references, alpha outputs, and native exports extend that evidence. The [completion review](media-studio-completion-review-2026-09-14.md) included fixture-based custom-option checks; this pass found that working controls had not established working remote base/alpha submission or honored options on every local architecture.

## Remaining limits and sources

Live SDXL, FLUX.1, SD1/2, and SD3 testing is blocked by missing runnable checkpoints. More than one supplemental reference, independent style/composition/detail roles, pose control, promptless editing, partial mask + reference, reference-only + alpha, and every format/resolution/quality combination remain untested. JPEG output encoding, EXIF orientation cases, oversized/animated files, mixed valid-and-invalid import batches, provider rate limits/authentication failures, other GPUs, full-quality renders, native file dialogs, packaged builds, and the complete desktop shell were not covered.

The reviewed current implementations support the distinctions above; upstream capabilities alone were not marked verified:

- [FLUX.2 klein model card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) and [Diffusers FLUX.2 pipeline](https://huggingface.co/docs/diffusers/api/pipelines/flux2) document the distilled four-step model and image conditioning.
- [Diffusers 0.39.0 FLUX.2 inpainting implementation](https://github.com/huggingface/diffusers/blob/v0.39.0/src/diffusers/pipelines/flux2/pipeline_flux2_klein_inpaint.py) accepts separate image references and positions multiple references. Its strength handling explains why 0.65 used only two of four steps. No speculative one-reference restriction was retained.
- [KREA2 pipeline](https://huggingface.co/docs/diffusers/api/pipelines/krea2), [KREA2 repository](https://github.com/krea-ai/krea-2/blob/main/README.md), [SDXL pipeline](https://huggingface.co/docs/diffusers/api/pipelines/stable_diffusion/stable_diffusion_xl), and [FLUX pipeline](https://huggingface.co/docs/diffusers/api/pipelines/flux) were compared with Machdoch's architecture-specific paths.
- [GPT Image 2 documentation](https://developers.openai.com/api/docs/models/gpt-image-2) and [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation) informed provider capability checks. This review verifies Machdoch's postprocessed alpha, not OpenAI-native transparency.
