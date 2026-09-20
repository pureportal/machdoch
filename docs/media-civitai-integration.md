# Civitai in Media Studio

Open **Media Studio → Assets → Browse Civitai**. Existing Civitai-linked assets also have **Browse versions on Civitai**.

## Implemented

- Catalog search with cursor pagination, resource type, base model, sort, period, creator, tag, and account favorites. Resource types and base models come from Civitai's live enum endpoint, restricted by the shared native compatibility policy. Base-model choices follow the selected resource type.
- Lookup by model link, version/download link, numeric ID, AIR identifier, or SHA-256. Hash and version lookups preserve the requested version.
- `civitai.com` and `civitai.red` links. Mature content is an explicit browsing choice; model and preview ratings are both respected.
- Preview galleries, preview saving to the media library, example prompt copying, trigger-word copying, publisher descriptions, tags, file details, publisher permissions, and direct source links.
- Version and file selection, installed-file detection by hash, and checkpoint/LoRA/embedding imports with source links, tags, previews, and trigger words.
- API-key management in Settings and the Civitai settings dialog. Validated keys persist in the host user-config directory (`civitai.json`), using the same atomic writes and file permissions as other user credentials. The UI receives connection status only; keys are sent to Civitai through Authorization headers, never download URLs. Keys can be replaced or removed.
- Browser query, Mature content, resource type, base model, sorting, period, tag, creator, and favorites persist across reopening and reload. Desktop uses the shell store; Fleet browser preferences are scoped to the selected host. Pagination cursors and API keys are excluded.
- Searchable type, base-model, sort, period, version, and file selectors support typing, arrow keys, Enter, and Escape. The import action stays visible while scrolling model details.
- Downloads with progress, cancellation, storage checks, scan checks, SHA-256 verification, safetensors inspection, and cleanup after import. Retry can reuse a verified staged file. Imports enter the existing library import queue.
- Loading, empty, disconnected, blocked-file, rate-limit, download-failure, and retry states. Older search responses cannot overwrite a newer search.

## API investigation

| API area | Use in this integration |
| --- | --- |
| Models and enums | Search, filters, model details, available versions |
| Model versions | Exact file selection, hashes, previews, trained words, availability, and license claims |
| Version by hash | Identify an existing file without downloading it again |
| Download endpoint | Native streaming download with integrity verification |
| Account and favorites | Validate a saved API key and browse bookmarks |
| Images | Version-provided previews and generation prompts; selected previews use the existing image importer |
| OAuth | Investigated; requires a registered Civitai application and callback configuration, neither supplied in this workspace |
| Collections, vault, publishing, and paid generation | Separate account-management and remote-generation features; this change does not mutate Civitai account content or spend Buzz |

The canonical API is `https://civitai.com/api/v1`. Red links resolve to that API; mature source links open on `civitai.red`. This follows Civitai's documented endpoint and browsing behavior. Account restrictions and regional filtering remain enforced by Civitai.

References: [site API](https://developer.civitai.com/site/), [models](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/models.md), [versions and hash lookup](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/model-versions.md), [enums](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/enums.md), [authentication](https://github.com/civitai/civitai-developer-docs/blob/main/site/guide/authentication.md), [OAuth](https://github.com/civitai/civitai-developer-docs/blob/main/site/oauth/index.md).

## Boundaries

- Network operations and downloads run on the desktop or connected Fleet host. Browser-only previews need a host.
- Managed imports use scanned safetensors files and the architectures already supported by Media Studio. Unsupported types, versions, specialized pipelines, file formats, and declared quantizations are excluded from browsing and direct lookups. Native inspection enforces the same policy before downloading.
- Credentials are stored on each host. Existing session-only keys must be saved once in Settings. OAuth is not implemented.
- Preview URLs remain remote unless the user saves a preview. No publisher HTML is rendered as active markup.
- Download cancellation removes partial files. Downloads do not resume partial byte ranges across application restarts.
- No real account credentials were available. Authenticated favorites and mature-account access were tested with IPC fixtures, not a live account.

## Verification

- `cargo test --lib civitai --quiet -- --include-ignored`: 12 passed, including live public search, enum loading, red-link resolution, exact version/file metadata, and a real small embedding download/import. The download test uses an isolated temporary library, verifies the published digest, preserves source metadata, and removes staged files after import.
- Focused Vitest suite: 24 passed across Civitai helpers, asset metadata, asset import, and the Assets view.
- UI and core TypeScript checks passed. Targeted type-aware lint passed with the UI CSS declaration included.
- `pnpm build:ui`: production UI build passed.
- `node scripts/verify-civitai-ui.mjs`: Playwright exercised pagination, filters, connection, favorites, version/file choices, preview and trigger-word actions, progress, cancellation, hash-failure recovery, checkpoint and add-on import callbacks, hash lookup, empty results, rate limits, retry, and stale-response protection.
- Desktop and 390px layouts were captured and inspected. The dialog had no serious or critical axe WCAG A/AA findings and no horizontal overflow. Playwright reported no page errors.
- The existing app at `http://127.0.0.1:4173` was checked separately: the Assets entry opens and closes the catalog and correctly explains the browser-only runtime limitation. No development server was started.

Screenshots and the automated report are under `apps/client/.cache/civitai-review/`. The UI fixture uses synthetic landscape previews and mocked IPC; the native integration tests use the real public API.

## Compatibility audit

The mapping uses exact Civitai enum names, verified against the live `/api/v1/enums` response and [Civitai's base-model definitions](https://github.com/civitai/civitai/blob/main/packages/civitai-shared/src/basemodel.constants.ts). Unknown names are excluded until reviewed.

- SD 1.x, SD 2.x, SDXL, and SD 3/3.5 variants map to their corresponding Machdoch architectures. UnCLIP is excluded.
- Illustrious and NoobAI map to SDXL. Pony maps to `pony`; SDXL tensor detection must not erase that identity during import. Pony V7 uses AuraFlow and is excluded.
- FLUX.1 Dev, Schnell, and Krea map to `flux-1`. Kontext is excluded. Krea 2 maps separately to `krea-2`.
- FLUX.2 Klein 4B/base LoRAs use the managed Klein 4B runtime. FLUX.2 checkpoints and Dev/9B LoRAs are excluded: the pinned [Diffusers 0.39.0 Flux2Pipeline](https://github.com/huggingface/diffusers/blob/v0.39.0/src/diffusers/pipelines/flux2/pipeline_flux2.py) lacks the single-file loader used by our importer, and add-on tensor verification currently targets Klein 4B.
- WAN 2.2 TI2V-5B and LTXV LoRAs map to the matching video runtimes. Their checkpoints cannot use the image-checkpoint importer. Generic Hunyuan Video, other WAN variants, and LTXV2+ are excluded.
- LoRA, LoCon, and DoRA import as LoRA add-ons; tensor inspection still rejects unsupported adapter algorithms. Embeddings are limited to the architectures exposed by the existing add-on capability registry.
- Only Model safetensors files with ordinary floating-point precision are listed. Explicit Refiner, Inpainting, and Pix2Pix versions are excluded from the standard checkpoint pipeline.

Regression coverage includes mixed-family results, unsupported file filtering, type-specific enum choices, upstream search restrictions, direct inspection restrictions, and preserving Pony during import. Playwright also checks that changing resource type removes incompatible base-model options and clears an incompatible selection.

This policy establishes importer/runtime support from metadata. Individual downloads still require scan/hash checks and tensor inspection; generation quality and every publisher's weights are not verified by catalog filtering.

Audit verification: 18 native Civitai tests passed with live API and download/import tests included; 26 focused frontend tests passed. UI TypeScript, targeted lint, and desktop/mobile Playwright checks passed. Mobile filter labels remain readable, with no horizontal overflow or serious/critical accessibility findings. Generation was not exercised for every model family.

## Search regression

The reported `Age` search reproduced against the public API: `period=Month` returned no items with a continuation cursor, while the otherwise identical `period=AllTime` request returned 24 items, including age slider LoRAs. The browser had defaulted to Month inside its collapsed filters.

- The default period is now All time. Explicit period selections still apply.
- Searches automatically traverse up to five empty pages per action, preserving all filters. Further pages remain accessible through Search more; No matching models appears only after pagination is exhausted.
- Repeated cursors produce a recoverable error, and superseded searches stop requesting additional pages.
- Clear filters preserves the search term and the mature-content setting.

Playwright covers these cases with mocked IPC, alongside the existing desktop/mobile and accessibility checks. A live native regression checks both `Age` and `age slider` for compatible LoRA results with mature content disabled. The compatibility and file-format policy is unchanged.

Verification: 19 native Civitai tests passed, including live search and download/import checks. `Age` returned 23 compatible models, including 8 age slider LoRAs; `age slider` returned 13 compatible models, including 10 age slider LoRAs. The five Civitai helper tests, UI TypeScript, targeted lint, and Playwright passed. Desktop/mobile screenshots were inspected; the accessibility report contained no violations. Browser interaction checks use mocked IPC, while native tests use the public API without account credentials.

## Persistence and download investigation (2026-09-20)

Public catalog visibility does not guarantee anonymous download access. A live request for Animagine XL V3.1 (version 403131, file 325600) returned HTTP 401 immediately; Juggernaut XL and SD XL returned normal delivery redirects. The original integration discarded credentials on host restart and replaced useful Civitai errors with generic Media Studio messages. Credentials now survive restarts and Fleet worker processes. Authentication errors preserve the recovery instruction and open Settings without losing the selected model. Verified cached downloads are checked before the free-space check, so reuse does not require enough space for another download.

The exact checkpoint from the reported failure was not identified. Live account-restricted access remains unverified without credentials.

Additional checks:

- 477 shared Media Studio tests passed; desktop and shared-package TypeScript and lint passed.
- Desktop and Fleet Media Studio production builds passed.
- `node scripts/verify-civitai-ui.mjs` and `node scripts/verify-civitai-ui.mjs --fleet`: keyboard search and selection, every persisted filter before the first post-reload search, masked saved-key status/removal, download authentication recovery, cancellation, hash failures, imports, pagination, race handling, and desktop/mobile screenshots. No page errors or serious/critical accessibility findings.
- `node --import @oxc-node/core/register scripts/verify-fleet-media.mjs`: built Fleet iframe, generation pages, Assets, Civitai, and mobile navigation passed with a fixture host.
- Native persistence tests cover reading after save, replacement, and removal; live public API and embedding download/import checks passed. A real DreamShaper checkpoint (model 4384, version 128713, file 93211; 2,132,625,894 bytes) also passed full download, SHA-256 verification, architecture inspection, and library import in an isolated temporary library. Test files were removed afterward.

Reports and screenshots: `apps/client/.cache/civitai-review/`, `apps/client/.cache/civitai-review-fleet/`, and `.cache/fleet-media-review/`.
