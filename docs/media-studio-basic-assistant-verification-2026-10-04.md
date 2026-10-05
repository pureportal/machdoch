# Basic assistant verification — 2026-10-04

The full Media Studio goal remains incomplete. This run recovered the unfinished Basic assistant left by the interrupted task. The [full coverage matrix](media-studio-verification-2026-10-04.md) and [model inventory](media-studio-model-support.md) retain the outstanding implementation and real-model checks.

## Changes

Basic Image, SVG, Video and Audio forms expose an Assistant action that fills their existing settings through the application's Codex inference path. It applies the returned settings together and leaves generation as a separate action. Closing the dialog, leaving Basic, changing workspaces, or manually editing settings prevents a late response from replacing the current draft. Failed requests retain their text for retry.

The returned graph must round-trip through the selected Basic recipe without changing its execution fingerprint. Operations that cannot be represented by that form produce an Advanced-mode recovery message. Model selection, image sampling, reference influences, and video audio settings are retained and checked.

Basic and Advanced share one request builder. It sends the models, addons and assets needed to edit the graph without exposing model filesystem paths. Local image models include their fixed-step and manual-guidance constraints. The interrupted version put that mapping in an invalid destructuring expression; this run repairs it and tests the resulting request. Basic model-switch resets use the same constraints.

## Checks

- 639 studio tests passed across 82 files. Studio typecheck and lint passed.
- Client core and UI typechecks passed. All seven client flow-agent tests passed.
- The final client-wide `typecheck` passed core and UI again, then failed its test typecheck with 29 diagnostics in four existing assistant-surface/display test files. They reference a removed bubble-shell module, exports and layout fields. These files are outside the Media Studio changes and remain unchanged. `final-client-typecheck.log` records the failure; a clean client-wide typecheck is not claimed.
- All eight native folder-import tests passed, including AudioLDM 2's native components, rejection of other repository classes, and required vocoder weights. Scoped Rust formatting and `git diff --check` passed.
- All nine native training tests passed, including cancellation of the real descendant-process tree. The first compiler-environment preparation timed out after 120 seconds; the retry compiled in 2 minutes 45 seconds and completed the tests in 4.69 seconds.
- The embedded desktop build passed: UI build 42.73 seconds, native build 6 minutes 22 seconds. Existing Tailwind sourcemap and unused-field warnings did not fail it.
- The importer rebuild passed: UI build 1 minute 13 seconds, native build 7 minutes 26 seconds. The full native suite initially recorded 362 passes, three worker timing failures, and 12 ignored external checks while this build was running. All 12 worker lifecycle checks then passed sequentially in 43.25 seconds without compilation running. The full sequential retry passed all 365 tests in 223.86 seconds, with the same 12 external checks ignored. The initial aggregate failure remains recorded separately.

## Browser evidence

Playwright operated the actual Basic generation view and assistant with production styles in headless Edge. Its host forwarded image and audio requests to the real application flow-agent implementation and Codex CLI. The catalog records were seeded; this harness did not execute native media generation.

It checked live image prompt/seed/sampling fields, live audio prompt/duration/seed/sampling fields, error retry, protection against manual edits during a request, ignored responses after closing, reachability in all four media forms, and the dialog's fit at a 390-pixel viewport. No page errors were recorded. An earlier automation timeout came from an incorrectly decoded ellipsis in the harness's pending-button text; the locator now identifies the pending action by its text prefix. No failed run is counted as a success.

Evidence is retained in `D:\Models\machdoch\verification\2026-10-04\basic-assistant`, including `playwright-basic-assistant-result.json`, live request/response JSON, field snapshots and screenshots. The harness intercepts browser requests; no development server was started.

## Native evidence

The isolated built desktop uses `D:\Models\machdoch`; the installed release desktop remains separate.

Playwright submitted an actual Basic image assistant request through native IPC, accepted its fields, and clicked Generate image. SDXL run `be8f096f-3740-4cbd-9d59-08d694812085` completed in 743.126 seconds of durable run time. The approximately 808.5-second harness cycle also includes Codex and UI work. Its native saved flow retains seed 161803, 30 sampling steps and guidance 7.5, with no LoRAs or conditioning sources. Native original-file export and an independent SHA-256 calculation both match the non-fixture 1024 × 1024 PNG: `07f2d78b28611ec6539b3acf777b758f2dbd50f2bb13a7d9649bfe8e804d7f07`. Artifacts include the saved flow, run, export record, `native-assistant-image.png`, and `playwright-native-image-result.json`.

The initial harness completed generation but used a nonexistent preview command, then incorrectly assumed that native records exposed a file URI. Final assertions resumed against the same completed run using the actual export API. Neither automation failure is a generation failure or a separate successful run. No page errors were captured during generation. A loading stack shows Diffusers constructing tensors through Accelerate. Cold loading and speed remain unacceptable.

Visual inspection shows a coherent red teapot with one handle/spout, a white cup and a dark brown wooden surface. A large blank background dominates the framing, and a second small brown cup appears. This is useful execution evidence, not proof of perfect prompt adherence or composition.

The next native AudioLDM 2 folder import exposed an incorrect rejection of its `audioldm2` Diffusers namespace. The importer now recognizes only the publisher's native projection and UNet classes for that pipeline and requires the vocoder's configuration and weights. Regression tests and the rebuild passed. Rebuilt native inspection accepts the actual 4,480,957,927-byte package with 2,850 tensors and no warnings. Native copy/hash/import succeeded and registered `local:user:73b30dbd9097bc3b4fd5865a8161f0fdbf16283fa90bec2e707457a05a5d083f` in the managed D library.

The native audio harness first failed to reopen Media Studio after a desktop reload. Its next attempt successfully accepted Codex's five-second ocean-waves recipe, but failed while trying to decorate Tauri's read-only invocation function to record its request/response. Another resumed field assertion used the image form's accessible prompt name instead of `Audio prompt`. These automation failures all preceded Generate audio. Their logs, DOM snapshots and screenshots remain under `navigation-`, `capture-`, and `field-locator-` prefixes. Actual generation resumes from the same accepted Codex draft rather than claiming those attempts as additional successful requests. The native user-request screenshot and durable generation flow provide evidence; a native request/response interception is not claimed.

Playwright then clicked the actual Generate audio control. Non-fixture run `b569dd00-890d-4609-a503-fb16fe8fc7ca` completed, and its saved native flow retains the imported model ID, duration five seconds, 100 steps, guidance 3.5, seed 48623, ocean-wave/seagull prompt, and negative prompt excluding music, speech, distortion and clipping. Original WAV export, the recorded asset digest, and independent hashing all match `59100b7fa621f1c905764fdd30ec783e0b862edeaf3cd40469869752d125b784`. The actual desktop audio element played to its end without a media or page error. The resumed generation/export/playback cycle took 271.46 seconds; this includes cold loading and is not a sampling-only benchmark.

Independent WAV inspection confirms 80,000 frames, one channel, 16 kHz, 16-bit PCM, and exactly five seconds. Peak amplitude is 0.213013 and RMS is 0.040579 (−27.83 dBFS), with no saturated samples. These measurements do not establish that the audio sounds like the requested scene or assess listening quality. The run, saved flow, export record, WAV, screenshot, `playwright-native-audio-result.json`, and `native-audio-signal-check.json` remain in the evidence directory.

Playwright also submitted the actual native Codex request for three scenes, generated opening/closing image variants, song-driven lip sync and an orbit LoRA. The dialog reported that Basic cannot represent this workflow, that no orbit LoRA was supplied, and that available video controls cannot attach the song. The saved recipes remained unchanged. `native-complex-user-request.json`, `native-complex-message.json`, screenshot and `playwright-native-complex-result.json` record the check. This verifies an accurate unavailable-state response; it is not evidence of successful multi-scene or lip-sync creation.

## Cleanup

The owned verification desktop and its identity-checked descendants were stopped. The temporary D storage setting and the Media Studio shell-state key were restored from the pre-run journal; other shell-state keys were preserved. Models, imported AudioLDM 2, generated assets and evidence remain on D. View preferences were not restored. The installed release desktop remains untouched. Shutdown-when-idle was disabled only in the owned process, so that in-memory change ended with it. `desktop-cleanup.json` records the cleanup. The initial cleanup identity check refused to proceed because a parsed UTC timestamp had been parsed a second time as local time; using its existing DateTime value resolved the check before any cleanup mutation.

The final normal desktop build passed without the Playwright debugging override: `pnpm --filter @machdoch/client exec node scripts/run-tauri.mjs build --debug --no-bundle`. UI compilation took 17.06 seconds and native compilation took seven minutes. Its existing Tailwind sourcemap and unused recovery-field warnings did not fail it. `normal-desktop-build.log` retains the result. Independent cleanup verification confirms the restored Media Studio state matches the journal, the temporary storage file is absent, the verification desktop is stopped, and the installed release desktop is still running. No development server was started.

Unrelated Ralph/CLI files changed during final verification. Workspace presence was checked, and those changes were preserved. Presence is advisory and does not establish their author. The client checks above and the final build describe the workspace at their execution times.

## Research and limits

Primary sources were checked again on this date: [Krea RAW/Turbo](https://www.krea.ai/krea-2-open-source), [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3), and [Wan 2.2](https://github.com/Wan-Video/Wan2.2). Krea identifies RAW as its training checkpoint and Turbo as its eight-step inference checkpoint. Wan's published S2V command accepts an image and user audio and specifies at least 80 GB GPU memory for that recipe. The test machine's approximately 16 GiB discrete GPU and 32 GiB system memory cannot validate that published configuration. This does not rule out other implementations or reduced-memory recipes.

The Basic assistant does not establish multi-scene lip sync, arbitrary audio conditioning, broad finetuning/LoRA training, every model's execution, or acceptable generated-media quality and speed. Those remain explicit gaps in the full goal.
