# Memory and retrieval system

## Investigation findings

The original stores were functional, but the normal capture path was not.

A targeted runtime diagnostic on 2026-08-23 loaded the real configuration without printing credentials:

```text
provider: openai
configuredApiProviders: [openai, google, codex-cli]
internalTaskModel: codex-cli:gpt-5.6-sol
globalMemoryEnabled: true
globalMemoryCount: 5
selectedInternalProvider: codex-cli
adapterCreated: false
```

This distinguishes an empty UI from a capture failure: global persistence and loading already contained five entries, while the automatic memory extractor could not start.

The concrete causes were:

1. In-process API agents received `remember_session_memory` and `remember_global_memory`, but delegated Codex, Claude, and Copilot CLI agents do not execute Machdoch's in-process tool definitions. Their loop state starts with an empty `memoryUpdates` array in `external-agent-provider.ts`.
2. The post-task extractor in `memory-consolidation.ts` was the only automatic capture path for delegated agents. It used the configured internal task model.
3. The internal-task selector accepted delegated CLI providers, while `createProviderAdapter` in `provider-adapters.ts` explicitly returns no adapter for every CLI provider. The extractor therefore returned no candidates.
4. Adapter and model failures were converted to an empty candidate list. There was no persisted or surfaced status that distinguished “nothing useful” from “extractor unavailable.”
5. Retrieval did run. `conversation-prompt-context.ts` loaded session and global entries and injected them into the prompt. It selected the first ten recency-sorted entries from each scope, regardless of the current request. This could consume up to 5,600 content characters and made retrieval appear unreliable when relevant older facts were displaced.
6. Session updates were persisted by the desktop session state and retained by interactive CLI chat state. Global updates were written atomically to the user configuration and shown in Settings. The UI exposed global contents and a session count, but no relevance or capture diagnostics. There was no workspace scope.
7. Exact normalized content prevented identical duplicates. There was no stable concept identity, contradiction replacement, importance/confidence model, ranked retrieval, global deletion UI, or durable workspace deletion UI. Session reset/branch operations could remove session memory as part of session state changes.

The failure was primarily **not generation**, not storage, loading, prompt injection, or display. The unranked retrieval policy was a separate quality and token-cost problem.

## Research findings

The selected design uses the useful common ground from recent memory and retrieval work without importing infrastructure that is disproportionate for a small structured fact store.

| Approach                                       | Quality                                                                                 | Latency and tokens                                                      | Complexity and cost           | Decision                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| Full conversation context                      | High recall, poor focus as history grows                                                | Highest prompt cost; suffers position effects                           | Low implementation cost       | Keep only a bounded recent window plus summary, not full history                    |
| Explicit memory tools                          | High precision when the executing agent recognizes a durable fact                       | No second model call; tiny stored records                               | Low                           | Primary capture path for API agents                                                 |
| Post-turn extraction                           | Good for agents that cannot call host tools; structured consolidation can resolve scope | One extra small model call after the response                           | Medium and provider-dependent | Use only for delegated CLI agents, not every turn universally                       |
| Session-end extraction                         | Can consolidate broadly                                                                 | Loses memories on interrupted/long sessions and delays availability     | Medium                        | Rejected                                                                            |
| Vector-only retrieval                          | Useful synonym recall                                                                   | Embedding calls/storage and model coupling                              | Medium operational cost       | Rejected for at most 128 short structured records                                   |
| Local lexical ranking                          | Strong for code identifiers, commands, paths, versions, and exact constraints           | Sub-millisecond at this scale; no network or tokens                     | Low                           | Adopted                                                                             |
| Hybrid lexical/vector retrieval with reranking | Best general semantic recall                                                            | Embedding plus reranker latency and cost                                | High                          | Revisit only when the corpus or measured miss rate justifies it                     |
| Hierarchical summaries or graphs               | Useful for large, multi-hop corpora                                                     | Additional extraction and maintenance                                   | High                          | Not adopted for the fact store                                                      |
| Full workspace vector index                    | Can retrieve source without tools                                                       | Staleness, duplicate context, indexing/change detection, embedding cost | High                          | Rejected; coding agents already search current files with `rg` and filesystem tools |

Sources that influenced the implementation:

- [LongMemEval](https://arxiv.org/abs/2410.10813) separates indexing, retrieval, and reading, and shows large performance losses in long conversational memory. This supports explicit scope separation and retrieval before prompt injection.
- [MemGPT](https://arxiv.org/abs/2310.08560) models tiered memory rather than treating all history equally. This supports session, workspace, and global tiers with different lifetimes.
- [Mem0](https://arxiv.org/abs/2504.19413) uses extraction, consolidation, and retrieval rather than replaying history, and reports large token and latency reductions. This supports concise fact records and keyed consolidation.
- [A-MEM](https://arxiv.org/abs/2502.12110) uses structured attributes and evolving links. Stable keys, kinds, importance, and confidence were adopted; graph evolution was not.
- [Zep](https://arxiv.org/abs/2501.13956) maintains evolving facts with temporal relationships. Machdoch keeps timestamps and keyed replacement, without introducing a graph for a small fact store.
- [Generative Agents](https://arxiv.org/abs/2304.03442) combines relevance, recency, and importance for memory selection. Those signals are represented directly in the local ranker.
- [OpenAI Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) isolates project-only memory from unrelated conversations, supporting a hard workspace boundary.
- [Mem0 entity-scoped memory](https://docs.mem0.ai/platform/features/entity-scoped-memory) partitions writes and reads by user, application, agent, and run identifiers. This supports treating scope as storage identity rather than display metadata.
- [LangGraph memory](https://docs.langchain.com/oss/python/concepts/memory) separates thread state from long-term custom namespaces and distinguishes semantic, episodic, and procedural memory. Machdoch stores semantic facts; chat history remains the episodic record, while instructions remain outside memory.
- [Letta memory blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/) keeps persistent, editable context in attachable blocks. This supports user-visible lifecycle controls without loading every stored entry into every prompt.
- [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) finds that BM25 and embeddings are complementary and that reranking improves retrieval at added cost. This supports lexical retrieval now and a measured hybrid upgrade path later.
- [OpenAI vector store retrieval](https://platform.openai.com/docs/api-reference/vector-stores) exposes hybrid rank fusion, score thresholds, metadata filters, and optional reranking. The local design mirrors thresholds and metadata/scope filtering without requiring a hosted vector store.
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) demonstrates that longer context does not guarantee effective use. This supports strict entry and character budgets.
- [RAPTOR](https://arxiv.org/abs/2401.18059) shows the value of hierarchical summaries for large corpora. It remains an option for a future large workspace-document corpus, not this short fact store.
- [RepoCoder](https://arxiv.org/abs/2303.12570) shows the benefit of repository-level retrieval and iterative use of current code context. Machdoch retains live file search instead of persisting stale copies of source text.

## Implemented design

### Scopes and persistence

| Scope     | Lifetime                           | Storage                               | Capacity |
| --------- | ---------------------------------- | ------------------------------------- | -------: |
| Session   | Current chat                       | Session state and task memory updates |       24 |
| Workspace | Across sessions in one active root | `<workspace>/.machdoch/memory.json`   |       64 |
| Global    | Across workspaces                  | User configuration                    |       40 |

Workspace storage resolves from `RuntimeConfig.workspaceRoot`, not a prompt-provided path. Each root therefore has a physically separate atomic JSON store. Cooperative file locking protects concurrent writes.

Each memory has a stable `key`, `kind`, concise `content`, retrieval-only `searchTerms`, `importance`, `confidence`, creation time, and update time. Reusing a key updates the existing record in place and preserves its id and creation time. Exact normalized content is also deduplicated. This gives current facts one canonical record and prevents conflicting versions from accumulating.

Memory content uses the scope as its implied subject. Preference entries use compact wording such as `Prefers concise answers`; generic framing such as `The user prefers:` is removed during normalization.

### Capture policy

- In-process agents receive explicit tools for enabled scopes. The input protocol requires a non-sensitive fact, stable key, kind, retrieval aliases, and importance. Sensitive, malformed, or extra-field calls are rejected.
- Runs that do not save through a memory tool receive a post-turn extraction pass. The pass runs after the agent's user-facing response, has a 60-second deadline, produces at most four structured candidates, and rejects low-confidence, sensitive, malformed, disabled-scope, and duplicate-key candidates.
- Runs that already wrote memory are not reviewed again.
- Extractor unavailability or failure never changes a successful task into a failure. `metadata.memoryCapture` records status, candidate counts by scope, stored count, failed count, and a machine-readable failure reason.

Routing always selects the narrowest useful scope. Current-chat information is session memory; project information is workspace memory even when phrased as a preference; only stable facts or explicit preferences about the user that apply across unrelated projects are global memory.

### Retrieval and prompt budget

The local ranker tokenizes Unicode text, camel-case identifiers, paths, commands, versions, and retrieval aliases. It combines BM25-style lexical relevance, query coverage, adjacent-token matches, scope-specific recency decay, importance, confidence, and a small global-preference prior. Search terms expand the index for likely future wording but are never injected into the model prompt.

Retrieval applies:

- minimum relevance score: `0.2`
- maximum selected records: `8`
- maximum memory content: `1,800` characters
- per-request quotas: session `3`, workspace `4`, global `2`
- recency half-lives: session `7` days, workspace `90` days, global `365` days

Only selected content is injected into `<session_memory>`, `<workspace_memory>`, and `<global_memory>`. The full normalized stores remain available to memory tools for correct replacement and deduplication, but are not placed in the prompt.

The previous worst-case memory payload was 20 records or 5,600 content characters. The new hard limit is eight records and 1,800 content characters: a 60% entry reduction and approximately 68% content-character reduction before XML framing, with unrelated requests commonly injecting no memory.

A local diagnostic over the maximum combined corpus size (128 records) ran 2,000 retrievals in 3,020 ms, or 1.51 ms per query. Its representative query selected five records and 326 content characters. This is a synthetic CPU measurement, not a cross-machine latency guarantee.

Retrieval diagnostics show candidate/selection counts by scope, context characters, and non-content selection signals such as lexical, phrase, recent, important, or global-preference. Stored memory contents are not copied into diagnostic sections.

### Display and lifecycle operations

`machdoch memory list` and its JSON form show global and active-workspace stores separately, including key, kind, id, and update time. **Settings > Memory** shows both durable stores for the active workspace and provides per-entry forget controls. Session memory remains part of session state.

Core deletion operations exist for global and workspace ids. Keyed replacement is the normal correction path.

## Verification strategy

Focused tests cover normalization, bounded storage, exact deduplication, stable-key replacement, deletion, atomic workspace persistence, workspace isolation, explicit tool validation, post-turn structured validation, extraction failure diagnostics, lexical ranking, relevance filtering, scope quotas, prompt budgets, prompt injection, and correction of unsupported internal-task provider selections.

The runtime contract is generated from the schema for TypeScript and Rust, and both sides normalize the new memory fields. TypeScript core, UI, and test projects and Rust boundary tests must pass together because user-config memory crosses that boundary.
