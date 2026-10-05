# Media Studio startup and LTX verification — 2026-10-05

Compiler initialization and managed-worker startup recovered in this continuation. The full studio goal remains incomplete. The previous [verification report](media-studio-verification-2026-10-05.md) retains earlier outcomes and the full requirement matrix; its startup blockers and failed-suite counts are superseded by the results here.

Models and new media remain under `D:\Models\machdoch`. Evidence uses `D:\Models\machdoch\verification\2026-10-05`. The installed desktop hosting the task was preserved. No development servers were started.

## Startup diagnosis and fixes

Visual Studio initialization completed in 44.171 seconds with the existing installation. The standard launcher subsequently reached Cargo, executed native tests, and built the desktop. Incomplete installer metadata did not require repairing Visual Studio. Discovery errors now distinguish a timeout or failed process from an absent toolchain and retain the underlying cause.

A later cleanup check again reached the 120-second compiler-initialization deadline. Its retry reached Cargo without changing the installation or budgets. The final test/build requests also waited behind another compilation in the shared target directory; that process was left intact and completed. The final media tests passed in 135.40 seconds after compilation, and the final desktop build succeeded. These results establish recovered execution, not elimination of intermittent initialization latency. Final launcher wall times include the shared lock and recompilation.

A real worker probe from the D runtime completed in 102.680 seconds and detected the Radeon RX 9070, 17,095,983,104 bytes of GPU memory, and 33,618,337,792 bytes of physical memory. Native managed runtime health also succeeded. Cold startup remains variable. The D runtime is on USB storage; the existing C runtime is on NVMe. Running the Python checks with the desktop's C environment cleared the earlier import and subprocess failures without increasing production deadlines.

A read-only Defender performance recording measured 2,858 realtime scans and 68.990 aggregate scan seconds during a 43-second interval. The longest individual scan was 14.711 seconds on the isolated desktop executable. Python and Rust compiler processes also incurred substantial scanning. This establishes a contributor to latency, not the sole cause of every earlier timeout. No antivirus settings or exclusions were changed. Evidence: `startup-defender-report.json`, `startup-defender-report.txt`, `compiler-trace-exit.json`, `worker-probe-trace-exit.json`. The measurement follows [Microsoft's performance recording guidance](https://learn.microsoft.com/en-us/defender-endpoint/tune-performance-defender-antivirus).

Isolated worker errors now retain captured stderr, including the last reported stage. Worker tests warm the resident process before measuring sampling inactivity and use the normal fixture startup budget for isolated processes. The blocked-input test still proves that progress cannot bypass the input deadline. Cleanup assertions now query the worker PID rather than refreshing the entire system. A concurrent native run recorded three failures; the final serial run cleared them. Production compiler and worker deadlines remain unchanged.

Download cancellation now suspends polling until the cancellation request finishes, preventing a late poll from replacing the canceled state. The regression covers both an already-started poll and a rerender during cancellation.

## Manual probes and pose guidance

The unused per-model probe API, frontend wrapper and contracts, native command and fleet dispatch, Python command, probe records, schema table declaration, and related import/edit/removal bookkeeping were removed. Automatic runtime health and checkpoint integrity checks remain. Existing imported models can generate directly; no manual model-verification action is required. Old stores can retain an unused probe table, but no current code reads or writes it.

The pose inspector still offered an obsolete verification recovery action. Removing that action exposed a separate defect: pose-map guidance wrote fields absent from image-generation tasks, while workflow execution and recipe readback took strength from the source's reference influence instead. Generation and editing tasks now share the guidance schema; the task owns strength and the denoising interval throughout editing, recipe readback, and native execution. Reference influence is hidden for pose sources, and pose controls appear only when a pose input is connected. Generation recipes now retain their pose source. Both boundaries reject invalid intervals; native validation also rejects nonnumeric interval values.

The production editor Playwright check used an installed-model fixture without probe history. It opened the pose canvas, added a figure, changed strength to 1.99 and the interval to 0.01–0.99 with the keyboard, closed and reopened the canvas, and confirmed retained values without page errors. This establishes editor behavior, not real pose-conditioned inference. Both generation and editing recipe regressions retain changed guidance. Evidence: `playwright-pose-no-model-probes.json`, `pose-no-model-probes.png`, `pose-guidance-core-tests.log`.

The mixed-media editor check also passed adding/removing nodes, rejecting an incompatible connection, all eight scene inputs, grouping, collapsing, renaming, and ungrouping. Evidence: `playwright-editor-no-model-probes.json`, `editor-scenes-no-model-probes.png`.

## LTX component and schedule fixes

The first fresh LTX run completed but its generated scene dissolved into colored noise. Checkpoint inspection found that inference paired the 0.9.8 transformer with the package's older directory VAE. That directory lacked timestep conditioning and used a different encoder and decoder architecture.

Inference now converts the VAE embedded in the selected checkpoint using the installed Diffusers converter, loads every tensor strictly, and retains the checkpoint's latent mean and standard deviation. The real 2B checkpoint passed a load of 226 tensors and 1,246,913,522 parameters. Discovery and native package identity no longer require the unused directory VAE. The new loader is included in desktop resources. Evidence: `ltx-checkpoint-components.json`, `real-checkpoint-vae.json`, `ltx-checkpoint-vae-tests.log`. The architecture and conversion were checked against the [official Diffusers converter](https://github.com/huggingface/diffusers/blob/main/scripts/convert_ltx_to_diffusers.py).

The sampler also used approximate timings from an upscaling example, including a near-zero timestep absent from the checkpoint's trained schedule. It now reads the eight exact allowed timesteps from checkpoint metadata. Multiscale sampling uses the trained first seven steps and the final three refinement steps, accounting for Diffusers' strength slicing and reporting the actual ten steps. The schedule reader and dimensional helpers have unit coverage; the changed 13B multiscale path has no new real-model execution. Sources: [LTX 2B recipe](https://github.com/Lightricks/LTX-Video/blob/main/configs/ltxv-2b-0.9.8-distilled.yaml), [LTX 13B recipe](https://github.com/Lightricks/LTX-Video/blob/main/configs/ltxv-13b-0.9.8-distilled.yaml), [upstream timestep validation](https://github.com/Lightricks/LTX-Video/blob/main/ltx_video/pipelines/pipeline_ltx_video.py).

LTX now reports model loading and actual sampling progress. The first two new runs completed in 951.957 and 914.270 seconds, respectively. Those wall times include native workflow execution and export. The matching-VAE run recorded 441.997 seconds for model loading and prompt preparation and 246.166 seconds for denoising and decoding. These results do not meet a general fast-generation claim.

## Checks completed

| Check | Result | Evidence |
| --- | --- | --- |
| Studio suite | 648 passed across 83 files after probe removal and pose fixes | `studio-final-tests.log` |
| Studio typecheck, client UI typecheck, and studio lint | Passed | `studio-final-typecheck.log`, `client-ui-final-typecheck.log`, `studio-final-lint.log` |
| Fleet protocol suite, typecheck, and lint | 408 passed; checks passed | `fleet-no-model-probes-tests.log`, `fleet-no-model-probes-check.log` |
| Compiler and Vulkan launcher checks | 12 passed, 2 skipped | `compiler-startup-diagnostics-tests.log` |
| Native media suite | 365 passed, 0 failed, 12 ignored after obsolete probe tests were removed and pose validation added | `native-pose-guidance-tests.log`, `native-pose-guidance-tests-exit.json` |
| Python media subset | 226 passed after probe removal | `python-no-model-probes-tests.log` |
| Full Python suite, including training utilities | 309 passed | `python-full-final-tests.log` |
| Production frontend build | Passed after pose fixes | `desktop-ui-final-build-corrected.log` |
| Final native desktop build with bundled frontend | Passed | `native-no-model-probes-desktop-build.log`, `native-no-model-probes-desktop-build-exit.json` |
| Final desktop native command and playback check | Probe command absent; native catalog and LTX bytes, audio playback, scene seek passed | `final-desktop-native-command-check.json`, `playwright-final-desktop-ltx-ui-playback.json` |
| Real checkpoint VAE load | Passed, including normalization equality | `real-checkpoint-vae.json` |
| Matching-VAE native generation, export, decode, and Playwright playback | Passed execution checks; visual defects remain | `checkpoint-vae-playwright-native-ltx-scenes.json`, `checkpoint-vae-ltx-scenes-independent-inspection.json`, `playwright-checkpoint-vae-ltx-ui-playback.json` |
| Exact-schedule generation and bundled desktop playback | Passed execution checks; orbit quality failed | `exact-schedule-playwright-native-ltx-scenes.json`, `exact-schedule-ltx-scenes-independent-inspection.json`, `playwright-exact-schedule-ltx-ui-playback.json` |

The isolated executable is a debug build with current Python resources copied beside it. Its bundled frontend is the production build. No installer or release-performance check is claimed. The 12 ignored native checks are not claimed as rerun. Tests establish software behavior; they do not establish perceptual media quality. The first final frontend-build command omitted `vite.ui.config.ts` and failed to resolve an entry; the corrected command built successfully.

## Real workflow and quality

Real Codex `gpt-6.1-sol` requests created first/last-frame LTX 2B workflows, joined the new scene to a prior real CogVideoX scene, and supplied a prior AudioLDM 2 soundtrack at a 0.5-second offset. The private desktop configuration selects `gpt-6.1-sol`; only that model value is retained in `codex-sol-verification-config.json`.

The matching-VAE run `5f80388b-f64d-45a7-b3e8-9b8a49190994` produced a non-fixture WebM whose native asset, original-byte export, independent decoding, and browser bytes share SHA-256 `0fc1b63ea0103f04a1f5003759c6e96c9ec745c1aea68d0b74bf6e2a0ee5cd3d`. Full decoding found 82 frames at 512 × 512 and 8 fps, 10.25 seconds, and 492,000 finite 48 kHz audio samples. Playwright verified sound enabled, playback, and seeking across the scene boundary with no page or media errors. This check used the current frontend through interception in the earlier isolated native executable.

Visual inspection shows that the VAE fix removed the colored-noise failure and retained recognizable teapots and cups. The objects still deform during the transition between the supplied images, and large portions have little motion. The second scene also retains its previously observed pinwheel deformation. Audio decoding and browser playback do not establish listening quality or lip synchronization.

The exact-schedule run `d9d068e1-f95a-4e55-a653-f3065030732e` completed against the rebuilt desktop in 591.760 seconds, including export. The final WebM, native asset, and browser bytes share SHA-256 `bdb7371d5ddcef0a5d1865f3345b2e9f642d34d6b6c83ee52cc97c87c5768fe6`. Its recorded eight timesteps match the checkpoint metadata. Worker time was 519.981 seconds: 333.147 seconds for loading and prompt preparation, 170.420 for denoising and decoding, and the remainder for setup, encoding, and release. GPU peak allocation was 9,689,332,736 bytes; post-release device free memory was 16,641,622,016 bytes. Differences in wall time across these runs do not isolate the effect of the sampler change from warmed storage or system load.

Independent full decoding again found 82 frames, 512 × 512, 8 fps, 10.25 seconds, and 492,000 finite audio samples. Playwright used the actual bundled production frontend without route interception, verified the native bytes, played with sound enabled, and sought across the scene boundary without page or media errors. Evidence: `exact-schedule-native-ltx-scenes.webm`, `exact-schedule-video-inspection.log`, `exact-schedule-ltx-ui-scene-playback.png`, `playwright-exact-schedule-ltx-ui-playback.json`.

The exact schedule retains coherent endpoint objects, but the fresh scene has little animation and changes abruptly between its endpoints. Of its 32 adjacent frame transitions, 26 differ by less than one mean RGB level; the largest differs by 42.729 levels. These measurements and the inspected contact sheet do not establish a smooth camera orbit. The supplied endpoints also depict different teapot designs and layouts; a test with consistent viewpoints is still needed. The video path therefore passes execution and export checks and fails this requested motion-quality test. Evidence: `exact-schedule-ltx-scenes-contact-sheet.png`, `exact-schedule-motion-and-performance.json`.

The rebuilt test harness also required explicit WebView2 debugging arguments and a relative frontend asset path. Environment debugging flags were ignored, and the initial absolute frontend path navigated to a file URL. The final build bundles the frontend and loads `http://tauri.localhost/`. The script now waits for native page initialization before invoking commands. The debugging setup follows [Microsoft's WebView2 guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags).

The final desktop after probe removal and pose fixes repeated this playback check against the same fresh asset, using its actual bundled frontend without interception. The digest matched, sound remained enabled, seeking to 4.25 seconds crossed into the second scene, and there were no page or media errors. Native invocation also confirmed that `media_probe_local_model` is absent and the catalog remains usable. This final playback repeats asset access; it does not count as another inference run. Evidence: `final-desktop-ltx-ui-scene-playback.png`, `playwright-final-desktop-ltx-ui-playback.json`, `final-desktop-native-command-check.json`.

## Remaining goal coverage

Full-weight finetuning and integrated lip sync remain absent. Broad model and LoRA execution, combined pose/mask/reference conditioning, song workflows, asset and keyword quality, and the complete image → postprocess → variant → first/last frames → video chain remain unverified. SVG defects from earlier real runs remain unresolved. The current LTX evidence covers one short 2B workflow; it does not establish modern-model breadth, the 13B quality path, universal stability, perceptual quality, or speed.

The current publisher audit reconfirmed [Krea 2 RAW training and RAW-to-Turbo LoRA inference](https://github.com/krea-ai/krea-2/blob/main/README.md) and [MiniMax's text-to-video API modes](https://platform.minimax.io/docs/api-reference/video-generation-t2v). Those sources establish upstream routes, not completed Machdoch jobs. [IntroSVG's publisher inference loop](https://raw.githubusercontent.com/gitcat-404/IntroSVG/master/inference_loop.py) renders a draft, critiques it with image feedback, and refines it. Machdoch's local IntroSVG path currently generates in one pass; that refinement remains unimplemented and unverified.

## Cleanup

The isolated desktops and their descendants were closed after verification. `cleanup-startup-final.json` and the final `cleanup-probe-removal-final.json` confirm no owned test processes remained and that installed host PID 3400 retained its executable and original creation time. Models, exported media, evidence, and test storage remain on D. The frontend build cache on C is ignored by Git. No user installation, global CLI configuration, antivirus policy, or development server was changed.
