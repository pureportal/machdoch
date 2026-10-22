**Machdoch: AI research and feature decisions**

Research snapshot: 22 October 2026, Europe/Berlin; online collection began on 21 October UTC. The latest arXiv daily listing inspected was 21 October. Repository baseline: `c434cf9983ef6c84e56d30683857a738f0da30b4`, plus the working tree inspected during this review.

**Recommendation: build a searchable workspace, persistent research projects, and autonomy that can prove its results.** Support these with memory that checks applicability, efficient programmatic tools, and measured model selection. These investments continue to matter when the underlying models change.

The strongest new research direction is improving the interfaces through which agents work: structured application operations, useful observations, and executable verification. Another strong finding is that more persistent memory can make an agent worse when old conclusions are reused without checking the present situation.

This is a research deliverable and proposed implementation sequence. It does not enable features or change the application. Rankings, effort, and product fit are engineering judgments. Paper results and vendor measurements have not been reproduced in Machdoch.

**What changed since the earlier assessments**

The [18 October assessment](ai-research-feature-priorities-2026-10-18.md) and [19 October roadmap](ai-research-roadmap-2026-10-19.md) remain useful background. Fresh evidence changes several decisions:

- Agent S4, MemDev-Bench, Anti-Persistence, REM, RITE, OpenSaC, TEX, and other papers submitted on 19–20 October provide more specific implementation and evaluation choices.
- Layout generation is substantially further along than those reports imply. Typed layouts, an editor, native adapters, composition, reference guidance, and masked repair already exist. The [current implementation ledger](artifacts/layout-control-2026-10-18/implementation-evidence.md) records actual local inference and remaining visual limitations. Treat those results as existing recorded evidence, not checks independently rerun for this review.
- Speech now includes a dedicated shared package, speech projects, profiles, and streaming answer playback. Full-duplex conversation remains a distinct proposed extension.
- Current MCP Apps documentation uses the split MCP 2.x packages, while Machdoch declares the monolithic SDK `^1.29.0` and calls its experimental Tasks API. Protocol work is a concrete prerequisite for some integrations, although no connection failure was reproduced here.
- New model discovery alone is insufficient. Gemini Argon continuation, OpenAI steering, programmatic tools, and live voice each require execution contracts beyond adding a model name.

**Scope and evidence quality**

The investigation covered agent execution, memory, context management, tool composition, computer use, research, multimodal retrieval, model routing, interactive results, voice, media, and proactive assistance. Discovery included keyword filtering the 1,547 entries in arXiv's [recent cs.AI listing](https://arxiv.org/list/cs.AI/recent?show=2000), targeted searches, and official release/specification pages. That is a discovery pool, not 1,547 papers read or validated.

Twenty-four papers were examined at the abstract/publication-record level. Methods, evaluation conditions, costs, or limitations were additionally inspected in the full text of Agent S4, MemDev-Bench, Anti-Persistence, REM, RITE, OpenSaC, and TEX. Product recommendations use original papers, author repositories, official model cards, and official documentation. Secondary search results were discovery leads only. This is a targeted engineering review, not an exhaustive or systematic literature review.

The evidence levels used below are: **available component**, an accessible implementation or documented service; **research result**, an authors' benchmark finding; **source observation**, something present in this checkout; and **proposal**, an integration or product judgment. None implies a verified production integration.

**Machdoch's existing foundation**

| Area | Source observation | Consequence for the roadmap |
| --- | --- | --- |
| Goals and completion | [Goal evaluation](../apps/client/src/core/goals/goal-evaluation.ts) already uses an independent validator with observed tool evidence and bounded transcript excerpts. It is instructed not to call tools. | Extend current evidence collection and verification. A new second goal engine would duplicate ownership. |
| Memory | [Entry types](../apps/client/src/core/types.ts) include scope, session provenance, importance, confidence, and timestamps. [Retrieval](../apps/client/src/core/memory-retrieval.ts) uses lexical signals, recency, and scope quotas. | Add explicit applicability and source state. The inspected entry type has no structured source fingerprint or supersession relation. |
| Context | [Conversation preparation](../apps/client/src/core/_helpers/conversation-prompt-context.ts) already selects recent and relevant earlier history and summarizes omitted material. [History tools](../apps/client/src/core/_helpers/chat-history-tool-definitions.ts) can recover older conversation. | Improve reconstruction and later-question evaluation; context summarization is already present. |
| Learning and procedures | A [reasoning bank](../apps/client/src/core/reasoning-bank.ts), [skill discovery](../apps/client/src/core/customizations.ts), [macro recorder](../apps/client/src/core/_helpers/macro-recorder-tool-definitions.ts), and RALPH exist. Macros can already produce skill artifacts. | Add applicability, held-out evaluation, and controlled promotion of procedures. Saving macros or lessons alone is not a new feature. |
| Tools | [MCP tools](../apps/client/src/core/mcp/tool-definitions.ts) already support search, inspection, resources, and asynchronous tasks. Direct exposure defaults to hybrid. | Measure current schema/result overhead and add tool-aware program execution where it earns its cost. |
| Protocol | [Client dependency](../apps/client/package.json) is `@modelcontextprotocol/sdk ^1.29.0`; [MCP client](../apps/client/src/core/mcp/client.ts) uses `client.experimental.tasks` and separate result retrieval. | Assess the selected current protocol and SDK contract before expanding Tasks or Apps. |
| Research and knowledge | [Web search](../apps/client/src/core/web-search.ts), browser reading, attachments, history, and context packs exist. No shared multimodal workspace index or persistent claim/source research project was identified in the inspected client/package sources. | Build on existing tools; distinguish a new saved research/data model from another search provider. Absence findings are limited to the inspected source. |
| Computer work | [Browser tools](../apps/client/src/core/_helpers/browser-tool-definitions.ts) already expose semantic locators, waits, and screenshot comparisons; desktop tools and managed workers exist. | Improve application operations, observation quality, and recovery rather than proposing basic browser automation again. |
| Allocation | [Adaptive controller](../apps/client/src/core/adaptive-controller.ts) uses task-text heuristics for context, reasoning, turns, and workers. [Goal work](../apps/client/src/core/goals/run-goal.ts) explicitly disables it. | Routing needs measured policies and deliberate composition with goals. Multi-agent execution already exists. |
| Voice | [Shared speech](../packages/speech/src/answer-stream.ts) and [chat voice](../apps/client/src/tauri/ui/chat-session/_helpers/use-chat-session-voice.ts) support answer playback, profiles, and a streaming path. | Add full-duplex listening, correction, and task delegation as an explicit new session type. |
| Images and layout | [Layout contract](../packages/media-studio/src/core/media/image-layout.ts), [editor](../packages/media-studio/src/tauri/ui/media/components/media-image-layout-editor.tsx), [capabilities](../packages/media-studio/src/core/media/image-layout-capabilities.ts), and [model manifests](../apps/client/src-tauri/src/media/open_model_manifests.json) include MOSS/FLUX 3 work. Capabilities distinguish integrated, installed, and inference-verified states. | Preserve this capability/evidence distinction. Do not rebuild the scene editor or relist these models as missing additions. |

**Recent papers that affect decisions**

Dates below are submission dates unless a revision is stated. All October dates are in 2026. A preprint's benchmark rank is not a general ranking of products.

| Paper and date | Decision-relevant evidence | Implication and limitation |
| --- | --- | --- |
| [Evolving Agent Interfaces / Agent S4](https://arxiv.org/abs/2610.28601), 20 Oct | Agents evolve application interfaces and usage knowledge using task experience and validation. | Highest-priority new architecture pilot: improve tools and observations. Public [code](https://github.com/simular-ai/Agent-S) exists; it is a separate S4 package. |
| [MemDev-Bench](https://arxiv.org/abs/2610.27524), 20 Oct | Prior experience helps localization/editing but also creates regressions when reused without reassessing applicability. Raw trajectories preserve process details that compressed memory can lose. | Retain inspectable evidence and gate its use. Evaluation is one agent/model configuration on a SWE-bench subset, not all desktop work. |
| [More Memory, Worse Agents / Anti-Persistence](https://arxiv.org/abs/2610.27406), 19 Oct | Erroneous stored abstractions can regenerate themselves through subsequent executions. The method retains trajectories and synthesizes temporary task guidance. | Compare on-demand guidance with persistent lessons. Three text environments and fixed backbones leave broad generalization unproven; reliable reusable knowledge still has value. |
| [REM](https://arxiv.org/abs/2610.27377), 19 Oct | Separates what to store, when to expose detailed experience, and when to evict it. Reports 27.6% versus 24.9% resolution with 17% lower cost-weighted tokens. | Pilot phase-structured experience and a measured recall trigger. Ninety-nine same-repository tasks, a fixed experience pool, and a simple struggle signal limit extrapolation. |
| [RITE](https://arxiv.org/abs/2610.27777), 20 Oct | Controlled silent tool errors roughly halve success across ten models. Extra checking improves detection more than final recovery. | Test wrong-but-plausible outputs and propagation of corrected evidence. Code release is pending internal review; this is a benchmark design reference, not an available integration. |
| [Lost in Recovery / ReTrace](https://arxiv.org/abs/2610.27954), 20 Oct | Evaluates whether a recovered state supports the same downstream actions/outcomes as the intended state. | Evaluate recovery by the state left behind. Clicking Undo or getting a successful response is insufficient evidence of restored workflow state. |
| [MMEnterprise-Bench](https://arxiv.org/abs/2610.27911), 20 Oct | Evolving multimodal records expose temporal conflicts and unanswerable questions; more retrieval does not consistently improve answers. | Workspace search needs versions, conflict handling, and explicit insufficient-evidence outcomes. Its collaboration projects are simulated. |
| [Evaluating Context Compaction on the Questions That Come Later](https://arxiv.org/abs/2610.27301), 19 Oct | Compression good for the current question can discard evidence for later questions; preferred methods vary by task and exact-identifier requirements. | Evaluate continuation after topic changes. Preserve recoverable originals and exact identifiers rather than selecting a universal compression recipe. |
| [OpenSaC](https://arxiv.org/abs/2610.25779), 19 Oct | Programs compose search, reading, reranking, extraction, and local processing. Paired experiments reduce time/tokens; broad collection quality drops slightly. | Strong implementation reference for research tools. The [MIT repository](https://github.com/liuqi6777/OpenSaC) is in development, requires Python 3.12+, and says this implementation is not on PyPI. |
| [TEX](https://arxiv.org/abs/2610.27290), 19 Oct | Agents cross-run generated tests against candidate patches and share execution results. | An optional coding verification experiment. Its full setting costs 12 times one agent; Python-only, single-run results do not justify default use for every change. |
| [COMPASS](https://arxiv.org/abs/2610.27822), 20 Oct | An agent routes using model capability/cost records and optional candidate inspection without router-specific training. | Begin with an inspectable policy and current evaluation records. Include routing overhead in Machdoch's comparison. |
| [LEASH](https://arxiv.org/abs/2610.22280), 15 Oct | Uses a weak model's hidden states for uncertainty-based escalation and continued oversight of a stronger agent. | Promising local-serving experiment; hidden-state access makes it unsuitable as a direct feature over arbitrary closed APIs. |
| [DuplexLedger](https://arxiv.org/abs/2610.27581), 20 Oct | Full-duplex timing and memory correctness remain separate weaknesses; its sidecar improves latest-value accuracy but slows interruption stopping. | Test corrected spoken instructions and final state, not just conversational fluidity. Reported absolute accuracy remains low. |
| [ProMemAgent](https://arxiv.org/abs/2610.27400), 19 Oct | Prospective memory links earlier intentions with later sensory context. | Explore requested event-conditioned assistance. A sensory-context benchmark does not establish dependable always-on desktop assistance. |
| [PLACE](https://arxiv.org/abs/2610.25179), 18 Oct | Separates write-side memory state correctness from whether a memory may influence a particular query. | Apply scope/eligibility before ranking and generation. Results are bounded to the evaluated memory backend and small Qwen models. |
| [SkillBrowser](https://arxiv.org/abs/2610.23554), 16 Oct | Loads procedural content when current reasoning reveals a need; static initial retrieval can inject unnecessary skills. | Measure on-demand skill exposure. Under-invocation and additional latency remain limitations. |
| [Agents Are Systems, Not Models](https://arxiv.org/abs/2610.01618), 1 Oct | In four scientific tasks, information and system configuration strongly affect outcomes; a dedicated verification tool changes behavior more than a prompt asking for verification. | Build verification into the execution interface. Four specialist-model tasks do not establish a universal law or Machdoch effect size. |
| [MemTrace](https://arxiv.org/abs/2610.04838v3), 4 Oct; v3 10 Oct | Anchors immutable traces to repository state and validates recalled evidence. | Start with source/artifact bindings and invalidate stale checks. A full graph database is not required to test the idea. |
| [SkillNEO](https://arxiv.org/abs/2610.20926), 14 Oct | Separates skill versions selected for use from candidates undergoing further improvement. | Useful promotion model, but final evaluation reuses development task instances. Require unseen-input evaluation for Machdoch. |
| [Just-In-Time Agent Memory / JAM](https://arxiv.org/abs/2609.34385), 28 Sep | Stores navigable raw history and builds query-conditioned context through a trained researcher. | Preserve source material and retrieve selectively. Its trained component is not a drop-in replacement for current lexical retrieval. |
| [Sage-A1.5](https://arxiv.org/abs/2610.28578), 20 Oct | A 35B MoE report combines orchestration, verification, and inspectable scientific exploration. | Watch as an open agent-model candidate; evaluate checkpoints, serving, licensing, and complete task performance before selecting a local default. |
| [Recursive Language Models](https://arxiv.org/abs/2512.24601v3), 31 Dec 2025; v3 11 May 2026 | Treats a large corpus as an external environment accessed through code and bounded recursive model calls. | Pilot only when ordinary retrieval misses global coverage. Input scale does not eliminate inference cost or recursion failures. |
| [MOSS-Image Technical Report](https://arxiv.org/abs/2610.23374), 16 Oct; repository announced report 19 Oct | Couples a 5B generator with intent-aware prompt enhancement and layout-rich evaluation. | Relevant to existing media work. It does not make already-integrated layout control a new roadmap item. |

**Three headline results that need careful interpretation**

Agent S4's [full evaluation](https://arxiv.org/html/2610.28601v1) reports 21.30% binary OSWorld V2 success versus 5.56% for the same model's fixed-interface comparison. However, its own harness with a seed repository already reaches 19.44%; evolution raises that to 21.30%. The full headline improvement should not be attributed solely to automated evolution. Its task-solving cost excludes interface evolution and infrastructure and assumes 80% input-cache hits. The transferable idea is better interfaces; the cost ratio is not a Machdoch forecast.

OpenSaC's [experiment](https://arxiv.org/html/2610.25779v1) reports about 30% less task execution time on both evaluated benchmarks. BrowseComp accuracy improves by 2.96 points; WideSearch row F1 declines by 0.84 points. It uses one run per task, excludes detected answer-exposure cases, and excludes retrieval-provider charges from cost. Adopt its programmatic workflow as a hypothesis to test, not a guaranteed improvement in research accuracy.

TEX's [cost and limitations](https://arxiv.org/html/2610.27290v1) make its test/patch cross-validation interesting for difficult coding work, but expensive as a general default. Likewise, [RITE's State Checker](https://arxiv.org/html/2610.27777v1) demonstrates that more error recognition does not automatically produce a corrected final result. Both favor measuring delivered outcomes over the number of checks or agents.

**Capabilities available to evaluate now**

| Component | Verified upstream availability | Machdoch decision |
| --- | --- | --- |
| [EmbeddingGemma 2](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2?hl=en) | Released 6 Oct; Apache-2.0, 740M total parameters, modular text/vision/audio encoders, shared multimodal vectors and 8K input context. | First local retrieval spike. Compare lexical retrieval, text-only embeddings, and multimodal embeddings. Do not assume its published mobile footprint applies to this Windows/Linux runtime. |
| [Docling](https://github.com/docling-project/docling) | MIT document-processing implementation with local execution, PDF structure, OCR, tables, diverse formats, and audio support. | Candidate ingestion component for page-aware search. Verify parser fidelity and licenses for selected model dependencies separately. |
| [Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5) | Released 7 Oct; API ID `claude-haiku-5-5`. Published input/output prices are $0.10/$0.50 per million tokens for prompts up to 100K; $0.50/$2.50 above 100K. | Evaluate extraction, summaries, catalog selection, and narrowly scoped workers. Compare total verified task cost, including tokenizer changes and repair work. |
| [Haiku API contract](https://platform.claude.com/docs/en/models/haiku-5-5/overview) | Adaptive thinking is default; sampling parameter restrictions, cache minimums, and programmatic model metadata are documented. | Verify adapter behavior and capability metadata before relying on discovery of a model ID. |
| [Gemini 4 Argon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-argon/) | Released 13 Oct; paid API and a documented new continuation protocol. Introductory $2/$10 input/output per million tokens ends 30 Nov; stated subsequent rates are $4/$20. | Focused long-task adapter spike, including continuation and cancellation. Introductory rates should not determine a permanent routing policy. |
| [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) | Public beta; typed probability, choice, and rubric-score outputs; currently `gpt-6-luna`. Docs require JS SDK 7.30.0+ for examples. | Pilot bounded classification/routing. Current client declares OpenAI `^6.46.0`; this needs deliberate SDK/API integration. Model scores are not proof that a task succeeded. |
| [Programmatic tool calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) | OpenAI documents isolated JavaScript orchestration; [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) documents hosted code calling selected client tools. | A strong capability to add through the existing host execution boundary. Provider execution and data-location contracts differ. |
| [MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/) | Stable extension spec dated 26 Jan; tool-associated UI resources and host bridge. Current SDK documentation uses split MCP 2.x peers and offers a host example rather than a supported complete host. | Build one focused interactive-results use case after a protocol/dependency spike. |
| [MCP 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and [Tasks](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) | Stateless request core, explicit extensions, updated SDKs, and final results carried in task state. `completed` can include a tool result with `isError: true`. | Assess interoperability before extending the old experimental task client. Protocol completion must not become a successful product outcome automatically. |
| [A2UI 0.9](https://developers.googleblog.com/a2ui-v0-9-generative-ui/) | Public declarative UI format with an official React renderer and client component catalogs. | Alternative for first-party generated controls; prioritize one interaction contract before adopting two broad rendering systems. |
| [GPT-Live architecture](https://developers.openai.com/api/docs/guides/voice-agents) | Documented full-duplex voice front end with client delegation to an independently selected backend. | Particularly suitable as an optional spoken interface over Machdoch's existing task runtime. |
| [Gemini Live](https://ai.google.dev/gemini-api/docs/live-api/capabilities) | Guide currently describes Gemini 3.8 Live, asynchronous function calling, interruption, and an extended-thinking variant; API marked preview. | A second provider candidate. Evaluate session status, tool scheduling, and correction behavior explicitly. |
| [OpenAI mid-turn steering](https://developers.openai.com/api/docs/guides/steering) | GPT-6 family over Responses WebSocket; acceptance queues input and does not undo prior output or cancel already-started tools. | Extend active-task correction deliberately, with receipt tracking and reconnect behavior. The inspected OpenAI adapter does not expose this transport contract. |
| [FLUX 3 Image Klein](https://bfl.ai/blog/flux-3-image-klein) and [MOSS-Image](https://github.com/OpenMOSS/MOSS-Image) | Public image code/weights; MOSS repository additionally announces API availability on 20 Oct. | Already represented in Machdoch. Continue capability verification and use the existing layout pipeline. Broad new model catalog work is a lower priority. |

**Recommended implementation order**

P0 is an enabling foundation; P1 is the next product investment; P2 follows a measured pilot. Effort describes relative scope: M spans several existing modules, L introduces a substantial shared subsystem or cross-client experience. It is not a delivery estimate. Confidence describes fit with Machdoch, not an independently measured performance gain.

| Order | Addition | Priority | Effort | Confidence | First useful result |
| --- | --- | --- | --- | --- | --- |
| 1 | Completion and recovery backed by current evidence | P0 | M | High | Every required outcome has an inspectable check tied to the state checked. |
| 2 | Local multimodal workspace knowledge | P1 | L | High | Search selected documents, code, screenshots, and recordings with exact source locations. |
| 3 | Memory with applicability and source history | P1 | M–L | High | Corrected facts and changed files stop old advice being treated as current. |
| 4 | Persistent research projects and refresh | P1 | M–L | High | A saved investigation with supported claims, contradictions, and meaningful change reports. |
| 5 | Efficient tool programs and better application interfaces | P1 | M–L | High | Batch useful operations and return compact evidence rather than repeated low-level interactions. |
| 6 | Interactive results through MCP Apps | P2 | M–L | High | Edit/filter a research comparison or inspect cited document passages inside the conversation. |
| 7 | Measured model and reasoning allocation | P2 | M | High | Cheaper narrow tasks with maintained verified quality and explicit cost ceilings. |
| 8 | Reusable procedures promoted from tested runs | P2 | M–L | Medium | A repeated task becomes a parameterized procedure that passes unseen examples. |
| 9 | Live conversation and active-task steering | P2 | L | Medium–high | Correct a running task by voice and receive an accurate account of its current state. |
| 10 | Requested assistance triggered by project events | Pilot | M | Medium | A selected event satisfies a remembered user intention and starts the requested preparation. |

The most attractive visible product pair is **workspace knowledge plus persistent research**. The best foundation to start immediately is **shared outcome evidence**, because memory, routing, skills, and autonomous recovery all need reliable feedback.

**1. Completion and recovery backed by current evidence**

Extend the existing goal lifecycle with a structured outcome record: requirement, observed artifact or external receipt, relevant input/output version, check result, collection time, and any dependencies that invalidate it. Collect this from actual host tool execution and constrained outcome probes. Keep the completion judge independent from execution.

The first release should cover file transformations, code checks, and one browser workflow. If a process exits successfully but writes the wrong file, the task remains incomplete. If an edited source invalidates a previously passing check, that check remains historical evidence. For a browser change, verify the resulting saved state or receipt rather than relying on a click or a success banner alone.

Reuse [goal evaluation](../apps/client/src/core/goals/goal-evaluation.ts), [goal storage](../apps/client/src/core/goals/goal-store.ts), existing action output, and the identity/provenance ideas already present in media verification. The inspected goal evidence path is useful groundwork; the proposed addition is durable requirement-to-state binding and decisive outcome collection.

Acceptance should inject a plausible wrong tool result, interrupt a task after a partial write, change relevant inputs after verification, and resume after restart. Recovery must continue from the actual state without blindly repeating a side effect. Measure false completion, verified success, correction propagation, and added time/cost. Successful recovery needs both restored state and successful continuation.

**2. Local multimodal workspace knowledge**

Give selected workspace locations one incremental search index. Return files with exact page/region references, source-code locations, or recording time ranges. Useful queries include “find the chart supporting this forecast,” “where did we decide to change this interface,” and “find the recording and document discussing the same component.”

Start with documents and code, then add screenshots and audio. Evaluate EmbeddingGemma 2 against the current lexical baseline; a suitable parser such as Docling should preserve document structure and locators. Add page-image or region retrieval only where charts/scans expose a measured weakness. A single model need not be the winner for every modality.

The shared index should own source identity, file versions, ingestion state, exclusions, and removal. Store raw or recoverable source references separately from embeddings. Reindex changed sources incrementally. Deleting or excluding a source must remove derived retrieval entries, previews, and cached context as well as the visible file listing.

Use the same retrieval service for chat, context packs, research, and media asset lookup. Put reusable indexing code in an appropriate shared location; keep desktop filesystem access and native model execution behind their existing boundaries. Fleet clients should request authorized host results rather than build a second inconsistent index.

Acceptance needs German/English paraphrases, scanned tables, charts, code identifiers, renamed files, changed values, recording timestamps, and deletion. Measure retrieval recall, locator correctness, evidence-supported answer quality, index size, warm/cold latency, and resource contention with media generation. Local indexing and cloud answering have separate data paths and should be tested accordingly.

**3. Memory with applicability and source history**

Separate user preferences, mutable facts, observed execution history, and proposed procedural advice. For mutable information, record source locators, observed state/version, supersession, and the task/workspace conditions in which it applies. Filter scope and eligibility before ranking it for the current task.

Keep supporting trajectories or durable evidence references so a short lesson can be inspected and reconstructed. A confidence number and recent update time do not demonstrate that the remembered advice still applies. On a user's correction, supersede the old fact explicitly. On a changed repository or external record, validate the dependency or keep the claim historical.

For lessons inferred by the agent, compare three policies on the same retained experience: current persistent lessons, temporary guidance synthesized for the current task, and no added guidance. Keep independently tested procedures available as procedures; the newer memory papers do not justify deleting durable user preferences or every reliable skill.

Extend [memory](../apps/client/src/core/memory.ts), [workspace memory](../apps/client/src/core/workspace-memory.ts), retrieval, consolidation, and the reasoning bank. Add a small applicability mechanism before introducing a graph database or trained memory controller. Test whether relevant memory helps and whether unrelated or misleading memory causes regressions. Include costs of writing and consolidation, not just reads.

Context continuation belongs in this work: preserve unresolved requirements, exact identifiers, evidence references, and user corrections across summarization. Use recoverable history for detail. Evaluate questions and task changes introduced after compaction, not just whether a summary answers the original question well.

**4. Persistent research projects and refresh**

Make a research task reopenable: question, scope, source snapshots/references, publication and revision dates, claims, supporting passages, disagreements, open questions, and report revisions. A user should be able to ask “refresh this investigation” and receive changed evidence and its effect on the conclusion.

Reuse current search providers, browser reading, history, RALPH, and scheduling. The first release can produce a structured research artifact and a comparison view; it does not need a new general workflow engine. Search can run before a complete workspace index exists, while local sources can join through the shared index later.

Important behavior is evidence synthesis: open primary sources, distinguish announcements from tested capabilities, resolve version/date conflicts, and leave unsupported claims unresolved. Compare sources on the same criteria. Broad comparison tasks need coverage tracking so programmatic batching does not quietly omit rows or criteria.

Acceptance should include contradictory and superseded source pages, an unavailable primary document, a paper with no released code, and a refresh that changes a recommendation. Measure claim support, citation location, answer coverage, unsupported conclusions, total search/model cost, and changed conclusions correctly reported. Retain source-level evidence so a generated report can be revised without repeating every search.

**5. Efficient tool programs and better application interfaces**

Add bounded programmatic execution over registered tools: independent reads in parallel, explicit sequencing for dependent operations, output filtering, joins, and compact structured observations. Each underlying call should retain normal validation, attribution, cancellation, and accounting. Keep large results addressable as artifacts rather than repeatedly copying them into model context.

Machdoch already has shell execution and tool discovery. The addition is a host-controlled contract for invoking its tool registry from a program. A shell command alone does not supply it. The [OpenAI runtime description](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) is a useful reference for separating program orchestration from unrestricted process/network access; provider-hosted execution remains a different deployment choice.

Start with two concrete operations: collecting a research comparison across many sources, and reading/modifying a spreadsheet range through a suitable existing or selected integration. Compare those against the current agent using identical task outcomes and total budgets. Record schema tokens, intermediate-result tokens, calls, latency, and verified success.

Then pilot interface improvement using task traces: identify repeated low-level work, propose a structured operation and observation, and test it in an isolated fixture environment. A useful candidate might return the exact changed spreadsheet values or a document's saved state. Prefer a small library of proven application operations before autonomous population-based interface evolution.

Protocol modernization is a scoped prerequisite where needed. Evaluate MCP discovery, transport, Tasks result/error semantics, cancellation, and reconnect using the chosen current SDK contract. Replace superseded implementations directly when adopting that contract; compatibility behavior needs a separate explicit requirement.

**6. Interactive results through MCP Apps**

Add one host-supported interactive result: a research comparison with editable criteria and filters, or a source viewer that opens the passage supporting a claim. Reuse shared conversation components so desktop and Fleet display consistent state.

Implement resource discovery, isolated rendering, and a host-mediated tool bridge. A visible widget action must produce an actual tool result and update saved state. It must not gain direct native privileges through the embedded document. Test keyboard navigation, untrusted resource isolation, restoration, and disconnected/remote-client behavior.

MCP Apps is the first interoperability choice for external tool interfaces. Evaluate A2UI separately only if first-party declarative controls justify it. A consumer product's generated UI announcement does not itself provide an embeddable API or a Machdoch integration.

**7. Measured model and reasoning allocation**

Use current task outcomes and cost records to select a model/effort level for bounded work. Begin with extraction, summaries, source selection, and classification. Keep difficult execution and final outcome judgments on a model that meets the task's measured requirements. Preserve explicit user model choices and configured data-location constraints.

The current [usage recorder](../apps/client/src/core/model-usage.ts), [internal task model](../apps/client/src/core/internal-task-model.ts), registry, and adaptive controller provide the base. Compare current allocation with a simple documented policy before training a router. Haiku 5.5 and Decisions are specific upstream candidates, with different output and integration contracts.

Measure verified task success per total cost, including routing, failed attempts, verification, retries, tools, and repair. Apply task-wide cost ceilings across continuations and workers. A protocol response's own token limit is not necessarily a total task budget.

Do not silently activate the adaptive controller inside Goal: it is currently explicitly disabled there. Define and verify that interaction first. Likewise, LEASH-style latent uncertainty requires an owned inference path, and the [agent-scaling study](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) supports testing whether a task actually benefits from coordination. More workers should be selected for useful independent work, not as a universal quality setting.

**8. Reusable procedures promoted from tested runs**

Turn a selected successful procedure into an artifact with parameters, required tools, applicability, expected outputs, and executable checks. Reuse existing macros, discovered skills, and RALPH. Keep candidate versions separate from the selected executable procedure.

Evaluate new inputs, changed application state, and failure recovery before promotion. Track source runs and outcome evidence. Provide a way to retire or replace a procedure whose assumptions no longer hold. Task-specific inferred advice can remain temporary while a tested procedure becomes reusable.

Begin with one recurring file/report transformation and one browser workflow. Verify that each improves completion or cost on held-out examples relative to current execution. Loading more skill descriptions is not the objective; expose the selected procedure when the current task needs it. Broad autonomous rewriting of instructions or tools remains an offline experiment.

**9. Live conversation and active-task steering**

Keep the existing text/task runtime as execution owner and add an optional full-duplex spoken interface. The conversation should accept a correction while work continues, stop stale playback, and distinguish working, waiting, failed, and complete states using actual task events.

GPT-Live client delegation is a strong architecture candidate; Gemini 3.8 Live is another documented option. Choose one for the first implementation. Reuse existing speech profiles and playback ownership where appropriate, while recognizing that streaming TTS is not continuous listening and conversation.

Unify spoken and typed corrections at the task boundary. Track when a correction was submitted and when it took effect. Respect already-completed actions and the fact that provider steering does not cancel an already-started tool. Reconnection must not duplicate a request or silently lose an accepted correction.

Acceptance needs interruptions, changed instructions, a long-running delegated tool, an interrupted side effect, and reconnect. Measure first-audio latency, interruption-stop latency, task accuracy, latest-instruction adherence, and duplicate side effects. Voice memory needs explicit update/ignore behavior; conversational smoothness is not evidence of correct final memory.

**10. Requested assistance triggered by project events**

Pilot an intention such as “when a new invoice arrives in this selected folder, extract the fields and prepare the monthly comparison” or “refresh this research when the monitored source changes.” The addition is linking a user intention and its readiness condition to the existing scheduler and saved artifacts.

Begin with explicit file/service events and deduplication, not broad sensory recording. Reuse current event matching and workflow jobs. Verify that changed or withdrawn intentions do not run, duplicate events do not repeat a side effect, and irrelevant events do not interrupt the user. Measure useful triggers, missed triggers, and unwanted interruptions.

**Implementation slices and decision gates**

| Slice | Bounded deliverable | Evidence needed to continue |
| --- | --- | --- |
| A: Outcome evidence | One shared requirement/check record integrated with existing goals; file, code, and browser fixtures. | False success and stale checks are rejected; restart preserves evidence; overhead is measured. |
| B: Knowledge prototype | Selected-folder ingestion, a lexical baseline, EmbeddingGemma 2 candidate, exact document/code locators. | Better retrieval on held-out queries without unacceptable RAM, disk, or foreground contention. |
| C: Memory lifecycle | Source/version bindings, supersession, query eligibility, and comparison of persistent versus temporary inferred guidance. | Lower stale-memory regressions; useful preferences retained; source removal actually clears derived retrieval. |
| D: Saved research | Structured question/source/claim artifact, evidence inspection, and one deliberate refresh. | Supported conclusions and meaningful refresh differences on contradictory/outdated-source fixtures. |
| E: Tool programs | One bounded orchestration path and one batch research/application operation. | Maintained success with improved token/latency cost; underlying calls remain auditable and cancellable. |
| F: Interactive output | One real MCP App supported on desktop and the relevant Fleet path. | Working external integration, state persistence, keyboard access, and isolation checks. |
| G: Routing and reuse | One narrow model policy and one parameterized learned procedure. | Held-out success/cost advantage with total execution cost counted. |
| H: Voice | One live voice provider attached to the existing task runtime. | Corrections take effect correctly, playback stops, reconnect avoids duplicate actions. |

A, B, and the protocol assessment can progress independently where modules allow. Memory validity can start with direct bindings before indexing is complete. Saved web research does not need to wait for every multimodal format. Routing and learned procedures should use outcome evidence, and live voice should use the same correction and task-state contract as text.

**Keep these as pilots or lower priorities**

| Candidate | Decision | Why |
| --- | --- | --- |
| Fully automatic interface/skill evolution | Offline pilot after structured operations and held-out evaluations. | Published methods remain bounded research systems; evolution cost and selection overfitting matter. |
| TEX-style candidate/test cross-validation | Optional difficult-coding mode with a fixed budget. | Useful structured feedback, substantial compute overhead, and limited language/domain evidence. |
| Recursive corpus analyst | Compare against retrieval plus bounded code analysis on a genuinely large task. | Adds value only if it improves coverage/quality under equal total cost. |
| Managed cloud execution | A selected unattended Fleet use case through the [OpenAI Agents API](https://openai.com/index/introducing-the-agents-api/), rather than a general runtime replacement. | Public beta provides durable execution, but task ownership, cancellation, instructions, tools, and local data need explicit integration. |
| Large local agent models | Controlled model-serving comparison, including Sage-A1.5 where accessible. | Checkpoints and parameter counts do not establish practical Windows/Linux memory, speed, or task quality. |
| Image/3D catalog expansion | Continue current media/3D work where a concrete capability remains missing. [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) is an available research implementation to assess. | Existing scene/layout work changes the priority; packaging, editability, hardware, and useful export matter more than catalog size. |
| Always-on screen/audio memory | Defer broad capture; use selected sources for a requested workflow. | Event-conditioned assistance can be tested with much less storage and ingestion work. |
| Inference kernels, custom agent-model training, world models, robotics | Monitor rather than make them the next product program. | They need a serving/training or physical-control responsibility not established by the current task. |
| Composer predictions and extra suggestion UI | Low priority until repeated user demand or measured input friction. | Current [Codex release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) describe a beta, but this offers less foundational value than searchable knowledge and reliable execution. |

Media-specific caution: the [FLUX publisher model card](https://huggingface.co/black-forest-labs/flux-3-image-klein) distinguishes generator parameters from the text encoder, says boxes are not hard masks, and reports substantial reference-runtime GPU memory. The launch's optimized NVIDIA configurations and the reference runtime are different setups. Machdoch's existing local ledger describes its own quantization/offload results. Use the applicable measured configuration; do not infer AMD behavior, exact outside-region preservation, or distribution rights from a launch headline. Review the exact pinned distribution and its license before changing packaging.

**How to decide whether the additions are working**

Create a small reusable evaluation set from representative Machdoch tasks, with separate development and held-out variants. Include a file conversion, a coding repair, a browser update, a research comparison, a source/version conflict, and a long task corrected after context refresh. Add voice/media cases when those features are being changed.

Use environment outcome checks where possible. Report verified success, false completion, stale-memory regressions, evidence/citation accuracy, user corrections, total cost, and median/tail latency. Do not collapse all of these into a single opaque score. [EGI-BENCH](https://arxiv.org/abs/2610.27234) is a current reference for multidimensional agent evaluation, not a mandate to run its full enterprise suite for every change.

For uncertain or stochastic pilots, use matched tasks and enough repeated trials to estimate variation; keep that separate from routine implementation checks. Run the narrow check for the changed behavior during development. Expand only when failures or concrete regression risks warrant it. A new model, extra agent, richer memory, or larger retriever earns adoption through observed improvement in delivered outcomes.

**Verification and remaining uncertainty**

Online checks established the cited public records, release claims, implementation availability, and current documentation at this snapshot. Relevant current source was inspected for goals, memory, context, tools/protocol, provider adapters, usage/allocation, speech, and image layout. The existing layout implementation ledger was read, including its recorded functional verification and limitations; its inference and hardware measurements were not independently repeated.

Only this research report was added. No application services, model downloads, paid provider runs, dependency upgrades, builds, or repository tests were started. Documentation validation covers local link targets and whitespace; it is not runtime validation. Hardware performance, account/region access, operational retention/deletion, full provider interoperability, and any predicted quality/cost improvement remain integration experiments. Existing unrelated working-tree changes were left intact.

The ranking assumes Machdoch remains a local-first, provider-flexible assistant spanning files, research, desktop work, workflows, and media. No customer analytics, team capacity, or delivery budget was supplied, so effort is relative and no adoption/ROI forecast or calendar commitment is asserted.
