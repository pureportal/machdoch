# Workspace intelligence: implementation and verification

Research and verification date: 22 October 2026.

| Feature | Delivered behavior | Desktop and Fleet |
| --- | --- | --- |
| Workspace knowledge | Incremental SQLite FTS5 search over supported workspace text files, source previews with line references, and saving search evidence into research projects. Git exclusions, sensitive files, symlinks, and size limits are enforced. | Shared panels, agent tools, CLI commands, and native/headless Fleet transport. |
| Context size | Per-chat and context-pack overrides, workspace defaults, CLI configuration, provider/model validation, and restoration of temporary pack settings after the next accepted prompt. | Shared picker; Fleet managed profiles preserve settings through export, synchronization, and execution. |
| Research projects | Persisted questions, notes, sources, findings, source links, revision conflict checks, and local source freshness checks. | Shared research editor, agent tools, CLI, and native/headless Fleet operations. |
| Applicable memory | Task conditions, exclusions, expiry, evidence age, confidence, and relevance are checked before retrieval. Reuse does not refresh evidence timestamps. The same rules cover reasoning-bank lessons. | Shared execution path and applicability details in memory views. |
| MCP Apps | Enabled by default; global setting; isolated interactive tool results; protocol initialization, original tool input/result, resize, and confirmed tool calls. App-only tools stay out of model catalogs. | Desktop and remote conversation views, native provider proxy capture, persisted headless chat results, and settings in Fleet. |
| Live voice and corrections | Streaming transcription, speech detection, playback interruption, configured transcript processing, serial correction submission, draft retention, and recovery of unsent text. Running-task corrections cancel and settle the current task before replacement. | Shared browser capture/control; native and Fleet bridges. OpenAI and Google streaming providers. |
| Skills | Global skill library with editing, search, enable/disable, conflict detection, frontmatter preservation, and resource access. Enabled skills use progressive disclosure; Codex and Copilot receive isolated native skill files. | Shared Instructions/Skills interface, CLI, Fleet operations, provider catalogs, and skill-reading tools. |

## Provider boundaries

| Provider | Configurable context size |
| --- | --- |
| Codex CLI | Numeric tokens, bounded by registered or discovered model capacity, including a discovered long-context maximum. |
| Claude CLI | The documented `[1m]` tier for supported Opus/Sonnet 4.6 models and aliases. Models without that selectable tier do not show the control. |
| Copilot CLI | Long context only when provider discovery advertises `longContextWindowTokens`. |
| OpenAI, Anthropic, Google, Langdock APIs | No arbitrary context-size control is exposed. A model's advertised capacity does not establish a configurable request parameter. |

Live voice uses the selected OpenAI or Google speech provider. Existing local dictation remains separate. Browser playback and native reply playback use their existing speech controls.

Workspace search covers text files; it does not claim PDF parsing, OCR, embeddings, or recording transcription. Research source checks verify local file fingerprints. Web sources remain marked unverified until reviewed; this implementation does not claim automatic web-source refresh.

## Research decisions

Research was performed before implementation for each feature. The existing [recommendations](ai-feature-recommendations-2026-10-22.md) and [deep review](ai-research-deep-review-2026-10-22.md) provide the broader investigation. These primary sources informed the implemented boundaries:

- Retrieval: [SQLite FTS5](https://www.sqlite.org/fts5.html) and [Node SQLite](https://nodejs.org/api/sqlite.html). Local indexing, literal query handling, and source references keep results inspectable without requiring an embedding service.
- Persistent research and evidence: [arXiv:2610.01097](https://arxiv.org/abs/2610.01097), [arXiv:2602.13855](https://arxiv.org/abs/2602.13855), and [arXiv:2609.25913](https://arxiv.org/abs/2609.25913). The implementation keeps sources and findings distinct and tracks changes instead of treating saved conclusions as permanently current.
- Memory applicability: [arXiv:2609.02127](https://arxiv.org/abs/2609.02127), [arXiv:2609.32521](https://arxiv.org/abs/2609.32521), and [MemDev-Bench](https://arxiv.org/abs/2610.27524). Retrieval eligibility is checked before ranking, and retrieval alone cannot renew evidence.
- Context configuration: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude model configuration](https://code.claude.com/docs/en/model-config), [Anthropic context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows), [Copilot model support](https://docs.github.com/en/copilot/reference/ai-models/supported-models), [Gemini models](https://ai.google.dev/gemini-api/docs/models), and [Langdock completion API](https://docs.langdock.com/en/developer/completion-api/completion-overview). Support is gated by provider and model rather than displaying a universal token slider.
- MCP Apps: [specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [overview](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html), and [host example](https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/README.md). The host negotiates supported capabilities and isolates app content behind an opaque-origin sandbox with restrictive CSP.
- Voice: [OpenAI realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [voice architecture](https://developers.openai.com/api/docs/guides/voice-agents), [Google live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe), and [Google ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens). Browser connections use short-lived credentials. An actual Google request revealed that the raw REST field must follow the [official SDK token converter](https://github.com/googleapis/js-genai/blob/main/src/converters/_tokens_converters.ts), using `bidiGenerateContentSetup` rather than the high-level SDK option name.
- Skills: [Agent Skills specification](https://agentskills.io/specification), [client implementation](https://agentskills.io/client-implementation/adding-skills-support), [Claude skills](https://code.claude.com/docs/en/skills), and [Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills). Catalogs disclose names/descriptions first, then load selected instructions and resources; native delivery uses the provider's supported isolated directory.

These design choices are engineering applications of the sources, not reproductions of paper benchmarks or claims of equivalent performance.

## Verification

Passed checks include:

- Real Chrome interaction with the shared components and real temporary SQLite/skill stores: search, source preview, source-to-project saving, research and skill persistence after reload, context gating, spoken correction submission, playback interruption, retained typed drafts, and failed-message recovery. The fixture was bundled and served through Playwright routing; no development server was started.
- Real Chrome MCP sandbox negotiation, tool interaction, opaque-origin isolation, and blocked undeclared network access.
- OpenAI short-lived credential creation and actual streaming transcription of generated test speech through the implemented connection.
- Focused knowledge/research, memory/reasoning, skills/delivery, MCP host/backend/proxy, live connection/capture/control, context, Fleet transport, task correction, temporary pack, and managed-settings regression tests.
- Native `cargo check --lib` using the installed Windows native/Vulkan toolchain; Fleet protocol Rust tests.
- Type checks for client core, desktop UI, client test sources, Fleet Manager, and shared client/product UI packages.
- Visual inspection of the skill editor and whitespace validation of the working diff.

Google ephemeral token creation succeeded. The live connection then reported depleted prepayment credits, so Google audio transcription could not be verified against the configured account. Its connection protocol is covered by mocked tests. Physical microphone capture, native audio devices, a packaged desktop launch, and a deployed Fleet installation were not exercised. Native compilation reported existing unused-code warnings in media and speech modules.

## Refinement verification

The subsequent refinement pass fixed:

- Workspace search in Git subfolders now respects repository exclusions. Windows line endings no longer prevent search excerpts from being saved as research evidence; fingerprints still identify the original file bytes. File validation and hashing use eight concurrent workers.
- Research refresh reloads the selected revision, and project selection is disabled during saves. Deleted sources no longer prevent editing a project's notes. Previously saved evidence is retained, while changed or newly supplied excerpts must match the source.
- Task-scoped MCP servers use Machdoch's app host when apps are enabled, including servers without cached discovery. Codex enrollment waits for optional MCP discovery within the existing server startup timeouts. The live test reproduced missing tools with Codex's default one-second discovery grace period and succeeded with `mcp_optional_startup_grace_ms = 0`. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
- Saved apps honor original-tool disablement, failed loads offer Retry, and switching workspaces removes the old frame. The settings toggle updates immediately and rolls back on save failure. Declared secure WebSocket connections are accepted in app CSP, consistent with the [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
- Stopping voice during message delivery cannot send the message twice. Conversation changes abort the old voice session and prevent late transcripts reaching the next chat. Recovery controls prevent editing or discarding text while delivery is pending.

Real Codex CLI **0.159.1**, using **gpt-6-luna**, called an MCP fixture through the production CLI proxy. Its result was persisted, loaded into the browser sandbox, and used to perform a confirmed app-only tool action whose file artifact was checked. The successful inference artifact was reused while refining subsequent browser checks.

Real OpenAI speech synthesis produced 175,200 bytes of PCM audio. A production ephemeral transcription session and browser WebSocket connection returned: “Change the research title to Northern Lights.” This verifies generated audio through the streaming connection; it does not verify a physical microphone or native audio device.

The shared Fleet workspace UI saved Windows search evidence into a research project and retained it after browser reload. Focused regression checks passed for changed search/research behavior, MCP backend/host/settings/projection/enrollment, voice delivery/connection/capture, temporary packs, context sizes, memory applicability, skills, and headless Fleet library operations. Client core, UI, test-source, and shared client UI type checks passed. An obsolete temporary-pack test was updated to the current queue/stop-and-send actions. No development servers were started.

A warm 256-file fixture measured **1,011 ms sequentially versus 211 ms with eight workers** for file validation, decoding, and hashing. This excludes traversal, SQLite, browser rendering, and cold storage; it is not an end-to-end search latency claim.

- [Live verification report](../.machdoch/validation/workspace-intelligence-fm4j1Z/report.json)
- [Actual Codex tool-call events](../.machdoch/validation/workspace-intelligence-fm4j1Z/codex.jsonl)
- [Performance measurement](../.machdoch/validation/knowledge-performance-cJUlMq/report.json)
- [Repeatable live verification runner](../apps/client/scripts/verify-workspace-intelligence-live/run.ts)

The live runner uses isolated configuration and synthetic workspace data, removes its copied Codex authentication file, and serves the browser fixture through Playwright routing. Packaged desktop launch, deployed Fleet networking, physical microphone capture, and non-Codex providers were not live-tested in this refinement pass. Codex discovery may now wait longer for a slow configured MCP server, bounded by its existing startup timeout.

## Further refinement and live capture verification

The next pass addressed four additional issues in the shared desktop/Fleet implementation:

- OpenAI transcription keeps pending partials and out-of-order finals together in spoken order. Completing an earlier utterance no longer clears a later utterance's recoverable text. Stopping while an identical earlier message is being sent also preserves intentional repeated speech.
- MCP Apps show loading until the initialization handshake completes. An app that does not initialize within 20 seconds is closed and offers Retry. Successful initialization and unmounting clear the timer.
- Selecting the already active Research tab leaves the unsaved-change state intact. Cancelling navigation retains the draft.
- Search indexing removes obsolete chunks in one SQL statement, avoiding a full scan of the unindexed path column for each changed file. Changed and deleted files are handled together; unchanged evidence remains intact.

The protocol checks used the current [OpenAI transcription guidance](https://developers.openai.com/api/docs/guides/realtime-transcription) and [MCP Apps initialization specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). The database change retains the existing [FTS5](https://www.sqlite.org/fts5.html) schema and secure deletion behavior.

Verification passed:

- **524 distinct focused tests across 26 files** covering workspace knowledge and research, memory applicability/retrieval/consolidation, reasoning-bank eligibility, context configuration and packs, global skills and provider delivery, MCP backend/projection/enrollment/host/UI, voice capture/connection/control, task corrections, and Fleet command handling. The research UI file was rerun after the active-tab fix; that repeated run is not counted twice.
- Type checks for client core, desktop UI, client test sources, and shared client UI. The existing native compilation results above remain the evidence for unchanged Rust code; native compilation was not repeated in this pass.
- A new real Codex CLI 0.159.1 invocation using gpt-6-luna called the production MCP proxy and persisted an interactive result. Browser interaction saved the revised title to a real file. The same inference artifact was reused for the final browser check.
- Browser checks exercised an app that deliberately omitted initialization, its timeout and successful Retry, settings disablement, research persistence after reload, and retaining an unsaved draft when navigation was cancelled.
- Real OpenAI speech synthesis and ephemeral transcription returned “Change the research title to Northern Lights.” The audio passed through a generated browser MediaStream, production AudioWorklet capture, speech detection, PCM encoding, and WebSocket transcription: one detected utterance and 86 audio chunks. Only the physical microphone acquisition boundary was replaced with generated audio.
- A separate integration check connected the production Fleet operation transport to the actual headless workspace runtime, without mocking its core services. It verified multichunk Unicode source responses, indexing, research persistence, global MCP App settings, and rejection of an unlisted workspace. This does not exercise deployed HTTP/WebSocket networking.

The synthetic performance fixture contained 1,200 files with 300 lines each. Measurements cover the production backend search request, including traversal, validation, reading, hashing, SQLite updates, and query execution; fixture creation is outside the timing.

| Operation | Before | After |
| --- | ---: | ---: |
| Initial indexing and search | 34,683 ms | 16,680 ms |
| Unchanged indexing and search | 6,809 ms | 8,184 ms |
| All files changed, then search | 209,004 ms | 30,091 ms |

These are single local synthetic measurements under development-machine load, not a latency guarantee or a statistical benchmark. Unchanged searches still traverse and hash files and did not improve in this measurement. Browser rendering and Fleet network time are excluded.

- [Live browser, Codex, and audio report](../.machdoch/validation/workspace-intelligence-JW912G/report.json)
- [New Codex tool-call events](../.machdoch/validation/workspace-intelligence-JW912G/codex.jsonl)
- [Confirmed app action artifact](../.machdoch/validation/workspace-intelligence-JW912G/workspace/app-action.json)
- [Production Fleet transport/runtime report](../.machdoch/validation/fleet-library-oVTOLJ/report.json)
- [Performance before](../.machdoch/validation/knowledge-refresh-rcwy1f/report.json) and [after](../.machdoch/validation/knowledge-refresh-vXGeGN/report.json)
- [Performance fixture runner](../.machdoch/validation/measure-knowledge-refresh.ts)

No development servers were started. Physical microphones and native audio devices, packaged desktop startup, and deployed Fleet networking remain unverified. Google voice was not retried; its earlier billing limitation remains recorded above. The MCP startup deadline can require Retry for an app whose own resources take longer than 20 seconds to initialize.

## Workspace isolation, network verification, and live corrections

Live voice now binds its session to both the chat and workspace. Changing the workspace within the same chat aborts the previous capture/connection and discards late processing results, partials, and final transcripts. Both desktop and remote composers supply the workspace identity. The focused voice-control and remote-composer checks passed: **23 tests across two files**. Shared client UI, desktop UI, and the live verification scripts passed type checks. The script check includes Fleet's ES2023 library target and the existing CSS declarations.

The browser runner now uses an isolated loopback HTTP listener, the actual Fleet API/authentication/CSRF handlers, GatewayHub WebSocket transport, client gateway connection, and headless workspace/instruction runtimes. Its fixture HTML is routed by Playwright; API requests cross the real network boundary. It verifies:

- Unauthenticated requests return 401, and authenticated mutations without CSRF protection return 403.
- A previously recorded real Codex MCP result initializes in the browser, performs its confirmed action, and saves the revised title. Timeout/Retry and enable/disable behavior still pass.
- Workspace search evidence survives research save/reload, and cancelling navigation preserves a dirty draft.
- Creating a global skill, disabling it, saving, and reloading preserves both its contents and disabled state through Fleet.
- Real OpenAI transcription still returns “Change the research title to Northern Lights.” through production AudioWorklet capture, speech detection, PCM encoding, and the browser WebSocket connection. This latest run detected one utterance and sent 82 audio chunks; the 86-chunk result above describes the earlier run.

A separate real Codex CLI 0.159.1 invocation with gpt-6-luna verified global skill delivery. The production enrollment materializer staged the enabled skill's `SKILL.md` and reference file, excluded the disabled skill, and removed the isolated enrollment afterward. Codex called Machdoch's production `read_managed_skill` tool for the skill and then its referenced JSON file, returning the exact generated marker. This exercises native file materialization and MCP resource consumption. Direct shell reading of the native skill files remains unverified: an earlier read-only invocation was rejected by Codex's execution policy, and the successful run retained the read-only sandbox. The CLI accepted `model_context_window=128000`; this does not measure effective long-context capacity. A fresh Machdoch profile correctly rejected that override for gpt-6-luna without discovered capacity metadata. Native skill directory and progressive disclosure behavior were checked against the [Codex skills documentation](https://learn.chatgpt.com/docs/build-skills).

Another live check used the production Fleet task runtime and execution controller to interrupt Codex while it was awaiting an MCP tool result. The first execution recorded `cancelled`; the replacement began only after that execution settled, called the revised-title tool, and recorded `executed`. Persisted history contained the original request, cancellation, correction, and “Northern Lights” with the exact generated UUID. Resubmitting the same command returned a duplicate receipt and did not create a third execution. The verifier selects the existing read-only generator role; this result does not establish behavior for an arbitrary uncooperative external command. The initial verifier entrypoint was incorrect and caused nested fixture launches; the corrected runner explicitly uses the production CLI entrypoint and rejects proxy arguments. The failed process tree stopped, and twelve copied authentication files in its stopped profiles were removed. Recursive deletion of the remaining temporary profiles was rejected by automatic approval review as “blocked by policy”; those non-authentication artifacts remain in the OS temporary directory.

The browser also acquired a real microphone track at 48 kHz, mono, and stopped it successfully. This checks device acquisition and release only. No microphone samples were stored or sent to a provider; the complete OpenAI transcription test uses generated speech.

- [Authenticated Fleet browser and OpenAI report](../.machdoch/validation/workspace-intelligence-JW912G/report.json)
- [Real Codex skill report](../.machdoch/validation/native-skills-ozImtj/report.json) and [tool-call events](../.machdoch/validation/native-skills-ozImtj/codex.jsonl)
- [Live cancellation, replacement, and persisted conversation](../.machdoch/validation/live-correction-CUncbc/report.json)
- [Physical microphone acquisition report](../.machdoch/validation/microphone-capture-CLHnPp/report.json)
- Repeatable runners: [network/browser/audio](../apps/client/scripts/verify-workspace-intelligence-live/run.ts), [skills](../apps/client/scripts/verify-workspace-intelligence-live/skills.ts), [corrections](../apps/client/scripts/verify-workspace-intelligence-live/corrections.ts), and [microphone acquisition](../apps/client/scripts/verify-workspace-intelligence-live/microphone.ts).

No development servers were started. The network fixture does not verify a deployed Fleet installation, TLS/reverse-proxy configuration, or the complete Fleet application entrypoint. Packaged desktop startup and physical speech through the native audio path remain unverified. Performance measurements from the preceding pass are unchanged; no new performance improvement is claimed here. These results advance the broader improvement goal without establishing complete end-to-end coverage of every deployment and device path.

## Built Fleet pages and shared interface refinement

The next browser pass used the actual built Fleet Instructions/Skills and Workspace Library entrypoints, including their CSS, through authenticated HTTP and WebSocket transport. The fixture now instantiates the full `FleetCliProductRuntime`, including snapshot and Ralph operations, instead of assembling individual workspace and instruction services. Only static asset delivery is routed by Playwright; product operations cross the real loopback network boundary.

This exposed and resolved several visible issues:

- The workspace library now scrolls within the application shell. Research actions at the bottom of a long project can be reached on a narrow screen.
- Instructions/Skills and Knowledge/Research use the existing Radix tabs implementation for arrow-key focus, Enter activation, and linked tab/panel semantics. Cancelling navigation still preserves an unsaved draft.
- Research textareas have explicit labels and stable IDs. Their accessible names no longer include the current text value.
- Skill actions have visible button boundaries, padding, focus outlines, and mobile touch targets.
- Shared Button and Input components use existing theme variables. Malformed color classes previously left primary actions without their intended fill and inputs without their intended focus styling.

The interaction changes follow the [WAI-ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). The color correction uses [Tailwind's documented custom-property syntax](https://tailwindcss.com/docs/adding-custom-styles).

Verification passed:

- Built Fleet pages create and reload skills and research projects, save a local search result as research evidence, preserve drafts when tab navigation is cancelled, and support keyboard tab navigation.
- A 390 × 844 viewport has no horizontal overflow. Scrolling reaches the research actions; screenshots record the final layout.
- Computed styles confirm primary-button fill and input focus rings in both light and dark themes.
- Five workspace-library DOM tests and ten skill-management DOM tests passed. Desktop UI, shared product UI, and the live verification scripts passed their focused type checks.
- The production Fleet media build passed. Desktop production assets and the native debug executable also compiled successfully; this is not an installer or release build.
- The MCP App/browser/OpenAI runner passed against the full Fleet runtime. It reused the recorded real Codex result and performed a fresh OpenAI transcription through production AudioWorklet capture, returning the expected sentence with one detected utterance and 79 audio chunks. Reuse of the model artifact is explicit in the report.

- [Built Fleet entrypoint report](../.machdoch/validation/fleet-entrypoints-9r7Q8G/report.json)
- [Research mobile screenshot](../.machdoch/validation/fleet-entrypoints-9r7Q8G/research-mobile.png) and [skills mobile screenshot](../.machdoch/validation/fleet-entrypoints-9r7Q8G/skills-mobile.png)
- [Updated MCP App, authenticated Fleet, and OpenAI report](../.machdoch/validation/workspace-intelligence-JW912G/report.json)
- [Built-entrypoint runner](../apps/client/scripts/verify-workspace-intelligence-live/entrypoints.ts)

No development servers were started. These checks cover the built embedded Fleet pages and full headless product runtime, but not a deployed Fleet installation, TLS/reverse-proxy configuration, or its Next.js dashboard. Earlier performance measurements remain unchanged.

### Native desktop verification

The updated desktop was built with `tauri:build --debug --no-bundle` under the isolated identifier `com.machdoch.verification20261022.dev`. Its main window stayed hidden, and `MACHDOCH_USER_CONFIG_DIR` and the test workspace pointed to synthetic data. The installed application remained running separately.

The actual WebView2 application loaded successfully. Calls from its webview crossed native IPC and launched the built CLI to verify workspace search/source content, research save/reload, stale-revision rejection, global skill save/reload/disablement, and MCP App settings. The Skills page displayed the saved entries. Toggling Enabled and clicking Save persisted the change through native IPC. The verification instance and its automation connection were stopped afterward.

The first research assertion was corrected to account for the schema's intentional trimming of excerpts. The bridge's synchronous script deadline was too short for the complete sequence, so the verifier ran asynchronously and retrieved its completed report. Neither issue required an application change.

- [Native desktop report](../.machdoch/validation/native-desktop-20261022/report.json)
- [Native build log](../.machdoch/validation/native-desktop-20261022/build.log)
- [Native IPC check script](../.machdoch/validation/native-desktop-20261022/checks.js)

This verifies native debug startup with current embedded UI assets and the external built CLI bundle. A release installer, embedded release CLI/runtime extraction, deployed Fleet dashboard, and physical speech through native audio remain outside the verified paths. Real OpenAI transcription, physical microphone acquisition, real Codex MCP Apps and skill consumption, and real Codex task correction each have their separate evidence above.
