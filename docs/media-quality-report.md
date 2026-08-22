# Machdoch media quality investigation and delivery

Date: 2026-07-28

## 2026-07-28 accepted HunyuanVideo 1.5 delivery

This section supersedes the earlier FramePack-driver blocker and the WAN 2.2
TI2V 5B acceptance below. The best verified local path on the reference
16 GiB AMD GPU is now the pinned HunyuanVideo 1.5 480p I2V step-distilled
model. The accepted result has visibly continuous body, arm, robe, hair, and
spell motion without the WAN clip's prolonged holds and endpoint snap, and
without the optical-flow prototype's ghost limbs.

The selection follows the current official
[Wan research index](https://wan.video/research-and-open-source),
[Wan2.2 repository](https://github.com/Wan-Video/Wan2.2),
[HunyuanVideo 1.5 repository](https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5),
[HunyuanVideo prompt guide](https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5/blob/main/assets/HunyuanVideo_1_5_Prompt_Handbook_EN.md),
[HunyuanVideo 1.5 Diffusers model collection](https://huggingface.co/collections/hunyuanvideo-community/hunyuanvideo-15),
[FramePack repository](https://github.com/lllyasviel/FramePack),
[Diffusers memory guide](https://huggingface.co/docs/diffusers/optimization/memory),
[LTX-Video repository](https://github.com/Lightricks/LTX-Video), and
[LTX-2 repository](https://github.com/Lightricks/LTX-2). Hunyuan's official
step-distilled profile specifies guidance 1 and 8 or 12 sampling steps. Its
8.3B I2V model is the strongest open path tested here that both improved the
actual frames and completed reliably on this 16 GiB/32 GiB host. FramePack is
retained for genuinely distinct first and last references. LTX-Video 2B remains
the CPU and low-VRAM path, while LTX-Video 13B remains available for
text-to-video and multi-keyframe work. LTX-2.3 is the preferred future
audio/video, lip-sync, IC-LoRA, pose, camera-control, and two-stage-upscale
integration boundary, but its 22B model plus required upscalers was not a
defensible download for this 16 GiB/32 GiB validation host.

Wan Animate 14B was not substituted for the general I2V path: its official
contract requires a character reference plus a preprocessed pose or facial
motion video, making it an appropriate explicit motion-control stage rather
than a transparent replacement for start-image animation. The official
Hunyuan 720p and 1080p super-resolution transformers are about 33.3 GB each
before the base I2V package. Adding either would exceed the useful storage and
host-memory envelope of this machine without addressing the primary motion
defect, so neither was downloaded. Native 848x480 generation followed by
lossless delivery remains the defensible 16 GiB quality path; super-resolution
stays an optional, separately reviewed stage for larger hosts.

### Accepted witch comparison

The accepted live desktop run is
`run:hunyuanvideo-1-5-quality-3ea9c2bc-a9f9-49a0-8f2c-4352e76526da`
from immutable flow revision `mfr-8d5925e65b6cd855d16d86bed8dca727`.
It used model revision
`854c04a4c8a53d990b418c7478f0802c0fc8c726`, BF16 checkpoint storage
and compute, four-block CPU offload, 848x480, 33 source frames, 16 fps,
12 distilled steps, guidance 1, and seed `72526022`. Total worker time was
1264.13 seconds with no out-of-memory failure.

Retained outputs:

- transparent master:
  `tmp/quality-evidence/2026-07-28-hunyuan-quality-33f-12step/witch-hunyuan-33f-transparent.webm`,
  SHA-256
  `bcd6067c1808d8c1cf4f88a4945ec13c75868be9d47c3b9c0ffafbaa3af47386`;
- opaque animated-background companion:
  `tmp/quality-evidence/2026-07-28-hunyuan-quality-33f-12step/witch-hunyuan-33f-composite.webm`,
  SHA-256
  `bb6342bea8d8c596e5b1ddfd18be879d81836ebb62e5ef9f0ff64510b1c98587`;
- decoded metrics and every-frame plates:
  `tmp/quality-evidence/2026-07-28-hunyuan-quality-33f-12step/evaluation/report.json`;
- companion decode evidence:
  `tmp/quality-evidence/2026-07-28-hunyuan-quality-33f-12step/composite-evaluation/report.json`.

Every one of the 33 frames was reviewed at full contact-sheet scale on alpha,
checker, white, black, cyan, and magenta plates. The casting arm progresses
continuously from the resting pose to full extension; the supporting arm and
torso counterbalance it; hair and robe react without becoming extra limbs; the
spell grows coherently; and the face, two arms, two legs, costume, framing,
first frame, and transparent subject remain valid. There is no ghost-limb
transition or abrupt final-pose replacement. The prompt's requested two planted
steps are not fully realized, and the result is softer than WAN, so this is a
strong consumer-GPU result rather than studio-grade animation.

| Measurement | WAN 2.2 5B accepted baseline | HunyuanVideo 1.5 accepted | Interpretation |
| --- | ---: | ---: | --- |
| Foreground optical flow | 0.643356 | 1.311776 | 104% more meaningful motion |
| Motion-compensated RGB residual | 4.738 | 3.876 | More motion with less residual error |
| High-frequency residual | 3.382 | 3.214 | Slightly less texture crawl |
| Alpha instability | 5.208 | 3.692 | 29% lower |
| Alpha coverage standard deviation | 0.003594 | 0.000727 | 80% lower |
| Subject sharpness | 4315 | 2353 | Softer; retained limitation |

The metric table is supporting evidence, not the acceptance decision. The
decision came from complete-frame visual review of anatomy, action continuity,
identity, endpoints, background, and transparency.

### General image, LoRA, and non-character validation

The existing saved FLUX dog-LoRA flow was upgraded to the current memory
contract and executed through the Tauri application:

- run
  `run:flux-dog-lora-quality-7ea3d052-2c9e-45e8-907e-f56244aeca3a`;
- exact LoRA digest
  `438618...`, strength 0.8, four FLUX distilled steps;
- retained 512x512 PNG:
  `tmp/quality-evidence/2026-07-28-flux-dog-lora-live/flux-dog-lora.png`,
  SHA-256
  `6ec8f651ea44c2398566bbb9cf4f958a30fd0010c0fe4037c1217ad087fb906d`.

The result is a clean golden-retriever studio image with stable eyes, muzzle,
ears, body, paws, and fur. The exact add-on identity and effective strength are
persisted in asset provenance, exercising the ordinary image and LoRA path
rather than only the witch fixture.

Opaque I2V initially exposed a general framing bug: square photography was
blindly center-cropped into 16:9, cutting off the head and lower body. The
conditioning boundary now preserves opaque photographs with aspect-safe
`contain` placement over a border-median background.

The final exact-chain validation uses the newly generated FLUX LoRA asset above,
not a previously saved substitute:

- run
  `run:hunyuanvideo-1-5-general-motion-b0816d70-fe5e-4833-8c4d-d6749f41fb3c`;
- immutable flow revision `mfr-cb2b1c7783d969854b0b768e0457dfa7`;
- exact source asset
  `asset:run:flux-dog-lora-quality-7ea3d052-2c9e-45e8-907e-f56244aeca3a:0`,
  SHA-256
  `6ec8f651ea44c2398566bbb9cf4f958a30fd0010c0fe4037c1217ad087fb906d`;
- HunyuanVideo 1.5, 672x384, 17 frames, 16 fps, 8 distilled steps,
  guidance 1, and seed `72526025`;
- 598.591 seconds total, no out-of-memory failure.

The persisted framing contract records a 384x384 placement, 144-pixel
left/right margins, no stretch, and `croppedSubject=false`.

Retained comparison:

- exact FLUX-LoRA-to-Hunyuan clip:
  `tmp/quality-evidence/2026-07-28-flux-lora-to-hunyuan-exact/dog-motion.webm`,
  SHA-256
  `d31c793bd37d40e1782b3c56d711197f7c7d0b1f360eaa3f8796e797b38fb09a`;
- all-frame exact-versus-prior-padded evidence:
  `tmp/quality-evidence/2026-07-28-flux-lora-to-hunyuan-exact/evaluation/report.json`;
- real Tauri library screenshot:
  `tmp/quality-evidence/2026-07-28-flux-lora-to-hunyuan-exact/tauri-library.png`;
- real Tauri model inventory after cleanup:
  `tmp/quality-evidence/2026-07-28-flux-lora-to-hunyuan-exact/tauri-model-discovery.json`.

All 17 exact-chain frames retain the complete animal. The tail swings while the
left forepaw rises progressively in frames 12-16; eyes, muzzle, ears, torso,
four-leg structure, and studio composition remain coherent without duplication,
fused joints, ghosting, or cropped anatomy. Its mean sharpness is 33.195,
motion-compensated residual is 0.938, and high-frequency residual is 0.451.
Motion is conservative and weighted toward the final third, so this validates
the general image/LoRA/I2V composition and lifecycle rather than superseding
the accepted witch clip as the motion-quality result. The earlier aspect-safe
run remains in
`tmp/quality-evidence/2026-07-28-hunyuan-general-dog-17f-padded/` for the
original padded-versus-cropped comparison.

### Hardware-aware execution and observed lifecycle

The model selector and worker use capabilities, available model artifacts,
usable device memory, physical RAM, task type, requested quality, and endpoint
requirements:

| Hardware/task envelope | Selected path |
| --- | --- |
| CPU only or approximately 6-13 GiB VRAM | LTX-Video 2B distilled FP8, 8 steps, conservative dimensions; CPU execution allowed |
| 14-15 GiB BF16-capable GPU plus at least 30 GiB RAM | HunyuanVideo 1.5 with FP8 storage, BF16 layerwise compute, aggressive offload |
| Reference nominal 16 GiB GPU / 32 GiB RAM | HunyuanVideo 1.5 BF16 storage and compute, four-block CPU offload, 8-step preview or 12-step 640-class quality |
| Distinct first and last references on a capable GPU | FramePack with endpoint-preserving temporal selection |
| Text-to-video or multi-keyframe fallback | LTX-Video 2B/13B according to available hardware |
| 24 GiB or larger GPU | Less aggressive offload, 768-class dimensions and/or longer 4k+1 frame contracts remain available |

Only the 16 GiB RX 9070 / 32 GiB RAM row was physically exercised. CPU,
8 GiB, 14 GiB, and 24+ GiB choices are covered by selection/configuration tests,
not physical machines.

Hunyuan prompt encoding, denoising, and VAE decoding have separate ownership
and lifetimes. The prompt encoder writes CPU safetensors and exits before the
transformer loads. The denoiser streams signed shards into its model rather
than first materializing a duplicate state dictionary, writes CPU latents, and
exits before the parent loads the VAE. During the accepted witch run:

- peak allocated GPU memory was 7,159,916,032 bytes and peak reserved memory
  was 9,604,956,160 bytes;
- post-release allocation was 79,691,776 bytes and post-release device free
  memory was 16,743,792,640 bytes;
- the observed process order was
  `prompt-encoder-subprocess -> denoiser-subprocess -> vae-parent`.

The exact-chain dog rerun independently repeated the transition. Its denoiser
process reached 33,558,454,272 bytes private host memory, exited completely,
and the parent then entered VAE decoding. Persisted Torch evidence reports
4,933,580,800 bytes peak allocated, 6,228,541,440 peak reserved,
79,691,776 bytes after release, and 16,743,792,640 bytes free after release.
The per-stage peaks are 3,952,685,568 bytes for the prompt encoder,
2,683,149,312 bytes for the denoiser, and 4,933,580,800 bytes for VAE and
post-processing. A transient native prompt-child exit on an immediate repeat
also exposed a diagnostic gap; the worker now retries one empty/native exit in
a fresh directory and reports the bounded stderr plus native exit code if the
retry fails.

This process isolation also applies between image and video nodes: the live
FLUX process exited before the Hunyuan generation was launched, so image model
weights could not remain resident and block the video stage. Sleep inhibition
is reference-counted across long media and desktop tasks and releases on
success, failure, cancellation, and application shutdown.

### Integrated behavior and remaining limits

The compiler now chooses Hunyuan for one-reference I2V, FramePack for genuinely
different start/end references, and LTX on unsupported or lower-resource
hardware. Model-native dimensions, frame forms, distilled sampling, guidance,
memory policy, VAE tiling, provenance, negative-prompt applicability, and
endpoint semantics are normalized at their integration boundaries. The normal
Flow UI exposes model-aware presets, effective steps/guidance, complete saved
workflow selection, and an accurate Hunyuan first-frame gate. The Library keeps
Slideshow at the top, shows all records through explicit pagination, and
retains full-frame alpha/player review controls.

The post-acceptance UI pass makes the native frame envelope visible before a
long render (`17–121, 4k+1` for Hunyuan, `17–129, 4k+1` for FramePack, and
`9–257, 8k+1` for LTX). Persisted Hunyuan operations now have a complete
TypeScript provenance contract. Model-aligned canvases are labeled by the
requested aspect (`16:9 model-aligned`) instead of exposing implementation
fractions such as `7:4`, while unrecognized assets report their exact pixel
ratio.

Hunyuan step-distilled I2V does not apply a separate negative-prompt branch;
provenance records `negativePromptApplied=false` instead of pretending
otherwise. It also does not natively condition on a terminal frame. FramePack
remains the correct distinct-endpoint path, while its current witch result was
rejected for insufficient motion. The installed LTX 13B candidate was rejected
for severe dissolution, identity loss, and malformed anatomy. The accepted
Hunyuan output is softer than WAN and does not provide explicit pose, planted
foot, contact, camera-path, audio, voice, or lip-sync control. Those remain
future model/stage integrations rather than hidden post-processing claims.

The model artifact added for the accepted replacement is
`models/hunyuan-video-1.5-i2v-step-distilled`, revision
`854c04a4c8a53d990b418c7478f0802c0fc8c726`, occupying 34,637,007,471 bytes.
No Wan Animate, Hunyuan super-resolution, or LTX-2.3 artifacts were downloaded.

The superseded `models/wan-2.2-ti2v-5b` package was permanently removed after
the Hunyuan character and general-video replacements passed. It occupied
64,270,950,708 bytes (59.857 GiB). Two stale Hunyuan `.incomplete` downloads
totaling 9,125,870,066 bytes were also removed. A superseded LTX
`runtime/transformer-offload` cache (13,045,700,552 bytes) and the non-executable
`models/Wan-Alpha` source clone (164,570,552 bytes) were then removed after
confirming that neither was referenced by the current worker. Total permanent
cleanup was 86,607,091,878 bytes. The executable LTX package
(41,892,975,285 bytes after cleanup), FramePack package, and active FramePack
FP8 cache were retained because they still own low-resource/text-to-video,
distinct-endpoint, and executable runtime capabilities respectively.

### Current verification and final Tauri state

The exact post-change source state passed:

- Python worker suite: 33 passed;
- Rust library suite: 401 passed, zero failed, one pre-existing reviewed-model
  test ignored;
- Vitest: 223 files passed, 1,988 tests passed, one skipped, zero failed;
- TypeScript core, UI, test, and logic-test typechecks;
- Oxlint, `cargo fmt --check`, and `git diff --check`;
- production core TypeScript build and production Vite UI build;
- Tauri debug production-path build with `--no-bundle`;
- optimized Tauri release build with `--no-bundle`
  (`apps/client/src-tauri/target/release/machdoch.exe`).

The production Vite build also verifies that the MCP quality driver is absent
from release chunks. It remains available only in the explicit debug build
used for the live application checks.

The final rebuilt desktop binary was opened through Tauri MCP and the saved
`Animate image - r8` flow was selected through its normal Workflows UI. The
selected video node showed:

- HunyuanVideo 1.5 as the effective executable model;
- eight sampling steps and guidance 1;
- complete, uncropped source thumbnails on the canvas and in the keyframe gate;
- the native-first-frame explanation and model-authored-ending limitation;
- a valid `17 source frames fit the native 17–121, 4k+1 contract` indicator;
- 672x384, 17 delivered frames, 16 fps, opaque lossless delivery;
- an enabled local run action.

The final Library showed `34 visual · 34 of 34 records`, `Showing 1-24 of 34
assets`, explicit page 1 of 2 navigation, and Slideshow at the top without
requiring a scroll to the bottom. Retained final-state evidence:

- normal Hunyuan inspector:
  `tmp/quality-evidence/2026-07-28-final-verification/tauri-final-hunyuan-inspector-contained.png`;
- Library:
  `tmp/quality-evidence/2026-07-28-final-verification/tauri-final-library-contained.png`;
- persisted exact-chain run detail:
  `tmp/quality-evidence/2026-07-28-final-verification/tauri-final-run-detail.json`;
- verification logs:
  `tmp/quality-evidence/2026-07-28-final-verification/`.

The final post-cleanup developer binary bound its debug-only MCP automation
bridge to `127.0.0.1`, not all network interfaces. A fresh live model scan
returned ten entries with no warnings or truncation: Hunyuan and FramePack
remained ready, LTX remained ready at its reduced size, and neither the WAN
package, Wan source clone, nor stale LTX cache reappeared. The Library opened
all 34 records, showed `16:9 model-aligned` on Hunyuan output cards, and the
accepted 848x480 transparent witch clip was stepped to frames 17 and 33 on a
magenta plate. Both frames retained a clean silhouette, two arms, two legs,
face, costume, and coherent spell action. The MCP console contained no
application errors after this pass.

Additional retained evidence:

- post-cleanup Library:
  `tmp/quality-evidence/2026-07-28-post-cleanup-verification/tauri-post-cleanup-library.png`;
- Hunyuan frame-contract inspector:
  `tmp/quality-evidence/2026-07-28-post-cleanup-verification/tauri-post-cleanup-hunyuan-inspector.png`;
- post-cleanup Models UI and exact MCP inventory:
  `tmp/quality-evidence/2026-07-28-post-cleanup-verification/tauri-post-cleanup-models.png`
  and
  `tmp/quality-evidence/2026-07-28-post-cleanup-verification/tauri-post-cleanup-model-discovery.json`;
- accepted witch frame 17 and frame 33 live magenta review:
  `tmp/quality-evidence/2026-07-28-post-cleanup-verification/tauri-accepted-witch-mid-magenta.png`
  and
  `tmp/quality-evidence/2026-07-28-post-cleanup-verification/tauri-accepted-witch-end-magenta.png`.

## Earlier 2026-07-28 FramePack investigation (superseded)

At that point, the WAN 2.2 TI2V 5B result below remained the accepted visual
baseline. That continuation integrated the installed FramePack I2V HY 13B
package, but did not promote an incomplete candidate or claim a visual
improvement without reviewing every output frame.

Official research and implementation references were the
[Wan research index](https://wan.video/research-and-open-source),
[Wan2.2 repository](https://github.com/Wan-Video/Wan2.2),
[FramePack repository](https://github.com/lllyasviel/FramePack),
[Diffusers FramePack documentation](https://huggingface.co/docs/diffusers/api/pipelines/framepack),
[Diffusers memory guide](https://huggingface.co/docs/diffusers/optimization/memory),
[LTX-Video repository](https://github.com/Lightricks/LTX-Video), and
[LTX-2 repository](https://github.com/Lightricks/LTX-2). FramePack's inverted
anti-drifting first/last-frame mode was selected because it directly addresses
the current endpoint-conditioned workflow without synthetic optical-flow
retiming.

Implemented changes:

- FramePack prompt encoders run in a short-lived subprocess. Prompt embeddings
  are transferred through a temporary safetensors file, then the process exits
  before the transformer loads. On the reference host the prompt child reached
  about 32.6 GiB committed memory while the video parent remained near
  1.2 GiB; the child released completely before generation.
- FramePack now decodes the complete 37-frame temporal section and selects the
  requested 17 or 33 frames by endpoint-preserving nearest sampling. The former
  prefix crop could discard the end-conditioned half. The new path preserves
  both endpoints and creates no interpolated ghost frames.
- Model-aware presets expose FramePack's guidance 9 and LTX distilled
  8-step/guidance-1 trajectory in both the inspector and execution request.
  LTX 768-class dimensions are aligned to its supported multiples instead of
  being silently changed in the worker.
- The Flow run action accepts any executable discovered local video model
  rather than searching only for the WAN model id. WAN-specific keyframe and
  completion wording was removed from the general UI.
- Offload group size is capped by reported VRAM: one block at 8 GiB, two at
  12 GiB, and four at nominal 16 GiB or more. Cache identity includes the group
  size. Auto uses RAM-backed offload on a nominal 16 GiB GPU with at least
  30 GiB physical RAM, and FramePack rejects hosts below 30 GiB physical RAM
  before loading its prompt encoders.

Measured rejected candidates:

| Candidate | Outcome |
| --- | --- |
| LTX-Video 0.9.8 13B distilled FP8, multiscale | Completed in 556.9 seconds with 9.62 GiB peak allocation and 33.7 MiB after release, but every-frame review showed severe green/brown dissolution, identity loss, and malformed anatomy. |
| FramePack, RAM-backed block offload | Reached about 14.2 GiB dedicated GPU memory and roughly 32–34 GiB host commit. Earlier diagnostic attempts were stopped after invalid temporal prefix cropping was identified; no result from that invalid crop was accepted. |
| FramePack, one-block disk offload | Built 61 groups / 17.23 GiB, then starved GPU compute and made ordinary shell probes take 14–60 seconds. Rejected as non-interactive. |
| FramePack, four-block disk offload | Built a signed 31-group / 17.23 GiB cache for inventory digest `sha256:e182a7bb6f96f02f8035210602ff4016dfee4741fa2fccb10884b75f5ea0b363`; conditioning sampled 22% average / 35% peak compute versus about 7.6% for one-block groups. The first transformer pass then entered a driver/storage wait. PowerShell termination, `taskkill /F`, and the Windows process API could not reap PID 20932. |

The final driver wait is a concrete live-validation blocker. It prevented a
completed FramePack candidate, a rebuilt Tauri run, model deletion, and final
post-change test/build execution in this session. Clearing it requires a GPU
device reset or host restart, neither of which was performed because it could
disrupt unrelated user work. The automatic policy was changed away from this
disk path before stopping so the next normal run will not reproduce it by
default.

Before the driver wait, focused verification completed successfully:

- 24 Python worker tests, including temporal selection and 8/12/16/24 GiB
  memory-profile selection;
- 49 Vitest compiler, template, and quality-helper tests;
- all core, UI, test, and logic-test TypeScript typechecks.

The visual acceptance criteria remain open. In particular, the existing witch
baseline has not yet been replaced by a fully decoded, all-frame-reviewed
FramePack result.

## 2026-07-27 continuation, correction, and current outcome

The previous **76.8/100** witch acceptance is withdrawn. Full-size endpoint
review found that `tmp/witch-krea-identity-end-v2/output-0000.png` has a third
arm/hand. The earlier semantic score therefore accepted an invalid keyframe,
and the resulting video cannot be a flagship result regardless of its measured
sharpness or clean alpha. This continuation uses
`tmp/witch-krea-two-arm-endpoint-v2/output-0003.png` instead: it has exactly two
arms and two legs, is 704x384, and has SHA-256
`e4d4b8115c893765e37a8b167633f2db23aa2a84f2432838a67b5e2c394e118f`.

The strongest **workflow and transparency** result produced through the actual
Tauri application is:

- run `fabcfd3c-b8ed-45fa-8788-b46f5de5bd49`;
- catalog asset `asset:fabcfd3c-b8ed-45fa-8788-b46f5de5bd49:0`;
- `tmp/quality-evidence/2026-07-27-tauri-final-alpha.webm`, 640x352,
  33 frames at 16 fps, 2.0625 seconds, lossless VP9 alpha;
- SHA-256
  `e2d7592043afb6a4bf93232a6b015471c7e8fcc065060173db00971dd07caaeb`;
- independent decode and comparison:
  `tmp/quality-evidence/2026-07-27-tauri-final-comparison/report.json`;
- all-frame transparency plates:
  `tmp/quality-evidence/2026-07-27-tauri-all-frames-magenta.png` and
  `tmp/quality-evidence/2026-07-27-tauri-all-frames-alpha.png`.

This clip preserves exactly two arms and two legs in all 33 reviewed frames,
retains the whole subject in alpha, and plays/steps reliably in the Tauri
reviewer. It is **not** accepted as first-class character animation. Frames
0-8 and 14-28 are long near-static holds, with visible pose changes around
frames 9-14 and an endpoint correction at frames 29-32. Its foreground optical
flow is only 0.643 pixels versus 1.640 for the superseded 17-frame master.
Normal playback therefore reads as a small number of pose changes rather than
continuous hand-drawn motion.

Two further attempts were rejected instead of being promoted:

- Motion-compensated retiming reduced transition outliers but created visible
  ghost arms and cut sharpness from 4315 to 2967. Evidence is in
  `tmp/quality-evidence/2026-07-27-retime-prototype-eval/`.
- A 512-class seed screen produced giant duplicated limb/garment structures
  through frames 3-12. A subsequent full 640/30-step reroll remained nearly
  static in a different intermediate pose through frames 2-29 and then snapped
  to the endpoint. The all-frame plates are
  `tmp/quality-evidence/2026-07-27-motion-screen-seed9137-all.png` and
  `tmp/quality-evidence/2026-07-27-quality-reroll-all-magenta.png`.

The current local blocker is the installed WAN 2.2 TI2V 5B first/last-frame
model on the 16 GiB AMD device. Prompt/seed tuning can trade static topology
for malformed dynamic anatomy, but it did not produce continuous valid motion.
The proper next model path is explicit pose/motion conditioning (WAN Animate or
VACE) or a stronger connected video provider. Neither is installed or
configured in this workspace, so this report does not claim commercial-model
or major-studio output quality.

### Implemented continuation changes

- Production primary-subject isolation is now fail-safe. If an opaque-core
  candidate would discard more than 65 percent of existing foreground, the
  worker preserves the original matte instead of deleting the character.
- Component cleanup now chooses the component with the strongest opaque
  evidence before considering border contact or raw area. A faint screen-spill
  bridge can no longer make a tiny detached hand highlight replace the actual
  subject.
- Generated WAN provenance now drives exact video FPS and alpha capability in
  the UI.
- The video node has a direct first/last keyframe gate with both previews,
  dimensions, unique reviewed-asset count, runtime-source status, and an
  explicit face/hands/limbs/costume/framing warning.
- The library preview now has frame stepping, an exact generated frame/time
  readout, a timeline, 0.25x/0.5x/1x/2x playback, keyboard controls, and
  checker/white/black/magenta/green/alpha review modes. Library cards do not
  autoplay videos.
- The actual application showed all 19 of 19 catalog records without hiding
  entries, published the new video into durable CAS, played the original WebM,
  stepped to frame 29, and rendered its decoded alpha plane.

These decisions align with current commercial workflow patterns without
pretending the local model matches their generators. Adobe Firefly exposes
first/last frames plus transparent-background preview on multiple solid plates
and an alpha-only view
([Adobe documentation](https://helpx.adobe.com/firefly/web/work-with-audio-and-video/work-with-video/generate-videos-with-transparent-backgrounds.html)).
Google Flow emphasizes reusable visual ingredients, frame-based shot control,
asset management, camera control, and scene extension
([Flow overview](https://blog.google/innovation-and-ai/products/google-flow-veo-ai-filmmaking-tool/),
[workflow guidance](https://blog.google/innovation-and-ai/products/flow-video-tips/)).
Runway Gen-4 similarly treats visual references and consistent subjects,
objects, locations, and styles as core production controls
([Runway research](https://runwayml.com/research/introducing-runway-gen-4)).
Machdoch's review and keyframe changes implement the locally supportable parts
of those patterns; multi-shot pose control remains the documented gap.

### Measured continuation evidence

| Measurement | Superseded 17-frame master | Valid Tauri result | Interpretation |
| --- | ---: | ---: | --- |
| Subject sharpness | 5921.409 | 4315.462 | Lower; valid result is softer |
| Foreground optical flow | 1.640 | 0.643 | Too little continuous motion |
| Motion-compensated RGB residual | 7.963 | 4.738 | Less flicker, partly because of holds |
| High-frequency residual | 5.874 | 3.382 | Less texture crawl, partly because of holds |
| Alpha instability | 5.589 | 5.208 | 6.8% lower |
| Alpha coverage standard deviation | 0.009125 | 0.003594 | 60.6% lower |
| Meaningful components/frame | 1.529 | 1.182 | Cleaner connected matte |
| Positive green spill at edge | 2.090 | 3.219 | Worse; visible plates remain acceptable |

The alpha fail-safe was driven by two identical-generation repair iterations.
Before the opaque-evidence selection fix, the v4 matte had alpha instability
78.283 and coverage standard deviation 0.071966. Component selection reduced
those to 34.072 and 0.046610 in v5, but three frames were still almost entirely
deleted by primary isolation. The new v2 guard retained all 33 subject mattes
in the app render, with coverage standard deviation 0.003594. This is a real
transparency fix; it does not solve the generator's motion model.

## Superseded 2026-07-26 outcome

The selected witch release is a substantial, measured improvement over the
recovered baseline, but it is not major-studio animation. It reaches Machdoch's
local consumer-GPU acceptance threshold at **76.8/100**. The remaining visible
limit is character mechanics: the spell-casting arm has a short early ghost and
the 5B first/last-frame model does not provide explicit pose, contact, or planted
foot control. This report does not relabel resolution, codec success, or an
automated score as studio quality.

The strongest reviewed witch masters are:

- Transparent:
  `tmp/witch-wan-quality-final/output-0000.webm`, 640x352, 17 frames,
  8 fps, lossless VP9 alpha, SHA-256
  `35d72b11e6c8b59963d9f92116f875a4a9ed930cfcd92ba28bdfb6a065c268b7`.
- Enchanted-beach composite:
  `tmp/witch-wan-quality-final/output-0001.webm`, 640x352, 17 frames,
  8 fps, lossless VP9, SHA-256
  `6accd5e3c530e4d1dc8c5377f613650ca2ea977c727838834c7ad7303e83c552`.
- Direct before/after alpha evidence:
  `tmp/quality-evidence/witch-final/before-after-alpha-magenta.png`.
- Complete decoded evidence:
  `tmp/quality-evidence/witch-final/report.json`.

The selected realistic supporting samples are:

- Clean square idle loop:
  `tmp/realistic-idle-quality-final-v15/output-0000.webm`, SHA-256
  `baeeb4c9c74d7f1a1177f9863f7a52c2a8b0a6044bc6196de6bdbd3481c41de1`.
- Portrait forward-step stress test, transparent:
  `tmp/realistic-walk-quality-final-v15-final/output-0000.webm`, SHA-256
  `20b81caca53592a26ecd1e95e0113f9cc43259207861d808757f3ba7c5d13363`.
- The same step over a custom animated gradient:
  `tmp/realistic-walk-quality-final-v15-final/output-0001.webm`, SHA-256
  `aee63630a0d1531f77273f0e5385181beec05309fbcabcd33b0adaf55a0dde40`.
- Style-reference stress result:
  `tmp/anime-style-reference-landscape-v2/output-0000.png`, 704x384 RGB,
  SHA-256
  `a72764e175d620bc456d9a17e104de3b0d70227be3472ed9bf20046bb8b61260`.
  The direct source/output plate is
  `tmp/quality-evidence/style-reference-final/source-vs-style-output.png`.

The forward-step sample is useful evidence, not a second flagship. It has real
body and limb displacement and preserves the character better than an
unconditioned reroll, but its foot motion reads partly as pose interpolation
rather than a physically planted walk. It therefore remains below the local
acceptance threshold.

## Baseline inventory and diagnosis

The exact recovered baseline chain is:

| Item | Location or identifier | Evidence |
| --- | --- | --- |
| FLUX key image | `tmp/witch-flux-start-v1/output-0000.png` | 1056x576 RGB, SHA-256 `e2a1c044e3b33800b3fa08b4b9563877d7e3f7a43cc5f8dfc7a8a8ad2246c967` |
| Rejected old endpoint | `tmp/witch-casting-end-v1.png` | Different face, proportions, costume, and pose language |
| Reviewed KREA endpoint | `tmp/witch-krea-identity-end-v2/output-0000.png` | 704x384, SHA-256 `3273572395da01585e8c8f87c0f535222cd32787ce983545d8531020e8100dd7` |
| Baseline alpha | `tmp/machdoch-anime-witch-spellcast-alpha.webm` | 512x288, 33 frames, 8 fps, artificial ping-pong |
| Baseline composite | `tmp/machdoch-anime-witch-beach-spellcast-final.webm` | 512x288, 33 frames, 8 fps |
| Baseline alpha digest | — | `15459064399f75be9ea41e1a832c2bb2689506d9a9ff0c69a8dcaa3b4f5b3ec3` |
| Baseline composite digest | — | `fd817da2eab1b151f247e2d8f03503845cf610253e2f260593e9864abe7a6078` |
| Compiled release flow | `tmp/witch-quality-flow-compiled.json` | Zero compiler diagnostics |
| Published flow revision | `mfr-9e660571c85a74603fab1601cdce32b0` | Development catalog |
| Published run | `run:anime-witch-production-spellcast-v2` | Both selected outputs and full lineage |

Frame stepping and all alpha plates showed the following baseline defects:

- large costume, face, silhouette, and leg changes between pose islands;
- repeated rather than physically continuous action because the second half is
  a reversed copy;
- floor-colored blobs and detached fragments beneath the boots;
- many holes and multiple matte components;
- strong green contamination along hair, cape, limbs, and footwear;
- texture boil and detail replacement during pose transitions;
- low delivery resolution and compression, although the recently repaired
  durable preview/export path itself was valid.

The selected release keeps the original witch identity and costume much more
consistently, performs a readable one-way casting reach, ends intentionally,
and removes the floor plate. Its remaining early arm ghost and late small-detail
softening are explicitly reflected in the anatomy and temporal scores.

## Fixed quality rubric

The review uses `docs/media-quality-rubric.md`. Scores are semantic human
review, with decoded measurements as supporting evidence:

| Criterion | Weight | Baseline | Selected witch | Selected-witch note |
| --- | ---: | ---: | ---: | --- |
| Identity and design continuity | 15 | 6 | 8 | Face, hat, palette, costume, and silhouette remain recognizable |
| Anatomy and local detail | 15 | 5 | 6 | Hands and joints are mostly coherent; early arm ghost prevents a higher score |
| Action and physical motion | 12 | 6 | 7 | Readable spell reach and secondary cloth/hair motion; limited weight shift |
| Temporal coherence | 15 | 4 | 7 | Much less texture/edge instability; not fully locked |
| Spatial image quality | 10 | 6 | 8 | 640-wide lossless master retains appreciably more line and fabric detail |
| Composition and aspect fit | 8 | 6 | 8 | Intentional native 16:9 frame with safe hat/boot margins |
| Transparency and compositing | 15 | 3 | 9 | Clean on checker, white, black, magenta, and cyan plates |
| Loop or shot ending | 5 | 6 | 8 | One-way intentional ending instead of forced ping-pong |
| Delivery integrity | 5 | 10 | 10 | Durable CAS, exact hashes, native playback, export, and independent decode |
| **Weighted total** | **100** | **53.0** | **76.8** | Acceptance target met; studio claim rejected |

## Measured before/after evidence

All values below come from forced `libvpx-vp9` RGBA decoding, not a browser RGB
proxy. Lower temporal and alpha residuals are better; sharpness is diagnostic.

| Alpha measurement | Baseline | Selected | Change |
| --- | ---: | ---: | ---: |
| Subject Laplacian variance | 3908.460 | 5921.409 | +51.5% |
| Motion-compensated RGB MAE | 11.706 | 7.963 | -32.0% |
| High-frequency residual | 6.844 | 5.874 | -14.2% |
| Motion-compensated alpha MAE | 14.425 | 5.589 | -61.3% |
| Alpha coverage standard deviation | 0.013973 | 0.009125 | -34.7% |
| Fractional-edge coverage | 0.016109 | 0.007772 | -51.8% |
| Meaningful components/frame | 3.364 | 1.529 | -54.5% |
| Holes/frame | 11.000 | 2.412 | -78.1% |
| Positive green spill at edge | 55.840 | 2.090 | -96.3% |

For the opaque composite, sharpness rises from 1144.352 to 1552.875 (+35.7%),
motion-compensated RGB residual falls from 5.930 to 5.803, and
high-frequency residual falls from 2.905 to 2.532. The baseline's near-zero
endpoint seam is not an advantage: it is achieved by reversing the shot. The
selected clip is intentionally non-looping, so its nonzero first/last distance
is expected and is not scored as a loop defect.

The last transparency iteration was driven by a failed realistic endpoint.
Before repair, a shadowed/wrinkled plate became a large translucent region in
the final frame. Opaque-core hysteresis plus stricter component cleanup, applied
to the identical generated frames, changed:

| Portrait matte measurement | Damaged pass | Final repair |
| --- | ---: | ---: |
| Alpha instability | 11.972 | 6.363 |
| Coverage standard deviation | 0.066007 | 0.032212 |
| Fractional-edge coverage | 0.039576 | 0.003541 |
| Meaningful components/frame | 3.471 | 1.059 |
| Holes/frame | 2.706 | 1.353 |

The repair removed 25,893 contaminated pixels through primary-core hysteresis,
414 detached-marker pixels through connected-component cleanup, and 2,091
transient ground pixels. The exact report is
`tmp/realistic-walk-quality-final-v15-final/refinement-report.json`; the direct
bad/fixed plate comparison is
`tmp/quality-evidence/realistic-walk-selected-final/before-after-matte-magenta.png`.

## Implemented pipeline changes

### Source image, edit, and reference conditioning

- Local image edits use FLUX.2 Klein native inpainting. The base image and
  global edit strength reach the inpaint pipeline; mask strength scales only
  the painted mask alpha.
- FLUX.2 accepts the supported image references as native image conditioning.
  KREA 2 remains text-to-image only and is not offered for image edits.
- Chroma staging is opt-in instead of inferred from prompt substrings. This
  prevents negative instructions such as "do not include a green screen" from
  rejecting valid opaque style, replace, or general edit outputs, while still
  enforcing a quantitative usable-green-border gate for transparency staging.
- Subject-aware video conditioning detects the main alpha/chroma component,
  excludes detached plate debris, decontaminates it, and performs a uniform
  contain fit with safe margins. It does not stretch or blindly center-crop.
- Local edit and video endpoints are validated before expensive generation;
  incompatible model/addon combinations fail with actionable diagnostics.

### Video generation and temporal behavior

- Quality presets now expose native 1:1, 16:9, 9:16, and 21:9 canvases at
  preview-512, quality-640, and quality-768 tiers.
- The quality default uses 640-class native generation, 33 frames at 16 fps,
  30 steps, guidance 5, explicit negative prompting, production matte,
  lossless VP9, and a one-way shot. The 17-frame, 8 fps, 8-step draft tier and
  768-class advanced tier remain available.
- WAN first and last images are packed into one causal temporal VAE condition,
  with neutral unobserved middle samples, a terminal stride context, locked
  first/last latent slots, and five-frame smoothstep endpoint restoration.
- `none`, `ping-pong`, and exact-endpoint `seamless` are distinct controls.
  Non-looping shots are no longer silently mirrored.
- Frame count, inference steps, guidance, negative prompt, frame rate, motion
  intent, resolution, loop mode, and memory policy travel end to end through
  TypeScript, Rust, worker invocation, response, asset tags, and provenance.
- Opaque and alpha VP9 take separate verified paths; the prior opaque-channel
  indexing hazard is covered by a real encode/decode test.

### Transparency and compositing

- The production matte estimates the real frame/shot key rather than assuming
  ideal `#00ff00`, then applies spatial edge refinement and conservative
  temporal stabilization.
- A run-length union-find connected-component engine replaces the former
  per-pixel flood fill, keeping production cleanup practical without SciPy.
- Primary opaque-core hysteresis removes large wrinkled plates, seams, and
  shadows before color decontamination can amplify them.
- Component cleanup now chooses a non-border primary subject, always rejects
  border-connected screen residue, uses true span-to-span distance, and applies
  a stricter rule to sub-64-pixel tracking markers.
- Tiny enclosed pinholes are filled while larger negative spaces, fingers, hair
  gaps, and fabric cutouts are retained.
- Low-persistence ground suppression removes floor shadows and tracking debris
  while preserving pixels with vertical foot/leg support.
- Straight foreground color is reconstructed at fractional edges, green excess
  is removed, and six pixels of valid foreground color are padded under alpha
  for 4:2:0-safe compositing.
- The repair utility can rebuild a production key, apply only primary-subject
  isolation to an otherwise good matte, and render either the enchanted beach
  or a caller-selected animated gradient.
- Every advertised alpha output is decoded back through `libvpx-vp9`; a missing
  alpha plane, wrong dimensions, wrong frame count, or bad loop endpoint fails
  the run.

### Workflow, usability, and delivery integrity

- Image-edit and video nodes expose quality-oriented simple defaults and
  advanced identity, motion, loop, matte, encoding, memory, and background
  controls.
- The compiler validates exact KREA compatibility, reference settings, aspect
  ratio, frame count, step count, guidance, matte, loop, and encoding values.
- Worker framing and matte evidence are stored in generation provenance.
- Generated files are atomically staged into durable CAS before completion,
  requested outputs are size/hash verified, and missing blobs fail publication.
- Original WebM bytes are used for native preview and verified-original atomic
  export. The previously repaired preview/publication/export behavior was
  retained.

## Representative scenario matrix

The matrix distinguishes generated evidence from compiler-only coverage.

| Scenario | Evidence | Result |
| --- | --- | --- |
| Anime, clear action, landscape 16:9, non-loop, transparent, special background | Selected witch alpha and enchanted-beach masters | Pass; substantial baseline improvement |
| Identity persistence across edit and image-to-video | FLUX source -> KREA v1.2 restage -> WAN first/last latent lock | Pass with one noted early arm ghost |
| Realistic game asset, square, idle, transparent, clean loop | `tmp/realistic-idle-quality-final-v15/output-0000.webm` | Pass; exact decoded first/last RGB and alpha seam |
| Realistic game asset, portrait, forward step, non-loop, transparent and custom background | `tmp/realistic-walk-quality-final-v15-final/` | Partial; clean delivery and readable pose transition, but planted-foot physics remains weak |
| Reference image replace/edit | Realistic heroine source -> KREA opposite-contact-pose endpoint | Pass for identity/costume; source studio plate required production re-key |
| Reference image used strictly for style | `tmp/anime-style-reference-landscape-v2/output-0000.png` and `tmp/quality-evidence/style-reference-final/` | Pass: empty 16:9 environment, no subject/green-plate leakage, crisp violet/cyan anime-fantasy transfer; result is more painted than strict cel animation |
| Square, landscape, portrait, ultra-wide composition | `tmp/quality-evidence/aspect-framing-final-v3/contact-sheet.png` | Pass: actual subject-aware renders, `stretched: false`, `croppedSubject: false` |
| Normal/custom/special background | Alpha diagnostic plates, vertical animated gradient, enchanted beach | Pass |
| Cinematic/movie-scene intent | Enchanted coastal witch composite and style-reference landscape stress test | Limited by local 5B motion model; composition path exercised |
| Ordered multi-reference roles | Compiler and database reference-role tests | Contract pass; no paid remote generation was claimed |

The aspect evidence uses both the anime witch and realistic heroine at all four
ratios. Ultra-wide gains side negative space; portrait preserves head and boots;
no result is stretched or produced by cropping the same delivered frame.

## Research conclusions and implementation decisions

- The current [Diffusers FLUX.2 API](https://huggingface.co/docs/diffusers/api/pipelines/flux2)
  exposes native image/reference conditioning and a dedicated inpainting path
  with global `strength`. The implementation retains the base image rather
  than compositing a simulated edit.
- The official [Diffusers KREA 2 API](https://huggingface.co/docs/diffusers/main/api/pipelines/krea2)
  documents the text-to-image pipeline, not a native image-edit contract, so
  KREA is not used for image conditioning.
- The official
  [WAN 2.2 TI2V 5B model card](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers)
  positions 5B 720p generation for consumer hardware such as a 4090. On this
  16 GiB AMD device, 640-class generation with disk group offload is the
  verified quality/time compromise; 768 remains an advanced tier.
- Hugging Face's
  [Diffusers memory guide](https://huggingface.co/docs/diffusers/optimization/memory)
  drove model/group offload, block-level disk caches, component staging, and
  cautious layerwise casting. Quantization is used only where the imported
  checkpoint already supplies reviewed scaled FP8 weights.
- The post-walk evaluation confirms that text plus first/last pose does not
  guarantee contact mechanics. The official
  [WAN Animate pipeline](https://huggingface.co/docs/diffusers/api/pipelines/wan)
  uses preprocessed skeletal and facial videos for explicit motion/expression
  control, while the official [VACE implementation](https://github.com/ali-vilab/VACE)
  composes reference-to-video with pose video control. Those are the technically
  appropriate next step, not more prompt tuning.
- [MatAnyone](https://github.com/pq-yang/MatAnyone) propagates a first-frame
  target mask through memory for stable human video matting. It was not bundled:
  the current inputs already have controlled chroma plates, MatAnyone is
  human-centric, and its NTU S-Lab license needs separate product review.
  Its memory-consistency result nevertheless motivated shot-wide calibration
  and temporal alpha stabilization.
- [Practical-RIFE](https://github.com/hzwer/Practical-RIFE) and
  [SeedVR2](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) remain
  sensible optional interpolation/upscale stages. They were not placed in the
  quality default because neither can repair a fused joint, wrong identity, or
  missing planted-foot mechanics; generative upscale can also invent unstable
  detail.

## Historical 2026-07-27 reproduction settings and hardware trade-offs

Verified machine:

- AMD Ryzen Z2 Go, 4 cores / 8 logical processors;
- 33,618,337,792 bytes physical RAM (31.31 GiB);
- AMD Radeon RX 9070 exposed through the pinned ROCm-on-Windows runtime as
  `cuda:1`, 17,095,983,104 reported device bytes (15.92 GiB);
- Torch 2.12.0+rocm7.14.0, Diffusers 0.39.0, Transformers 5.13.0,
  Accelerate 1.14.0, Pillow 12.3.0, imageio-ffmpeg 0.6.0;
- pinned FFmpeg 7.1 `libvpx-vp9` encoder/decoder.

Reviewed local models:

- KREA checkpoint:
  `models/krea-2/checkpoints/redcraft23INT8INT4FP8_30Krea2.safetensors`,
  13,141,826,368 bytes, SHA-256
  `f6088960c0febd27cbd372fc758bb07d012f2d8ae3cd10c45c903d48b94409ea`.
- KREA identity adapter:
  `models/krea-2/lora/krea2_identity_edit_v1_2_r64.safetensors`,
  457,111,048 bytes, SHA-256
  `f794b47142555c929cf536a2f1e4f335174b9aedbb08572b07d45814d4242423`.
- WAN model revision `b8fff7315c768468a5333511427288870b2e9635`,
  package digest
  `2110ec4b92ef42f45d68f3a391e36b627391559758690aef73cbdd3b63bdd325`.

Selected witch video settings:

- prompt and negative prompt:
  `tmp/witch-wan-quality-v2-request.json`;
- response and exact runtime provenance:
  `tmp/witch-wan-quality-v2.stdout.log`;
- seed 72,526,017; 640x352; 17 source frames; 8 fps; 20 steps;
  guidance 5; one-way non-loop;
- first key `tmp/witch-flux-start-v1/output-0000.png`;
- last key `tmp/witch-krea-identity-end-v2/output-0000.png`;
- production matte, lossless alpha VP9, enchanted-beach composite;
- WAN elapsed time approximately 727 seconds; selected post-matte/composite
  refinement approximately 58 seconds.

Portrait step settings:

- KREA request/response:
  `tmp/realistic-walk-krea-end-request.json` and
  `tmp/realistic-walk-krea-end.run2.stdout.log`;
- KREA seed 26,072,631; 384x704; edit strength 0.68; reference boost 2.5;
  fit mode; grounding 768; cold run approximately 13 minutes 35 seconds;
- WAN request/response:
  `tmp/realistic-walk-wan-request.json` and
  `tmp/realistic-walk-wan-final.stdout.log`;
- WAN seed 26,072,632; 352x640; 17 frames; 8 fps; 20 steps; guidance 5;
  non-loop; approximately 16 minutes 56 seconds;
- final re-key and composite report:
  `tmp/realistic-walk-quality-final-v15-final/refinement-report.json`.

Style-reference stress settings:

- exact request:
  `tmp/anime-style-reference-landscape-request.json`, SHA-256
  `812c17de8d6c73140d394577db329c9738d4c02a2c357d0a87c85368ba74fe73`;
- worker response:
  `tmp/anime-style-reference-landscape-v2.response.json`, SHA-256
  `aacaa41aee6de839ece07e2f888489c3fc0fcc994f7bb9a82506a0c99c72b26f`;
- seed 26,072,641; 704x384; 8 steps; edit strength 0.92; reference boost
  0.5; fit mode; grounding 768; `requireChromaBackground: false`;
- worker `media-diffusers-worker/1.16.0`; elapsed time 532.954 seconds;
- decoded evaluator:
  `tmp/quality-evidence/style-reference-final/report.json`. Output sharpness
  was 725.840 versus 668.910 for the reference, with no alpha or encoding
  ambiguity.

Both KREA and WAN automatically selected block-level disk offload with one block
per group. The verified KREA cache is about 13.6 GB per compatible graph shape;
the WAN cache is about 10.0 GB. This makes 16 GiB generation possible but
increases cold-start time and storage. A 24 GiB-or-larger GPU can use less
offload and the quality-768 tier. A 14B pose-controlled pipeline on this device
would require much larger downloads, heavier offload, and substantially longer
iteration; it was not represented as a practical default.

## Historical 2026-07-27 verification and delivery

Completed evidence:

- forced RGBA decode of every selected alpha WebM;
- frame count, dimensions, alpha range, first/last endpoints, spatial,
  optical-flow, motion-compensated temporal, matte, component, hole, spill, and
  loop metrics;
- contact sheets over checker, white, black, magenta, cyan, and the alpha plane;
- direct frame-by-frame visual review of first, last, extremes, and uniform
  temporal samples;
- exact KREA and WAN request/response logs, seeds, model revisions, digests,
  runtime policy, and output hashes;
- durable publication of the selected witch key, endpoint, transparent master,
  and composite under the existing development profile;
- idempotent publication rerun, SQLite integrity check, exact CAS verification,
  verified-original export, and independent FFmpeg decode;
- aspect-framing evidence across both styles and every supported ratio.
- identical-seed KREA style-reference generation after explicit chroma-gate
  wiring, followed by direct visual inspection and decoded still-image metrics.

Final automated and delivery results:

- Rust: 389 library tests executed, 388 passed, zero failed, and the one
  reviewed-model BiRefNet test remained intentionally ignored;
- Python: all 8 managed-runtime quality tests passed, including real opaque VP9
  encode/decode and explicit chroma-gate behavior;
- TypeScript: core, UI, and logic-test configurations all type-checked;
- Vitest: 62 compiler, node-registry, media-runtime, and media-store tests
  passed;
- targeted ESLint, `cargo fmt --check`, and `git diff --check` passed;
- idempotent publication returned the three exact reviewed asset digests;
- read-only SQLite `PRAGMA integrity_check` returned `ok`; all three CAS blobs
  were available, byte-exact, and SHA-256 exact;
- all five selected representative WebMs and the verified-original export
  independently decoded through FFmpeg with exit code zero;
- the export is byte-for-byte identical to the selected alpha master:
  1,124,438 bytes and SHA-256
  `35d72b11e6c8b59963d9f92116f875a4a9ed930cfcd92ba28bdfb6a065c268b7`.

## Historical 2026-07-27 limitations (superseded)

1. The selected witch still has a short early casting-arm ghost and limited
   weight transfer. Its score is 76.8, not studio quality.
2. WAN TI2V 5B first/last conditioning can describe and interpolate poses but
   cannot enforce a true skeletal trajectory, ground contacts, or exact
   expression curves. The portrait step demonstrates this limit.
3. The correct open-weight upgrade for body mechanics is pose/face-conditioned
   WAN Animate 14B or VACE 14B. It is not a sensible basic preset for the
   verified 16 GiB / 32 GiB machine without a separate large model installation,
   pose preprocessing, and long offloaded renders.
4. Chroma matting is now clean for the verified single-character plates. Hair
   filmed against arbitrary natural backgrounds would benefit from a separately
   licensed learned temporal matting backend.
5. No interpolation or generative upscale is enabled by default. Those stages
   should be optional and judged against anatomy/identity, not assumed to improve
   them.
6. Full-speed playback remains available through Machdoch's native WebM viewer;
   automated evidence independently verifies that every frame is distinct and
   decodable. Semantic motion judgment in this report is conservative where
   frame evidence exposes ambiguous mechanics.
