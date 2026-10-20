# Text to Speech implementation evidence

The acceptance contract remains [the complete suite plan](text-to-speech-suite-plan-2026-10-18.md). This is an implementation ledger, not a completion declaration. Open work remains in scope.

## Recorded checks

- `node --test packages/speech/src/speech.test.ts`: **14 passed**, including Unicode round-trip, malformed syntax, contiguous casting, segmentation, selection context, snapshot hashing, Markdown/control safety, incremental buffering, answer revision handling, dictionary matching, cumulative alignment, late playback rejection and autoplay recovery.
- Native focused harness, `cargo test --manifest-path docs/validation/text-to-speech/native/Cargo.toml --lib`: **23 passed** after fixing SQLite signed integer conversions. This executes the production parser and store files. It covers fragmented SSE/MessagePack, finish handling, alignment replacement, WAV sample counts, revision conflicts, concurrent writers, immutable provenance, interrupted-job recovery and corrupted assets. Subsequent native changes still need integration checks.
- UI type checking found missing workspace links, then two Fish label type errors. Workspace links and the two labels were corrected; the next check must establish the current result.
- Full desktop library checking initially stopped during environment setup because Ninja was absent from PATH. Rust exists at the user's `.cargo/bin`; this is being resolved, not treated as a permanent external blocker.
- No development server was started.

## Provider and environment evidence

[Environment capture](validation/text-to-speech/environment-2026-10-18.json) records the Fish OpenAPI digest `4482b160d34f1d4fd1af96c3e8b3e9781fa4ed4059ba31f1178c6b5d1987a65e`. Raw provider schema downloads are under `D:\Models\machdoch\speech\research`, not the repository or a default model cache.

The process environment has no `FISH_API_KEY` or `FISH_AUDIO_API_KEY`. This does not establish the contents of a future OS credential entry. Windows device inspection reports **AMD Radeon RX 9070** and **AMD Radeon(TM) Graphics**. No NVIDIA executable was found at its standard System32 path. These devices do not meet the documented NVIDIA runtime contract; no local Drama 3 inference was claimed or attempted.

The current [timestamped WebSocket documentation](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-live-with-timestamps) specifies MessagePack, concurrent text/audio, `stop` followed by `finish`, trailing empty-audio alignment corrections and replacement by chunk sequence. This resolves the plan's documentation gap for that transport. The [Drama 3 guide](https://docs.fish.audio/features/text-to-speech/drama-3) still requires an explicit `model: drama-3` header because a missing/unrecognized value selects a different model.

Voice Design remains a distinct `voice-design-1` request. Its current OpenAPI preview text maximum is **150**, while the prose guide says **300**; implementation follows the inspected schema's stricter bound. Account billing units/rates, API retention terms, hosted text/speaker/reference capacities and actual model behavior remain unverified. No price or hosted speaker limit is invented.

The [encoder capture](validation/text-to-speech/encoder-2026-10-18.json) records an installed, checksum-verified FFmpeg 9.0.2 Windows x64 distribution, GPL-3.0 license location and binary hashes, all under `D:\Models\machdoch\speech\encoder`. Installation does not by itself verify the application's export pipeline.

## Requirement matrix

| Contract area | Implementation/evidence | Remaining work before acceptance |
| --- | --- | --- |
| Separate app, rail, command, persisted selection | `tts` identity, Mod+4 command and lazy studio mount in client shell | Focused navigation/reopen/restart UI checks; activity and shutdown integration |
| Shared compiler and source mapping | `packages/speech/src/script.ts`, `compiler.ts`; focused checks pass | Large-book latency/memory measurement; full scoped language completion; stable selective rerender checks |
| Editor, source/structured views, diagnostics, undo, autosave/conflicts | `packages/text-to-speech/src/editor.tsx`, `studio.tsx`; native CAS/revision tests pass | Real focused editor UI checks, folding/outline/find across chapters, crash-draft recovery and IME/RTL interaction evidence |
| Imports, localization, templates, reading/bookmarks | Project domain includes variants/bookmarks | Complete connected import/template/localization/reading actions and checks |
| Fish REST, timed SSE, native MessagePack WebSocket | `speech/fish.rs`, `transport.rs`; parser tests pass, explicit model headers in source | Wire-boundary capture tests, inline MessagePack reference verification, frontend streaming integration |
| Voices, casting, references, cloning, design | Native `voices.rs`, `providers.rs`; connected studio panels, rights checks and private creation | Real library/voice mutation fixtures require Fish key and cleared recordings; recording/trim/import-format workflows and design provenance round-trip checks |
| Pronunciation dictionaries | Shared validation/leftmost-longest preview, native revisions and inline Fish compilation | UI preview/conflicts/import/export and exact pinned take provenance checks |
| Profiles and supported answer providers | Canonical typed service, Fish speech-only schema, OpenAI/Google profiles, explicit system voice playback | Native service integration checks; remove obsolete ad hoc command/wrapper after all consumers are migrated |
| Immutable takes/cache/snapshots | SQLite immutable revisions/assets/takes and request snapshots; corruption and lineage tests pass | End-to-end cache replay/bypass, selective rerender and provenance checks across imported projects |
| Durable queue, priorities, budgets, cancellation/recovery | Native `jobs.rs`, cancellation tokens and budget reservations; uncertain restart storage test passes | Native dispatcher/budget/cancellation race tests, atomic submission audit, queue pause and batch actions |
| Bounded streaming/playback/alignment | Shared coordinator and measured alignment; native bounded disk-spooled PCM and pull operation | AudioWorklet integration, seek/final-asset handoff, bounded buffer and cancellation latency measurement |
| Answer content safety and ordering | Explicit terminal response boundary, Markdown AST, no synthesis fallback, ledger, revision/session/new-turn interruption, microphone pause | Focused hook/UI checks; final-channel adapter streaming mode, per-conversation override, selection/save/open-in-studio actions |
| Waveform, timeline edits, mixing, production checks | Editable timeline trims/gains/fades and native FFmpeg assembly | Interactive waveform, split/move/silence/crossfades/ducking and measured checks; timing invalidation/realignment |
| Export: WAV/MP3/Opus/FLAC/M4B/transcripts/subtitles | Native export implementation plus pinned local encoder | Real fixture exports and decode validation; chaptered M4B metadata, two-pass loudness, clips/stems, accurate assembly selection |
| Portable project archives | Current-schema ZIP path/size/digest validation and archive writer/importer | Lossless all-revision/reference/transcript/rights/lineage round-trip; atomic import and collision isolation audit |
| Media Studio handoff | Native decoded audio import with source-project/take/model/alignment provenance | UI handoff navigation and actual Media Studio inspection; deduplicated imports must retain all source links |
| Creative direction, voice comparison, assistance | Direction wrapping and take A/B controls | Reviewable configured-text-model assistance, director notes/rehearsal and explicit comparison budgets |
| Self-hosted connection and managed runtime | Explicit SGLang connection settings; no cloud fallback; revision/infilling stays disabled | Pinned request-schema verification, safe reference transport, managed manifest/install/uninstall/preflight; actual eligible-host synthesis/continuity edit |
| Storage/cache retention/deletion | Transactional metadata, scoped content-addressed files, integrity validation | Reference-counted retention/cleanup, cross-window recoverable drafts, full-disk/truncation fixtures and deletion behavior |
| Credentials, privacy, consent, licensing | Native OS keyring integration, explicit cloud consent, no credentials in project/profile contracts | Actual keyring save/test/delete; diagnostics/export privacy checks; applicable model/codec/service/account rights and retention review |
| Remote/Fleet | Existing remote settings are not counted as speech transport | Authenticated scoped job/audio operations, client playback, ownership/disconnect and secret-leakage checks |
| RALPH/CLI/Smart Scheduler | Canonical typed operation contract exists | Connect those execution surfaces and verify durable job/asset ownership and budget propagation |
| Accessibility/platforms/performance | Semantic controls, responsive studio, CodeMirror; shared playback state tests | Focused Playwright/keyboard/accessibility checks; real playback/export on Windows/macOS/Linux and latency/memory measurements |

## External prerequisites versus open implementation

Real Fish synthesis/listening and voice mutation evidence needs a configured Fish account/key, suitable account access/credit, and consent-cleared voice references. Local inference needs an eligible supported NVIDIA host and a verified pinned runtime/model/codec/license snapshot. Account-specific billing/retention/rights terms cannot be established from public pages alone. macOS/Linux playback evidence requires those actual runtimes.

These prerequisites do not close or excuse the open implementation and verification work listed above. The goal is not complete.
