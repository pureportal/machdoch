# Media Studio experience review — 2026-09-14

The main problems were the connections between working features: Basic could show an Advanced run's assets, selecting Activity could detach the graph's run status, opening another workflow could lose an unfinished draft, and inspecting or saving results required unnecessary navigation. This iteration fixes those connections across Basic, Advanced, Assets, and Activity.

The review used the current implementation, recent Media Studio history, and [the advanced-workflow report](media-studio-advanced-2026-09-14.md). Existing local changes were retained. Generation, segmentation, refinement, and upscaling algorithms were not replaced in this iteration.

## Changes

| Confirmed problem                                                                                                                                          | Resulting behavior                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic selected whichever job was active, including Advanced work, and result selection changed as the queue progressed.                                    | Basic shows its own generations in a bounded list. Each card selects that generation's results and has its own Activity and cancellation actions. A new submission selects the new job; subsequent progress preserves the user's selection.                               |
| Reusing an image while Video was selected could leave the editor on Video; edits could retain unrelated references, pose inputs, or a hidden quality gate. | Edit, Use as reference, and Animate open the appropriate Basic editor and clear unrelated conditioning. The selected image becomes the explicit source. Animate in Advanced remains available.                                                                            |
| Opening or converting a workflow could discard the existing draft. Saving from Basic could conflict because Advanced history had not loaded.               | Replacing a draft first saves a revision and obtains its current revision history when needed. A save failure prevents replacement. This applies to conversion, saved workflows, imported workflows, Advanced animation, inspecting a run, and reusing Advanced settings. |
| Graph status depended on the selected Activity run and could disappear after navigation. Queued runs could exhaust monitoring before execution began.      | The graph retains its own run, including its queued state. Its toolbar opens the corresponding results or Activity and cancels that run directly. Monitoring continues while queued and reports a persistent monitoring failure.                                          |
| Background refresh invalidated an in-progress run selection before its saved settings arrived. Initial loading could overwrite an early navigation choice. | Selection requests remain valid across polling; initial loading is explicit, and navigation becomes available after saved UI state loads. Activity highlights the selected run while its details load.                                                                    |
| Activity emphasized execution details and provided no direct gallery for a run's outputs.                                                                  | Final results appear before settings and logs, with inspection, playback, and saving. Workflow intermediates are separately disclosed with their step and attempt; failed runs expose their intermediates immediately. The inspector comes first in narrow layouts.       |
| Asset inspection used a small floating panel, and the library fetched offscreen previews ahead of the selected result.                                     | A responsive dialog provides a larger contained preview, dimensions, saving, editing, animation, reference reuse, and settings. Previews load near the viewport; collapsed intermediates do not fetch previews.                                                           |
| Video preview blobs were assigned an image MIME type. Saving had no success state. Report destinations were rejected by native export validation.          | Video uses its stored MIME type. Successful export shows Saved; cancellation and failure retain retry controls. JSON reports now use the same verified export path as media, with matching-extension validation and unchanged bytes.                                      |
| Quality-gate failures repeated lengthy assessment text in the page header and inspector, and recovery actions could do nothing.                            | A concise notice opens the affected run's results. Reports visibly distinguish Passed, Failed, and Inconclusive. Detailed gate reasons remain expandable. Failed and canceled runs reopen their pinned settings through Edit and rerun.                                   |

The implementation separates generation cards, run results, and asset inspection into focused components. It retains the existing native execution paths and export integrity checks.

## Verification

Playwright rendered the actual Media Studio components using the existing Vite service on port 4173 and forwarded commands to the running Tauri backend on port 9223. File dialogs received explicit test destinations. Generation, workflow execution, persistence, previews, and exports used the real backend. No additional development server was started; the existing desktop watcher rebuilt after the native export fix.

Evidence is under `apps/client/.cache/media-experience-2026-09-14/`. It includes screenshots, saved requests and run details, exported media and reports, assertions, and test logs. Verification workflows, runs, and assets remain in the development app.

### Basic journeys

- Generated a new 1024 × 1024 red bowl through Basic: `7d12dc96-c185-4bfa-9d3f-2b24800c1778`. Progress, completion, exact-card Activity navigation, result inspection, and saving were exercised.
- Queued another generation and canceled it before execution: `aa8cf571-7cd1-40a4-9531-9ed456faccac`. It produced no output and did not invoke native generation. The completed bowl remained selectable after the prompt changed.
- Used Edit image on the completed result and generated a blue bowl: `435519e1-7411-4dee-a2bd-2b7dd2430d27`. Persisted conditioning identifies the first bowl's exact asset and digest as the source. Both exported images were visually inspected: the requested color change succeeded and retained a similar composition. This was a full-image edit, not an exact protected-pixel test.
- Animate opened Basic Video with the selected source. Returning through Assets and Use as reference switched back to Image. Stale conditioning was also covered by automated checks.

Results: [red bowl](../apps/client/.cache/media-experience-2026-09-14/basic-red-bowl.png), [blue bowl](../apps/client/.cache/media-experience-2026-09-14/basic-blue-bowl.png), and [animation draft](../apps/client/.cache/media-experience-2026-09-14/basic-animate-draft.png).

### Navigation, inspection, and recovery

- Injected one workflow-save failure at the UI boundary; conversion stayed in Basic and retained the unfinished Advanced draft. Retrying performed a real save and retained the edited source label in revision 2 of `workflow-review:cfb1436b-51dd-4698-8e3b-2132b915162d`.
- Ran an image → resize → save graph through the UI: `be0e4131-bb69-4d4c-a150-7fd32c9ab10a`. It saved one 320 × 320 image. Selecting another Activity run, visiting Basic, and returning to Advanced retained the graph's own run; View results opened the correct output. Advanced jobs did not appear in Basic.
- Added 4.2 seconds of latency to the real saved-workflow lookup. Background polling no longer discarded the selected run's settings.
- Inspected image and video results from the previous SPAN/video run, `workflow-run:7f81405f-54c6-4e7d-8212-67cff0359385`. Playback reached the end of its 2.125-second, 512 × 512 video without a media error. Image and video exports match their stored assets by byte count and SHA-256. This rechecked delivery of existing outputs; it did not regenerate that video.
- Checked the asset dialog at 1440, 900, and 430 pixels wide, including actual screenshots, viewport bounds, scrolling, and reachable actions.
- Canceled an active three-pass visual review using the Advanced toolbar: `workflow-run:35445c8a-1229-43c6-93f6-c7c2a76353b0`. Canceled state was observed about 3.4 seconds after clicking; no final output was published. An earlier harness attempt waited for execution to finish before attempting cancellation and is excluded from cancellation evidence.
- Opened the fresh inconclusive Stop run in Activity, inspected its intermediate results, exported its JSON report, and reopened its pinned settings with Edit and rerun. The exported report matches the stored SHA-256. The initial failed report export is retained as evidence of the native validation defect fixed here.

Evidence: `navigation-assertions.json`, `recovery-assertions.json`, `exports-verified.json`, `cancel-review-before.json`, `cancel-review-final.json`, and `inconclusive-report.json`.

### Rechecked advanced limits

These are new executions using the current managed runtime, not results copied from the previous report.

| Check                                      | Run                                                 | Observed outcome                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated-image stop                        | `workflow-run:03761182-0c79-4645-882c-ef8369721c23` | Stopped on attempt 2; no final output.                                                                                                                      |
| Three-attempt limit                        | `workflow-run:f44a2350-2dcd-49dd-84e4-440806909cdc` | Exactly 3 attempts with repetition detection disabled; no final output.                                                                                     |
| Independent output before a failing branch | `workflow-run:ede620f2-485f-4dbd-b760-d1db2a12b2ec` | The early output did not publish; stopped after 3 failed attempts.                                                                                          |
| Inconclusive Stop                          | `workflow-run:795b4b9b-9806-4006-a8fe-37609e9b0c25` | An intentionally short assessment budget produced unknown judgments. Stopped after 1 attempt despite Repeat on failure; retained evidence, no final output. |
| Inconclusive Continue                      | `workflow-run:fe10dc60-1b44-44aa-9484-de09441e43c2` | Saved 1 image while retaining an inconclusive assessment. Completion was not reported as a passed quality judgment.                                         |
| Garden appearance assessment               | `workflow-run:a6c8f160-4e56-4508-bbf9-95d19d5ba4b7` | One review passed; the second response was incomplete. The combined decision was inconclusive and stopped publication.                                      |

The last assessment used the earlier garden asset from `workflow-run:32d64902-72ff-47d9-8906-28805bf083a3`, not the later full-strength replacement. The later full-strength result from `workflow-run:07cb5f2c-5b16-441e-9fd9-2d7fdd66dcd3` was separately exported again and visually inspected. It contains a complete garden and path, but the subject still appears composited, with imperfect lighting and ground contact. Inspection of the stored upscaled blue dress also shows a flat-looking dress and visible silhouette fringes. Successful export or upscaling does not remove those defects.

Inspected files: [background](../apps/client/.cache/media-experience-2026-09-14/background-rechecked.png), [upscaled dress](../apps/client/.cache/media-experience-2026-09-14/saved-dress.png), and [saved video](../apps/client/.cache/media-experience-2026-09-14/saved-video.webm).

### Automated checks

- Frontend Media Studio: **43 files, 286 tests passed** with `vitest run src/core/media src/tauri/ui/media`.
- Native exports: **4 tests passed** with `cargo test --lib media::exporting::tests`, covering original bytes and audit recording, oriented-image metadata removal, misleading extensions, and JSON report preservation.
- Core, UI, and test TypeScript checks passed. UI and test checks were repeated after the final recovery changes.
- Media UI lint, formatting for all 18 affected UI/test files, native export formatting, and targeted whitespace checks passed.
- The final runtime check reported ready, with **0 active and 0 queued runs**.

The full native and managed-Python suites from the previous iteration were not rerun; their counts are not included above. This iteration changed native export handling and frontend orchestration/presentation, with real worker executions used to recheck the relevant advanced behavior.

## Remaining limits

- **SAM3 access remains blocked.** A fresh request through the managed Hugging Face client returned HTTP 401 / `GatedRepoError` for `facebook/sam3` weights; no credential was present. `sam3-access.json` records the check. SAM3 inference and the complete SAM3 → edit journey remain unverified.
- **Reliable automatic acceptance and refinement convergence remain unproven.** The new garden assessment was still inconclusive, and inspected previously accepted media still has visual defects. Agreement and exact preservation checks do not establish satisfactory edges, lighting, anatomy, or semantic success.
- The review rechecked installed-runtime readiness on the AMD Radeon RX 9070. Fresh installation/repair, other hardware and models, paid remote-provider execution, and packaged builds were not verified in this iteration.
- New video generation, a fresh SPAN inference, new masked background generation, maximum 20-attempt loops, and automated video-content quality judgments were not rerun here. Existing image/video delivery and the fresh limits listed above are the evidence for this iteration.
