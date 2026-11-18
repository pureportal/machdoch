# Licensing

## Scope

Machdoch-owned code and documentation are licensed under the PolyForm Noncommercial License 1.0.0. Commercial use requires a separate licence from the licensor. The project licence does not relicense third-party source, dependencies, model weights, externally supplied assets or separately attributed material. Existing third-party licence and copyright notices take precedence for that material.

Releases published before this change remain available under Apache-2.0 for the versions already distributed under it.

[EULA.md](../EULA.md) states the end-user terms. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) identifies copied and bundled material. Contributions require a written agreement that lets the licensor offer them under both the project licence and separate commercial licences.

## Release bundles

Run `pnpm licenses:headless`, `pnpm licenses:desktop`, `pnpm licenses:fleet-manager` or `pnpm licenses:landing` after installing the locked dependencies. The generators collect full legal files from the installed production dependency graph, preserve nested native notices, and reject packages without licence evidence. The desktop generator also collects the resolved Rust graph and the exact embedded Node.js licence. MPL-only crate sources accompany the desktop notices.

The generated bundle's `manifest.json` records versions and file hashes. A bundle is evidence of collected notices, not a legal clearance or a substitute for corresponding-source and relinking obligations. Desktop and headless packaging include the generated bundle; the Fleet Manager container includes its bundle at `/workspace/legal-release`.

## Unresolved obligations

The [audit](../docs/licensing/README.md) remains relevant. Its first finding, the ComfyUI-derived MiniMax code in Fizgig, was resolved on 2026-11-17 by replacing that code; see [NOTICE-RefMod.txt](../apps/client/src-tauri/python/NOTICE-RefMod.txt). Adding the project licence and notices does not resolve these findings:

- Redistributed LGPL/GPL binaries need their corresponding source and applicable build/relinking arrangements. Fleet Manager's Sharp/libvips libraries and any redistributed GPL-enabled FFmpeg are examples. Licence texts alone do not satisfy these obligations.
- Python runtime and accelerator packages need review for each actual distributed environment; the earlier audit did not establish complete terms for seven AMD/ROCm packages. Runtime downloads and model acquisitions are governed by their publishers' terms.
- Android packaging includes the project licence and end-user terms; complete Android dependency notices, final-artifact inspection and ownership of externally supplied assets remain unverified. Do not infer clearance from licence declarations in dependency metadata.

Model restrictions, including territorial, commercial and registration requirements, remain separate from the application licence. No broader model permissions are granted here.
