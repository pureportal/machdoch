# Machdoch licence audit

The findings below describe the audit snapshot. Subsequent project licence, end-user terms and release notice collection are documented in [legal/README.md](../../legal/README.md). Those additions do not clear the unresolved GPL provenance or other source/model obligations.

Audit date: 5 October 2026. Software version: 29.0.0. Repository HEAD: `adca921d2463856b64edd0d3b03bb8a72abcb037`, including the working tree available during the audit. Lockfile fingerprints and counts are in [inventory-summary.json](inventory-summary.json).

**Not all licence obligations are covered. The present source and packaging cannot be cleared for an unrestricted commercial, proprietary, or Apache-only release.** Most ordinary dependencies permit commercial use, but there is an unresolved GPL provenance issue in bundled Python code, missing distribution notices, and separate model restrictions. These findings are evidence of gaps, not a finding that every supported model has been used unlawfully.

This report and its inventories are audit evidence. They are not the third-party licence bundle that releases must carry. No application code, model policy, package licence, or project licence was changed by this audit.

## Scope and verification

| Area | Evidence examined | Result and limit |
| --- | --- | --- |
| JavaScript/TypeScript | 883 exact package versions in `pnpm-lock.yaml`; 707 exact local metadata records and 176 exact registry records; workspace manifests | Every locked package has a resolved licence declaration or licence-text finding. Declarations do not prove that all embedded material is covered. |
| Installed direct npm dependencies | 66 direct production dependencies resolved against actual installation paths | All 66 versions match the lock. Another 239 versions are old `.pnpm` cache entries, not evidence of production version drift. |
| Rust | Both Cargo locks, 862 package versions: 860 third-party and two workspace packages | All third-party registry licence declarations resolved. Full offline Cargo metadata was blocked by uncached `core-foundation@0.9.4`; exact enabled graphs for every release target remain unverified. |
| Android | Gradle offline resolution of `releaseRuntimeClasspath`, 36 coordinates, exact publisher POMs and relevant parent POM | All 36 runtime coordinates declare Apache-2.0. The final APK and complete embedded notice contents were not inspected. Test/build dependencies have separate scope. |
| Python | 17 pinned direct requirements; 163 installed metadata records across the production and development Windows AMD media environments, representing 83 unique versions | Direct requirement licences resolved; inspected installed metadata and legal files. Seven AMD/ROCm packages still lack adequate root legal evidence. Other accelerator/OS environments were not installed or inspected. |
| Native and embedded components | 156 nested legal files, FFmpeg executable build flags, native npm packages, release scripts, resource mappings | Identified LGPL/GPL and native notice obligations. This is not a complete licence reconstruction of every native binary. |
| Models | 31 declared profiles, additional discovered MiniMax support, 39 pinned publisher metadata records, workflow component manifests | All 20 acquisition licence-source digests matched. Some sources are model cards rather than full terms; matching a digest establishes identity, not permission. |
| Copied code and assets | Explicit source-origin statements, notices, Git provenance, selected upstream comparisons, 66 tracked binary assets | Established concrete ComfyUI port evidence. Ownership of every original contribution, image, icon, sample, dataset and externally supplied checkpoint cannot be proven from the repository. |

Primary licence documents were checked online against publishers, including exact revisions where obtainable. Ten restricted-model documents were retrieved at the configured revisions. Krea's pinned `LICENSE.pdf` returned HTTP 401; its publisher's public community terms were inspected instead, without claiming that the pinned PDF was verified.

The final [inventory validation](validation.json) passed: lock membership, dependency specifiers, installed direct versions, model digests, source/asset fingerprints and evidence links were checked. These checks validate the audit records; they do not establish copyright ownership or satisfy distribution obligations.

## Findings requiring resolution

### 1. Bundled Fizgig includes unresolved ComfyUI-derived code

`apps/client/src-tauri/tauri.conf.json` packages the entire `python/fizgig` directory. Its Apache-2.0 licence and copied third-party notices do not establish permissive rights for these files:

| Local file under `apps/client/src-tauri/python/fizgig/` | Evidence |
| --- | --- |
| `minimax/model.py:3` | Explicitly describes a faithful port of `ComfyUI`'s `comfy/ldm/minimax/model.py`; three identical function AST comparisons found. |
| `minimax/vae.py:3` | Explicitly describes a port of `ComfyUI`'s `comfy/ldm/minimax/vae.py`; seven identical function AST comparisons found. |
| `minimax/audio_vae.py:10` | Explicit ComfyUI port statement; seven identical function AST comparisons found. Also identifies original MIT DAC/BigVGAN lineage, which requires tracing separately. |
| `minimax/sampling.py:138` | Describes an implementation ported from ComfyUI's sampling code; no identical function AST match found in the selected comparison. Some sampling algorithms have earlier permissive origins. |

ComfyUI's checked upstream revision is GPLv3. The explicit port statements and selected structural matches make this a release blocker until the relevant copyright lineage and licence grants are established. A downstream Apache label cannot grant rights its author does not own. The structural comparison is not a legal determination of substantiality or of which individual portions have independently permissive origins. See [comparison evidence](copied-code-evidence.csv) and the [upstream licence](https://github.com/Comfy-Org/ComfyUI/blob/5c460d8172fe30761ff67c0df3d5643bb74e0d70/LICENSE).

The current notices mention a GPL `detect_gpu.py` from `comfyui-rocm`, but that file is absent from the bundled subset. It is not the basis of this finding. The notices do not account for the MiniMax ports that are present.

Resolve this by obtaining a verifiable permissive grant for the relevant portions, removing/replacing them using material with established rights, or distributing the affected derivative/combined work under the applicable GPL terms with corresponding source. A Python subprocess boundary does not, by itself, settle whether the surrounding worker/application is a separate work. The scope needs review before deciding whether the whole application can remain proprietary. See the [GNU GPL FAQ on aggregation and communication](https://www.gnu.org/licenses/gpl-faq.en.html).

### 2. Distribution notices are incomplete

There is no project-level `LICENSE`, `NOTICE`, or aggregate third-party licence bundle. Internal npm packages and the two workspace Rust packages have no declared licence. The RPM generator explicitly writes `License: Unspecified` at `.github/scripts/build-linux-rpm.mjs:158`.

| Shipped or generated component | Gap |
| --- | --- |
| Desktop's compiled JavaScript CLI and frontend | The build bundles third-party code but does not collect its required licence/copyright texts into a release notice bundle. A licence label or registry URL alone is insufficient. |
| Embedded desktop Node executable | `apps/client/src-tauri/build.rs` copies the build machine's Node binary without collecting that exact version's full licence file and embedded-component notices. Node's full file contains substantially more than its top-level MIT grant. |
| Linux ONNX Runtime 1.24.2 | `.github/scripts/stage-onnx-runtime.sh` extracts the shared library, and `tauri.linux.conf.json` packages it, without the archive's licence and third-party notices. The Rust wrapper's licence does not replace them. |
| Headless package | `apps/client/scripts/build-headless-package.mjs` packages the compiled CLI and Playwright runtime without an aggregate licence bundle for the compiled dependencies. It uses the user's Node installation rather than shipping a Node executable. |
| Copied shadcn UI components | The client and fleet manager's `components.json` identify shadcn generation; no shadcn copyright/permission notice was found in project source or packaged notices. Copied source is outside npm dependency scanning. Verify generated-component provenance and retain the applicable [MIT notice](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md). |
| Lucide icons | The installed licence includes ISC terms and an MIT notice for Feather-derived icons. Preserve both applicable notices rather than reducing this to an ISC label. |

Some notices are already present: Whisper.cpp, the bundled Whisper model, the Windows Vulkan loader, Fizgig, MuseTalk and copied Diffusers training code. The Playwright packaging copies the whole package, retaining its own `LICENSE` and `NOTICE`; the gap is not that those files are necessarily discarded. These positive findings do not cover the remaining JavaScript, Rust and native contents.

For Node, collect the licence from the version actually shipped. The local 24.14.1 licence was checked as evidence, not as proof of the version in all CI artifacts. For ONNX, include its [1.24.2 licence](https://github.com/microsoft/onnxruntime/blob/v1.24.2/LICENSE) and [third-party notices](https://github.com/microsoft/onnxruntime/blob/v1.24.2/ThirdPartyNotices.txt). Apache components also require preservation of applicable notices and prominent changed-file notices for modifications. See [Apache-2.0 section 4](https://www.apache.org/licenses/LICENSE-2.0.html).

### 3. Copyleft dependencies need component-specific handling

| Component | Actual licence and consequence |
| --- | --- |
| `sharp` and platform libvips binaries | The JavaScript wrapper is Apache-2.0, but `@img/sharp-win32-x64@0.35.4` declares `Apache-2.0 AND LGPL-3.0-or-later`; the native libvips DLLs were found. This is a fleet-manager production dependency through Next.js. Distributing it requires LGPL notices, corresponding library source and a compliant replacement/relinking arrangement. Running it only on your own hosted server has a different distribution consequence. |
| Rust CSS parsing/selectors | `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext` and `selectors` have MPL-2.0-only entries in the locks. When included in distributed executables, make the covered source, including modifications, available under MPL and provide its notices/access information. MPL is file-level and does not normally require the surrounding application to use MPL. See the [Mozilla FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). |
| Python `certifi` and `tqdm` | MPL-covered material exists in the installed runtime; retain applicable notices/source availability when redistributing those runtimes. |
| Windows FFmpeg in `imageio-ffmpeg@0.6.0` | Both inspected copies are FFmpeg 7.1 with `--enable-gpl --enable-version3`, x264/x265 and static components. The wrapper's BSD licence does not cover this executable. The binary is GPLv3; corresponding-source/build and notice duties arise if you redistribute it or its wheel. |

The observed FFmpeg hash is `2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3`. Machdoch currently invokes it as a separate executable obtained through runtime installation; no current Tauri FFmpeg resource shipment was established. That does not automatically make the whole application GPL. Rehosting/caching wheels for distribution or including the executable in installers changes the assessment. The [FFmpeg legal page](https://ffmpeg.org/legal.html) explains why build flags matter; codec patent rights are separate and were not cleared here.

Avoid false positives: `dompurify` offers Apache-2.0 **or** MPL-2.0; select Apache if appropriate. `r-efi` offers permissive alternatives to LGPL. `axe-core` is a development dependency; `lightningcss` is build tooling. The SciPy wheel's licence text includes GCC runtime exceptions and bundled components; a GPL word search does not establish a GPL requirement for all of Machdoch. `AND` means cumulative obligations; `OR` permits choosing an applicable alternative.

### 4. Model permissions are separate from software licences

Supporting a model architecture or installing an Apache-licensed inference library does not grant rights to the weights, associated material, or all outputs. The repository's `review-required` flag and licence acceptance are acknowledgements, not a substitute for permission. Actual territory, purpose, revenue and any separate agreements determine whether use is covered. No restricted model was run as part of this audit.

| Model family/version present or supported | Publisher restriction relevant to Machdoch |
| --- | --- |
| MiniMax H3, discovered profile and bundled trainer | The August 2026 community licence excludes the **EU, UK, South Korea and United States**. It explicitly restricts use of the works and outputs there, including hosted use. Germany/EU operation requires separate permission; a free test is not an automatic exemption. Commercial products/services over $20m yearly revenue need prior written authorization; commercial interfaces must display MiniMax H3. [Official terms](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE). |
| HunyuanVideo 1.5 | The community licence excludes the **EU, UK and South Korea**. German/EU use needs a separate grant. The publisher also sets a large-service authorization threshold. The community Diffusers mirror does not override the publisher's rights. [Official terms](https://huggingface.co/tencent/HunyuanVideo-1.5/blob/main/LICENSE). |
| AudioLDM2 | The pinned model declares **CC-BY-NC-SA-4.0**. Commercially directed use is not cleared by the Apache licence of the inference code. Obtain suitable rights or exclude it from commercial use. [Pinned publisher card](https://huggingface.co/cvssp/audioldm2/blob/c8e7e189d324425c05c4c2f81214041ef4107983/README.md). |
| FLUX.1 dev, FLUX.2 dev, klein 9B and base 9B | Non-commercial/non-production model terms; commercial model deployment needs a separate licence. Commercial output permission does not authorize a commercial inference service. The licences have specific evaluation/R&D allowances, so not every company test is forbidden. Schnell and klein 4B/base 4B have different, Apache terms. [Pinned FLUX.2 dev terms](https://huggingface.co/black-forest-labs/FLUX.2-dev/blob/26afe3a78bb242c0a8bb181dcc8937bb16e5c66c/LICENSE.md). |
| Krea 2 Raw; Fizgig also supports Krea training | Public June 2026 terms permit commercial model/derivative/**output** use only below **$1m total company-wide trailing annual revenue**, including affiliates and all revenue sources. At or above it, prior enterprise permission is required. Inference-code Apache terms do not replace model terms. Public terms also impose distribution notices and reasonable content filtering. The pinned gated PDF was not verified. [Publisher community terms](https://github.com/krea-ai/krea-2/blob/main/docs/KREA-2-COMMUNITY-LICENSE). |
| Ideogram 4 NF4 | The exact pinned document is a **non-commercial model agreement**. It does not permit commercial/promotional use of outputs under that grant. Separate permission is needed for commercial use. [Pinned terms](https://huggingface.co/ideogram-ai/ideogram-4-nf4/blob/f664347839e0a87bc495f5c9483cc0014b8e344e/LICENSE.md). |
| CogVideoX 1.5 5B and 5B I2V | Commercial use requires registration and a basic commercial licence, offered without charge below the specified service-size threshold; larger use requires contacting the publisher. This differs from CogVideoX 2B's Apache licence. [Pinned terms](https://huggingface.co/zai-org/CogVideoX1.5-5B/blob/fdc5267c90b5c06492985b966e43aae984e189e0/LICENSE). |
| LTX 2.3, LTX 2.5 and Sulphur 2 derivative | Community terms set a **$10m company/group revenue threshold** for commercial use requiring a paid grant. Limited commercial R&D allowances are defined, not unrestricted production permission. LTX 2.5 points to the newer August 2026 `LICENSE-2_x`; the pinned Diffusers card's old `LICENSE.md` link is broken. Resolve and retain the actual applicable document instead of relying on the card digest. [Current publisher LTX 2.x terms](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x), [pinned LTX 2.3 terms](https://huggingface.co/Lightricks/LTX-2.3/blob/5948be4ced3a4493d1f836df64378ff136ddb770/LICENSE). |
| Stable Video Diffusion XT | The exact pinned licence is the Stability community agreement, rather than an assumed older research-only licence. Commercial use requires registration; licences terminate if annual revenue of you/affiliates, individually or collectively, exceeds **$1m**, requiring a separate grant. Distribution/product use also carries licence, notice and attribution conditions. [Pinned terms](https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt/blob/9e43909513c6714f1bc78bcb44d96e733cd242aa/LICENSE.md). |

Other configured families have publisher MIT/Apache declarations, including Z-Image, Qwen Image, Sana, GLM Image, HiDream, Wan, Mochi and Helios. These are useful positive evidence, not clearance of every separately sourced encoder, checkpoint, dataset or derivative. For example, a pipeline's externally required Llama/Gemma component needs its own review.

The lip-sync workflow downloads multiple components, including MuseTalk weights, a Stability VAE, Whisper tiny, face-parsing weights and YuNet. Its manifest does not include those components' full licence documents. A mirrored face-parsing card's `wtfpl` declaration is insufficient proof that the uploader can license the original checkpoint. The RealESRGAN mirror also needs original checkpoint provenance. The pinned YuNet publisher licence was found and inspected.

### 5. Remaining provenance and native-runtime evidence

`media_face_parsing.py` closely follows the structure of the upstream BiSeNet implementation, but only a MuseTalk licence is bundled. Establish whether the source was adapted from `zllrunning/face-parsing.PyTorch` and retain its [original MIT notice](https://github.com/zllrunning/face-parsing.PyTorch/blob/master/LICENSE) if applicable. Similar architecture alone is not proof of unlawful copying.

Fizgig's LoRA module identifies Microsoft/LoRA, cloneofsimo/lora and ComfyUI references. Trace the actually incorporated portions and notices. Merely referencing an algorithm/specification, including Stability's ModelSpec, is not proof that protected source was copied. The expected ModelSpec `LICENSE.md` URL returned 404 and was not treated as a confirmed violation.

The tracked `fizgig/assets/h3_silu_temb_grid.safetensors` is a 5.5 MB activation-grid asset, not an ordinary npm package. The trainer credits Larryvrh's ComfyUI MiniMax turbo work, whose code licence is Apache-2.0, but the shipped notices do not identify that origin. Establish the asset's permission and whether model-derived-data restrictions apply; an Apache code licence alone does not settle this.

The installed packages below have no adequate root licence declaration/text in the inspected evidence:

`amd-torch-device-gfx12-0`, `amd-torch-device-gfx1201`, `amd-torchvision-device-gfx1201`, `rocm`, `rocm-sdk-core`, `rocm-sdk-device-gfx1201`, `rocm-sdk-libraries`.

Some nested ROCm component legal files exist; that does not establish complete native-wheel redistribution rights. Their lack of top-level metadata is an evidence gap, not proof of a prohibited licence. Collect the precise publisher/distributor terms and bundled component notices before shipping these wheels. Uninspected NVIDIA/CPU/macOS/Linux variants remain outside this conclusion.

Review ownership of branding, generated/copied icons, screenshots, test clips and training data. MuseTalk's published sample media has a non-commercial research limitation; using it for that permitted research is different from shipping it or using it in commercial marketing. This audit cannot establish creator permissions or individual likeness rights from file hashes.

## Downloads and distribution boundaries

| Mechanism found | Licence consequence |
| --- | --- |
| Desktop bundles source, JavaScript, Node, Whisper resources and platform native libraries | Machdoch is redistributing those contents. Required notices/source arrangements belong in the actual installer/artifact. |
| A hosted frontend delivers browser JavaScript | That client code is distributed to browsers even when the server application is not distributed. |
| Fleet manager uses Next.js and sharp only on your hosted server | Server-only use generally differs from giving customers its container, executable or installation archive. A customer-distributed fleet manager must cover its native dependencies. |
| Media installer downloads uv 0.12.13 and manages Python/wheels from upstream | uv's exact-version MIT/Apache texts were verified. CPython and binary wheel components have their own terms. No Machdoch shipment of these complete runtimes was established. Rehosting or bundling them requires a full binary inventory and notices/source review. Downloading directly does not eliminate model use restrictions. |
| Installed Chrome/Edge used by browser automation | No browser binary distribution was established. Playwright code and its notices are separate. |
| GitHub Copilot SDK and CLI | The SDK is MIT. The current Rust configuration disables the SDK's CLI-embedding feature, although its build script downloads a CLI into a cache. Machdoch resolves an installed CLI; no embedded CLI was established. If redistributed later, the CLI has separate terms permitting unmodified redistribution only as part of an application providing material functionality, with its licence/notices. Exact cached 1.0.70 binary terms were not extracted. [Publisher CLI terms](https://github.com/github/copilot-cli/blob/main/LICENSE.md). |
| Optional MCP presets run packages through npx | The five configured packages' current metadata declares MIT/Apache terms; they are unpinned and opted into separately. Their complete changing transitive trees and service terms are not permanently cleared by this snapshot. |
| AI provider integrations and user-installed agent CLIs | SDK licensing does not grant subscription, API, model or account permissions. No unrestricted redistribution/use right is inferred for those services or executables. |

## Machdoch's own licence

There is no single licence forced by React, Tauri, Next.js, CodeMirror, XYFlow or the other permissively licensed frameworks. A missing project licence also does not grant the public open-source rights; see [GitHub's licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

| Intended product policy | Suitable direction, after the blockers are resolved |
| --- | --- |
| Permissive open source, including commercial reuse | **Apache-2.0** is a reasonable recommendation for Machdoch-owned code: it permits commercial reuse and includes an express contributor patent grant. MIT is another option. Neither choice overrides third-party copyleft or model restrictions. |
| Keep Machdoch's original source proprietary | A proprietary licence/EULA is possible with the ordinary permissive dependencies and compliant MPL/LGPL components, provided the ComfyUI-derived issue is removed or separately cleared. Exclude third-party components from claims of exclusive ownership and preserve their rights. |
| Retain GPL-covered derivative code without another grant | Meet GPLv3 obligations for the affected derivative/combined work. Depending on the actual integration, the covered work may extend beyond those individual files. Do not label that combined work Apache-only or proprietary without resolving the scope. |

You normally do not apply for or buy an MIT/Apache/GPL licence: the rights holder chooses terms for code they own, and third-party grants apply when their conditions are met. Separate model enterprise grants, registrations, service agreements or codec patent licences may require an application/payment.

No project licence was applied because ownership and the intended open-source/proprietary policy cannot be established from this audit. Confirm employee/contractor/contributor rights before granting public licences. Merely choosing GPL does not cure missing attributions, model territory/commercial restrictions or unrelated asset rights.

## Release actions

1. Resolve the ComfyUI/Fizgig provenance and GPL scope before any proprietary or Apache-only distribution.
2. Establish which restricted models will actually be used, where and for what purpose. Obtain the required grants/registrations, or exclude those uses. Resolve model subcomponents and the MiniMax activation-grid asset separately.
3. Choose Machdoch's licence/EULA for code you own; add consistent project/package/RPM metadata after resolving ownership and dependency constraints.
4. Generate a versioned licence bundle from the dependencies actually shipped on each platform, including copied code, full native/component notices, and required source-access arrangements. Preserve upstream modification notices where required.
5. Make each release path include that bundle: desktop installers, browser assets, headless archives, fleet-manager distributions and Android packages. Verify built artifacts rather than relying only on source mappings.
6. Freeze and review the supported Python/native runtime variants; obtain complete AMD wheel provenance and corresponding terms. Recheck unpinned optional tools when versions change.

The remaining legal decision is narrow but consequential: establish rights and combined-work scope for the ComfyUI ports, plus the actual model agreements and territories. A licence specialist should review that evidence before release; this repository audit cannot provide that final determination.

## Evidence files

- npm: [locked packages](npm-dependencies.csv), [direct installed versions](npm-direct-installed.csv), [workspace manifest/lock comparison](workspace-direct-dependencies.csv), [unused cache versions](npm-installed-outside-lock.csv).
- Rust: [both-lock inventory](rust-dependencies.csv).
- Android: [runtime coordinates and publisher licences](android-runtime-dependencies.csv), [Gradle resolution output](android-release-runtime.txt).
- Python/native: [direct requirements](python-requirements.csv), [observed environments](python-installed.csv), [FFmpeg flags and hashes](ffmpeg-builds.json), [nested legal-file hashes](embedded-third-party-legal-files.csv).
- Models: [configured profiles](model-profiles.csv), [publisher metadata](model-publisher-metadata.csv), [20 licence-source digest checks](model-license-digests.csv), [restricted-model document checks](restricted-model-license-checks.csv).
- Provenance: [ComfyUI comparisons](copied-code-evidence.csv), [tracked binary asset hashes](tracked-assets.csv), [optional MCP metadata](optional-mcp-presets.csv), [primary-document checks](primary-source-checks.csv).

No final installer, AppImage, RPM, APK, fleet-manager container or complete cross-platform native runtime was unpacked and cleared. The lock inventories include build/dev/optional/target-specific packages and must not be presented as an exact contents list for every release. Source-origin searches and selected comparisons cannot prove the absence of all unattributed copying.
