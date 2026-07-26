# Media Studio local runtime

This document describes the executable local-media path, not a demo or mock
profile. Media Studio still opens without Python, a GPU, FFmpeg, or downloaded
weights; unavailable capabilities fail preflight with a specific remedy.

## Capability-oriented architecture

Flows declare typed media operations and required capabilities. They do not
name a Python class or branch on a model family:

- image, video, and future audio tasks are distinct modalities;
- the compiler binds each task node to a model descriptor through
  `runtimeBindings`;
- providers advertise capabilities such as `text-to-image`,
  `start-end-to-video`, `lora`, `background-remove`, `alpha-video`, and
  `video-composite`;
- model architecture is extensible catalog data. Import and discovery can add
  a compatible checkpoint or add-on without adding another generation screen;
- executable workspace packages are registered through declarative discovered
  runtime profiles in `src/core/media/discovered-model-profiles.ts`, keeping
  family-specific package metadata out of the Studio UI and compiler;
- output, alpha, license, lifecycle, runtime-readiness, and hardware
  constraints are validated before execution.

This boundary lets Stable Diffusion, Pony-family checkpoints, later FLUX/KREA
revisions, and additional video or audio providers reuse the graph, compiler,
catalog, run, and asset contracts.

## Managed model lifecycle

Use **Models → Scan models** to discover workspace packages. Checkpoints and
LoRAs are inspected without importing model code. Import is a reviewed,
content-addressed copy into the app data model store, followed by an offline
load verification of the exact checkpoint digest and pinned runtime
fingerprint. A verified model is then added to the direct-generation
allowlist.

The workspace list is searchable across names, paths, architecture,
capabilities, status, and diagnostics. Importable entries expose a direct
**Review import** action, while long paths and diagnostics wrap without hiding
actions. Safetensors classification is based on bounded header/tensor metadata
rather than its filename or parent folder. One malformed or partially
downloaded file is reported as an actionable unsupported entry and does not
abort the rest of the scan.

Diffusers directories are classified from `model_index.json`, transformer
configuration, component indexes, and download metadata rather than from the
directory name. The WAN executor accepts the preferred
`wan-2.2-ti2v-5b` directory or one uniquely matching renamed package. Multiple
compatible packages are an actionable ambiguity instead of an arbitrary
choice, and other WAN variants remain visible but cannot accidentally execute
through the 5B profile. Execution revalidates all 20 required/indexed
components against the pinned Hugging Face revision and content identities;
the model digest includes those identities, not only file names and sizes.

Discovery is bounded by depth, a scan-wide file budget, and diagnostic count.
Recognized model packages consume the same file budget as ordinary workspace
files, so many packages cannot each restart the limit. Limits also apply inside
a single large directory, an unreadable entry is isolated without aborting the
remaining scan, and JSON manifests larger than 16 MiB are rejected before they
are read into memory. An incomplete package inventory remains visible with a
bounded, actionable diagnostic instead of being treated as execution-ready.

The runtime currently recognizes the following image architecture families:

- Stable Diffusion 1/2, SDXL, SD3;
- FLUX.1 and FLUX.2;
- KREA 2;
- WAN 2.2 TI2V for video.

LoRA compatibility is driven by the selected model's add-on capabilities and
the imported adapter's inspected architecture/target components. Selected
weights, order, strengths, schedules, immutable digests, and worker evidence
are retained in run provenance.

## Pinned Windows AMD path

The Windows worker is launched from
`src-tauri/python/runtime/Scripts/python.exe` in development and from the
equivalent bundled resource in a packaged build. It runs offline with pinned
PyTorch, Diffusers, Transformers, Accelerate, PEFT, Pillow, safetensors, and
imageio-ffmpeg versions.

On hybrid AMD systems the readiness probe first identifies the discrete
adapter, then inference workers set `HIP_VISIBLE_DEVICES` before importing
Torch. The selected adapter becomes process-local `cuda:0`; persisted runtime
identity deliberately ignores that unstable logical ordinal while retaining
the physical adapter label, memory, package tuple, architectures, and
capabilities. Generation evidence must still match the isolated device.

The reference Windows 11 validation system uses an RDNA 4 Radeon RX 9070
(`gfx1201`, 15.92 GiB) through a ROCm PyTorch build. AMD's current Windows
support matrix lists RX 9070/gfx1201 and FP8 on RDNA 4, while noting that
PyTorch—not the complete ROCm stack—is the supported Windows surface:
<https://rocm.docs.amd.com/projects/radeon/en/latest/docs/compatibility.html>.

## Executed model profiles

The exact local variants are discovered from immutable files and manifests;
names are not inferred from filenames at execution time.

- **FLUX.2 klein 4B**: the managed local Diffusers image profile, including
  compatible LoRA loading.
- **KREA 2**: an imported RedCraft 23 INT8/INT4/FP8 checkpoint with a pinned
  Qwen3-VL encoder and Qwen-Image VAE companion bundle. KREA's official
  repository distinguishes RAW training and Turbo inference/LoRA behavior:
  <https://github.com/krea-ai/krea-2>.
- **WAN 2.2 TI2V 5B**: the complete workspace Diffusers package under
  `models/wan-2.2-ti2v-5b`. The Studio exposes bounded `4k+1` frame counts from
  17 through 121. The draft preset is 17 frames at 8 fps and 8 steps; the
  quality preset is a native 640-class, 33-frame, 16 fps, 30-step render. The
  validated 16 GiB Radeon path uses block-level CPU/disk offload, so it remains
  substantially slower than the model card's normal 24 GiB-class workload.
- **BiRefNet Matting**: a managed, checksummed ONNX package used before the
  model-free border-matte fallback.

The Diffusers WAN API supports distinct first and last image conditions. The
connected character-loop template intentionally fans one immutable cutout
asset into both ports:
<https://huggingface.co/docs/diffusers/api/pipelines/wan>.

## Alpha-preserving outputs

Image cutout publishes two lossless assets:

1. a straight-alpha RGBA PNG;
2. its exact 8-bit alpha matte.

WAN produces RGB frames, so transparent video is an explicit post-process:

1. the endpoint character is generated on a uniform chroma-green studio
   background and cut out for the persisted first/last input asset;
2. every WAN frame must retain a predominantly green border or the run fails;
3. a feathered per-frame chroma matte becomes straight RGBA;
4. the requested one-way, ping-pong, or seamless shot policy is applied
   explicitly; one-way action is never silently mirrored;
5. FFmpeg/libvpx encodes `yuva420p` VP9 in WebM with `alpha_mode=1`;
6. the worker forces a libvpx RGBA decode of the complete encoded sequence and
   rejects the result unless its alpha plane, decoded frame count, dimensions,
   codec, and decoded first/last seam stay within the bounded contract.

WebM's alpha representation uses an 8-bit plane in which zero is transparent
and 255 is opaque: <https://wiki.webmproject.org/alpha-channel>.

When the graph includes `source.animated-background` and
`operation.video-composite`, the same verified straight-alpha frame sequence
is composited over a seamless procedural background. It is published as a
second, opaque VP9 WebM; the transparent master remains a separate first-class
asset rather than a preview-only effect.

## Connected character-loop workflow

The built-in **Generated character idle loop** template executes one persisted
graph:

```text
prompt → KREA/FLUX image + optional LoRAs → subject cutout
                                      ├→ WAN first frame
                                      └→ WAN last frame (same asset id)
WAN → transparent VP9 WebM
WAN + animated background → opaque composited VP9 WebM
```

Both execution stages pin the same saved flow revision and plan snapshot.
Published video provenance records the first/last asset ids and digests, model
revision, runtime/adapter evidence, frame/alpha validation, and composite
configuration.

## Distinct-keyframe character action

The **Anime witch beach spellcast** workflow uses two identity-matched but
meaningfully different keyframes. The first is a grounded anticipation pose;
the second has deeper knees, a rotated torso, an arm extended into the cast,
and hair, cape, skirt panels, and ribbons driven in the opposite direction.
The action prompt names anticipation, large hand travel, hip/shoulder rotation,
release, and follow-through instead of asking for a neutral idle loop.

Diffusers 0.39 accepts `last_image` in `WanImageToVideoPipeline`, but the WAN
2.2 5B `expand_timesteps` branch constructs `video_condition` from only the
first image and masks only latent frame zero. The implementation is visible in
the upstream
[`prepare_latents`](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/wan/pipeline_wan_i2v.py)
path. Machdoch now constructs one complete temporal condition before a single
causal VAE encode: the first frame occupies sample zero, neutral frames occupy
the unobserved middle, and the terminal image is repeated over the final
four-sample VAE stride. Only the first and last latent slots are locked during
denoising. This preserves the VAE's temporal context while making the terminal
condition effective in the 5B branch. For a distinct endpoint it also eases a bounded,
reference-calibrated color recovery into the final three forward frames and
restores the exact reviewed endpoint pixels at the terminal frame. The worker
records `first-last-temporal-context-lock-v3` plus
`endpoint-reference-color-and-pixel-restore-v3` evidence; same-endpoint loops
do not run endpoint restoration.

The `enchanted-beach` animated-background style adds independent periodic
sunset clouds, aurora bands, ocean ripples and crests, foam, reflected hand
magic, runes, motes, and boot spray. It composites those layers after the
transparent character, so the environmental interaction does not replace or
hide the foreground body action.

The isolated developer store contains the completed run
`run:anime-witch-beach-spellcast-v1` and saved flow
`flow:anime-witch-beach-spellcast-v1`, revision
`mfr-291358796d3593b09efe965390969746`. The 12-step Radeon RX 9070 render has
17 forward frames expanded to a 33-frame, 512 x 288, 8 fps ping-pong loop. Its
transparent master digest is
`15459064399f75be9ea41e1a832c2bb2689506d9a9ff0c69a8dcaa3b4f5b3ec3`;
the enchanted-beach companion digest is
`fd817da2eab1b151f247e2d8f03503845cf610253e2f260593e9864abe7a6078`.
Independent libvpx/FFmpeg decoding found alpha values 0-255, 33 frames in both
files, decoded loop-endpoint MAE `0.015482584635416666` for the alpha master
and `0.01970305266203704` for the composite.

Frame review measured first-to-release silhouette IoU `0.55867`, down from
`0.94411` in the rejected static-character attempt. Mean consecutive
foreground optical flow increased from `0.4865` to `2.3785`, and maximum flow
from `0.9210` to `14.4552`. Visual review confirmed the wider planted stance,
torso turn, extended casting arm, crossing support arm, head turn, and strong
hair/cape/ribbon sweep alongside the animated water and spell layers.

## Large-library and responsive behavior

The native asset and run catalogs use opaque database-instance identities,
monotonic revisions, and stable page queries. The UI reconstructs a coherent
snapshot across every native page, retries if the revision changes mid-read,
and reuses the cached snapshot when nothing changed. Asset lineage, tags, and
reviews are hydrated only for the current native page. This removes the former
200-asset and 100-run visibility ceilings without loading the entire catalog on
every poll.

The asset library, model add-on library, and reference picker render 24 cards
per page; workspace discovery renders 50 model records per page, managed models
render 16, run history renders 30, and composite/contact-sheet pickers render
20. Search resets to the first page, deep links select the page containing
their asset, and page bounds recover when a scan or filter changes. Paging
returns keyboard focus and scroll position to the result heading. Searches
match every whitespace-separated term across rich metadata: assets include
lineage, operation details, aliases, tags, ids, and digests; models include
family, provider, capabilities, license, runtime, acquisition, and verification
metadata; add-ons include architecture, targets, trigger tokens, source,
license, digest, and path.

Active add-ons remain pinned above filtered inactive results so they can always
be disabled after a model change. Generation controls enforce the selected
model's declared concurrent-add-on limit before submission and explain the
limit in place. Model install, import, rescan, probe, and external-runtime
actions are selected from capability-oriented acquisition and verification
metadata rather than provider-name conditionals.

Slideshow remains in the library header and always uses the complete filtered
visual set, not only the rendered page. Video cards are non-interactive
previews; transport controls are exposed only inside the dedicated slideshow
dialog so cards do not contain nested controls.

Review dialogs use a bounded viewport layout with an independently scrolling
body and a persistent action footer. This keeps license acceptance, import,
delete, export, composite, contact-sheet, and runtime-install actions
reachable at the supported 960 x 720 minimum window size. Model/runtime/run
refreshes use newest-request ownership so a slow older scan cannot replace a
newer result or change the currently selected run. Runtime refresh uses a
synchronous request lock to reject same-render double activation. Asset
dependency inspection is independently cancelable and stale delete plans
cannot reopen or overwrite a newer dialog.

## Development and verification notes

The repository `.taurignore` excludes the managed Python runtime and bytecode
cache from desktop source watching. Installing or running the worker therefore
does not trigger a recursive Tauri rebuild.

The validated worker contract is `1.10.0` on Python 3.12.10 with PyTorch
`2.12.0+rocm7.14.0`, HIP 7.14, and Diffusers 0.39. Runtime readiness, imported
model metadata, saved graph revisions, and generation provenance are persisted
separately: upgrading the worker does not rewrite evidence from an older
completed run.

The isolated developer store contains the following immutable reference
evidence:

- `run:e2e-final-flux-dog-lora-v1`: FLUX.2 klein 4B plus a compatible LoRA,
  worker 1.10.0 on Radeon RX 9070;
- `run:e2e-connected-krea-lora-image-v2`: KREA 2 RedCraft 23 plus the KREA
  realism LoRA and subject cutout;
- `run:e2e-connected-wan-loop-v3`: WAN 2.2 TI2V 5B with the same KREA asset
  and digest recorded for first and last conditions;
- `flow:e2e-connected-krea-wan-loop`, revision
  `mfr-8cdc5107f211387095223738d1c5661c`: eight nodes and nine edges.

The WAN run published a 33-frame 512 x 512 transparent VP9 WebM with decoded
alpha range 0-255 and decoded endpoint MAE `0.01340961456298828`, plus a
33-frame opaque animated-background companion. Both current CAS files hash to
their persisted SHA-256 digests. A browser acceptance exercise at 960 x 720
with 104 discovered models, 61 add-ons, and 53 assets verified result paging
and focus recovery, rich-metadata search, header-level Slideshow access to all
53 filtered visuals, cancelable slow dependency inspection, and no document
overflow or console errors.
