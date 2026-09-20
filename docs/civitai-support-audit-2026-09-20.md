# Civitai compatibility audit

The browser was filtering by architecture names more broadly than the download and execution paths support. This audit follows the current checkout, including the Wan checkpoint acquisition changes already present.

## Corrections

- Checkpoints now require an import path that provisions their companion configuration and components: SD 1.x, SDXL, Pony, Krea 2, and Wan 2.2 TI2V-5B. SD2, SD3, FLUX.1, FLUX.2, and LTX standalone checkpoints are excluded from Civitai. Some of these families remain usable as complete local packages; that does not establish a working Civitai checkpoint installation.
- DoRA is excluded. The installed, pinned Diffusers 0.39.0 loader removes `dora_scale` tensors, while Machdoch's image add-on path delegates to that loader. Recognizing the tensors during import was insufficient evidence of correct execution.
- Wan and LTX expose standard LoRA only. Their runner explicitly rejects DoRA, convolutional LoCon, non-PEFT dialects, and network-alpha tensors. The latter restrictions still require inspecting the downloaded tensors because Civitai's resource type does not describe the dialect.
- LCM, Hyper, Lightning, Turbo, generic SDXL Distilled, and FLUX.2 Klein 4B-base entries are excluded from the supported base list. The current image runner has no matching per-variant scheduler/configuration profiles; Klein execution enforces four steps and guidance 1.0. For example, [LCM requires an LCM scheduler](https://huggingface.co/docs/diffusers/api/pipelines/latent_consistency_models), and [Lightning documents trailing timesteps and a different prediction mode for its one-step variant](https://huggingface.co/ByteDance/SDXL-Lightning).
- Catalog files now use the downloader's existing hash, scan-result, and size validation, in addition to safetensors format and precision checks. Versions without any eligible file disappear.
- Saved resource and base filters are checked against the returned options before the first search. Invalid selections reset while preserving the query and other preferences.

## Names in the screenshot

Illustrious and NoobAI map to SDXL. Pony retains its own identity while using the SDXL pipeline. Krea 2 has a dedicated loader and component installer. SD 1.4 and 1.5 share the SD1 pipeline. These names should remain visible.

FLUX.1 Schnell, Dev, and Krea remain selectable for compatible add-ons, but disappear when Checkpoint is selected. The Civitai checkpoint import does not supply their required component package.

Wan support is limited to 2.2 TI2V-5B. A14B and Wan-Alpha remain excluded. LTX is add-on-only in Civitai. SVG acquisition remains in the managed model library; it does not add a Civitai base-model family.

## Enforcement and limits

`civitai_compatibility.rs` supplies the rules used for upstream search parameters, returned versions/files, options, direct lookups, and download inspection. Regression tests exercise the same combinations across these paths, including mixed-version results and an API returning unsupported entries.

This is a filter based on metadata and implemented loaders, not certification of every publisher's file. Incorrect base labels, adapter dialects, tensor layouts, and model variants cannot all be established from a Civitai listing. Downloads retain SHA-256 verification and tensor inspection; import and model probing enforce further constraints. Hardware readiness, gated access, and successful full-size generation are separate from catalog compatibility.

The browser checks use mocked native responses. They verify desktop/Fleet controls, saved-filter recovery, and mobile layout, rather than a real Fleet download or GPU generation.

## Verification

- 27 native Civitai tests passed, covering filtering, inspection, and file eligibility.
- Two opt-in live Civitai tests passed: enums, direct version lookup, file inspection, general search, and Age/age-slider search. Full model download/import tests were not run.
- 14 frontend Civitai tests passed; Media Studio type checking and lint passed.
- Eight Python add-on tests passed in the installed managed runtime, exercising small real image/video models and tensor loading. The global Python environment lacks PEFT and was not used for the successful run.
- Playwright checks cover desktop and Fleet browsers, saved unsupported filters, dropdown scrolling, download controls, and 390px layout/accessibility.
- Full-size model downloads and GPU generation were not performed during this audit.
