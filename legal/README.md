# Licensing

## Scope

Machdoch-owned code and documentation are licensed under Apache-2.0. The project licence does not relicense third-party source, dependencies, model weights, externally supplied assets or separately attributed material. Existing third-party licence and copyright notices take precedence for that material.

[EULA.md](../EULA.md) states the end-user terms without adding restrictions to Apache-2.0. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) identifies copied and bundled material. Contributions intentionally submitted for inclusion in Machdoch-owned code are covered by section 5 of [LICENSE](../LICENSE), unless explicitly stated otherwise or governed by a separate agreement; contributors must have the necessary rights.

## Release bundles

Run `pnpm licenses:headless`, `pnpm licenses:desktop`, `pnpm licenses:fleet-manager` or `pnpm licenses:landing` after installing the locked dependencies. The generators collect full legal files from the installed production dependency graph, preserve nested native notices, and reject packages without licence evidence. The desktop generator also collects the resolved Rust graph and the exact embedded Node.js licence. MPL-only crate sources accompany the desktop notices.

The generated bundle's `manifest.json` records versions and file hashes. A bundle is evidence of collected notices, not a legal clearance or a substitute for corresponding-source and relinking obligations. Desktop and headless packaging include the generated bundle; the Fleet Manager container includes its bundle at `/workspace/legal-release`.

## Unresolved obligations

The [audit](../docs/licensing/README.md) remains relevant. Adding the project licence and notices does not resolve these findings:

- Fizgig's `minimax/model.py` and `minimax/sampling.py` describe ComfyUI ports. The checked upstream is GPLv3. Their rights and the scope of any affected combined work require resolution before a release containing them can be cleared. Obtain a verifiable grant, replace/remove the affected material, or satisfy the applicable GPL terms; the root Apache licence is not a grant for those portions. The former audio and video VAE ports were replaced with Machdoch adapters to Diffusers' Apache-2.0 H3 autoencoders; this does not clear the remaining combined-work obligations.
- Redistributed LGPL/GPL binaries need their corresponding source and applicable build/relinking arrangements. Fleet Manager's Sharp/libvips libraries and any redistributed GPL-enabled FFmpeg are examples. Licence texts alone do not satisfy these obligations.
- Python runtime and accelerator packages need review for each actual distributed environment; the earlier audit did not establish complete terms for seven AMD/ROCm packages. Runtime downloads and model acquisitions are governed by their publishers' terms.
- Android packaging includes the project licence and end-user terms; complete Android dependency notices, final-artifact inspection and ownership of externally supplied assets remain unverified. Do not infer clearance from Apache declarations in dependency metadata.

Model restrictions, including territorial, commercial and registration requirements, remain separate from the application licence. No broader model permissions are granted here.
