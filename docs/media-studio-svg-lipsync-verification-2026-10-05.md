# Media Studio SVG and lip-sync verification — 2026-10-05

The full studio goal is incomplete. This continuation verifies integrated MuseTalk execution and addresses IntroSVG generation, memory placement, and obsolete model verification metadata. Real media and logs are retained under `D:\Models\machdoch\verification\2026-10-05\svg-lipsync`.

## Changes

IntroSVG now renders its draft and uses the local vision model to critique and revise it. Balanced permits one revision; Quality permits three. The final candidate is the highest-scoring rendered draft. Fast remains a direct generation mode. Invalid XML, unsafe external resources, malformed critiques, and unchanged corrections fail explicitly. Nested SVG documents are extracted as complete XML instead of stopping at the first closing tag.

The renderer is the pinned Windows wheel `resvg_py==0.5.0`. Critique previews retain the viewport aspect ratio, use a white backdrop, and fit within 512 pixels. Reference images remain part of the visual review. New recipes default to one candidate, and the worker reports loading, generation, review, and refinement stages. The refinement module is included in desktop resources.

The real run exposed two GPU-placement defects: the SVG command did not select the studio's chosen adapter, and automatic placement could also use other adapters. The command now selects and configures the adapter before loading. Placement uses that GPU and CPU only. Profiling then found decoder weights being transferred during autoregressive generation. The revised placement keeps the language model and output head on the GPU, allocates remaining memory to vision blocks, and uses the current Transformers offloaded cache. It reports insufficient memory explicitly. See the publisher's [refinement implementation](https://github.com/gitcat-404/IntroSVG/blob/master/inference_loop.py), [renderer API](https://resvg-py.readthedocs.io/en/latest/api.html), and [cache documentation](https://huggingface.co/docs/transformers/main/en/kv_cache).

Unused model verification metadata was removed from native and TypeScript catalog contracts, profile builders, fixtures, and model search. The removed native probe command stays absent. Package integrity and runtime health remain automatic internal checks.

## Real lip-sync evidence

An initial standalone probe joined two one-second excerpts of the publisher's animated-character sample and ran the actual MuseTalk 1.5 weights. It produced 50 frames at 640 × 1106 and 25 fps with a soundtrack and separate vocals. Total time was 764.949 seconds; lip rendering occupied roughly 28 seconds. The rest was dominated by imports and loading. All frames and 32,000 finite audio samples decoded. Mouth-region changes averaged 9.899 pixel levels; changes outside the face averaged 1.436. Visual inspection found subtle mouth variation. These measurements establish changed pixels, not accurate phoneme alignment.

The native test used the publisher's human-face sample, a mirrored second excerpt to create a visible cut, and normalized English speech. A distinct soundtrack file was supplied separately from vocals. This is spoken-audio testing, not a song or singing test. [MuseTalk's repository](https://github.com/TMElyralab/MuseTalk) supplies the model and example assets.

Actual Codex 6.1 Sol produced a typed graph containing both video sources, ordered scene composition, separate Audio and Vocals connections, MuseTalk 1.5, and an opaque WebM output. The isolated desktop's effective internal-task configuration is `codex-cli`, `gpt-6.1-sol`, `xhigh`; `codex-effective-model.json` records those fields. The native command routes through the internal-task inference implementation, which passes the configured model to Codex. Frontend compilation and native revision saving succeeded. Native workflow `45933200-965f-4001-ab74-d237b4a237c9` completed and exported in 923.080 seconds. It produced a non-fixture 640 × 854 WebM with SHA-256 `e1ce70c775fd07904e1272cc054d51949f1edf844a53a94a88075f13f5c77467`.

Independent decoding retained all 50 frames, the scene cut, and 32,000 finite 16 kHz audio samples. Audio peak was 0.4871 and RMS was 0.1249. The generated mouth regions differed on all 50 frames, averaging 11.869 pixel levels; outside-face changes averaged 1.572. The eight full-face comparisons and all 50 mouth crops were inspected. Teeth were softened and mouth variation was limited. Phoneme accuracy, perceptual synchronization, and listening quality were not established. The result does not meet a perfect lip-sync or fast-generation claim.

Playwright used the actual bundled desktop frontend without route interception. Native output, original-byte export, and browser bytes matched. Preview had sound enabled; playback advanced and seeking to 1.25 seconds crossed the mirrored cut without page or media errors. Browser duration was 2.008 seconds; full video decoding found 50 frames at 25 fps. Evidence: `codex-request.json`, `codex-result.json`, `compilation.json`, `prepared-native-request.json`, `native-human-run.json`, `playwright-native-human-lipsync.json`, `playwright-final-ui.json`, `native-human-lipsync-inspection.json`, and the corresponding WebM and PNG files.

An earlier executable rejected the lip-sync node because it preceded the source integration. The rebuilt executable accepted and completed it. That earlier failure is retained as `native-failure.json`; it does not describe the successful rebuilt run.

## SVG evidence

The existing publisher package, revision `5da60d628d226361fb0a8210dc021782e5ee484a`, was registered through the native installer. Sixteen allowlisted files totaling 16,600,362,059 bytes were linked from the existing download into a new managed package tree. The installer rehashed every file before registration. No database readiness flags were injected, and this does not count as a fresh network download. Evidence: `svg-install-plan.json`, `svg-install-cached-package.json`, `svg-install-completed.json`, and `svg-install-model.json`.

Two initial standalone attempts crashed in the ROCm DLL with access violation `0xC0000005`; the first failed in a token-membership operation and the second in a cumulative-sum operation. Both operations passed on the explicitly selected RX 9070. A temporary custom end-token implementation was discarded. The canonical implementation uses normal model end tokens and fixes adapter selection and placement.

The next native Balanced request reached actual text generation without that crash. A read-only stack sample found Accelerate transferring decoder weights during generation. The run was canceled through the native API before producing an asset, and its worker exited. The cancellation and stack evidence are `svg-swap-heavy-cancel.json`, `svg-model-stack.txt`, and the corresponding canceled run record. A new real request tests the resident decoder and offloaded cache; its final result is pending at report draft time.

## Software checks

- Complete Media Studio suite after metadata removal: 656 tests across 84 files passed in 89.54 seconds.
- Native media suite after metadata removal and the test-only import correction: 366 passed, 12 ignored, 157.12 seconds after compilation. Ignored checks require external services, fixtures, or an additional disk.
- Complete Python discovery after the resident-decoder change: 369 tests passed in 64.075 seconds; total command time was 114.760 seconds.
- Media Studio and client UI typechecks, scoped lint, and whitespace checks passed. The final production frontend build passed in 58.52 seconds. The final native debug build passed in 3 minutes 52 seconds after frontend work; total build command time was 298.083 seconds. Its remaining warning concerns the pre-existing `RecoverySummary.recovered_runs` field.

Earlier failed broad Python discovery identified obsolete SVG expectations and incomplete test doubles. Those were updated to the canonical XML extraction and explicit allocation behavior. Earlier focused invocations also used a nonexistent test module name; the corrected invocations passed. These harness failures are retained separately from model execution evidence.

## Full-goal assessment

| Requirement | Evidence and remaining gap |
| --- | --- |
| Modern image, video, SVG, and audio models | Current adapters, profile and training research are in the linked support reports. Real execution is limited to specific SDXL, Krea Turbo, CogVideoX, LTX, IntroSVG, AudioLDM 2, and MuseTalk recipes. It does not establish every variant or all 31 exact profiles. MiniMax and Krea RAW still lack real execution here; several publisher runtimes remain unintegrated. |
| Beginner and advanced generation | Prior reports exercise Basic forms and Advanced recipes. This continuation tests a native Codex-created scene/lip-sync graph and real asset playback. Full usability, all conditioning combinations, and all editing/grouping interactions remain unverified. |
| Stable, fast, high-quality media | The verified paths execute and retain original exports. Image composition and LTX motion issues remain in earlier evidence. Lip-sync rendering defects and cold latency remain. SVG quality and speed require the final real result. Software checks cannot establish perfect media. |
| Assets, downloads, and keyword detection | Prior download, import, export, playback, and LoRA keyword checks remain relevant. This continuation registers a real managed SVG package and removes internal probe terms from model search. Broad semantic keyword quality is unverified. |
| Full finetuning and LoRA creation | SDXL LoRA smoke training and adapter generation were verified previously. Krea RAW training has no completed real job. Full-weight finetuning and training for other families are not implemented. Publisher routes are documented separately. |
| Multi-scene video, supplied audio, and lip sync | Real native scene composition and MuseTalk execution are now established for the tested 2-second graph. Singing, songs, long clips, diverse faces, generation-stage motion LoRAs, and their combined quality are unverified. |
| LLM enhancement | Prior Basic field filling and this Advanced graph use real Codex 6.1 Sol requests. Generated scenes combined with a song and singing lip sync remain unverified. |
| Remove model verification | Probe command removal was verified in the desktop. Obsolete catalog metadata and search tokens have now been removed in source; final native catalog serialization must be checked after the last build. |
| Typed cross-model flows | Compiler and native graph checks pass for the tested utilities and earlier media recipes. The complete image → postprocess → variant → distinct first/last frames → video chain still lacks a real end-to-end run. |
| Clear flow editor | Existing automated checks cover types and interactions. This continuation does not establish every add/remove/group/port interaction against every real model. |

The machine has a 16 GB RX 9070 and about 32 GB of system RAM, with model storage on D. Publisher requirements for larger inference and training jobs exceed this hardware; those jobs cannot be verified here merely by listing their profiles. Paid-provider execution and gated-model access have not been verified in this continuation. Build and cold-runtime delays are measured on this Windows debug desktop and are not release performance guarantees. The installed task host was preserved; only the owned isolated test desktop is eligible for cleanup.

See the [support matrix](media-studio-model-support.md), [training research](media-studio-training-research-2026-10-04.md), [earlier real generation report](media-studio-verification-2026-10-03.md), [SDXL training report](media-studio-verification-2026-10-04.md), and [LTX/startup continuation](media-studio-startup-verification-2026-10-05.md).
