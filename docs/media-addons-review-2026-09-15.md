# Media Studio LoRA and embedding review — 15 September 2026

## Results

| Capability                              | Result in Machdoch                                                                                                                                                                                             | Evidence                                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image LoRA, Basic                       | **Verified for FLUX.2 klein 4B + Dog LoRA.** Selecting the asset changes the image; strength 0.5 and 1 produce different results.                                                                              | Three matched renders, inspected below.                                                                                                             |
| Image LoRA, Advanced                    | **Verified for the same combination.** Conversion preserves the selected LoRA and strength.                                                                                                                    | Advanced and Basic at strength 1 produce byte-identical PNGs.                                                                                       |
| Video LoRA, Basic and Advanced          | **Unsupported by the current application.** A compatible WAN LoRA cannot be imported or passed to video generation.                                                                                            | Real asset inspection, import rejection, UI inspection, and native request rejection. No video LoRA render was possible.                            |
| Embedding, Basic and Advanced           | **Broken on the tested GPU runtime.** SD1.5 generates without EasyNegative; both runs with it fail before sampling.                                                                                            | CPU/GPU device mismatch in both native runs.                                                                                                        |
| Embedding after diagnostic intervention | **The asset affects real generation**, but this requires correcting device handling outside the normal application flow. A second defect prevents the suggested mixed-case token from using all eight vectors. | Three separate diagnostic renders, actual tokenizer inspection, and pixel comparisons. This is not a product fix or a successful UI embedding test. |
| Required-trigger warnings               | **Partially working, with misleading and missed warnings.**                                                                                                                                                    | Live Basic/Advanced checks and production compiler/tokenizer reproductions below.                                                                   |

This pass adds this review and local evidence. It does not change production source. Downloads, an SD1.5 import, test workflows, and generation history remain locally available. Existing workspace changes were retained.

Evidence is in [the local review directory](../apps/client/.cache/media-addons-review-2026-09-15/). This directory is ignored by Git; run IDs, settings, and key results are recorded here so the findings remain understandable without it.

## Scope and execution

Reviewed the current working tree, including the earlier uncommitted Media Studio fixes, and relevant changes in `8f8534d` (workflows, 14 September), `ddd0216` (library imports, 1 September), and `2c7a81e` (desktop workflows, 22 August). The previous review's successful KREA2 LoRA loading was not treated as evidence of a matched visual effect or video support.

Playwright drove the production Media Studio React component through the existing Vite service and real Tauri commands/events. Only file-picker selections were supplied by the harness. Model inspection, registration, saved flow revisions, queue execution, generation, storage, and exports used the running desktop backend. The Windows file-picker window itself was not tested. No development service was started or restarted.

Runtime: Windows, AMD Radeon RX 9070 with 16 GB VRAM, 32 GB system RAM; worker `media-diffusers-worker/1.62.0`; Diffusers `0.39.0`, Transformers `5.13.0`, PEFT `0.19.1`, Torch `2.12.0+rocm7.14.0`. Source and running bundled worker SHA-256 matched:

```text
2cc15a85d35107c0531c9151a5a1e9820424862567e848e25d32247c95a08ad4
```

Memory pressure affected some loading and browser-bridge timings. These runs establish functionality and failure modes, not speed benchmarks.

## Asset handling

### Current behavior

- Import inspects Safetensors headers, tensor shapes, LoRA dialect/rank/components, or embedding dimensions/vector counts. Reviewed import hashes the file and stores an immutable copy under the desktop Media Studio data directory, `models/addons/sha256/<digest>/addon.safetensors`. Sources under the workspace `models` tree remain intact. Pickle `.pt`/`.bin` embeddings are intentionally unsupported.
- Basic offers compatible assets through **More options → Browse**, with search, category/tag/type filters, selected chips, strength, and embedding placement. LoRA text strength and denoising-window controls are conditional. Advanced has a separate picker in the generation node's **Expert** tab, including an editable embedding token.
- Compatibility checks provider, architecture, tensor confidence, components, and tensor profile. Selection reconciliation removes incompatible assets and enforces limits. Switching the test model from FLUX to SD1.5 removed the incompatible image LoRA. The family check is coarse: a matching architecture or a publisher hint is not proof of compatibility with every checkpoint variant.
- Saved recipes retain ordered selections and per-run settings. Native resolution verifies immutable files; the image worker applies named LoRAs, checks loaded components, and records their digest and strengths. Embedding loading checks vector dimensions, aliases, and collisions, then inserts the selected token into the selected prompt channel.

Relevant implementation: [model-addons.ts](../apps/client/src/core/media/model-addons.ts), [Basic picker](../apps/client/src/tauri/ui/media/components/media-addon-picker.tsx), [Advanced picker](../apps/client/src/tauri/ui/media/components/media-flow-view.tsx), [native import](../apps/client/src-tauri/src/media/model_addon.rs), [native execution](../apps/client/src-tauri/src/media/provider_local_diffusers.rs), and [image worker](../apps/client/src-tauri/python/media_diffusers_worker.py).

### Assets used

| Asset                                      | Origin and compatibility                                                                                                                                                                                                                                                       | Handling                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLUX.2 klein 4B                            | Installed model, revision `e7b7dc27f91deacad38e78976d1f2b499d76a294`.                                                                                                                                                                                                          | Reused and reprobed successfully.                                                                                                                                               |
| Dog LoRA, 8,374,984 bytes                  | [Publisher's FLUX.2 klein 4B DreamBooth LoRA](https://huggingface.co/MarioAlviano/lora-dog-flux2-klein-4b). Publisher specifies `a photo of sks dog`. Rank 4, 60 denoiser targets.                                                                                             | Reused installed asset, digest `4386187032d69407d7fa6fb1b836716a0a2a7b2266cbb4c4dcbd04c00a66e23e`.                                                                              |
| EasyNegative, 24,655 bytes                 | [Publisher's SD1 negative embedding](https://huggingface.co/datasets/gsdf/EasyNegative). Eight 768-dimensional vectors. It was trained on Counterfeit; the publisher does not establish equal effectiveness on other models.                                                   | Reused `models/stable-diffusion-1/embeddings/EasyNegative.safetensors`, digest `c74b4e810b030f6b75fde959e2db678c268d07115b85356d3c0138ba5eb42340`.                              |
| SD1.5 EMA checkpoint, 4,265,146,304 bytes  | [SD1.5 repository](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5), pinned revision `451f4fe16113bff5a5d2269ed5ad43b0592e9a14`, CreativeML Open RAIL-M.                                                                                                    | Downloaded to `models/stable-diffusion-1/checkpoints/v1-5-pruned-emaonly.safetensors` and imported. Digest `6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa`.  |
| WAN Loomis Painter LoRA, 644,947,744 bytes | [Publisher's WAN 2.2 TI2V 5B LoRA](https://huggingface.co/Markus-Pobitzer/wlp-Wan2.2-TI2V-5B-lora), pinned revision `7d85f8180d6b72a5adfab1457d68596a60ca1b85`. Publisher demonstrates the matching Diffusers base and `load_lora_weights`; no mandatory trigger was inferred. | Downloaded to `models/wan-2.2-ti2v-5b/loras/loomis-painter.safetensors`. Digest `38df0780f572a9f91073057501ec0091cd816d144c946bfd1a391164f977c0fb`. Native import was rejected. |

Downloaded files were streamed, hashed, and checked against their expected sizes. Pinned source records and publisher cards are retained beside the source weights and in the evidence directory.

**SD1.5 setup gap:** importing the checkpoint did not provision its offline pipeline configuration/tokenizer files. The first probe failed. Fetching the pinned official configuration and placing it in the existing per-checkpoint `config` location allowed the next probe and baseline generation to succeed. The workspace copy is at `models/stable-diffusion-1/runtime/config`; the managed revision has the same configuration. This was manual review setup, not successful automatic first-use installation. See [initial failure](../apps/client/.cache/media-addons-review-2026-09-15/sd15-probe-missing-config.json) and [successful probe](../apps/client/.cache/media-addons-review-2026-09-15/sd15-probe.json).

## Real image LoRA comparison

All four runs used FLUX.2 klein 4B, seed **9152026**, **512 × 512 PNG**, **4 distilled steps**, effective guidance **1**, no conditioning images, and no transparency. Positive prompt:

```text
a photo of sks dog sitting on a grassy lawn, full body, soft daylight, sharp focus
```

| Run                                    | Mode and selection   | Output                                                                                                              |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `a1173e92-1eff-40f9-a988-455ebf4f4e6c` | Basic, no LoRA       | [Baseline PNG](../apps/client/.cache/media-addons-review-2026-09-15/a1173e92-1eff-40f9-a988-455ebf4f4e6c.png)       |
| `0ff32a2b-4df5-41e0-95ba-e3f59c12e7bf` | Basic, strength 1    | [LoRA PNG](../apps/client/.cache/media-addons-review-2026-09-15/0ff32a2b-4df5-41e0-95ba-e3f59c12e7bf.png)           |
| `ccded9a0-5269-4b88-9b73-8ee1610a96f5` | Advanced, strength 1 | [Advanced PNG](../apps/client/.cache/media-addons-review-2026-09-15/ccded9a0-5269-4b88-9b73-8ee1610a96f5.png)       |
| `8da7c051-0865-4cad-ba0a-59f016eb6d29` | Basic, strength 0.5  | [Lower-strength PNG](../apps/client/.cache/media-addons-review-2026-09-15/8da7c051-0865-4cad-ba0a-59f016eb6d29.png) |

The baseline shows a shaggy white/tan dog. Strength 1 changes it into a stylized puppy with much larger ears/head and conspicuous fine grain. Strength 0.5 shows a brown/white puppy with more natural proportions and less conspicuous grain. This verifies a visible effect and a functioning strength control. It does not establish exact reproduction of the training dog or a general quality improvement.

Mean absolute RGB difference from baseline was **47.04/255** at strength 1 and **22.99/255** at strength 0.5. Basic and Advanced at strength 1 had **zero pixel differences and identical file bytes**, SHA-256 `c2e1cc4d1a2da8a686eba3ab21ec601ad884e046cfd4addd8d8c0ca1e4b6a093`. These metrics measure change, not quality.

Native provenance records the expected asset digest, strength, denoiser targets, and rank. Verified-original exports match their stored digests. [Comparison data](../apps/client/.cache/media-addons-review-2026-09-15/output-comparisons.json), [UI queue snapshots](../apps/client/.cache/media-addons-review-2026-09-15/image-queue-completed.json), and [captured requests](../apps/client/.cache/media-addons-review-2026-09-15/image-captured-requests.json) accompany the per-run records.

## Video LoRA boundary

The WAN asset is a valid rank-128 LoRA with 600 tensors targeting 300 denoiser modules. Machdoch's inspector recognizes the LoRA format but reports an unknown architecture. The import UI's base-model list contains image families only. Passing the publisher's correct `wan-2.2-ti2v` architecture directly to the native importer fails with `architecture is not a supported local image family`.

The generation boundary independently rejects `modelAddons` as an unknown field of `media_generate_video`. The Advanced video node has no add-on configuration, the model capability tables expose no video add-ons, and `generate_video` never calls the image worker's `_apply_addons` routine. This affects the current Hunyuan, WAN, FramePack, and LTX application paths; the actual import/request attempts used WAN.

Basic video correctly labels its existing controls **Starting image model** and **Starting image add-ons** when it must generate a first frame. Those selections belong to the image node. Supplying an existing starting image hides those controls and clears their trigger warning. That UI behavior was checked live; it does not apply a LoRA to video denoising.

Evidence: [WAN inspection](../apps/client/.cache/media-addons-review-2026-09-15/wan-inspection.json), [import UI](../apps/client/.cache/media-addons-review-2026-09-15/wan-import-settled.png), [native rejections](../apps/client/.cache/media-addons-review-2026-09-15/video-boundaries.json), [generated-first-frame controls](../apps/client/.cache/media-addons-review-2026-09-15/basic-video-first-frame-addons.png), and [supplied-first-frame controls](../apps/client/.cache/media-addons-review-2026-09-15/basic-video-supplied-first-frame-settled.png).

**No video LoRA output or visual comparison was possible through Machdoch.** Compatible source weights were available; the blocker is the product integration. Standalone upstream WAN LoRA generation was not tested.

## Embedding failures and diagnostic renders

### Normal application runs

All three used SD1.5, seed **9152026**, **512 × 512 PNG**, **20 steps**, guidance **7.5**, and the same positive prompt:

```text
a studio photograph of a blue ceramic teapot on a wooden table, soft window light, detailed
```

| Run                                    | Configuration                                   | Result                                                                                                                          |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `07ad326d-5ad2-4b2a-b3ef-e9043be5eeb2` | Basic, no embedding                             | Completed; [inspected baseline](../apps/client/.cache/media-addons-review-2026-09-15/07ad326d-5ad2-4b2a-b3ef-e9043be5eeb2.png). |
| `d787b79c-2835-4e5d-80c5-3d3ebe70f218` | Basic, EasyNegative, Negative placement         | Failed before sampling: `Cannot generate a cpu:0 tensor from a generator of type cuda.`                                         |
| `f1cc5cb5-b6f6-4d5c-8019-51f506881d89` | Advanced, same selected embedding and placement | Same failure.                                                                                                                   |

The actual saved recipes and requests preserve the negative placement and token; the warning did not block submission. Both failures are incorrectly classified as `SAFETY_REJECTED_OUTPUT`, with the user-facing message “A safety policy rejected this media operation.” The error classifier searches the entire diagnostic text for “safety”; the traceback includes Diffusers' unrelated safety-checker startup notice. The actual failure is a device mismatch. See [UI failure](../apps/client/.cache/media-addons-review-2026-09-15/embedding-ui-failed.png), [queue records](../apps/client/.cache/media-addons-review-2026-09-15/embedding-ui-queue.json), and [native requests](../apps/client/.cache/media-addons-review-2026-09-15/embedding-captured-requests.json).

### Root cause and isolated comparison

The production loader enables CPU offload before adding embeddings. The installed Diffusers textual-inversion loader removes those hooks and restores them using the text encoder's resident device, which is CPU. Instrumenting the real pipeline showed `_execution_device` changing from `cuda:0` to `cpu:0` immediately after `_apply_addons`. The worker subsequently creates a CUDA random generator, producing the failure above. Source: Machdoch worker `_load_pipeline` around line 1042 and `_apply_addons` around line 1569; [Diffusers textual-inversion loader](https://github.com/huggingface/diffusers/blob/main/src/diffusers/loaders/textual_inversion.py).

An isolated script used the same managed Python environment, checkpoint, embedding file, and production worker. It explicitly restored GPU offload after add-on loading, only inside the diagnostic process. It rendered a separate matched baseline and two embedding cases at **32 steps**, seed **9152026**, 512 × 512, pipeline guidance **7.5**, with the teapot prompt above. These are diagnostic outputs, not app runs and not the 20-step UI baseline.

| Diagnostic                     | Actual embedding tokens encoded | Output                                                                                                                         | Mean RGB difference from diagnostic baseline |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| No embedding                   | 0                               | [Baseline](../apps/client/.cache/media-addons-review-2026-09-15/embedding-device-diagnostic/baseline/output-0000.png)          | —                                            |
| Token `EasyNegative`, Negative | **1 of 8**                      | [Mixed-case token](../apps/client/.cache/media-addons-review-2026-09-15/embedding-device-diagnostic/uppercase/output-0000.png) | 33.08/255                                    |
| Token `easynegative`, Negative | **8 of 8**                      | [Lowercase token](../apps/client/.cache/media-addons-review-2026-09-15/embedding-device-diagnostic/lowercase/output-0000.png)  | 27.23/255                                    |

The embedding changes the teapot silhouette, spout, handle, lid, and composition. The two aliases also produce visibly different images. This confirms that the compatible embedding can influence generation once the device defect is addressed; it does not establish a general aesthetic benefit on SD1.5.

**Second defect:** the loader reports all eight mixed-case aliases registered, but CLIP tokenization returns lowercase `easynegative`. Diffusers' expansion checks against the mixed-case added-token names and does not expand the prompt. Only one learned vector reaches encoding. The lowercase alias expands to all eight. This was observed with the actual pipeline and installed libraries, not inferred from file metadata. It should not be generalized into a universal case-sensitivity rule for LoRA phrases or other tokenizers.

Evidence: [instrumented device/token results](../apps/client/.cache/media-addons-review-2026-09-15/embedding-device-diagnostic.json), [diagnostic comparisons and digests](../apps/client/.cache/media-addons-review-2026-09-15/embedding-diagnostic-comparisons.json), and [diagnostic script](../apps/client/.cache/media-addons-review-2026-09-15/diagnose_embedding.py).

### Other embedding limits

- The current capability table declares textual inversion for SD1, SD2, SDXL, and FLUX.1. FLUX.1 negative/both placement is rejected; its supported placement is positive. SD2, SDXL, FLUX.1, and multi-encoder embeddings were not rendered in this review. FLUX.2, KREA2, SD3, video, and remote models expose no embedding support here.
- New embedding selections default to **Positive**, including EasyNegative. There is no publisher placement metadata to supply the appropriate default. Basic image generation also has no general negative-prompt editor, although an embedding can select Negative placement.
- `_append_token` checks whitespace-separated exact strings. A token followed by a comma or exclamation mark is appended again. With the working lowercase alias, real tokenization encodes **16 embedding tokens instead of 8** in those cases.
- A long positive prompt containing 90 repetitions of `blue` followed by the token leaves **zero embedding tokens** after the SD1 CLIP limit of 77 tokens. The UI's substring check would accept it. This is a tokenizer-level reproduction, not a long-prompt image render. See [tokenizer cases](../apps/client/.cache/media-addons-review-2026-09-15/tokenizer-probe.json).

## Trigger words: storage, rules, and warnings

### Implemented rules

The import UI parses comma/newline-separated phrases, collapses whitespace, removes case-insensitive duplicates, and limits them to 32 entries of 128 characters each. Native import persists normalized `trigger_words_json` and `default_token` in the model-add-on record. For an embedding, the import field is labeled **Token** and requires exactly one entry; that entry supplies both its trigger and token alias.

Later Assets edits are stored in UI asset metadata and overlaid onto the native descriptor. For embeddings, the first edited trigger becomes the displayed default token. An already selected embedding retains its previous `selection.token`; reconciliation does not update it. This was reproduced with production metadata/selection functions. Consequently, warnings can use the edited default while generation uses the old selected alias.

The shared matcher lowercases, collapses whitespace, then performs a **substring search**. **Any one** listed phrase is sufficient. There is no stored “all required” rule, polarity rule, tokenizer check, or proof of activation. Multiple entries currently mean alternatives; whether a particular asset requires several phrases together must be established from its actual requirements before changing that behavior.

Source: [asset-metadata.ts](../apps/client/src/core/media/asset-metadata.ts), [model-addons.ts](../apps/client/src/core/media/model-addons.ts) around lines 102–123, [import dialog](../apps/client/src/tauri/ui/media/components/media-asset-import-dialog.tsx), and [native storage](../apps/client/src-tauri/src/media/model_addon.rs) around lines 1205 and 1862.

### Live warning checks

| Case                                                           | Basic                                                          | Advanced                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Selected Dog LoRA; phrase absent                               | Warns; Generate remains enabled.                               | Warns in the generation node's Expert tab; Run remains enabled.                                   |
| Correct phrase entered                                         | Warning clears.                                                | Warning clears.                                                                                   |
| Phrase in uppercase                                            | Warning clears, matching implemented case normalization.       | Same.                                                                                             |
| Extra whitespace inside phrase                                 | Warning clears.                                                | Uses the same matcher; not separately exercised live.                                             |
| `a photo of sks dogmatic painting`                             | Warning clears because `dog` matches a prefix of `dogmatic`.   | Same. This does not verify the publisher's full phrase or its learned effect.                     |
| Click Add for missing Dog LoRA phrase                          | Appends first configured phrase and clears warning.            | Code targets the connected positive source; live Add was tested with the embedding below.         |
| EasyNegative selected as Negative, no token in positive prompt | Warns despite the worker's automatic negative insertion.       | Same misleading warning in Expert.                                                                |
| Click Add for that negative embedding                          | Inserts token into the **positive** prompt and clears warning. | Inserts it into the connected **positive** source and clears warning.                             |
| Remove selected EasyNegative                                   | Warning clears; reselecting restores it.                       | Same.                                                                                             |
| Leave Expert tab / close generation inspector                  | Basic's warning is outside More options.                       | Warning is not visible in the inspector's Basic tab or on the closed canvas; Run remains enabled. |
| Supply a starting image for Basic video                        | Starting-image add-ons and warning disappear.                  | No video add-on picker exists.                                                                    |

Evidence: [Basic LoRA cases](../apps/client/.cache/media-addons-review-2026-09-15/basic-trigger-cases.json), [Advanced LoRA cases](../apps/client/.cache/media-addons-review-2026-09-15/advanced-trigger-cases.json), [Basic embedding cases](../apps/client/.cache/media-addons-review-2026-09-15/embedding-basic-trigger-cases.json), [Advanced embedding warning](../apps/client/.cache/media-addons-review-2026-09-15/embedding-advanced-warning.png), and [Advanced Add result](../apps/client/.cache/media-addons-review-2026-09-15/embedding-advanced-add-positive.png).

Neither compiler nor native submission enforces the configured trigger list as a required preflight. These warnings are advisory. Zero-strength LoRAs are also still eligible for a missing-trigger warning; that finding is from the production-function probe, not a zero-strength render.

### Warning prompt can differ from generation prompt

A valid combined image/video graph with two connected prompt nodes reproduces a more serious mismatch:

1. The image node receives the dog prompt containing the required phrase.
2. The video node receives `The dog slowly turns its head.`
3. The motion prompt is first in the graph's node array.
4. Compilation returns **ready**. The image inspector checks its connected prompt and finds the phrase.
5. `readImageTaskNodeSettings` instead takes the first `source.prompt` in the graph, returning the motion prompt as the image-generation prompt. The submission path uses those settings.

This uses two valid connected sources, not an unconnected decoy. The result is verified through production graph creation, compilation, and settings functions; this specific combined graph was not rendered. See [reproducer and ready plan](../apps/client/.cache/media-addons-review-2026-09-15/graph-prompt-probe.json), [compiler.ts](../apps/client/src/core/media/compiler.ts) around line 1896, [inspector prompt resolution](../apps/client/src/tauri/ui/media/components/media-flow-view.tsx) around line 3215, and [submission](../apps/client/src/tauri/ui/media/media-studio.tsx) around line 2841.

## Focused improvements

| Priority | Improvement                                                                                                                                                                                                                                      | Verification needed                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | Load embeddings before enabling offload, or restore the actual GPU execution device after loading. Apply this at the loader boundary.                                                                                                            | Repeat the unchanged Basic/Advanced 20-step pair with and without EasyNegative; both modes should complete and agree.                                                                                                                            |
| 1        | Resolve embedding aliases using each tokenizer's real normalization; verify expected vector tokens survive expansion and truncation. Prevent duplicate insertion around punctuation.                                                             | Real CLIP coverage for mixed/lowercase aliases, eight-vector expansion, punctuation, collisions, and overlength prompts; then other declared encoder families.                                                                                   |
| 1        | Use one resolved prompt and selection per executed node for warnings, request creation, and provenance. Include prompt channel and the selected embedding alias.                                                                                 | Separate connected image/motion prompts, variables, edited defaults, disabled/zero-effect selections, and queued immutable recipes.                                                                                                              |
| 1        | Remove missing-token warnings for embeddings already inserted automatically. Add a publisher-backed placement default; EasyNegative should start as Negative. Never fix a negative token by appending to positive text.                          | Same placement/clearing behavior in Basic and Advanced, including Add actions and actual encoded prompts.                                                                                                                                        |
| 1        | Surface actionable LoRA trigger warnings beside submission in both modes, using the resolved execution data. Keep a single concise row, for example `Missing “a photo of sks dog”` with **Add**.                                                 | Warning remains visible when the inspector closes and clears after correction or deselection. Establish phrase/alternative requirements before tightening matching.                                                                              |
| 2        | Add video LoRA support through architecture detection, import, model-specific compatibility, separate video selections, graph/native contracts, video loading/offload, and provenance. Keep existing **Starting image add-ons** distinct.        | Actual matched WAN video renders with and without the compatible LoRA; inspect frames and motion. Image or first-frame success must not qualify this feature. Until implemented, reject the import with a direct unsupported-capability message. |
| 2        | Provision pinned configuration/tokenizer dependencies when importing supported single-file checkpoints. Classify runtime errors from structured causes instead of incidental log words.                                                          | Fresh offline SD1.5 setup and a device-error reproduction must produce the correct actionable state, without a false safety rejection.                                                                                                           |
| 2        | Keep trigger/token edits in one canonical asset record and evaluate the alias saved in each selection. Reuse the same picker behavior in both modes. Retain strong tensor/base-variant checks and use documented asset defaults where available. | Edit/reload/reselect checks, base-variant mismatch rejection, and another same-seed strength comparison. The Dog result supports an easy strength adjustment, not a universal new default.                                                       |

These are proposed changes, not implemented changes. Prioritize execution and prompt resolution; keep additional controls and copy minimal.

## Checks and remaining limits

- **Client:** 48 files, **313 tests passed** using `pnpm exec vitest run src/core/media src/tauri/ui/media --maxWorkers=1 --reporter=dot` from `apps/client`. Existing React test warnings remain.
- **Native Media Studio:** **219 passed, 3 ignored** using the existing built `machdoch_lib-8c6603e4da232a1d.exe media:: --test-threads=1`. No native source file was newer than that binary. This was not a fresh Cargo build; ignored live/model-dependent tests are not counted as passes.
- **Python worker:** **66 tests passed** using `python -m unittest discover -s apps/client/src-tauri/python -p test_media_diffusers_worker.py`. [Suite log](../apps/client/.cache/media-addons-review-2026-09-15/python-tests.log) records `OK`; Pillow deprecation warnings remain. These checks do not cover the failing real embedding/offload/tokenizer combination.
- **Actual application generations:** five completed image runs and two failed embedding runs. No video LoRA run could be submitted. Three additional diagnostic images completed after an explicitly isolated device intervention. All published test images were exported and inspected; comparison data records image digests and pixel differences.
- **Review artifacts:** Formatting and local links passed. All five verified-original exports matched their stored digests. No active or queued Media Studio runs remained, and the review browser was closed. [Final verification](../apps/client/.cache/media-addons-review-2026-09-15/final-verification.json).
- Other image LoRA families, multiple simultaneous LoRAs, denoising schedules, independent text-encoder strength, embedding combinations, SD2/SDXL/FLUX.1 embeddings, long-prompt image renders, and upstream video LoRA rendering remain untested here. KREA2's previously installed LoRAs were not reverified by matched comparisons.
- The reviewed desktop is a development build on one AMD machine. Packaged builds, NVIDIA, CPU-only execution, and other operating systems remain unverified. No general quality or identity-accuracy claim follows from these small comparisons.

The runtime and model setup gap, two embedding defects, unsupported video path, and warning mismatches remain present in production source at the end of this review.
