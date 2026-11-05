# Inject less, prove more: how to radically improve Machdoch's agents

The biggest gains available to Machdoch are not a smarter memory database or more agents. They come from four changes: keep raw evidence and retrieve it precisely, recover what the user meant before coding, prove work on every run instead of only in goal mode, and treat tool output as untrusted data at the host level. This is what the newest research supports, and Machdoch's own data shows the gap is real. **I replayed the production retrieval code against the local stores, and only about 36% of sampled lessons and 16% of sampled memories looked useful for the query they were retrieved for.** Most matched on a single word. This run's own context included a lesson about tiled VAE decoding, because the task contained the word "memory".

Three findings drive the ranking:

- **Most dedicated memory systems score below plain retrieval from raw history.** Keeping evidence intact matters more than distilling it ([Memory Tax](https://arxiv.org/abs/2610.34073)).
- **Clarifying before coding is the largest single effect found.** In a controlled test, implementation pass rates went from 5-6% with no client interaction to 39-49% with it ([SWE-Clar](https://arxiv.org/abs/2610.31854)).
- **Silent failure is the norm.** Agents silently choose between conflicting instructions, 23.4% of code-editing episodes end with no independent check after the last edit, and prompt warnings do not stop injection.

Treat all of this with care. Nearly every paper here is a recent preprint, most read through a summarizing fetch tool, and effect sizes come from the authors' own benchmarks. Value and effort labels are my judgment. No proposed feature has been built or tested in Machdoch; only the retrieval replay was run.

## What this adds to earlier reports

This report does not repeat the [October 30 control report](Agent%20CLI%20control%20research%20update.md), which focused on CLI control and goal verification. Since then, 39.0.0 shipped goal checks that inspect real work and provider-session continuation. From that report's list, two items remain open and still matter: the constraint ledger (a search of `apps/client/src/core` finds provider compaction events handled only for Copilot) and the replay harness (no agent eval suite is tracked in the repo). Both are folded into the plan below.

The goal records can't show the effect of 39.0.0 yet. Of 47 local records, 1 is complete and none holds a verdict from the new verification.

## Local measurement: retrieval is the cheapest big win

Method: I ran the real `retrieveReasoningLessons` and `retrieveConversationMemory` against this workspace's stores, using 258 commit subjects as stand-ins for task prompts. I then hand-judged a seeded random sample of 25 lessons and 25 memories. Scripts and method are in [the research notes](../research_notes/Inject%20less%20prove%20more/README.md).

| Measure | Lessons | Memories |
|---|---|---|
| Store size against its cap | 240 of 240 | 64 of 64 |
| Items retrieved per query | 3.61 | 2.83 |
| Retrieved on a single shared word | **67.6%** | **82.3%** |
| Judged useful in the sample | **9 of 25 (36%)** | **4 of 25 (16%)** |
| After a two-word gate: items kept | 264 of 932 | 110 of 729 |
| After a two-word gate: useful in the sample | 6 of 9, and 3 useful items lost | 1 of 3, and 3 useful items lost |

Limits: commit subjects are shorter than real prompts, which inflates single-word matches. The replay uses default limits, while a live run's adaptive budget can inject fewer items. The sample is small, one judge (me) labelled it from titles and short excerpts, and the stores are from one workspace.

Four things stand out:

1. **Any one shared word can qualify an item.** `assessMemoryApplicability` passes on one shared non-stopword (`memory-applicability.ts`), and `can`, `new` and `check` are not stopwords in `memory-retrieval.ts`. In the replay of this task, the four memories selected matched on words like `can`, `check`, `agent` and `new`.
2. **The feedback loop cannot see harm.** The bank records 1,539 retrievals, 108 helpful marks and **zero harmful marks**. Those marks come from a model reviewing its own task (`reasoning-bank-consolidation.ts`). A signal that has never gone negative cannot demote a misleading lesson.
3. **Both stores are full, and eviction ignores value.** Workspace memory keeps the 64 most recently updated entries regardless of importance (`memory.ts`). Lessons are trimmed by confidence and helpful count, so the unreliable signal in point 2 partly decides what survives (`reasoning-bank.ts`).
4. **Entries are lossy by construction.** The 280-character cap keeps a conclusion and discards its evidence, which is the "construction loss" Memory Tax measures. Only the memory source session is recorded, so nothing marks a memory as derived from untrusted tool output.

A word-count gate alone is too crude for memory: it lost as many useful items as it kept. The better design is to inject only pinned constraints and preferences by default, and let the agent pull the rest through `search_memory`.

## Ranked plan

Effort: **S** up to a week, **M** two to four weeks, **L** one to three months, for one engineer. Evidence classes: **Local** (measured here), **Code** (read in this repo), **Measured** (a study; status in the evidence sections), **Vendor**, **Doc**, **Inference**.

| # | Build | Value | Effort | Evidence | Backed by |
|---|---|---|---|---|---|
| 1 | Stricter retrieval: pinned items by default, pull for the rest, stronger gate, shown reasons | Very high | S | Local; Measured | Replay above; Memory Tax; PrefDiag |
| 2 | Proof gap on every run, not only goals | Very high | S-M | Measured | Soei: 23.4% and 57.8% |
| 3 | Clarify before coding: an automatic gate on the existing interview | Very high | M | Measured | SWE-Clar; Ask or Assume; SWE-RPG |
| 4 | State delta on resume, showing changed values | High | S-M | Measured (small); Code | EnvOS: 0/16 to 15/16 |
| 5 | Host-side conflict detection across memory, skills and instructions | High | S-M | Measured | Epistemic Parity; WhoWins |
| 6 | Context cost panel, then trim tools | High | S-M | Measured; Local | Paritok; Instruction Stacks; Is Bash All You Need? |
| 7 | Secret scrubbing, provenance labels, pinned skill and MCP updates | High | S-M | Measured; Code | HookPry; CARI; Soei |
| 8 | Requirement ledger with a requirement-to-code map, including the constraint ledger | Very high | M | Measured | RepoTrace; SWE-CC; earlier constraint studies |
| 9 | Compile repository rules into deterministic checks | High | M | Measured | SWE-CC: 43.1% of policies violated |
| 10 | Experience store: immutable episodes, budgeted rendering, claim lifecycle | Very high | L | Measured | Memory Tax; FlexA-Mem; KEEL; Stratum; LongMemEval-V2 |
| 11 | Best-of-N across CLIs with deterministic selection | High | M | Measured | Beyond Passing Tests; Identical Runs |
| 12 | `machdoch eval`: paired runs, replay, valid-completion rate | High, enabling | M-L | Measured; Vendor | Identical Runs; When Agents Fail; Claude and Cursor evals |
| 13 | MCP proxy reliability: bounded retries, typed errors, breaker, constraint checks | Medium-High | M | Measured, mitigations untested | MCP-Injector; Symbolic Constraint Agents |
| 14 | Untrusted-input run profile for unattended work | High for scheduled and Fleet runs | L | Measured, with real utility cost | Progent evaluation; CARI; Cursor |
| 15 | Subtask-scoped context for RALPH, goal passes and the API runtime | Medium-High | M-L | Measured, small | Spine |
| 16 | PDF and OCR in workspace knowledge, then embeddings | Medium-High | M-L | Measured; Vendor | FlexA-Mem; Memory Tax; Cursor |
| 17 | Verification-as-exploration for desktop and browser work | Medium, unproven | M-L | Measured (abstract, no numbers) | VeriCUA; PUSV |

Items 1, 2, 4, 5 and 6 are the best first month because they change host logic only and apply to all three CLIs. Item 12 ranks low only because of its cost. It is what turns every other number here from literature into Machdoch data, so start a small version alongside item 1.

## Better understanding

**Clarifying before coding has the largest effect I found.** SWE-Clar gives agents 100 real Upwork jobs and a simulated client. On GPT-5.6 Luna and GLM-5.3 Flash, implementation pass rates were:

| Protocol | GPT-5.6 Luna | GLM-5.3 Flash |
|---|---|---|
| No client interaction | 6% | 5% |
| Clarification first | 49% | 39% |
| Complete requirements upfront | 75% | 71% |
| Clarification interleaved with coding | **26%** | **13%** |

Across nine models, clarification score and implementation score correlate at r = 0.89, and final disclosure of hidden requirements reached only 33.6-53.7%, so even good clarification leaves gaps ([SWE-Clar](https://arxiv.org/abs/2610.31854), preprint, full text via fetch; simulated client, greenfield tasks, wide intervals). A peer-reviewed result points the same way: separating underspecification detection from execution reached a 69.40% resolve rate on underspecified SWE-bench ([Ask or Assume?](https://aclanthology.org/2026.findings-emnlp.15/), Findings of EMNLP 2026). The diagnosis also matches. Implicit requirement recovery is the main bottleneck in 163 repository tasks, accounting for 24.5-46.0% of runs, with a 31.5% average resolve rate ([SWE-RPG](https://arxiv.org/abs/2608.09072), preprint, abstract; denominator unclear). The best of 16 models passed only 48.3% of implicit-requirement scenarios ([Implicit Intelligence](https://arxiv.org/abs/2602.20424), preprint, abstract).

Machdoch already has a user-invoked interview (`core/task-interview.ts`, `chat-interview.ts`). **Build an automatic gate on top of it.** Before an expensive run, a cheap pass asks whether two plausible readings would produce behaviorally different results ([CONTRA](https://arxiv.org/abs/2610.01769), preprint). If so, ask up to a few questions before work starts, and otherwise proceed and state the assumption. Hold back once coding has started, since interleaving was the worst clarification protocol. Skip it for unattended runs, and hold out a share of runs to measure later correction counts.

**Requirement ledger.** Extend 39.0.0's goal checklist to ordinary chats, and link each requirement to the code it touches. RepoTrace injects that correspondence into context. It reports a 56.78% reduction in regression errors, and average per-round reward rising from 0.163 to 0.371 on one harness and model ([RepoTrace](https://arxiv.org/abs/2610.35333), preprint, abstract). User prohibitions from the earlier constraint-ledger recommendation belong in the same record. Restate them after compaction and on resume.

**Compile rules into checks.** Across 823 policies from 12 repositories, agents violated 43.1% of applicable policies while still producing correct patches, and nearly half of the violations occurred in intermediate steps rather than the final diff ([SWE-CC](https://arxiv.org/abs/2610.06193), preprint, abstract). Machdoch's instruction system already tracks delivery with digests and receipts, but delivery is not compliance. Offer a one-click "make this rule checkable" that generates a deterministic check, running on each edit where a hook exists and at the end of the run otherwise.

**Do not lead with LSP.** The only direct measurement found that it usually doesn't save tokens: +6% to +118% on localization, precision but no savings on references, and location-only LSP failing about three-quarters of multi-file renames that grep solved. Agents also ignored it 94-100% of the time on localization ([Xu](https://arxiv.org/abs/2608.13568), preprint, preliminary, older models). Offer it as an on-demand tool for reference tasks only.

**Mine git history instead.** In Stratum's sample of 852 commits, 47.3% of co-changed file pairs stayed disconnected even with transitive imports and test links ([Stratum](https://arxiv.org/abs/2610.36153), Python only). A local co-change table in the existing SQLite library is cheap, works on any repository, and needs no parser. This is my inference from that measurement; no study has tested its effect on task success.

## Better context

**Fix what reaches the model before tuning what it holds.** A study of 720 runs found that about a third of tool results were cut by a fixed-length slice, each one becoming invalid JSON, even though the largest prompt used only 5.75% of the window. In its controlled test, the cost appeared as 43% more tool calls and about twice the computation rather than as wrong answers, and causation for accuracy loss remains open ([Context Is a Pipeline](https://arxiv.org/abs/2610.36114), preprint, one agent). Machdoch's `limitText` (`runtime-text.ts`) adds a notice, but it is still a positional prefix cut that can break structured output, and I did not check whether each caller offers a way to fetch the rest. Adopt two rules for Machdoch-owned tools:

- **No silent truncation.** Every response states what was returned, what remains and what it cost, as in Stratum's page-safe envelope.
- **Degrade before dropping.** Shrink an item to a signature or record before removing it. This independently appears in FlexA-Mem, where adding the rule alone raised completion 10.7 points at a 4k budget, and in [Rivet](https://arxiv.org/abs/2610.34967) (both preprints, tight budgets).

**Show the value, don't send a reminder.** Opus 5 failed all 16 trials when a value changed mid-task, reached 2 of 16 when reminded to re-check, and 15 of 16 when shown the updated value ([EnvOS](https://arxiv.org/abs/2610.40246), NeurIPS 2026 workshop, small sample, non-coding). 39.0.0 makes this urgent. A resumed provider session binds to instruction and history digests, with no record of workspace state (`provider-session-store.ts`), so a resumed agent may trust what it read yesterday. On resume, inject a short delta: files changed since the last turn that the agent had read, Git state, and changed run status.

**Measure, then trim the instruction stack.** One instrumented gateway found tool-schema filtering removed 21-57K tokens per turn and was the only unambiguously positive lever, while content compression saved little per turn but compounded over a session, and non-destructive recall spends some of that back ([Paritok study](https://arxiv.org/abs/2609.22114), preprint, one gateway; authors built it). Across 1,886 releases of five agents, tool definitions dominated the latest requests of three ([Instruction Stacks](https://arxiv.org/abs/2610.37332), preprint). This run exposed **123 Machdoch tools**, including `hash_text`, `generate_uuid`, `sort_unique_lines` and `test_regex`, which the shell already covers. They are deferred on Claude here. What they cost on Codex and Copilot wasn't measured.

The bolder test is to move simple tools behind the `machdoch` CLI. On two enterprise benchmarks, bash alone beat typed tools by 21.8-24.5 and 4.8-7.4 points with 19-72% fewer tokens, adding typed tools back gave no detectable gain, and programmatic calling trailed bash ([Is Bash All You Need?](https://arxiv.org/abs/2609.11999), preprint, abstract, not coding). Its authors condition this on isolating arbitrary execution, which ties to item 14. Start with a panel showing first-request size by source, as Claude Code's `/skill-doctor` does for skills ([What's new](https://code.claude.com/docs/en/whats-new)), and remove tools with no recorded use.

**Watch cache share per run.** On one third-party endpoint, the same model cost about 23x more per run in one agent than another, mostly because 92-98% of input was cached in one and 2-11% in the other ([Identical Runs](https://arxiv.org/html/2609.33812v1), preprint, full text via fetch, one task). That is not a general ranking of those agents, but it shows how large this lever can be. Both Anthropic and OpenAI now offer cache diagnostics ([Claude](https://platform.claude.com/docs/en/release-notes/overview), [OpenAI](https://developers.openai.com/api/docs/changelog)).

**Scope context by subtask where Machdoch owns it.** Spine keeps unfinished subtasks in full and replaces finished ones with their results, preserving the cache prefix. With GPT-5.6 Sol it reports a score of 38.1 to 42.6 and cost of $681 to $461 on SWE-Milestone, though cost rose 5.4% on ProgramBench ([Spine](https://arxiv.org/abs/2610.37224), preprint, full text via fetch; 7 and 50 tasks, no variance reported). It took about 17K lines inside Codex, so it isn't available on the CLI paths. It fits RALPH blocks, goal passes and the API runtime, where Machdoch assembles the prompt.

## Better memory

**Raw history beats distillation more often than vendors imply.** On LongMemEval-s with Qwen3.6-27B, naive two-round RAG scored 81.4, while 11 memory systems scored 58.8-79.4. With GPT-5.6 Luna, every system fell below RAG on that benchmark. MINT-Eval and PersonaMem-v2 show narrower or mixed gaps ([Memory Tax](https://arxiv.org/abs/2610.34073), preprint, full text via fetch; static, English, limited tuning, frontier models largely untested). FlexA-Mem's fact recall stayed within 0.7% of BM25 over raw text at every LongMemEval budget, and it concluded LLM-written records add little there ([FlexA-Mem](https://arxiv.org/abs/2610.33274), preprint, full text via fetch; only 147 tasks had pre-registered predictions). The good news is that Machdoch's SQLite FTS5 is already close to the right foundation.

**Memory still wins when it holds experience that raw search cannot find.** These results frame the design:

| Source | Result | Why it matters | Limit |
|---|---|---|---|
| [Stratum](https://arxiv.org/abs/2610.36153) | Root cause found 21/24 with a prior agent's notes vs 6/24 for lexical retrieval, at 4.5x fewer tokens | Failed attempts and root causes are worth storing | Re-diagnosis of the same 8 bugs, file-level scoring, no transfer test |
| [KEEL](https://arxiv.org/abs/2610.34043) | +4.2 to +21.7 points over no knowledge, and beat its benchmark's default curation | Knowledge gated by verifier evidence | One benchmark, single rollouts; cost about 4x on Opus 4.6; **Haiku lost 8.4 points** |
| [LongMemEval-V2](https://arxiv.org/abs/2605.12493) | 72.5% for a coding agent over files with instructions, 69.3% for plain Codex, 48.5% for the best RAG | An agent with file tools is a strong memory controller | 108-186 s per query; no cost reported |
| [AMA-Bench](https://arxiv.org/abs/2602.22769) | 57.2% with a causality graph vs 51.8% long context; Mem0 21.0% | Most systems trail long context; causal structure can help | In-episode only |
| [DolphinBench](https://arxiv.org/abs/2609.24971) | Mem0 70.67% vs built-in 65.67% at about 56% higher cost; Claude Code group 26-36% | Task-based scoring with cost and latency is the right benchmark shape | **Authors are from Mem0**, synthetic data |

**The target design has four parts:**

1. **Immutable episodes.** Keep each run's transcript, tool events, diffs and verdict, addressable by ID and never rewritten. Secrets are scrubbed before writing.
2. **Deterministic rendering.** Build a compact timeline plus recovered detail per call to fit a budget, with no model call at read time, as in FlexA-Mem.
3. **Claims with a lifecycle.** Move lessons through draft, provisional, confirmed, contradicted and retired, with transitions driven by verifier results in code. Show only provisional and confirmed claims to the agent. 39.0.0's goal checklist is the natural evidence source and replaces the self-review that has never recorded harm. Run the costly analyzer only on failures, to contain KEEL's 4x cost, and keep the feature off by default for small models until tested.
4. **Files any CLI can read.** Publish notes and a manifest as plain files, bound to file hashes and commits. LongMemEval-V2's ablations found workflow instructions consistently mattered, and that is how a mixed-model handoff worked in Stratum. This is the multi-CLI memory that single-vendor products have little reason to build.

Consolidation should follow Anthropic's Dreams pattern: it writes a new store, never changes its input, and leaves the output to be reviewed or discarded ([Dreams](https://platform.claude.com/docs/en/managed-agents/dreams), research preview). Machdoch's post-task consolidation writes directly into live stores today. A reviewable diff costs little and protects against the failure critics raise, where bad habits harden into permanent policy.

**Surface conflicts, because models won't.** In 1,383 runs, 89% disclosed nothing about a memory-skill contradiction, and moving a block closer to the task shifted which source won ([Epistemic Parity](https://arxiv.org/abs/2610.33128), NeurIPS 2026 workshop, three open-weight models). Across 14 open-weight models and 1.9M replies, the first of two conflicting lines in a message won 72-95% of the time, at most 2.92% of decided replies flagged a conflict, and in tool and file-write tasks the same text won less often in the system message than as a labelled user message ([WhoWins](https://arxiv.org/abs/2610.33201), preprint, abstract). So:

- Detect conflicts in the host when selecting context, and show them only when one exists.
- Test placement per model, since a system-prompt position does not guarantee priority. Machdoch's current split, a stable system prompt with context in the user message, looks reasonable but has not been measured.

**Personalization has the same bottleneck.** Selecting evidence from history and knowing when a preference applies were the two limits in 11 GUI agents, and supplying the right evidence added at most 7.06% ([PrefDiag-Bench](https://arxiv.org/abs/2610.30573), preprint, abstract, mobile). Better preference storage won't fix selection.

## Improved features

**Proof gap.** In 45 real sessions, an estimated 23.4% of code-editing episodes (95% CI 17.1-35.7) ended with no independent check after the last edit, and 57.8% of to-dos marked complete had no proof in between ([Soei](https://arxiv.org/abs/2610.39468), preprint, abstract, classifier-based, small sample). Machdoch's file-change capture and tool events should let a heuristic compute this on every run with no model call. If an edit has no later check, run or request one before reporting done, and show a state only when a gap exists. This extends 39.0.0's goal rigor to the common case.

**Best-of-N.** The October 30 report found no source measuring this. Two now bear on it, and both favor it:

- A controlled re-evaluation found best-of-N with an analyzer-weighted ranker matched or beat prompting, planning, self-refinement, a reviewer agent and retrieval at matched budgets, and only 1 of 66 techniques beat it on its primary target beyond the 95% interval, consistent with chance ([Beyond Passing Tests](https://arxiv.org/abs/2610.38977), single-author preprint, abstract; code quality rather than task resolution).
- On one tabular task, three attempts gained a median +0.0081 AUC, and two runs of the same pairing differed by 0.0147 on average ([Identical Runs](https://arxiv.org/html/2609.33812v1)).

**Selection must be independent and must check compliance.** In the second study, the seven highest scores all came from runs that broke the data rules, and a single automated quality signal gets gamed in the first. Offer N=2-3 as an explicit, cost-labelled action for hard tasks, in isolated worktrees. Rank with tests and rule checks rather than an LLM judge, and treat provider diversity as a hypothesis, since the one preregistered cross-provider verifier found no added detection ([Sion & April](https://arxiv.org/abs/2610.28667), preprint, small).

**`machdoch eval`.** Claude Code now has `claude plugin eval` with a no-plugin baseline, and Cursor's Agent SDK tests agents with evals ([What's new](https://code.claude.com/docs/en/whats-new), [Cursor](https://cursor.com/changelog)). Machdoch needs this for its own harness. Design for what the variance evidence demands:

- Three-run comparisons ranked the weaker pairing ahead 28-44% of the time, and detecting agent differences took about 39-113 runs per arm ([Identical Runs](https://arxiv.org/html/2609.33812v1)), so prefer paired replay and large effects.
- Harness rankings change with model and benchmark across 52,168 trajectories, so report per pairing and include valid completion ([When Agents Fail](https://arxiv.org/abs/2610.32483), preprint, abstract).
- Automate proposal, not adoption. Two revisions by frontier models improved held-out scores by only 2.80 points, with an interval crossing zero ([Lehmann & Vahdati](https://arxiv.org/abs/2610.30499), preprint, abstract, ARC-AGI-3), even though [Self-Harness](https://arxiv.org/abs/2606.09498) reports gains in all nine of its pairings.

**MCP proxy reliability.** A permanent-heavy fault profile calibrated from 57,240 issue threads cut task scores 60%, and a larger model kept no larger share of its score ([MCP-Injector](https://arxiv.org/abs/2610.32555), NeurIPS 2026 poster per the arXiv listing; two model sizes). Mined constraints checked at call time removed 59-87% of failed calls ([Symbolic Constraint Agents](https://arxiv.org/abs/2610.25552), preprint, abstract). Machdoch's proxy sits on that path for every CLI, so bounded retries, typed errors, a breaker for repeatedly failing tools and schema checks would help all of them. MCP-Injector did not test these mitigations, so measure them.

## New capabilities

**A safe mode for untrusted input.** Machdoch mode launches with `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox` or `--allow-all` (`external-agent-provider.ts`). That is a deliberate choice for attended work, and this report does not propose restoring the Fleet path boundary you decided against. Unattended runs that read external content are a different risk:

- Instructions hidden in diagnostic output succeeded in 94.8% of model-level trials, and 61.3% on Codex and 58.7% on Claude Code. Generic warnings failed and explicit policies over-refused ([CARI](https://arxiv.org/abs/2610.38799), preprint, abstract).
- Trojanized hook updates reached 92.5% per-harness success across seven harnesses, and Microsoft Defender had 0% recall on the artifacts ([HookPry](https://arxiv.org/abs/2609.03884), preprint, abstract).
- The same injection was followed 2.6x more often from a README or TODO than from code on GPT-5.4 ([Trust Region](https://arxiv.org/abs/2610.38867), preprint, abstract).
- Malicious memory files had a weak, inconsistent effect, at -8 to +6 points ([Memory Files](https://arxiv.org/abs/2610.38521), preprint, abstract), so memory files deserve less alarm than the other three.

Deterministic enforcement outside the model has the best evidence, but it costs real capability: Progent cut attack success from 25.8% to 4.2% while utility fell from 45.2% to 27.1%, with about 15x more model calls ([adaptive evaluation](https://arxiv.org/html/2606.26479v1), preprint, weak 7B model). So make it a run profile for scheduled, Fleet and RALPH work, not a default. It would combine an OS sandbox ([Cursor](https://cursor.com/blog/agent-sandboxing) reports sandboxed agents stop 40% less often, vendor data), a credential proxy, and egress rules. Anthropic keeps credentials out of the sandbox entirely in Managed Agents ([engineering post](https://anthropic.com/engineering/managed-agents)).

Three cheap steps can come first:

- **Pin updates.** Hash skills and MCP tool definitions and require approval when they change. MCP discovery hashes exist, but I found no pinning logic in a targeted search, so confirm this.
- **Scrub secrets in code.** The lesson consolidator has a regex gate, while memory consolidation relies on a prompt instruction. I found no redaction in the provider session store. Soei found credential-like strings in 16 of 45 real sessions.
- **Record provenance.** Mark whether a memory came from the user or from tool output, and never let tool-derived text become an instruction.

**Knowledge beyond text.** Add PDF and OCR ingestion first, since the library indexes text files only and BM25 is already competitive. Add embeddings second, for prose and mixed German and English queries. On code, Cursor's own test found +12.5% offline accuracy but only +0.3% code retention, rising to +2.6% in codebases of 1,000+ files ([Cursor](https://cursor.com/blog/semsearch), vendor, Nov 2025). That modest online effect argues against rushing embeddings for code. EmbeddingGemma 2 remains the local candidate from the [October 22 review](../docs/ai-research-deep-review-2026-10-22.md).

**Verified computer use.** VeriCUA treats verification as exploration, building a rubric and choosing GUI or code checks for unresolved requirements. It reports stronger rejection of false completion claims, with no numbers on the page I read ([VeriCUA](https://arxiv.org/abs/2610.40578), work in progress). Rechecking the UI before each action stopped 100% of 180 adversarial time-of-check attacks, but not DOM injection ([PUSV](https://arxiv.org/abs/2604.18860), preprint). Machdoch's Windows control tools make this a plausible differentiator, but it should wait for items 1-9.

**Provider features worth wiring on the API path.** These need the API runtime and do not reach CLI runs:

| Feature | Status | Use |
|---|---|---|
| Anthropic turn-scoped system messages, tools inside mid-conversation system messages | Beta | Per-turn deltas and tool changes without breaking the cache |
| Anthropic compaction on demand, session budgets, per-message effort | Beta, varies | Host-controlled compaction and spend |
| OpenAI 12-hour prompt cache | Available, writes at 2.5x input price | Long unattended runs |
| OpenAI async tool calling, mid-turn steering, effort changes | Available | Parity with live CLI control |
| OpenAI Decisions API | GA, gpt-6-luna | Bounded classification, such as the clarify gate |

Sources: [Claude release notes](https://platform.claude.com/docs/en/release-notes/overview) and the [OpenAI changelog](https://developers.openai.com/api/docs/changelog), read through a summarizing fetch.

## Where the evidence argues against the attractive option

| Don't build yet | Why |
|---|---|
| Graph database or third-party memory backend | Graph systems scored below RAG in nearly every Memory Tax comparison, and vendor numbers conflict and are hard to compare. AMA-Bench's causal graph is a real counterexample, so retest only if replay shows a need |
| Auto-applied self-improving harness or memory consolidation | Held-out gain was 2.80 points with an interval crossing zero; bad habits can harden. Propose changes and require review |
| Prompt warnings as injection defense | Warnings failed in CARI and did not reliably protect in the memory-file study |
| Questions during coding | Interleaved clarification was far below clarifying first in SWE-Clar |
| LSP-first code understanding | Conditional and usually negative on tokens in the one direct measurement |
| Reminder text as a staleness fix | 2/16 against 15/16 for showing the value in EnvOS |
| Screen-capture memory like Codex Chronicle | I found no outcome evidence, and the privacy cost is high ([Chronicle docs](https://developers.openai.com/codex/memories/chronicle), snippet only). Watch it |
| Choosing defaults from public leaderboards | Aggregators disagree on SWE-bench Pro and Terminal-Bench, the official Terminal-Bench page gave me no entries, and METR calls measurements above 16 hours unreliable and no longer updates the page ([METR](https://metr.org/time-horizons/)) |

## Benchmarks worth borrowing

Use task designs from these in `machdoch eval`. Their scores are not targets, because harness and model interact.

| Benchmark | Borrow it for | Status |
|---|---|---|
| [SWE-Clar](https://arxiv.org/abs/2610.31854) | Clarify gate, with its clarification-off and interleaved conditions | Preprint, 100 tasks |
| [SWE-RPG](https://arxiv.org/abs/2608.09072) | Implicit requirements and planning diagnosis | Preprint, 163 tasks |
| [SWE-CC](https://arxiv.org/abs/2610.06193) | Deterministic policy checkers during execution | Preprint, 500 tasks |
| [CodeSpecWeave-Bench](https://arxiv.org/abs/2610.40256) | Interdependent requirements | Preprint, 100 tasks, 1,044 specs |
| [DolphinBench](https://arxiv.org/abs/2609.24971) | Memory scored by tasks with cost and latency | Preprint, vendor authors |
| [LongMemEval-V2](https://arxiv.org/abs/2605.12493) | Learning an environment from trajectories | Preprint, 451 questions |
| [EnvOS](https://arxiv.org/abs/2610.40246) | Stale state, and certifying graders before trusting them | Workshop paper |
| [MCP-Injector](https://arxiv.org/abs/2610.32555) | Fault injection at the proxy | NeurIPS 2026 poster per arXiv |
| [WhoWins](https://arxiv.org/abs/2610.33201), [Epistemic Parity](https://arxiv.org/abs/2610.33128) | Instruction placement per model | Preprint; workshop paper |

## Limits of this research

- **Read depth varies.** Stratum, Spine, FlexA-Mem, KEEL, Memory Tax, DolphinBench, LongMemEval-V2, AMA-Bench, Identical Runs and SWE-Clar were read in full text or large part, through a summarizing fetch that can misreport details and that truncated some long pages. Everything marked "abstract" was read from the abstract page only. Check the PDFs before quoting any figure publicly.
- **Peer review is rare.** Ask or Assume is the main peer-reviewed result here, and three others are workshop or poster acceptances per arXiv. Many papers are days old and unreplicated, and many authors built the winning system.
- **Models and domains differ.** Many studies use open-weight or older models and non-coding tasks. Long, private, multi-session work with current frontier models remains nearly unstudied.
- **Local data is thin.** The replay uses one workspace and commit subjects. No study measures any of these features in a real multi-week deployment with a control arm.

Machdoch's durable advantage is that it sits above every CLI and sees what happens on private repositories. Memory, proof, conflicts, tool reliability and evaluation can all live in that host layer, so they keep their value as models improve and carry across providers. Harness assumptions also expire: Anthropic found that context resets which helped one model became dead weight on a newer one ([engineering post](https://anthropic.com/engineering/managed-agents)). That is why every addition here should ship with a way to measure it and a way to remove it.
