# Media Studio settings and LoRA review

Settings were lost through two paths: leaving the studio canceled its 250 ms save timer, and add-on reconciliation wrote an empty selection back while the catalog was loading. The same reconciliation ran in Advanced node controls.

Pending saves now flush on navigation and page exit. Failed initial loads cannot overwrite existing storage. Catalog rendering no longer mutates saved add-ons; explicit model selection retains compatible choices. Image, video, SVG, sampling, references, seeds, and add-on controls continue through the existing studio state store.

Asset filters, LoRA browser filters, and the expanded generation options panel are remembered locally, scoped to the Fleet instance when applicable.

The LoRA picker uses compact previews, wrapping names, larger controls, a scrollable selection area, and a fixed Done action. Selected LoRAs expose their strengths directly in the generation form. Filters have a reset action, and the mobile filter layout avoids truncated controls. Studio error notices now stay within the viewport.

Verification:

- 484 Media Studio tests passed, including save-on-navigation, save failure/retry, delayed catalogs, and complete recipe serialization.
- Media Studio lint/type checks and client UI TypeScript checks passed.
- Client UI and Fleet Media production builds passed. Fleet retains its bundle-size warning.
- `node scripts/verify-media-settings.mjs` checks the shared studio in client and Fleet modes, with mocked host storage and a delayed catalog. It covers selection, strengths, immediate navigation, full reload, asset filters, and 1440px, 390px, and 320px layouts.
- Screenshots and browser results are written to `apps/client/.cache/media-settings-review/`.

Live native storage across application restarts and an enrolled Fleet host were not exercised. Generation and downloads were outside this change.
