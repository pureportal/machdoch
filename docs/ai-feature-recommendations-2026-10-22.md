**Machdoch: ranked AI feature recommendations**

Research date: 22 October 2026, Europe/Berlin. Source inspection baseline: `c434cf9983ef6c84e56d30683857a738f0da30b4` and the current working tree.

**Build searchable workspace knowledge, persistent research projects, and execution with verifiable outcomes first.** Improve memory applicability and tool efficiency alongside them. These capabilities should retain their value as models improve, and they extend foundations Machdoch already owns.

This is a fresh research and implementation brief alongside the existing [deep review](ai-research-deep-review-2026-10-22.md). It adds budget-matched memory evidence, recent context-compression findings, explicit priorities, and concrete adoption gates. It proposes work; it does not enable features. Product ranking and effort are engineering judgments, not measured customer demand or delivery commitments.

The investigation used current original papers, author repositories, official specifications, model cards, and API documentation. Recent-paper discovery included arXiv's cs.AI listing, whose latest displayed daily batch was 21 October, plus targeted searches for memory, tools, research, context, computer use, evaluation, voice, and media. Papers from 14–20 October receive particular attention. Selected methods and limitations were inspected in the full text of Agent S4, Anti-Persistence, OpenSaC, and RITE; other papers below were reviewed at abstract/publication-record level. This is a targeted engineering review, not an exhaustive literature review or reproduction of benchmark results.

**Priority and product value**

Priority balances breadth of usefulness, differentiation, readiness, existing implementation, and dependencies. Effort describes a useful first release: M means a bounded cross-module change; L means a new persistent subsystem or substantial runtime integration. Confidence concerns product fit, not an estimated probability of research results reproducing.

| Rank | Addition | What users gain | Decision | First-release effort | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Searchable workspace knowledge | Ask across documents, code, screenshots, and later recordings, with exact sources | Start now with selected folders and document/code search | L | High |
| 2 | Verifiable task outcomes | Work completes with evidence that the requested state was reached | Start now by extending Goals and existing execution records | M | High |
| 3 | Persistent research projects | Reopen an investigation, inspect evidence, and refresh changed conclusions | Start now using existing web tools | M | High |
| 4 | Memory that checks applicability | Fewer repeated explanations and fewer mistakes caused by stale advice | Start now with source bindings and supersession | M | High |
| 5 | Programmatic tools and structured application operations | Faster research and batch work with less context overhead | Pilot two representative workflows | M–L | High |
| 6 | Interactive results through MCP Apps | Manipulate comparisons, charts, or forms directly in chat | Pilot one useful result after protocol assessment | M–L | Medium–high |
| 7 | Measured model and reasoning allocation | Lower total cost and latency for a given completed task | Pilot narrow internal workloads | M | High |
| 8 | Live voice and reliable active-task corrections | Talk naturally while work runs and change direction without restarting | Pilot one provider over the existing task runtime | L | Medium–high |
| 9 | Procedures learned from verified runs | Repeat useful work with tested, parameterized procedures | Extend macros and RALPH after outcome evidence exists | M | Medium |
| 10 | Assistance triggered by requested project events | Refresh research or process new files when relevant changes occur | Pilot explicit events through the existing scheduler | M | Medium |

The first three are the main product investments. Numbers 4, 5, and 7 improve the quality and economics of that experience. Numbers 6 and 8 offer visible interaction improvements but should not postpone the underlying knowledge and execution work.

**What Machdoch already has**

| Inspected source | Existing foundation | Actual addition needed |
| --- | --- | --- |
| [Goal evaluation](../apps/client/src/core/goals/goal-evaluation.ts) | Independent evaluation receives observed tool evidence and transcript excerpts; the evaluator is instructed not to execute tools | Structured requirement-to-check evidence and fresh verification collected by execution |
| [RALPH journal](../apps/client/src/core/_helpers/ralph-run-journal.helper.ts) | Checkpoint, outcome, recovery, route, and heartbeat records | Reuse durability for evidence and research; a second workflow engine is unnecessary |
| [Memory entries](../apps/client/src/core/types.ts), [retrieval](../apps/client/src/core/memory-retrieval.ts) | Scope, session provenance, confidence, importance, timestamps, lexical ranking, recency, and quotas | Source state/version, supersession, explicit applicability, and evaluation of harmful recall |
| [Conversation preparation](../apps/client/src/core/_helpers/conversation-prompt-context.ts) | History selection and summarization | Preserve active requirements, exact identifiers, corrections, and references across compaction |
| [MCP tools](../apps/client/src/core/mcp/tool-definitions.ts) | Search, discovery, resources, and asynchronous task tools | Interactive resource hosting and controlled orchestration of tool calls from programs |
| [MCP client](../apps/client/src/core/mcp/client.ts), [dependencies](../apps/client/package.json) | Monolithic MCP SDK `^1.29.0`, experimental Tasks calls | Deliberate adoption of the selected current SDK/protocol contract |
| [Adaptive controller](../apps/client/src/core/adaptive-controller.ts), [usage recorder](../apps/client/src/core/model-usage.ts) | Task-text heuristics for reasoning/context/worker budgets and model-call telemetry | Policies selected using observed outcomes and total cost; Goals currently [disable the adaptive controller](../apps/client/src/core/goals/run-goal.ts) |
| [Browser tools](../apps/client/src/core/_helpers/browser-tool-definitions.ts) | Semantic locators, inspection, waits, and screenshot checks | Higher-level application operations and explicit checks of saved state |
| [Macro recorder](../apps/client/src/core/_helpers/macro-recorder-tool-definitions.ts) | Browser/desktop recordings already generate prompts or skills | Held-out evaluation, version promotion, and retirement of invalid procedures |
| [Chat voice](../apps/client/src/tauri/ui/chat-session/_helpers/use-chat-session-voice.ts) | Speech profiles, playback ownership, and streaming answer playback | Continuous conversation, interruption, delegation, and correction delivery |
| [Image manifests](../apps/client/src-tauri/src/media/open_model_manifests.json), [layout capabilities](../packages/media-studio/src/core/media/image-layout-capabilities.ts) | FLUX 3/MOSS entries and a layout capability pipeline | Evaluate remaining capabilities; adding these names again would duplicate existing work |

Targeted searches of tracked client/package source did not identify a shared multimodal workspace index, saved claim/source research-project model, or MCP Apps host. These are bounded source observations, not proof that no related code exists anywhere. No runtime failure was reproduced in this review.

**Research that changes the decisions**

Dates are submission dates unless marked as revisions or publisher dates. Benchmark results describe the authors' evaluated systems, not expected Machdoch improvements.

| Paper or research source | Finding that matters | Consequence for Machdoch |
| --- | --- | --- |
| [Evolving Agent Interfaces / Agent S4](https://arxiv.org/abs/2610.28601), 20 Oct | Better observation/action interfaces substantially improve computer-use performance | Build structured application operations; explore automated interface improvement offline |
| [MemDev-Bench](https://arxiv.org/abs/2610.27524), 20 Oct | Historical experience can help code localization and editing, but also break otherwise solvable tasks when applicability is not reassessed | Bind memory to current task and source state; retain access to supporting execution history |
| [RITE](https://arxiv.org/abs/2610.27777), 20 Oct | Plausible incorrect tool results propagate; more detection and refetching do not reliably repair final outcomes | Verify resulting state and invalidate downstream conclusions affected by corrected evidence |
| [Anti-Persistence](https://arxiv.org/abs/2610.27406), 19 Oct | Persisted inferred rules can regenerate errors; task-specific guidance synthesized from retained experience performed better in the tested settings | Compare temporary guidance with persistent lessons; keep user facts/preferences distinct |
| [REM](https://arxiv.org/abs/2610.27377), 19 Oct | What to store, when to recall, and when to evict matter beyond retrieval accuracy | Load detailed experience when useful during execution instead of injecting everything initially |
| [OpenSaC](https://arxiv.org/abs/2610.25779), 19 Oct | Code can compose search, reading, extraction, and evidence retention with fewer model round trips | Use research as the first programmatic-tool pilot |
| [TEX](https://arxiv.org/abs/2610.27290), 19 Oct | Cross-executing candidate tests and patches provides concrete feedback for collaborative coding | Reserve candidate/test cross-validation for difficult repairs with an explicit compute budget |
| [SkillBrowser](https://arxiv.org/abs/2610.23554), 16 Oct | Loading procedural content when the current task needs it beats some static-selection methods; invocation failures and latency remain | Evaluate on-demand skill exposure against current discovery |
| [Ignored, Not Refused](https://arxiv.org/abs/2610.23254), 16 Oct | Low injection success can coexist with failure to do the legitimate task | Evaluate task completion and unauthorized actions together when changing tools or retrieval |
| [ProPerAgent](https://arxiv.org/abs/2610.22671), 15 Oct | Retrieving the right memory and choosing when to intervene are separate difficult problems | Begin with explicit project events; broad ambient assistance remains experimental |
| [SkillNEO](https://arxiv.org/abs/2610.20926), 14 Oct | Separates versions selected for execution from versions being improved; final evaluation uses the same task instances | Adopt the version lifecycle idea, but require unseen inputs before promoting a procedure |
| [TRACE](https://arxiv.org/abs/2608.06503), revision 14 Oct | Compaction can change later behavior; paired continuations expose failures that summary quality alone misses | Test what the agent does after compaction, especially after corrections |
| [Compaction harm prediction](https://arxiv.org/abs/2610.08722), 6 Oct | Recent behavior predicts harmful compaction only weakly; superiority over token-based rules at matched retention is unresolved | Do not assume a heuristic compaction trigger fixes long-task reliability |
| [Continuous Context Management](https://arxiv.org/abs/2609.35540), 28 Sep | Every-turn compaction cuts context usage but lowers success for most tested models without training | Do not deploy aggressive compaction based on token savings alone |
| [Budget-constrained skill/memory study](https://www.servicenow.com/research/publication/sina-hajimiri-are-emnlp2026.html), publisher date Oct 2026 | A token-matched plain actor matches or beats AWM, ASI, and ReasoningBank in aggregate on the tested web tasks | Count retrieval, synthesis, writing, and repair overhead; compare against spending the same budget on execution |
| [Continual Learning Bench](https://arxiv.org/abs/2606.05661), 4 Jun | Dedicated memory designs do not automatically outperform ordinary in-context learning | Require measured improvement across task sequences before claiming that Machdoch learns |
| [Recursive Language Models](https://arxiv.org/abs/2512.24601), revision 11 May | A model can inspect a large external corpus through code and recursive calls | Pilot comprehensive corpus analysis when retrieval alone misses global relationships |

Four findings deserve closer interpretation:

1. **Agent S4 supports better interfaces more strongly than unrestricted self-evolution.** Its full evaluation reports 21.30% OSWorld V2 binary success versus 5.56% for the fixed-interface comparison. In its own harness, however, no repository reaches 15.74%, the seed repository reaches 19.44%, and evolution reaches 21.30%. Costs exclude repository construction and infrastructure and assume 80% input-cache hits. Start with useful application operations before investing in evolutionary search. [Full evaluation](https://arxiv.org/html/2610.28601v1).
2. **OpenSaC demonstrates a tradeoff, not a universal quality win.** Execution time falls about 30% on both benchmarks, but BrowseComp accuracy rises 2.96 percentage points while WideSearch row F1 falls 0.84 points. Results use one run per task, audited subsets, and costs excluding retrieval-provider charges. Preserve coverage and citations when batching work. [Methods and results](https://arxiv.org/html/2610.25779v1).
3. **Memory needs selective persistence.** Anti-Persistence still retains trajectories; temporary guidance can influence later experience indirectly. The paper explicitly leaves broader, longer-term generalization unresolved and acknowledges the benefit of retaining reliable knowledge. It does not justify deleting preferences or every tested procedure. [Limitations](https://arxiv.org/html/2610.27406v1).
4. **A checker is not a recovery mechanism by itself.** RITE's extra check increases noticing and refetching more than final success. Its evaluation uses a clean verification path after single-site corruption; code release is conditional on internal approval. Transfer the failure cases and measurement approach rather than treating it as an available recovery library. [Discussion and availability](https://arxiv.org/html/2610.27777v1).

Multi-agent allocation also remains workload-dependent. Google's [scaling research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) argues for matching coordination to task structure. The [current author repository](https://github.com/ybkim95/agent-scaling/) has expanded evaluation and [corrected analysis scripts](https://github.com/ybkim95/agent-scaling/blob/main/CHANGELOG.md). Use the current reproducibility material rather than turning an earlier headline percentage into a universal routing rule.

**Available capabilities worth evaluating now**

“Available” means public code/weights or documented service access. It does not establish account eligibility, hardware suitability, or an end-to-end Machdoch integration.

| Capability | Verified upstream state | Integration decision |
| --- | --- | --- |
| [EmbeddingGemma 2](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2?hl=en) | Apache-2.0 multimodal embeddings; 740M total parameters with modular text, vision, and audio encoders; 8K context | Strong first candidate for local retrieval; benchmark text-only and multimodal configurations on actual supported hardware |
| [Docling](https://github.com/docling-project/docling) | Public MIT document-processing implementation; structured PDFs, tables, office formats, images, and audio among supported inputs | Evaluate ingestion and source locators; check selected model dependencies separately |
| [Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5) | Released 7 Oct; API ID `claude-haiku-5-5`; designed for inexpensive short tasks and subagents | Pilot extraction, summaries, and classification; evaluate cost per verified outcome |
| [Gemini 4 Argon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-argon/) | Released 13 Oct through the paid API; long-task continuation protocol documented by the publisher | Test continuation, tool execution, cancellation, and usage accounting before treating discovery as complete support |
| [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) | Public beta; typed probability, choice, and rubric scores; currently `gpt-6-luna`; examples require JS SDK 7.30.0+ | Optional classifier/routing experiment; Machdoch declares `openai ^6.46.0`, so integration is deliberate work |
| [OpenAI programmatic tools](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling), [Anthropic programmatic tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) | Documented tool orchestration in hosted execution environments | Adopt the capability where it helps; execution, result formats, and retention differ across providers |
| [MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/) | Interactive tool resources and host bridge; current SDK uses split MCP 2.x peers; no complete supported host beyond an example in that repository | Build one external interactive-result integration and verify desktop/Fleet behavior |
| [MCP 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) | Stateless core and formal extensions; Tasks carries eventual results and errors | Assess current client/server integration together; replace superseded implementation when adopting the new contract |
| [A2UI 0.9](https://developers.googleblog.com/a2ui-v0-9-generative-ui/) | Declarative UI protocol with an official React renderer and custom component catalogs | Alternative for first-party generated controls; do not introduce two rendering systems without distinct needs |
| [GPT-Live](https://developers.openai.com/api/docs/guides/voice-agents) | Full-duplex voice with client delegation to a separately chosen backend | Strong architectural match for adding speech over Machdoch's existing execution owner |
| [Gemini 3.8 Live](https://ai.google.dev/gemini-api/docs/live-api/capabilities) | Live API remains preview; async tools and interruption are documented | Second voice candidate; extended-thinking session state needs explicit handling |
| [OpenAI mid-turn steering](https://developers.openai.com/api/docs/guides/steering) | Responses WebSocket accepts updates during execution; accepted input may still be pending | Add receipt/reconciliation semantics; a correction does not undo an action already taken |
| [FLUX 3 Image Klein](https://bfl.ai/blog/flux-3-image-klein), [MOSS-Image](https://github.com/OpenMOSS/MOSS-Image) | October releases with public weights/code; MOSS announces API availability on 20 Oct | Already represented in Machdoch's media manifests; prioritize verified missing behavior over another catalog expansion |

Provider pricing and capability metadata should be refreshed at implementation time. A low per-token rate does not establish lower end-to-end cost. Likewise, a compact image generator's parameter count omits other runtime components; NVIDIA publisher timings do not establish Windows/AMD performance.

**Concrete first releases**

**1. Searchable workspace knowledge.** Let a user select a folder, ask a question, and open the exact supporting page, table, or code location. Use document parsing plus lexical and embedding retrieval, keeping source identity and content fingerprints. Add screenshot and recording search after document/code retrieval is useful. Hybrid retrieval is one retrieval design with complementary signals, not an obsolete compatibility path.

Start with a local index and incremental updates. Access filtering must happen before results enter model context. Removing a source should remove its derived searchable content. Local indexing and cloud answering are separate data flows. Compare a lexical baseline, text embeddings, and multimodal embeddings on English/German queries, exact code identifiers, scanned tables, renamed files, changed values, and source deletion. Measure supported-answer quality, locator correctness, indexing time, RAM, and disk use.

**2. Verifiable task outcomes.** Extend Goals with records connecting each requirement to its latest artifact/state and a check result. For a file task, reopen and inspect the saved file. For a browser task, observe the committed application state. For code, retain the relevant check result tied to the tested revision. Evidence becomes stale when the underlying artifact changes.

Keep the existing evaluator as the consumer of evidence; make execution collect it. Reuse current journals for restart recovery. The initial cases should include a tool claiming success without saving, a check that passed before a later edit, and a restart after an action. Measure false completion and correct completion together. Apply verification to meaningful boundaries, not every trivial intermediate step.

**3. Persistent research projects.** Save the question, scope, source locations and dates, supported claims, disagreements, open questions, and report revisions. A refresh should explain which evidence changed and whether the recommendation changed. This investigation is a representative use case: a later release or revised paper should update the relevant conclusion without discarding the whole project.

Build on existing search, reading, attachments, and scheduler capabilities. First deliver saved web research with claim-to-source navigation and one manual refresh; add local corpus search when available. Evaluate contradictory sources, revised papers, unavailable primary pages, incomplete comparison coverage, and an update that reverses the recommendation. Saving citations alone is insufficient if they do not support the claim.

**4. Memory applicability and context continuity.** Distinguish durable preferences, mutable facts, observed outcomes, and inferred procedures. Bind mutable entries to source identity/state and record which entry supersedes which. Retrieve only eligible scoped material, then rank relevance. Keep supporting history addressable rather than retaining only compressed conclusions.

For inferred lessons, compare current persistent guidance, temporary task-specific guidance, and no extra guidance at the same total budget. Preserve unresolved requirements and corrections during context compaction. Evaluate the next actions after compaction, including changed user instructions; do not optimize only summary length. Retain useful facts while measuring regressions caused by stale or irrelevant memory.

**5. Programmatic tools and application operations.** Provide one bounded tool-orchestration path that can batch independent reads, filter large results, and retain source references. Each call must still pass the normal host validation, cancellation, authorization, and accounting boundary. A shell alone does not provide that contract. Distinguish the current agent's orchestration environment from functionality shipped inside Machdoch.

The first pilots should be multi-source research collection and one structured spreadsheet/document operation. Return exact changed values and final saved state where possible. Prefer an existing supported application API before adding a new integration. Compare success, coverage, intermediate tokens, latency, and all provider costs. Provider documentation itself reports workloads where programmatic calls add overhead; select them by task shape.

**6. Interactive results.** Host one MCP App: an editable research comparison with criteria/filters and links to supporting passages is a good first choice. Reuse shared conversation UI for desktop and Fleet. Use isolated rendering and a host-mediated tool bridge, with restoration and keyboard navigation. A widget action must produce a real tool result and saved state. Keep architecture and protocol details out of the product UI.

**7. Model and reasoning allocation.** Begin with extraction, classification, summaries, and source selection. Compare a simple explicit policy using smaller models with current execution, preserving user-selected models and data-location constraints. Include routing, retries, verification, and failed attempts in cost. Enforce budgets across the whole task, including worker and continuation requests.

Use the existing usage recorder and model registry. Define the interaction with Goals before enabling allocation there. Native provider capabilities need adapter support and contract checks; adding a model to discovery is only one step. Keep a single canonical contract per adopted capability rather than accumulating legacy paths.

**8. Live voice and corrections.** Add one continuous spoken session whose backend remains the existing task runtime. Let the user interrupt playback and revise the task while work continues. Track correction submission, provider acceptance, and actual application separately; reconcile connection loss before replaying input. Already-completed actions cannot be undone merely by steering the model.

Test numbers, names, language changes, interruption, long-running tools, and reconnect. Measure task correctness and unwanted duplicate actions alongside audio latency. Existing streaming TTS supplies useful playback infrastructure but does not establish full-duplex conversation support.

**9. Tested reusable procedures.** Extend current macros/skills with explicit applicability, parameters, expected outputs, source runs, and executable checks. Keep experimental versions separate from the version selected for use. Test new inputs and changed application state before promotion. Start with one recurring file transformation and one browser procedure; measure whether reuse actually saves time or improves completion.

**10. Requested event-driven assistance.** Connect an explicit intention to existing scheduler events: refresh a saved investigation when a selected source changes, or prepare a report when a new file appears. Test duplicate delivery, withdrawn intentions, irrelevant events, and failures. Measure useful actions and unwanted interruptions. A continuously recorded screen/audio history is not needed for this first release.

**Implementation order and decision gates**

| Sequence | Bounded deliverable | Continue only when |
| --- | --- | --- |
| A, in parallel | Document/code knowledge spike; requirement/check evidence; MCP contract assessment | Locators are correct; stale/false completion is detected; selected current protocol behavior is understood |
| B | Saved research with refresh; source-bound memory | Changed evidence produces the right report update; stale memories stop influencing unrelated work |
| C | Programmatic research workflow; one interactive comparison | Useful coverage is preserved while cost/latency improves; widget state survives restoration |
| D | Narrow routing policy; one promoted procedure | Held-out tasks show a success/cost advantage at equal total budgets |
| E | One live voice provider; one requested event workflow | Corrections take effect, reconnect avoids duplicate actions, and event timing is useful |

Saved web research can begin before the local index is complete. Source binding can begin without a graph database. Protocol work can proceed independently. Budget and outcome records should be reusable across these features rather than introducing a different accounting/evaluation subsystem for each.

A small evaluation set should contain representative file, coding, browser, research, memory-conflict, and post-compaction correction tasks, with separate development and unseen variants. Measure verified success, false completion, stale-memory regressions, citation support, latency, and total cost separately. For uncertain AI behavior, use matched tasks and repeated trials to expose variability. Routine implementation checks should stay narrow.

**Defer or keep experimental**

- Unrestricted self-modifying agents and automatic instruction rewriting: promising research, but improvements must survive unseen tasks before promotion.
- General multi-agent swarms: use workers for independent useful work; coordination is not a universal quality setting.
- Every-turn context compression: current evidence includes success regressions despite token savings.
- Full ambient screen/audio memory: proactive timing remains difficult; start with selected sources and explicit events.
- Training a foundation model or building inference kernels: no demonstrated product bottleneck here requires owning those layers.
- Broad image/video/3D model expansion: continue concrete media gaps; several prominent new image capabilities already have implementation work in this checkout.
- Replacing Machdoch's runtime with a hosted agent platform: no such replacement is required for the recommended features.

**Verification and limits**

Public records, methods/limitations for the four specified papers, current official capability documentation, and the linked local source were inspected. The review did not reproduce paper benchmarks, call paid model APIs, download models, measure local hardware, or start services. Account/region access, runtime interoperability, actual retention/deletion behavior, and quality/cost improvements require the proposed integration experiments.

Only this recommendations document was added in this investigation. The existing deep review and unrelated working-tree changes were preserved. Documentation validation checks local link targets and whitespace; it does not validate the application. No application tests or builds were needed for this research-only change.

The priorities assume the current documented product direction: a local-first, provider-flexible assistant for files, desktop work, research, workflows, and media. Team capacity, customer usage, and delivery budget were not supplied, so the report makes no calendar or ROI promises.
