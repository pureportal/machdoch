**Machdoch: AI research and feature roadmap**

Research cutoff: 19 October 2026. Source baseline: commit `8c631d0f8a1f95bf5d3fe684c446875f4654e25d` and the working tree inspected during this review.

**Recommendation: invest first in verifiable execution, memory that stays current, and a searchable multimodal workspace.** Together, these make Machdoch more useful across models, providers, workflows, and applications. The strongest subsequent additions are persistent research projects, skills derived from tested procedures, interactive tool results, and editable media composition.

This is a research deliverable and proposed roadmap. Rankings, relative effort, and acceptance criteria are engineering judgments, not measured Machdoch performance or delivery commitments. Public documentation establishes an upstream capability; it does not establish a successful Machdoch integration.

**Scope and evidence.** The investigation covered agent execution, memory, context management, tool orchestration, research, document retrieval, computer use, voice, generative interfaces, image composition, 3D, and inference efficiency. It emphasized September and October 2026 papers and releases, retaining earlier work where it explains a practical implementation. Sources below are original papers, author repositories, official specifications, model cards, and vendor engineering publications. Selected methods and limitations were inspected in the full text of MemTrace, SafeActBench, SkillNEO, and PRISM; other paper assessments primarily use their abstracts and publication records. This is a targeted engineering review, not a systematic literature review or an independent benchmark reproduction.

The existing [18 October assessment](ai-research-feature-priorities-2026-10-18.md) was used as background and checked against fresh sources. This review adds evidence-to-action research, memory calibration, bounded harness optimization, the current MCP task contract, and more specific model constraints. It also accounts for speech implementation now present in the working tree.

**Machdoch's current foundation**

These are source observations. An existing implementation, a proposal, and an independently verified runtime capability are different evidence levels.

| Area | What exists | Relevant gap or extension |
| --- | --- | --- |
| Durable execution | [Goal runner](../apps/client/src/core/goals/run-goal.ts), independent [goal evaluation](../apps/client/src/core/goals/goal-evaluation.ts), [RALPH](../apps/client/src/core/ralph.ts), scheduling, and managed workers. The evaluator receives observed tool evidence and bounded transcript/output excerpts, and cannot collect fresh evidence itself. | Link requirements to durable, structured observations and invalidate conclusions when the underlying state changes. Extend existing execution ownership. |
| Memory | [Retrieval](../apps/client/src/core/memory-retrieval.ts) combines BM25, phrases, search terms, importance, confidence, recency, and scope quotas. [Entry types](../apps/client/src/core/types.ts) include session provenance and timestamps. | Explicit fact versions, source references, supersession, and applicability to the current workspace state. Recency is a ranking signal, not proof of validity. |
| Procedural learning | [Reasoning bank](../apps/client/src/core/reasoning-bank.ts) tracks helpful and harmful lessons; [macro recording](../apps/client/src/core/_helpers/macro-recorder-tool-definitions.ts) captures procedures. | Turn selected procedures into parameterized, versioned skills with tests on unseen inputs. |
| Context allocation | [Adaptive controller](../apps/client/src/core/adaptive-controller.ts) uses task-text heuristics and profiles to allocate context, reasoning, iterations, and workers. An [internal task model](../apps/client/src/core/internal-task-model.ts) already exists. | Learn which allocations actually improve task outcomes. The [provider audit](provider-feature-compatibility-2026-10-15.md) documents that Goal currently disables this controller. |
| Tool discovery | [MCP tool definitions](../apps/client/src/core/mcp/tool-definitions.ts) already expose search, inspection, resources, and asynchronous task operations. [Client](../apps/client/src/core/mcp/client.ts) uses `client.experimental.tasks`, including separate result retrieval. | Measure exposure cost, support controlled programmatic composition, and assess the July 2026 protocol changes. Tool search and asynchronous work are already implemented. |
| Search and knowledge | [Web search](../apps/client/src/core/web-search.ts), file attachments, history tools, and context packs. | A shared incremental index across document pages, files, images, audio, and video was not identified in the inspected sources. |
| Computer use | [Browser tools](../apps/client/src/core/_helpers/browser-tool-definitions.ts) include semantic locators, waits, and screenshot comparison. [Desktop tools](../apps/client/src/core/_helpers/desktop-ui-tool-definitions.ts) include capture and Windows control discovery. | Connect observations, targets, actions, and outcome checks consistently, particularly across long tasks and changing UI state. |
| Voice and creation | Media generation and assets exist. New [speech runtime](../packages/speech/src/runtime.ts), [speech playback](../packages/speech/src/session.ts), and [TTS studio](../packages/text-to-speech/src/studio.tsx) source is present, including jobs, revisions, takes, and cancellation paths. | Evaluate and extend this implementation for realtime conversation. Layout and 3D remain [separate](media-studio-layout-control-research-2026-10-18.md) [proposals](image-to-3d-studio-plan-2026-10-18.md) in the reviewed material. |
| Interactive results | React conversation surfaces and MCP resource handling exist. No MCP Apps host was identified by the targeted source searches. | Add a standards-based host for interactive forms, charts, tables, and viewers. |

**Research that changes the product decisions**

Treat arXiv records as preprints unless a venue is explicitly identified. Numbers below are author-reported results under their particular models, tasks, and harnesses. They are not comparable across rows.

| Paper and inspected date/version | Useful result | Implication and limit |
| --- | --- | --- |
| [MemTrace](https://arxiv.org/abs/2610.04838v3), 4 October; v3 10 October 2026 | Anchors immutable execution traces to files, symbols, tests, and task state; checks whether recalled evidence still applies. Reports a 21.2 percentage-point DeepSWE pass@1 improvement in its Codex CLI setting. | Use state-aware memory and evidence invalidation. Its coding results do not establish equivalent gains for desktop or research tasks. |
| [From Evidence to Action / SafeActBench](https://arxiv.org/abs/2610.07753), 6 October 2026 | Across 656 cases and ten model/harness configurations, good static action judgment does not reliably transfer to interactive execution. Uses a provenance-bound ledger and deterministic trajectory checks. | Verify prerequisites and actual returned results throughout a workflow. A successful tool response alone does not establish the intended end state. Controlled benchmark environments remain a limitation. |
| [SkillNEO](https://arxiv.org/abs/2610.20926), 14 October 2026 | Separates the skill version deployed from versions still being improved. Mini's average reward rises from 49.1% to 66.4% on 86 tasks. | Promising for procedure improvement. [Full-text limitations](https://arxiv.org/html/2610.20926v1) explicitly say final evaluation reuses development tasks and inputs; unseen-input generalization is unproven. Average reward is not universally a binary success rate. |
| [DAEDALUS](https://arxiv.org/abs/2610.08048), 6 October 2026 | Explorer and solver agents generate practice tasks, derive heuristics from failure, and retain them after repeated success. | Useful for learning unfamiliar tool conventions in a controlled practice environment. Do not let exploratory practice mutate a user's real accounts or production workspace. |
| [MemCalib](https://arxiv.org/abs/2609.24259v3), 21 September; v3 8 October 2026 | Finds both over-use and under-use of retrieved memories; proposes a training method to balance them. | Evaluate whether recalled information changes actions appropriately, not just whether it was retrieved. Its model-training method is not a drop-in client feature. |
| [RRSI](https://arxiv.org/abs/2609.24972v3), 21 September; v3 4 October 2026 | Constrains and prunes harness evolution to reduce benchmark-specific edits; reports smaller but persistent gains on out-of-distribution evaluations. | Pilot offline optimization with fixed budgets and held-out tasks. Use the current revision: its headline gains differ from earlier indexed summaries. |
| [Beyond Prompts / PRISM](https://arxiv.org/abs/2609.05736v2), 4 September; v2 9 September 2026; record reports EMNLP 2026 acceptance | Routes repairs to prompts or constrained tool-boundary middleware and evaluates selected improvements under a budget. | Attribute failures before changing prompts. [Limitations](https://arxiv.org/html/2609.05736v2) include controlled offline tasks, small scorecards, a Telecom scoring caveat, and no demonstrated repeated deployment loop. |
| [Agent Memory: Characterization and System Implications](https://arxiv.org/abs/2606.06448), 4 June 2026 | Profiles ten memory systems and separates construction, retrieval, and generation costs. | Meter memory writes and consolidation as well as retrieval. A more elaborate memory store needs an actual workload advantage. |
| [MemGym](https://arxiv.org/abs/2605.20833), 20 May 2026 | Evaluates memory across tool dialogue, research, coding, and computer-use tracks. | Use execution-oriented evaluations alongside conversational recall. Memory and reasoning effects need separate controls. |
| [DeepWeb-Bench](https://arxiv.org/abs/2605.21482), 20 May 2026; work in progress | Cross-source derivation and calibration dominate errors in its evaluated research tasks. | Research quality needs claim checking and reconciliation. Page count is an inadequate quality metric. |
| [Argus-Retriever](https://arxiv.org/abs/2606.04300), 3 June 2026 | Uses region-aware, query-conditioned visual document retrieval. | Valuable when tables, charts, and page layout matter. Compare its complexity with a lightweight multimodal index first. |
| [MarginMerge](https://arxiv.org/abs/2608.02969), 4 August 2026 | Compresses multi-vector page representations while preserving useful regional coverage. | Consider only after visual retrieval warrants the larger index and storage is a measured bottleneck. |
| [OSWorld 2.0](https://arxiv.org/abs/2606.29537v2), 28 June; v2 13 July 2026 | Tests 108 long computer workflows, exposing failures in constraint tracking, changing information, hidden state, and verification. | Validate complete workflows and mid-task corrections; short successful GUI demonstrations are insufficient evidence. |
| [Tactile](https://arxiv.org/abs/2607.14443), 16 July 2026 | Combines accessibility, OCR, visual regions, affordances, and verification cues in an observe/act/check loop. | Reuse the architecture idea. Its reported macOS-oriented results do not establish support on Machdoch's Windows and Linux targets. |
| [Context Privilege Escalation](https://arxiv.org/abs/2609.01222v2), 1 September; v2 2 September 2026 | Analyzes role escalation and persistence across scopes in twelve agent harnesses. | Preserve source trust and scope through retrieval, compaction, and skill learning. Retrieved material must not become authoritative instructions through summarization. This paper does not establish a Machdoch vulnerability. |
| [Recursive Language Models](https://arxiv.org/abs/2512.24601v3), 31 December 2025; v3 11 May 2026 | Treats large inputs as an external environment accessed through code and recursive model calls. | Pilot bounded analysis over large corpora. This changes how data is accessed; it does not make context or inference free. |

Two additional areas were screened rather than selected for immediate product work: [MiniCorp](https://arxiv.org/abs/2610.05912v2), revised 13 October 2026, is an enterprise simulator rather than evidence of deployable autonomous company management; [DFlash](https://arxiv.org/abs/2602.06036) is speculative-decoding research for inference serving, which cannot be applied as a client-side speedup to an arbitrary hosted model.

**Recent capabilities available to evaluate**

“Available” means a public API, release, model card, or specification was checked. It does not imply access for every account, a compatible local runtime, or an unrestricted redistribution license.

| Capability | Verified upstream status | Machdoch decision |
| --- | --- | --- |
| [EmbeddingGemma 2](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/) | Released 6 October 2026; modular multimodal embeddings, 740M total parameters, Apache-2.0. The publisher describes a 270M text path with optional vision/audio encoders. | Highest-priority new model spike: local search across text, code, images, audio, and video. Measure Windows/Linux runtime, actual memory, retrieval quality, and indexing cost. Publisher mobile-memory figures are not desktop measurements. |
| [MOSS-Image Base/SFT](https://github.com/OpenMOSS/MOSS-Image) | Author repository announces code and weights on 16 October 2026, with 5B image backbone, layout inputs, and Apache-2.0 repository licensing. | Strong recent candidate for editable layout generation. Verify the exact weight license and full dependency stack before packaging; heterogeneous training is not proof of consumer AMD inference support. |
| [FLUX 3 Image Klein](https://bfl.ai/blog/flux-3-image-klein) | Released 15 October 2026: 5.6B image model, base/distilled variants, references, generation/editing, and spatial inputs. | Evaluate for a specific quality/control advantage. Do not select a local default on parameter count alone. |
| [FLUX publisher model card](https://huggingface.co/black-forest-labs/flux-3-image-klein) | Reference B200 measurements at 1024 square are 25–31 GB peak GPU memory with upsampling off. Boxes are not hard masks; edits may alter other regions. FLUX Kommunity terms restrict commercial uses. | Treat memory, exact-region preservation, and distribution as unresolved integration constraints. The model card qualifies the launch page's editing language. |
| [Gemini 4 Argon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-argon/) | 13 October 2026 release describes paid API availability and a continuation protocol. | Evaluate through the current Google capability contract. Long-run support may require execution changes beyond adding a model identifier. |
| [Claude Haiku/Sonnet/Opus 5.5](https://www.anthropic.com/news) | Official newsroom lists releases on 7 October, 28 September, and 22 September 2026. | Candidates for small, medium, and difficult tasks in the existing provider. Compare complete-task cost and quality before changing defaults. |
| [OpenAI Agents API](https://openai.com/index/introducing-the-agents-api/) | Public beta announced 10 September 2026, providing managed long-lived agent sessions and orchestration. | Pilot an explicit cloud execution target for unattended work. Preserve Machdoch's task ownership, cancellation, instruction delivery, and evidence contracts. |
| [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) | Hosted long-horizon execution service described 8 April 2026. | Another backend candidate, not a reason to introduce a second user-visible task lifecycle. |
| [MCP Apps](https://apps.extensions.modelcontextprotocol.io/) | Official extension; stable specification dated 26 January 2026. Tool-associated HTML resources communicate through a host bridge. | Build a focused host for interactive results. The extension SDK provides building blocks and examples, not a complete supported host implementation. |
| [MCP 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) | Stateless request contract, optional discovery, and revised extension-based asynchronous tasks. | Check current interoperability before extending the older experimental task client. In the current Tasks contract, a protocol-completed task can still contain `isError: true`; completion is not application success. |
| [A2UI 0.9](https://developers.googleblog.com/a2ui-v0-9-generative-ui/) | Public declarative generative UI format and renderers. | Narrow pilot when controlled React components provide a clear advantage. Avoid implementing two general UI frameworks simultaneously. |
| [Gemini Live](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [OpenAI voice architectures](https://developers.openai.com/api/docs/guides/voice-agents) | Documented realtime conversation capabilities and voice-agent architectures. | Extend existing speech work with interruption, live task steering, and accurate task-state narration. Speech generation and full-duplex conversation are separate integration requirements. |
| [TRELLIS.2](https://www.microsoft.com/en-us/research/workbench/project/trellis), [UniForge3D](https://github.com/xibushu/UniForge3D) | Public image-to-3D research and implementations; UniForge3D targets sparse unposed multiview images. | Retain a bounded 3D Studio pilot. The author [license statement](https://github.com/xibushu/UniForge3D#license) distinguishes MIT code from noncommercial weights and other dependencies. |

**Priority order for Machdoch**

Effort is relative to the inspected architecture: medium means a focused cross-layer extension; large means a new subsystem or substantial runtime/UI integration. Estimates exclude unknown provider, packaging, and hardware issues. Priority reflects expected utility and durability, not publication recency.

| Rank | Addition | User benefit | Recommendation | Effort |
| --- | --- | --- | --- | --- |
| 1 | Verifiable task completion and recovery | Tasks finish with inspectable proof and resume from the correct state. | Build first, using Goals and RALPH. | Medium–large |
| 2 | State-aware memory | Previous findings remain useful without repeating stale facts or old test results. | Build with the evidence foundation. | Medium |
| 3 | Local multimodal workspace search | Find the right document page, image, recording passage, or code fragment. | First major new product capability. | Large |
| 4 | Persistent research projects | Save evidence, compare sources, and refresh a research question over time. | Build on current web search and the shared index. | Medium–large |
| 5 | Efficient tool orchestration | Large tool collections and data workflows use less model context. | Measure exposure first; pilot programmatic calls. | Medium–large |
| 6 | Skills learned from tested procedures | Repeated work becomes faster and more consistent. | Controlled pilot, then evaluated promotion. | Medium |
| 7 | Interactive results through MCP Apps | Edit a table, inspect a document, or manipulate a chart directly. | Deliver one useful integration first. | Medium–large |
| 8 | Editable image and media composition | Move objects, preserve text, and revise selected parts of a design. | Continue the existing layout proposal. | Large |
| 9 | Measured model, reasoning, and worker allocation | Spend computation where it improves completed work. | Extend the controller after outcome measurement exists. | Medium |
| 10 | Computer use with outcome checks | Browser and desktop workflows tolerate changing state and verify saved results. | Improve the current tools, one workflow at a time. | Medium–large |
| 11 | Realtime voice over ongoing tasks | Speak corrections and receive timely, accurate progress updates. | Extend the current speech implementation. | Large |
| 12 | Bounded corpus analysis and cloud execution | Handle unusually large or unattended jobs. | Separate opt-in pilots with a concrete workload. | Large |

**1. Verifiable task completion and recovery.** Add structured evidence to the existing task lifecycle: the requirement being checked, observation or artifact reference, affected object, state/version fingerprint, result, and collection time. Evidence should come from host-observed tool results and direct outcome checks, with a compact projection for the evaluator. Avoid relying exclusively on a model's final description of what happened.

For example, a task that exports a spreadsheet should verify that the output opens and contains the required sheets and values. A coding task should connect relevant checks to the version that was checked. A browser task should check the saved record or downloaded artifact. When an action changes a dependency, invalidate only the evidence whose applicability is affected, using conservative rules until dependency coverage is reliable. This proposal extends the existing independent evaluator rather than replacing it.

SafeActBench's [evidence-to-action method](https://arxiv.org/html/2610.07753v1) motivates checking prerequisites and propagating actual receipts between dependent actions. Acceptance should include a successful command with the wrong output, a partial workflow, an interrupted task, a mid-run correction, and an old passing result followed by changed inputs. Completion must reflect the observable result. Collect the smallest decisive check; additional review must earn its execution cost.

**2. State-aware memory.** Distinguish durable preferences, current facts, historical observations, and reusable procedures. Add source locators, supersession, and applicability metadata to memory. For mutable facts, retrieval should establish which version is current; a relevant old embedding must not win merely because its wording matches the question.

Use MemTrace's [state-consistency approach](https://arxiv.org/html/2610.04838v3) as an architectural reference, starting with explicit file/artifact bindings instead of requiring a general graph database. Preserve useful history as history. Evaluate changed values, conflicting sources, scope isolation, corrections, and deletion through all retrieval paths. MemCalib motivates testing whether the agent appropriately ignores irrelevant remembered material as well as uses relevant material. Apply source trust during consolidation so imported content cannot acquire instruction privileges.

**3. Local multimodal workspace search.** Create one incremental index with stable source references: file version, page and region, audio/video time range, and asset identifier. Combine exact lexical matching with semantic retrieval, and add visual retrieval where page layout carries information. Return the source and a directly usable locator, not just a generated answer.

The first spike should compare the current lexical baseline with [EmbeddingGemma 2](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/) on representative Machdoch files, code, screenshots, multilingual documents, and recordings. Preserve page structure, tables, and timestamps during ingestion. Excluded or deleted material must disappear from search, caches, previews, and generated context. Measure retrieval accuracy and citation location separately from answer quality, along with index size, incremental update latency, RAM/VRAM, and interference with foreground work.

Start with lightweight representations. Argus and MarginMerge become relevant if measured table/chart retrieval failures justify multi-vector indexing. A specialized document parser should be selected by extraction correctness on actual inputs rather than a generic OCR leaderboard.

**4. Persistent research projects.** Save a question, scope, source snapshots, publication/revision dates, claims, supporting passages, unresolved contradictions, and report revisions. Support a deliberate refresh through the existing scheduler, showing meaningful changes to conclusions or evidence. Reuse current web providers, history, and RALPH.

The useful addition is continuity and auditable synthesis. A report should distinguish a paper, a revised paper, a product announcement, and a tested integration. Claims need support from the cited passage; disagreement should remain visible where the evidence cannot resolve it. [DeepWeb-Bench](https://arxiv.org/abs/2605.21482) supports allocating work to derivation and calibration, alongside source discovery.

Acceptance: handle contradictory sources, an outdated release page, an inaccessible original, a revised result, and an unsupported precise claim. Refresh must update the saved findings without duplicating previous side effects. Judge evidence support and question coverage, not report length.

**5. Efficient tool orchestration.** First measure context spent on tool definitions, results, repeated discovery, and intermediate data. Machdoch already searches and inspects MCP tools. Improve selection and output projections where traces show waste. Retain large results as artifacts that subsequent steps can inspect selectively.

Next, pilot a bounded code runtime that composes selected tools, filters results, and returns a compact result with evidence references. [Anthropic's MCP code-execution publication](https://www.anthropic.com/engineering/code-execution-with-mcp) explains the potential savings and operational costs; its illustrative 98.7% token reduction is not a forecast for Machdoch. Every tool action must remain attributable, cancellable where supported, and governed by the host's existing execution boundary. A general shell alone does not provide this integration contract.

Before expanding asynchronous tooling, test the installed SDK/client against a current MCP server. The inspected client uses an experimental task API and a distinct result request, whereas the [current Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) returns final results in task state. This is evidence of a contract difference, not a reproduced connection failure. Implement the selected current contract directly; do not create indefinite compatibility paths without an explicit requirement.

Acceptance: compare the same multi-tool task with equal outputs and checks; include execution overhead and failures in cost/latency. Restart must retain task identity, cancellation must reach the appropriate operation, and tool-level errors must not appear as successful work.

**6. Skills learned from tested procedures.** Use the reasoning bank, recorded macros, and task evidence to propose a reusable procedure with inputs, tools, outputs, and checks. Version it and test it on new task variants before making it the selected procedure. Keep experimental candidates outside the normal execution path.

SkillNEO, DAEDALUS, and RRSI motivate different parts of this lifecycle; they do not establish that unrestricted self-modification is reliable. PRISM adds a useful engineering lesson: decide whether a failure belongs to the prompt, tool schema, tool boundary, state handling, or execution environment before choosing a repair. A malformed identifier should not produce a permanent paragraph of general instructions if a precise boundary fix resolves it.

Acceptance: improve verified outcomes on held-out inputs, count skill development cost, retain the prior selected version when a candidate regresses, and preserve source scope. Re-evaluate skills when provider or tool behavior changes. Do not fine-tune a foundation model merely to store a workflow.

**7. Interactive results through MCP Apps.** Add resource discovery and a host-controlled bridge to isolated tool UIs. Choose one use case: an editable comparison table, cited document viewer, or chart with filters. Reuse the shared conversation components for desktop and Fleet where practical.

The [official extension](https://apps.extensions.modelcontextprotocol.io/) supplies the interaction contract. Embedded actions should pass through the same host tool policy and produce visible outcomes in task history. Verify keyboard access, cancellation, remote-client behavior, resource restrictions, and prevention of direct native access from the embedded resource. Keep model-authored claims separate from actual widget state. A2UI remains a targeted alternative for declarative native components, rather than a second simultaneous general platform.

**8. Editable media composition.** Continue the existing layout plan with one editable scene containing assets, text, transforms, regions, and relationships. Compile it to the selected model's actual spatial input or render deterministic composition where exact geometry and typography are needed. Preserve the scene and recipe so a user can revise an element without recreating the project.

MOSS-Image and the existing Ideogram work are concrete candidates; FLUX 3 is another evaluation target. The [FLUX model card](https://huggingface.co/black-forest-labs/flux-3-image-klein) explicitly says that boxes are not hard masks and edits may change content outside the region. Exact preservation therefore needs deterministic composition/restoration or a separately verified execution mechanism. Test visible object placement, text correctness, references, edit boundaries, runtime memory, and export fidelity.

Prioritize control and editability over adding another general image picker. Reuse the speech suite for narrated multimedia projects. Keep the separately proposed 3D Studio within its actual engine, licensing, and hardware constraints.

**9. Measured model, reasoning, and worker allocation.** Extend the adaptive controller with task outcomes, full cost accounting, and understandable execution policies. Preserve explicit user model and data-location choices. A selected small-model route should be intentional; do not silently change providers when a call fails.

Compare single-agent execution with bounded parallel work on tasks that have independently useful subtasks. [Google's agent-scaling study](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) shows that coordination can help decomposable tasks and harm sequential work in its evaluated settings. New small and frontier models are candidates for these roles, not automatic defaults.

The [current provider audit](provider-feature-compatibility-2026-10-15.md) also identifies Goal/controller composition and native instruction-delivery gates. Resolve these deliberately before relying on native delegation or adaptive Goal behavior. Acceptance should measure verified success per complete-task cost, latency distributions, wasted work, and user corrections. Include discovery, workers, checking, memory operations, failed attempts, and provider charges where available.

**10. Computer use with outcome checks.** Build a common action record over the current browser and desktop tools: observed state, target identity, action, and expected consequence. Rediscover targets after relevant state changes and use semantic controls when they are available. Screenshots and coordinates remain valid techniques for visual surfaces, with current observations and checks.

Tactile suggests the tool-layer architecture; OSWorld 2.0 suggests the evaluation difficulty. Begin with supported Windows/Linux workflows: a moved window, a delayed UI update, changing page content, an interrupted form, and a downloaded result. Measure completed artifacts and correct external state, not clicks executed. Connect these observations to task evidence so browser and desktop work can resume coherently.

**11. Realtime voice over ongoing tasks.** Extend the new speech packages with a continuous conversation session that can interrupt audio, amend a running instruction, delegate tasks, and report their actual state. Keep one task owner so reconnecting or repeating a spoken request cannot accidentally duplicate an action.

Evaluate Gemini Live and OpenAI's documented voice architectures against the existing task backend. First verify microphone capture, playback cancellation, and local/cloud speech jobs already being implemented. Then test barge-in, correction during execution, reconnect, selected-window sharing, and task cancellation. Measure first audible response and successful task steering as well as transcription accuracy. New narration models alone do not provide these behaviors.

**12. Bounded corpus analysis and cloud execution.** Run two distinct pilots only for demonstrated workloads. For unusually large collections, an RLM-style analyst can inspect external data through code and bounded subcalls while retaining source references. Compare it with ordinary indexed retrieval using the same budget. Limit recursion, inference, tools, wall time, and output volume, and measure tail cost.

For unattended jobs, test one managed agent backend through Fleet. Check durable identity, tool access, instruction inheritance, progress, interruption, artifact retrieval, and usage accounting. A local desktop-control task cannot simply be assumed to work in a hosted sandbox. Choose one owner for continuation and stopping so provider and Machdoch loops cannot independently multiply work.

**A concrete starting sequence**

| Increment | Deliverable | Decision it enables |
| --- | --- | --- |
| First | A file-task vertical slice with structured observations, requirement checks, invalidation after edits, and correct resume. A small representative evaluation set accompanies it. | Establish whether the evidence foundation reduces false completion and repeated work. |
| Second | Memory supersession and source applicability using that same record. | Establish whether remembered facts improve actions after changes and corrections. |
| Third | Incremental local search across documents and selected media, with exact source locators. | Select an embedding/runtime approach from measured usefulness and resource cost. |
| Fourth | A saved research project that can refresh its evidence and findings. | Deliver an immediately useful workflow built on the foundation. |
| Parallel bounded spike | Current MCP task interoperability and one interactive MCP App. | Resolve a protocol dependency and demonstrate useful direct manipulation. |
| Subsequent | Evaluated skill promotion and routing; editable media and realtime voice through their existing modules. | Expand capability using measured outcomes and the product area with strongest demand. |

This is a dependency order, not a calendar estimate. It deliberately allows a small MCP integration spike alongside the larger index work. Existing speech work should continue through its own validation; this review does not require restarting it.

**Evaluation and selection**

Use representative Machdoch tasks: a file transformation, a repository change, a browser workflow, a cited research comparison, a long task with a correction, and a media edit. Separate development examples from held-out variants. For each feature, add only the pertinent changed-state, cancellation, malformed-result, deletion, or scope cases.

Compare a candidate with the current implementation under the same model, task inputs, and total budget before attributing gains to a new subsystem. Repeat enough runs to expose relevant variability, and retain task-level outcomes rather than only averages. Track verified completion, false completion, total cost, latency, user corrections, and the specific failure mode being targeted. Statistical confidence requires adequate representative data; no universal success-rate improvement is assumed here.

The first investment decision can therefore be small: prove the evidence/memory slice and the local retrieval spike. Promote subsequent features when they produce useful behavior on realistic held-out work, rather than reproducing a vendor demo.

**Areas to defer or keep narrow**

| Area | Current recommendation |
| --- | --- |
| Unlimited agent swarms | Use bounded, task-specific parallelism and measure coordination overhead. |
| Automatic production harness rewriting | Keep optimization offline until candidates pass held-out evaluations and review of tool semantics. |
| Always-on screen recording | Introduce capture for a selected task/session only when it solves a demonstrated workflow. |
| Large graph database as the first memory change | Start with explicit evidence relations and versioned facts; expand only for observed query needs. |
| New general image-model catalogs | Add a model when it unlocks a specific control, quality, cost, or hardware advantage. |
| 3D as a general productivity priority | Keep the existing dedicated proposal; prove asset quality, exports, model-stack rights, and hardware support first. |
| Kernel-level inference research | Use advances through a supported serving runtime when Machdoch actually owns local inference. |
| Robotics, world simulation, autonomous companies | Monitor research; no immediate integration is justified by the inspected product scope. |

**Verification and remaining uncertainty.** Primary online sources were checked against relevant source files, package metadata, the existing provider audit, and current media/voice proposals. The local document links were checked for existence. The repository already contained unrelated modified and untracked work; this task adds only this report. No application, development server, provider task, inference job, or benchmark was started. Code tests and builds were not run for this documentation-only change.

Model quality, account access, task success, latency, GPU compatibility, actual memory use, commercial permissions for complete model stacks, and integration effort remain unverified locally. Hardware identity was not inspected, and published NVIDIA or mobile measurements must not be treated as measurements of the user's machine. Findings are current to the research cutoff and should be rechecked when implementation begins.
