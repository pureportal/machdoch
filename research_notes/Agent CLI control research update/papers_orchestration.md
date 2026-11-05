# Newest academic papers on orchestrating and running AI coding agents (for machdoch features)

Research date: 2026-10-30. How to read these notes:

- **Status tags:** `[PEER: main]` conference or journal main track or Findings, `[PEER: workshop]` workshop paper, `[ACCEPTED]` author-declared acceptance on arXiv only, `[PREPRINT]` no venue listed, `[VENDOR]` engineering write-up, not peer reviewed. Within each section, entries are grouped in that order.
- **Verification:** every paper below had its abstract page (or venue page) opened in this session. `(full text read)` means the HTML body was also read, at least in part. All other figures are abstract-level. Pages were read through a summarizing fetch tool, so check exact numbers against the PDF before quoting them publicly.
- **Sample sizes:** when an entry says "n not in abstract", the abstract gave none. It does not mean the paper has none.
- **Credibility and Feature lines are my judgment**, not claims from the papers. Credibility: High, Medium or Low, relative to this field, where almost everything is a self-reported benchmark from the system's own authors.
- **Features were not cross-checked against machdoch's code.** Repository searches timed out, so some may overlap with what exists. Features assume machdoch hosts provider CLIs, so it can act before spawn, at hooks or tools, at an API proxy, and after a run, but cannot fine-tune or read model internals.
- **Date scope:** a few pre-2026 papers are included because they gained an ICLR 2026 or ACL 2026 venue, or because the brief named them. Each is marked with its first-submission date.

## Multi-agent orchestration: when parallel helps or hurts, decomposition, conflicts, hierarchies, scheduling, runtimes

### Takeaway
Parallelism pays when the work is decomposable along dependency boundaries and something verifies integration. Unstructured parallel agents commonly lose to one agent on quality and nearly always on cost per unit of result. The best conflict-control results so far gain reliability by falling back to serial execution, not by delivering safe concurrency.

### Cited Findings

#### Peer-reviewed

**Passes Alone, Fails Together: Benchmarking Semantic Coordination in Parallel LLM-Agent Development.** Xia, Wu, Park. [arXiv:2609.25396](https://arxiv.org/abs/2609.25396), Sep 2026. `[PEER: workshop]` EXPRESS 2026, 6 pages.
- Mechanism: "stale" benchmark runs the same tests on each patch alone and on the combination, counting only failures the combination introduces.
- Evidence: on mined Django PR pairs (834 runs, 417 pairs), only one run showed interference after grading was corrected. On constructed tasks using 12 Django helpers, interference hit 97% of runs. A message describing the finished concurrent change recovered 82% of runs. The authors warn that constructed rates are not estimates of real-world frequency.
- Credibility: Medium-High. Short workshop paper, but it reports its own grading correction and limits its claim.
- Feature: **combined-patch gate plus sibling change notice.** Before merging parallel work, run tests on each patch and on the merge, and classify combination-only failures. When a sibling lands an interface change, inject a short notice into still-running agents.

**AgenticFlict: A Large-Scale Dataset of Merge Conflicts in AI Coding Agent Pull Requests on GitHub.** Ogenrwot, Businge. [arXiv:2604.03551](https://arxiv.org/abs/2604.03551), Apr 2026. `[ACCEPTED]` AIware 2026 per the arXiv page.
- Mechanism: deterministic merge simulation over agent PRs, extracting conflict regions.
- Evidence: 142K+ PRs collected, 107K+ simulated, 29K+ conflicting (27.67%), across 59K+ repos, with 336K+ conflict regions.
- Credibility: High as a descriptive dataset. It measures PRs against their base branch, not concurrent same-session agents.
- Feature: use the conflict regions as a **replay fixture** to test any auto-merge resolver machdoch builds.

#### Preprints

**When Parallelism Pays Off: Cohesion-Aware Task Partitioning for Multi-Agent Coding (Co-Coder).** Yang et al. [arXiv:2606.00953](https://arxiv.org/abs/2606.00953), May 2026. `[PREPRINT]` (full text read)
- Mechanism: treats orchestration as graph partitioning, trading critical-path reduction against context transfer. Builds a static-analysis dependency graph, isolates hub files, runs community detection, then uses a dependency-aware scheduler.
- Evidence: 28 tasks (DevEval, CodeProjectEval), three runs per repository. Up to +14.0% pass rate, 2.10x speedup, 35% lower API cost. Negative baselines: Claude Code Agent Teams was fastest but below sequential on quality (54.1% vs 56.8%; 16.3% vs 20.1%). File-based parallel raised cost 44% and 60% for little or no pass-rate gain.
- Credibility: Medium. Plausible mechanism, small n, and headline figures are "up to". Authors evaluate their own system. Their own caveat: near-total coupling collapses to one group, so no speedup.
- Feature: **cohesion-aware splitter.** Before fan-out, build an import or dependency graph, isolate hub files to a single owner, partition by community, and refuse to parallelize when the partition collapses.

**Claim Plane: A 30-Pair, Three-Seed Confirmatory Study of Deterministic Pre-Write Admission.** Nikolaev. [arXiv:2608.00947](https://arxiv.org/abs/2608.00947), Aug 2026. `[PREPRINT]` Design paper: [arXiv:2607.21909](https://arxiv.org/abs/2607.21909).
- Mechanism: each worker declares a versioned change intent (base commit, resources, committed or contingent operations). A deterministic control plane admits compatible intents, limits same-file parallelism to declared regions, and serializes overlaps. Scope changes need atomic promotion and re-admission.
- Evidence: 30 frozen CooperBench pairs, 3 seeds, 4 arms, 360 executions. Pair pass rose from 23.3% (unconstrained parallel) to 50.0% with static admission (+26.7 points, 95% bootstrap CI 9.6 to 60.0). Integration success rose from 65.6% to 96.7%. But 96.7% of static executions were serialized, including 93.3% of clean cases, and there was no useful wall-clock gain. Dynamic admission blocked 46 of 90 executions and fell to 22.2%, with 45 blocks on files already declared, pointing to weak region coverage and amendment handling.
- Credibility: Medium-High for design (frozen inputs, seeds, intervals, honest nulls). Lower for generality: single author, one model pair, DeepSeek only.
- Feature: **intent ledger with leases.** Agents declare touched files before work; overlaps serialize automatically. Do not ship fail-closed dynamic blocking without a cheap amendment path, and report the realized parallelism to users rather than implying speedup.

**Multi-agent Collaboration with State Management (STORM).** Liu et al. [arXiv:2605.20563](https://arxiv.org/abs/2605.20563), May 2026. `[PREPRINT]` (full text read)
- Mechanism: agents get a consistent code view, and conflicting edits are detected at write time rather than at post-hoc worktree merge.
- Evidence: 16 Commit0-Lite repos and 20 PaperBench Code-Dev papers, three models on OpenHands. On Sonnet 4.6 Commit0 score: single 66.4, git worktree 63.8, STORM 82.5. Git worktree scored below single-agent on Commit0 for all three models. STORM also fell below single-agent on Qwen (70.5 vs 75.3) and DeepSeek (63.2 vs 65.2). Single-agent had the best cost efficiency on every model and benchmark. Chardet on Sonnet: 99.7% single vs 22.1% STORM.
- Credibility: Medium. No repeat-run variance reported. "Combined" variants take the per-task best of two runs, which inflates scores, so ignore the 87.6 and 78.2 headlines. Bash writes bypass the check.
- Feature: **write-time conflict check via pre-edit hooks** where a provider CLI exposes them, plus a post-hoc detector for shell writes. Default to one agent and require the planner to justify fan-out.

**CooperBench: Why Coding Agents Cannot be Your Teammates Yet.** Khatua et al. [arXiv:2601.13295](https://arxiv.org/abs/2601.13295), Jan 2026. `[PREPRINT]`
- Mechanism: 600+ paired-feature tasks across 12 libraries and 4 languages, with expert-written tests.
- Evidence: about 30% lower success together than alone. Failures: vague or mistimed messages, broken commitments, wrong beliefs about the partner's plan.
- Credibility: Medium-High. Large and real-repo, and already reused as a substrate by Claim Plane. It tests agents coordinating by themselves, which is the condition a host's control plane is meant to replace.
- Feature: **do not rely on agent-to-agent chat for safety.** Make coordination host-enforced state, and use CooperBench pairs as machdoch's regression suite for its parallel mode.

**When Agents Coordinate: Measuring Coordination in Multi-Agent AI Coding.** Destefanis, Aste. [arXiv:2608.16801](https://arxiv.org/abs/2608.16801), Aug 2026. `[PREPRINT]`
- Mechanism: models each run as a temporal network of agents and files, across team size, structure and file policy.
- Evidence: 1,902 runs plus a 244-run sealed replication. Shared files cut output tokens about 42% at eight agents on message-heavy work but add overhead when files already carry coordination. A named coordinator created no hub and no reliable success gain. Agents sought hidden grading files unprompted, in about 80% of replication runs.
- Credibility: High relative to the field: large n, and the coordinator and file findings replicated in a sealed run.
- Feature: **verifier isolation.** Keep acceptance tests and goal-loop oracles outside any agent-readable worktree. Add a **blackboard file** only above a message-volume threshold, and do not assume a "lead" role helps by label alone.

**An Empirical Study of Coordination Mode as the First-Class Citizen in From-Scratch Multi-Agent Coding (MSEval).** Ren et al. [arXiv:2607.27877](https://arxiv.org/abs/2607.27877), Jul 2026. `[PREPRINT]`
- Mechanism: 10 full-stack projects, 10 collaboration topologies, automated grader measuring function, latency and prefix-cached token cost.
- Evidence: 100 runs. Topology alone moved scores by over 30 points and doubled wall-clock time. Structured pipelines converged fastest and best; heavy managerial oversight hurt.
- Credibility: Low-Medium. 100 runs across a 10x10 design implies about one run per cell, so large single-cell swings could be noise.
- Feature: **pipeline as the default RALPH flow template** (spec, implement, test, review stages with defined handoffs) over manager-heavy flows.

**OrchBench: Evaluating Multi-Agent Orchestration Plans in Isolation via Deterministic Simulation.** Ren et al. [arXiv:2607.25656](https://arxiv.org/abs/2607.25656), Jul 2026. `[PREPRINT]`
- Mechanism: gives a planner a task DAG, per-agent context limit and agent budget, then scores the plan in a deterministic simulator without running workers.
- Evidence: simulated scores correlate r = 0.816 with Claude Code execution quality, at 1.3% of the token cost and 10.3% of the wall-clock time. n not in abstract. Finding: keeping task-critical information matters more than adding agents.
- Credibility: Low-Medium. Good idea, correlation only, sample unknown.
- Feature: **plan linter before spawn.** Score a proposed fan-out on makespan, context transfer and estimated tokens before paying for workers.

**Towards a Science of Scaling Agent Systems.** Kim et al. [arXiv:2512.08296](https://arxiv.org/abs/2512.08296), Dec 2025, v3 Apr 2026. `[PREPRINT]` Google and MIT authorship per search summaries.
- Mechanism: controlled evaluation with standardized tools, prompts and compute, comparing single agent against four multi-agent architectures, then fitting a predictive model.
- Evidence (v3 abstract): 260 configurations, 6 benchmarks, 3 LLM families. Change vs single agent ranges from +80.8% (decomposable finance) to -70.0% (sequential planning). Cross-validated R² = 0.373 (0.413 with a task-grounded capability metric). Picks the best architecture for 87% of held-out configurations. Centralized verification limits error propagation. Tool-heavy tasks incur multi-agent overhead.
- Credibility: Medium-High for design, but not coding-specific. Version drift: search summaries of v1 give 180 configurations, 4 benchmarks and R² = 0.513, so use v3. The widely repeated 17.2x vs 4.4x error-amplification figures came through search summaries and the v3 abstract page did not show them; I did not confirm them.
- Feature: **parallelizability gate.** Estimate task decomposability and tool intensity before fan-out; sequential-reasoning tasks stay single-agent. Always route parallel output through one verification stage.

**Worse Together: How Performance Breaks Down in Multi-User Multi-Agent Teams.** Paliskara, Namchittai, Lampinen. [arXiv:2610.00583](https://arxiv.org/abs/2610.00583), Sep 2026. `[PREPRINT]`
- Mechanism: 5 frontier models, 77 scenarios, 4 environments including a merge queue and a shared API budget, comparing one coordinator for all users against one agent per user.
- Evidence: teams did worse in every environment. Without a channel, teams collapsed in two environments. A team lead, explicit procedures, and a platform check requiring agents to read peer messages before committing helped.
- Credibility: Medium. Mostly non-coding and multi-user, so transfer to one developer's fleet is partial.
- Feature: **single allocator for shared budgets and the merge queue,** and a commit gate requiring that sibling notices were acknowledged.

**AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge Conflict Rates.** Xu, Subramanian, Karthik. [arXiv:2607.04697](https://arxiv.org/abs/2607.04697), Jul 2026. `[PREPRINT]`
- Mechanism: AIDev-pop dataset, replaying three-way merges on co-active PR pairs.
- Evidence: 33,596 PRs, 2,807 repos, 747 replayed pairs. Textual conflict 41.7% cross-agent vs 19.8% same-agent (non-overlapping CIs). 84.4% of conflicted files were source code; about 42% of conflicts were structural (modify/delete, add/add).
- Credibility: Medium-High for what it measures. One pair per repo, and pairs were not necessarily coordinated.
- Feature: **stricter serialization when mixing providers** in one repo, since the cross-agent conflict rate is about double.

**HiveMind: OS-Inspired Scheduling for Concurrent LLM Agent Workloads.** Agyemang et al. [arXiv:2604.17111](https://arxiv.org/abs/2604.17111), Apr 2026. `[PREPRINT]`
- Mechanism: transparent HTTP proxy with admission control, rate-limit tracking, AIMD backpressure with circuit breaking, token budgets and priority queues. No agent code changes.
- Evidence: 7 scenarios with 5 to 50 agents. Failure rates 72-100% uncoordinated vs 0-18% with HiveMind; 48-100% of wasted compute eliminated; under 3 ms overhead. Ablation: transparent retry was the most important primitive, more than admission control.
- Credibility: Medium. Authors' contention scenarios, but the mechanism is standard systems engineering and open source under MIT.
- Feature: **local LLM proxy under spawned CLIs** feeding machdoch's adaptive budget controller with real 429/502 signals. Build retry first.

**Agent libOS: A Runtime Substrate for Capability-Controlled Self-Evolving LLM Agents.** Zhang. [arXiv:2606.03895](https://arxiv.org/abs/2606.03895), Jun 2026, v3 Aug 2026. `[PREPRINT]`
- Mechanism: operation admission (identity, capabilities, budgets), information-flow labels, durable causal evidence, checkpoints, and a prepare-dispatch-settle protocol that exposes ambiguous effects and prevents blind replay.
- Evidence: 33/33 deterministic tasks, 12/12 real-model runs, 30-run paired Skill study. Explicitly does not prevent prompt injection, provide kernel-grade sandboxing, or undo external effects.
- Credibility: Low-Medium as evidence (small, single author, self-defined oracles). Useful as a design reference.
- Feature: **prepare-dispatch-settle wrapper** for machdoch-controlled effectful tools (see the long-running section).

#### Vendor reports (not peer reviewed)

**Scaling long-running autonomous coding.** Lin, [Cursor blog](https://cursor.com/blog/scaling-agents), Jan 2026. `[VENDOR]`
- Reports: flat swarm with file locks gave 20 agents the throughput of 2 or 3. Optimistic concurrency made agents risk-averse. A dedicated integrator became a bottleneck and was removed. Recursive planners plus workers that do not coordinate, with a judge and fresh iterations, ran hundreds of agents and produced 1M+ lines for a browser over about a week.
- Credibility: Low as evidence. No control, no quality measurement, and outputs not independently assessed. The post says prompts mattered more than harness and models, which is contested by [AHE](https://arxiv.org/abs/2604.25850).

### Inferences
- Default to one agent. A host should treat fan-out as something a task earns through a decomposability check, not as a mode users switch on. STORM, Co-Coder and Scaling Agent Systems all point this way.
- Git worktrees isolate bytes, not compatibility. Treat worktrees as the floor, and add intent declaration, write-time checks, and combined-patch tests.
- Conflict evidence is about two different things. Textual PR conflicts are common (19.8-41.7% in pairs, 27.67% against base). Semantic combination failures were rare in reviewed PR pairs (1 in 834 runs) and near-universal in constructed cases (97%). Real rates in unreviewed concurrent agent work are unknown.
- Hierarchy evidence conflicts. Centralized verification helps (Scaling), a coordinator can beat teams (Worse Together), a named coordinator gives no reliable gain (When Agents Coordinate), and heavy management hurts (MSEval). A reading that fits all four: **verification and allocation at the center help; managerial message passing does not.**

### Gaps
- I found no ICSE or FSE 2026 main-track paper specifically on parallel coding-agent orchestration. A targeted search returned only a turn-control paper and a workshop listing, so the search may have missed some. The field's key evidence on this question is preprint-level.
- No independent replication of any coding-agent coordination system was found.
- Secondary sources attribute an approximately 15x token premium for multi-agent work to Anthropic ([FlowHunt blog](https://www.flowhunt.io/blog/multi-agent-ai-system/)). I could not trace it to a primary source, so do not use it.

## Long-running agents: harnesses, checkpointing, recovery, resumability, compaction, context engineering

### Takeaway
Silent loss of constraints during compaction is the best-replicated finding here and the cheapest to fix. Claims that one compaction method beats another are contested, with the newest study finding none better than default self-summarization on current benchmarks. Crash resume in existing frameworks is demonstrably unsound, and restoring a checkpoint is not the same as safe recovery.

### Cited Findings

#### Peer-reviewed
No main-track peer-reviewed 2026 papers on compaction, checkpointing or long-running harnesses were found. Every entry below is a preprint or vendor write-up.

#### Preprints

**LoopsBench: From Harness Engineering to Loop Engineering in Coding Agent Evaluation.** Li et al. [arXiv:2608.00267](https://arxiv.org/abs/2608.00267), Jul 2026. `[PREPRINT]` (full text partly read)
- Mechanism: 112 long-horizon tasks as dependency DAGs of testable units, with tests released as prerequisites complete and finished nodes kept as regression checks.
- Evidence: 8 languages, 9 domains. Resolve rates: Claude dynamic workflows 24.11%, Codex goal mode 20.59%, Claude Code goal mode 17.65%, **Ralph loop 7.84%**. Regression events per run: 0.36, 0.34, 0.13, 0.17. Best overall, Opus-4.7 with Claude Code and outer continuation, 25.00%.
- Credibility: Medium-High for design. Threats: model-assisted task construction, hidden checkpoint state, proprietary model drift. The abstract says 5,300+ units, while Table 1 says 37,296, and I could not reconcile them. Cost data sits in an appendix I did not read. It tested one Ralph implementation, not machdoch's RALPH flow engine.
- Feature: **run machdoch's goal loop and RALPH flows on LoopsBench or its methodology** before investing further. Add a **DAG progress ledger** that keeps completed units as regression checks, since fresh context alone did not remove regressions.

**Benchmarks Are Surprisingly Compaction-Friendly.** Salle et al. [arXiv:2610.31778](https://arxiv.org/abs/2610.31778), Oct 2026. `[PREPRINT]`
- Mechanism: fixed OpenCode scaffold, five compaction strategies, three frontier models, three long-horizon benchmarks.
- Evidence: threshold had no measurable effect for 1M-context models. No method beat default self-summarization. More aggressive discarding cost some models up to 20 points. The first summary dropped about one third of anticheating rules, worse with each compaction. In real sessions (SWE-chat), how-to-work and do-not instructions were dropped about 6x more than build specifications. n not in abstract.
- Credibility: Medium-High. Independent of any compaction product it would promote, and the newest study here. Its point is also a warning: benchmarks understate losses because progress lives on disk.
- Feature: **do not build a custom summarizer first.** Use provider self-summarization and spend effort on a constraint ledger (next entry).

**Lost in Context Compaction: When LLM Systems Drop Side Constraints.** Wang et al. [arXiv:2608.11242](https://arxiv.org/abs/2608.11242), Jul 2026, v2 Oct 2026. `[PREPRINT]`
- Mechanism: CONPACT evaluation suite; a constraint extractor keeps constraints apart from the summary and appends them after compaction, without modifying compactor or model.
- Evidence: agent deleted emails without approval in 30 of 100 sessions after compaction, versus none before. Compactors retained 17% of injected constraints on average; with the extractor, over 90% across three scenarios.
- Credibility: Medium-High. Independently consistent with Salle et al. The extractor's own evaluation size is not in the abstract.
- Feature: **pinned constraint ledger.** Extract user prohibitions and approval rules from the session into a host-owned file and re-inject after every compaction or new session. This is my top recommendation: cheap, host-side, and provider-agnostic.

**Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon Agents.** Chen et al. [arXiv:2605.08580](https://arxiv.org/abs/2605.08580), May 2026. `[PREPRINT]`
- Mechanism: the compactor runs in parallel while the agent continues on original context. A judge checks the summary against the agent's actual continued reasoning.
- Evidence: up to +8.8 points accuracy and up to 39.7% lower latency on SWE-bench Verified and BrowseComp. n not in abstract.
- Credibility: Medium-Low. "Up to" figures, and in tension with Salle et al.
- Feature: limited for a CLI host, since compaction runs inside the provider CLI. A **post-compaction audit** that compares the summary against the ledger is the feasible subset.

**CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents.** Nguyen et al. [arXiv:2609.26779](https://arxiv.org/abs/2609.26779), Sep 2026. `[PREPRINT]` (full text partly read)
- Mechanism: truncates or drops rather than rewrites; each pass works on original content only, avoiding summaries of summaries. Released as an API proxy that works with Claude Code and Codex.
- Evidence: up to 50% lower cost under bounded context with performance held or better on Terminal-Bench. On Terminal-Bench 2.1 with GLM 5.3 Flash: 76.69% ± 1.41 at $0.16, vs Claude Code auto-compaction 70.97% ± 3.72 at $0.14, vs default 200K 73.03% ± 3.04 at $0.21. Limits: benefit only on medium-to-long tasks, scaffold-dependent, sharp drop at 8K.
- Credibility: Medium. Authors' own method, with error bars but unstated run counts.
- Feature: **evaluate as an optional proxy-layer compaction** for cheap models. This is the rare compaction idea a host can apply without changing the CLI. Benchmark it first against self-summarization.

**Self-Compacting Language Model Agents (SelfCompact).** Li et al. [arXiv:2606.23525](https://arxiv.org/abs/2606.23525), Jun 2026. `[PREPRINT]`
- Mechanism: a compaction tool plus a short rubric on when to compact (sub-task resolved, converging) and when not to (mid-derivation, stuck).
- Evidence: 6 benchmarks, 7 models. Up to +18.1 points on math, +5-9 on agentic search, 30-70% lower cost per question, against a no-summarization baseline. Not coding benchmarks.
- Credibility: Medium-Low for coding, since it has not been tested there.
- Feature: **add the rubric to agent instructions** where a provider CLI has a manual compact command, and trigger compaction at flow-step boundaries rather than on a token threshold.

**AutoCompact: Learning When to Compact Context in Long-Horizon Coding Agents.** Zhang et al. [arXiv:2610.02163](https://arxiv.org/abs/2610.02163), Oct 2026. `[PREPRINT]`
- Mechanism: supervised fine-tuning from judge-corrected trajectories, then joint RL on task success.
- Evidence: +9.2% on SWE-bench Verified, +5.0% on SWE-PolyBench Verified. n not in abstract.
- Credibility: Medium-Low; unreplicated.
- Feature: not buildable by a CLI host, since it needs model training. Its output is a signal that policy timing matters.

**ARC: Addressable Recall Compaction for Long Context-Window Control in AI Agents.** Dang et al. [arXiv:2607.25066](https://arxiv.org/abs/2607.25066), Jul 2026. `[PREPRINT]`
- Mechanism: append-only ID-addressable log of tool observations; compaction replaces older ones with citations the agent can dereference.
- Evidence: 99.40% vs 88.12% on Needle-in-a-Haystack; 29.97% vs 28.25% on LongBench-v2 Hard. Small models with 16-32K context only.
- Credibility: Low-Medium for coding, since it uses non-coding tasks and small models.
- Feature: **MCP recall tool** over machdoch's transcript store, so agents can fetch past tool output by ID after compaction rather than rerun it.

**Memory as Infrastructure: Reliability Engineering for Persistent Agent Memory in Months-Long LLM-Assisted Development.** Helwig. [arXiv:2609.05510](https://arxiv.org/abs/2609.05510), Aug 2026. `[PREPRINT]`
- Mechanism: local hybrid retrieval, precision-gated injection, anti-recurrence stores for decisions and dead-ends, session-start health gate, heartbeat telemetry, alert budgeting.
- Evidence: 633,000-line codebase, 78,933 hook invocations, 85 recorded failures, 84 of them in the first three weeks. N=1, no control arm, self-reported. A pre-registered ablation protocol is published for others.
- Credibility: Low as efficacy evidence, useful as an operations report. The author is upfront about the N=1 limit.
- Feature: **memory health gate at session start** with explicit failure modes. Add a **dead-ends store** to the reasoning bank.

**Prime Agent: A Self-Improving RLM Harness.** Karten et al. [arXiv:2608.23552](https://arxiv.org/abs/2608.23552), Aug 2026. `[PREPRINT]` Technical report.
- Mechanism: persistent REPL, a "continual harness" carrying histories, memories, skills, prompts and subagent specs across trajectories, standardized recovery and resource accounting.
- Evidence: ARC-AGI-3 RHAE Best@1 from 30% to 95.5%. Coding claims are qualitative in the abstract.
- Credibility: Low-Medium. Authors present their own product, with no n in abstract.
- Feature: **daemon-backed sessions view** with inspect and manage, if not already in machdoch.

**Resume Means Resume: A Machine-Checked Conformance Contract for Checkpoint, Interrupt, and Resume Semantics.** Khan. [arXiv:2608.03836](https://arxiv.org/abs/2608.03836), Aug 2026. `[PREPRINT]`
- Mechanism: six properties (prefix continuation, effect exactly-once, fork determinism, checkpoint validity, consume-once, recovery determinism), TLA+ model, LLM-free fault harness across pinned frameworks.
- Evidence: 5 frameworks, 7.4M model states, 196 proof obligations, 39-cell fault matrix. LangGraph 1.2.9 re-executes completed work after SIGKILL; CrewAI 1.15.2 re-executes effect-bearing methods; pydantic-graph 1.x cannot resume after a mid-node crash.
- Credibility: Medium-High. Deterministic and reproducible against pinned versions, though single author and framework claims should be re-checked.
- Feature: **adopt the six properties as a conformance test suite for machdoch's RALPH engine,** with a kill-at-every-step harness.

**Safe to Resume? Breaking Execution Continuity of Agent Execution via Rollback.** Wu et al. [arXiv:2608.29381](https://arxiv.org/abs/2608.29381), Aug 2026. `[PREPRINT]`
- Mechanism: a restored checkpoint can resume a state that never coexisted with its external effects. Failure modes include inconsistent state, stale dependencies, nondeterministic replay, and unrecorded effects.
- Evidence: three end-to-end attacks on Hermes, Cline and LangGraph (malware-check bypass, mail forwarding, double payment); failures recur across five frameworks.
- Credibility: Medium-High as demonstrated attacks; no prevalence estimate.
- Feature: **resume safety check.** On restore, invalidate approvals and verification results, re-verify the working tree against the checkpoint, and mark effects since the checkpoint as unknown.

**Beyond Single-Use Tokens: Durable Authorization State for Replay-Resistant LLM Agent Actions (CapLease).** Xu et al. [arXiv:2608.01710](https://arxiv.org/abs/2608.01710), Aug 2026. `[PREPRINT]`
- Mechanism: binds a user confirmation to a canonical action with Issue-Prepare-Commit transitions, so replanning or crash recovery cannot re-spend an approval. Exactly-once external effects still need an idempotent sink.
- Evidence: no numbers in abstract. A search snippet of the paper body cites equivalent reproposals in 39.8% of 10,152 trajectories; I did not confirm it in the body.
- Credibility: Low-Medium as evidence, sound as design.
- Feature: **approvals keyed to canonical action and consumed once,** surviving restart. Applies to machdoch permission prompts.

#### Vendor reports (not peer reviewed)

**Effective harnesses for long-running agents.** Young, [Anthropic Engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), Nov 2025. `[VENDOR]`
- Reports: an initializer session creates `init.sh`, a progress log, an initial commit, and a JSON feature list, all initially failing. Each later session works on one feature, tests end-to-end, commits, and updates progress, after first checking the state and running a smoke test.
- Credibility: Low as evidence, with no quantitative results. Widely copied, and mechanisms are cheap to try.
- Feature: **session-start ritual** in the goal loop: read the log, read the feature list, smoke test, then work.

### Inferences
- A consistent signal across Lost in Context Compaction and Benchmarks Are Compaction-Friendly: what is lost is behavioral instructions and constraints, not task specifications. This is well-suited to a host, which can store constraints outside the conversation.
- LoopsBench's low Ralph score is a real warning, but not a verdict. It measures one implementation at a fixed contract, and cost per resolve was not extracted. Fresh context did not prevent regressions, so explicit state tracking is what needs building.
- Recovery should be treated as a verification event, not a continuation. "Resume Means Resume" and "Safe to Resume?" both show that frameworks restore bytes without restoring validity.

### Gaps
- I found no controlled head-to-head of fresh-context restart versus compaction on cost per resolved task, apart from LoopsBench, whose cost appendix I did not read.
- A search snippet attributed to CliffCompaction says every compaction strategy increases steps per trajectory, mostly through re-reads. The portion of the paper I read did not show this, so treat it as unverified.
- A search snippet said some compactors do worse than no compaction in Lost in Context Compaction. The abstract does not state this.

## Agent memory and learning: procedural memory, replay, skills, self-improving agents, evolving prompts and harnesses

### Takeaway
Memory and skill learning work when writes are gated by real execution and regressions are tested. Without those gates, memory can be neutral or harmful: agents copy what they retrieve, and models are weak at writing skills for themselves. Harness evolution has strong reported gains, but those come mainly from authors' own benchmarks with expensive outer loops.

### Cited Findings

#### Peer-reviewed

**How Memory Management Impacts LLM Agents: An Empirical Study of Experience-Following Behavior.** Xiong et al. [ACL 2026 Long, pp. 623-645](https://aclanthology.org/2026.acl-long.27/). `[PEER: main]`
- Mechanism: studies add and delete memory operations. Agents output something very similar to a retrieved memory when the task resembles it. This causes error propagation and misaligned replay, where memories that look correct still mislead. Later task evaluations can act as free quality labels.
- Evidence: n not in abstract.
- Credibility: High for venue. It directly describes the failure mode of a reasoning bank.
- Feature: **outcome-labeled lessons.** Score each lesson by the outcomes of later tasks that retrieved it, and demote or delete those correlated with failure.

**ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory.** Ouyang et al. [arXiv:2509.25140](https://arxiv.org/abs/2509.25140), Sep 2025, v2 Mar 2026. `[ACCEPTED]` ICLR 2026 per arXiv.
- Mechanism: distills strategies from both self-judged successes and failures; MaTTS spends extra compute per task to gain contrastive evidence.
- Evidence: beats raw trajectory and success-only memory on web and SE benchmarks; no numbers in abstract.
- Credibility: Medium-High. Relies on self-judged labels, which the ACL paper above suggests are risky.
- Feature: **replace self-judgment with verifier outcomes** as the label, and store failure lessons too. For hard tasks, run k attempts and extract lessons from the difference between them.

**Agentic Context Engineering (ACE).** Zhang et al. [arXiv:2510.04618](https://arxiv.org/abs/2510.04618), Oct 2025, v3 Mar 2026. `[ACCEPTED]` ICLR 2026 per arXiv.
- Mechanism: an evolving playbook via generation, reflection and curation, with itemized incremental updates to avoid brevity bias and context collapse.
- Evidence: +10.6% on agent benchmarks, +8.6% on finance. Not coding. n not in abstract.
- Credibility: Medium-High. Later used as a baseline, and beaten by [Meta-Harness](https://arxiv.org/abs/2603.28052) and reportedly [AHE](https://arxiv.org/abs/2604.25850).
- Feature: **itemized, ID-addressable lessons with merge operations** rather than rewriting a memory document.

**GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning.** Agrawal et al. [arXiv:2507.19457](https://arxiv.org/abs/2507.19457), Jul 2025, v2 Feb 2026. `[ACCEPTED]` ICLR 2026 Oral per arXiv.
- Mechanism: samples trajectories, reflects in natural language, proposes and tests prompt changes, and merges lessons from a Pareto frontier.
- Evidence: beats GRPO by 6% average and up to 20% across six tasks, with up to 35x fewer rollouts; beats MIPROv2 by over 10%. Search-level note: the GEPA+Merge variant had mixed results on one model.
- Credibility: High for prompt optimization. Not specific to coding harnesses.
- Feature: **offline prompt tuner for machdoch's own flow and step prompts,** using recorded runs and a Pareto of success vs tokens. Open source at [gepa-ai/gepa](https://github.com/gepa-ai/gepa) per the abstract; license and fit not checked.

**Darwin Gödel Machine.** Zhang et al. [arXiv:2505.22954](https://arxiv.org/abs/2505.22954), May 2025, v3 Mar 2026; [ICLR 2026 poster](https://iclr.cc/virtual/2026/poster/10007327). `[PEER: main]` Included because the brief named it.
- Mechanism: archive of agent variants, each self-modified and tested empirically.
- Evidence: SWE-bench 20.0% to 50.0%, Polyglot 14.2% to 30.7%.
- Credibility: Medium-High, but low baselines exaggerate improvements and outer-loop cost is high.
- Feature: **archive, not a single best,** for evolved harness configs.

**Huxley-Gödel Machine.** Wang et al. [arXiv:2510.21614](https://arxiv.org/abs/2510.21614), Oct 2025; [ICLR 2026 proceedings](https://proceedings.iclr.cc/paper_files/paper/2026/hash/821d20219c2f14850af1b5220f0ed13f-Abstract-Conference.html). `[PEER: main]`
- Mechanism: picks which variant to modify based on descendants' results rather than its own score.
- Evidence: beats prior self-improving methods with fewer CPU hours on SWE-bench Verified and Polyglot. No numbers in abstract.
- Credibility: Medium-High; "human-level" claim is narrow, defined against particular benchmark results.
- Feature: **expand config variants by lineage productivity** if machdoch ever runs an archive search.

**Memp: Exploring Agent Procedural Memory.** Fang et al. [arXiv:2508.06433](https://arxiv.org/abs/2508.06433), Aug 2025, v4 Apr 2026. `[ACCEPTED]` ACL 2026 Findings per arXiv.
- Mechanism: procedural memory as step instructions plus script-like abstractions, with build, retrieve, update and deprecate strategies. Memory from a stronger model can help a weaker one.
- Evidence: TravelPlanner, ALFWorld; no numbers in abstract.
- Credibility: Medium; non-coding.
- Feature: **strong-to-cheap memory transfer.** Lessons distilled from expensive runs are given to cheap-model runs, tying the memory system to the router.

#### Preprints: skills and memory

**SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks.** Li et al. [arXiv:2602.12670](https://arxiv.org/abs/2602.12670), Feb 2026, v4 Jun 2026. `[PREPRINT]`
- Mechanism: paired no-skill vs curated-skill runs with deterministic verifiers.
- Evidence (v4): 87 tasks, 8 domains, 18 configurations. Pass rate rose from 33.9% to 50.5%. Focused skills with at most three modules beat large bundles. Smaller models with skills can match larger ones without. [v1](https://arxiv.org/abs/2602.12670v1): 86 tasks, 11 domains, 7,308 trajectories; only +4.5 points in Software Engineering; 16 of 84 tasks negative; **self-generated skills gave no average benefit.** The v4 abstract no longer states that last result.
- Credibility: High relative to the field. I did not check why the self-generated claim left the v4 abstract, so cite it as v1.
- Feature: **cap skill size,** treat auto-generated skills as untrusted until verified, and expect modest coding gains.

**CODESKILL: Learning Self-Evolving Skills for Coding Agents.** Li et al. [arXiv:2605.25430](https://arxiv.org/abs/2605.25430), May 2026, v2 Sep 2026. `[PREPRINT]`
- Mechanism: an RL-trained manager extracts, updates and prunes multi-granularity skills, with rubric and execution rewards.
- Evidence: +11.03 pass rate over no-skill, +5.10 over the best prompt or memory baseline on EnvBench, SWE-Bench Verified, Terminal-Bench 2. n not in abstract.
- Credibility: Medium; contradicts SkillsBench v1's self-generated finding, but with a trained curator.
- Feature: copy the **skill-bank operations** (extract, merge, prune) without the RL training.

**SkillGLoW: Procedural-Family Skill Consolidation.** Yan et al. [arXiv:2609.02217](https://arxiv.org/abs/2609.02217), Sep 2026. `[PREPRINT]`
- Mechanism: clusters per-task skills into procedural families, compresses into de-instantiated priors, regenerates instance detail per task, and **commits a prior only if real execution shows no degradation.**
- Evidence: 4 benchmarks, 3 models. +17.2 points on hard tasks vs no skills, positive in all 12 runs, 3.6x more compact than a per-task pool. Unseen ALFWorld 73.9% to 83.9%.
- Credibility: Medium; all 12 positive is encouraging, unreplicated.
- Feature: **commit gate for the reasoning bank.** A new consolidated lesson goes live only after a replay on recorded tasks shows no regression. Consolidate per-task lessons into families on a schedule.

**SkillOS: Learning Skill Curation for Self-Evolving Agents.** Ouyang et al. [arXiv:2605.06614](https://arxiv.org/abs/2605.06614), May 2026. `[PREPRINT]`
- Mechanism: frozen executor plus trainable curator, using grouped task streams where earlier tasks update and later related tasks evaluate.
- Evidence: no numbers in abstract.
- Credibility: Low-Medium at abstract level.
- Feature: **evaluate lessons on later related tasks,** the same principle as the ACL finding.

**MemDelta: Controlled Baselines and Hidden Confounds in Agent Memory Evaluation.** Wang. [arXiv:2606.29914](https://arxiv.org/abs/2606.29914), Jun 2026. `[PREPRINT]`
- Mechanism: changes one component at a time on LongMemEval-S, 500 questions, three model families.
- Evidence: agent self-memory 42% vs basic retrieval 47%. Swapping only the embedding model moved accuracy +6.2 points (p = 0.004), enough to flip Mem0 vs RAG conclusions. Mem0 matched cloud RAG on 2 of 6 question types at 50x cost.
- Credibility: Medium-High for method; conversational memory, not coding.
- Feature: **fix the embedding model and test retrieval changes against a baseline** before claiming memory improvements. Start with plain retrieval.

**MemTrapBench: Benchmarking Cognitive Traps in LLM Memory Use.** Wang et al. [arXiv:2608.20202](https://arxiv.org/abs/2608.20202), Aug 2026. `[PREPRINT]` "Work in progress".
- Mechanism: tests reasoning fixation and belief distortion from accurate, relevant memories.
- Evidence: all five frameworks, on two model families, under the no-memory setting, with the strongest dropping over 10%. Adversarial by design, per secondary sources, so not a general utility estimate.
- Credibility: Medium; a stress test.
- Feature: **frame injected lessons as hypotheses to check,** and include a "does this lesson apply here?" step.

**Guardrails Beat Guidance: A Large-Scale Study of Rules, Skills, and Persistent Configuration.** Zhang et al. [arXiv:2604.11088](https://arxiv.org/abs/2604.11088), Apr 2026. `[PREPRINT]`
- Mechanism: 679 scraped rule files, 25,532 rules, 5,000+ Claude Code runs on Opus 4.6.
- Evidence: random and curated rules each gave +13.8 points on a discriminative SWE-bench Verified subset, suggesting content-independent priming. Pass rates stable from 0 to 50 rules. Prohibitions outperform directives.
- Credibility: Medium. One model, and a "discriminative subset" can inflate effects. Surprising result; needs replication.
- Feature: **write machdoch-injected rules as prohibitions,** and A/B test any injected content against a random-content control.

**Evaluating AGENTS.md.** Gloaguen et al. [arXiv:2602.11988](https://arxiv.org/abs/2602.11988), Feb 2026, v3 Sep 2026. `[PREPRINT]`
- Mechanism: SWE-bench with generated context files, and real issues from repos with developer-written files.
- Evidence: no general improvement in success, inference cost up over 20%. Agents follow instructions, but repo overviews do not help. Search summaries add that generated files are mildly negative; I did not confirm this in the paper. n not in abstract.
- Credibility: Medium-High; authors at ETH per [SRI Lab](https://www.sri.inf.ethz.ch/publications/gloaguen2026agentsmd), and consistent with the next two entries.
- Feature: **do not auto-generate repository overview files** in setup; inject only constraints and commands.

**Do Context Files Help Coding Agents? A Two-Agent Ablation Study.** Khatri. [arXiv:2607.27250](https://arxiv.org/abs/2607.27250), Jul 2026. `[PREPRINT]`
- Evidence: 288 runs, 17 tasks, 3 repos, Claude Code and Codex. No measurable correctness change, bounded to about 10-15 points. Failures came from implementation skill, not missing repository knowledge.
- Credibility: Medium; a small sample with a wide bound. It cannot rule out small effects.
- Feature: reinforces the same choice as above.

**Instruction Adherence in Coding Agent Configuration Files: A Factorial Study.** McMillan. [arXiv:2605.10039](https://arxiv.org/abs/2605.10039), May 2026. `[PREPRINT]`
- Evidence: 1,650 Claude Code sessions, 16,050 observations. File size, position, architecture and contradictions showed no detectable effect. Compliance fell about 5.6% in odds per generated function (OR = 0.944); replicated, but post hoc and non-monotonic.
- Credibility: Medium-High for careful statistics. Trivial target instruction.
- Feature: **re-inject key rules periodically** during long sessions, instead of tuning file layout.

#### Preprints: harness evolution

**Meta-Harness: End-to-End Optimization of Model Harnesses.** Lee et al. [arXiv:2603.28052](https://arxiv.org/abs/2603.28052), Mar 2026. `[PREPRINT]`
- Mechanism: an agentic proposer reads code, scores and full traces of prior candidates through a filesystem.
- Evidence: +7.7 points with 4x fewer context tokens vs a state-of-the-art context system on classification; +4.7 points on 200 IMO problems across five held-out models; beats hand-built baselines on TerminalBench-2 (no number).
- Credibility: Medium-High, given held-out models and authors with a record in this area.
- Feature: **give the optimizer raw traces, not summaries.** machdoch's stored transcripts are a natural corpus.

**Agentic Harness Engineering (AHE).** Lin et al. [arXiv:2604.25850](https://arxiv.org/abs/2604.25850), Apr 2026. `[PREPRINT]`
- Mechanism: file-level editable components, layered evidence from trajectories, and each edit paired with a prediction checked in the next round.
- Evidence: Terminal-Bench 2 from 69.7% to 77.0% in ten iterations (Codex-CLI at 71.9%). SWE-bench-Verified with 12% fewer tokens than seed. Ablations credit tools, middleware and memory, **not the system prompt.**
- Credibility: Medium. The tuning and test relationship should be checked in the full paper.
- Feature: **edit-with-prediction changelog.** Every automated harness change records its predicted effect, later checked. Tune tools and middleware before prompts.

**Self-Harness: Harnesses That Improve Themselves.** Zhang et al. [arXiv:2606.09498](https://arxiv.org/abs/2606.09498), Jun 2026, v3 Aug 2026. `[PREPRINT]`
- Mechanism: mine weaknesses from traces, propose minimal edits, accept only after regression tests.
- Evidence: nine model-benchmark combinations all improved on held-in and held-out sets; up to 132% relative gain, from a minimal starting harness, which flatters relative gains.
- Credibility: Medium.
- Feature: **per-model weakness mining.** A nightly analysis produces minimal proposed changes for human review, per provider and model.

**Group-Evolving Agents.** Weng et al. [arXiv:2602.04837](https://arxiv.org/abs/2602.04837), Feb 2026. `[PREPRINT]` on arXiv; search results list ICLR and NeurIPS 2026 pages I did not open.
- Evidence: 71.0% vs 56.7% on SWE-bench Verified and 88.3% vs 68.3% on Polyglot; about 1.4 vs 5 iterations for framework bugs.
- Credibility: Medium; its comparison with human-designed agents needs full-text checking.
- Feature: **share lessons across parallel agents** in a group, with a quality filter.

**Mendel Gödel Machine.** Liu et al. [arXiv:2608.07645](https://arxiv.org/abs/2608.07645), Aug 2026. `[PREPRINT]` Compares trajectories across tasks and lineages rather than one failure at a time; no numbers in abstract. Credibility: Low-Medium at abstract level. Feature: **generate proposals from comparative evidence,** such as two provider runs on one task.

**Hierarchical Self-Improvement.** Zhou. [arXiv:2608.08466](https://arxiv.org/abs/2608.08466), Aug 2026. `[PREPRINT]` Frozen model with per-family harnesses, evolver and meta-evolver. Game-environment gains of +15 to +39.3, but **no improvement on NLE, where tasks exceed model capability.** Credibility: Low-Medium; not coding. Feature: **per-task-family configuration,** and stop evolving where capability is the constraint.

**Self-Evolving Coding Agents.** Zhou et al. [arXiv:2608.03392](https://arxiv.org/abs/2608.03392), Aug 2026, v4 Sep 2026. `[PREPRINT]` Survey; flags feedback reliability, benchmark overfitting, reversibility and cost. Useful as a map, not as evidence.

### Inferences
- A pattern for a safe reasoning bank: label by verifier outcome (ACL 2026), itemize (ACE), consolidate into families (SkillGLoW), gate by replay (SkillGLoW, Self-Harness), demote using later outcomes (ACL 2026, SkillOS), and keep lessons small (SkillsBench). Curators that win against no-memory baselines all include some form of execution feedback.
- Harness evolution works only with reliable reward signals, and a host's expensive runs are limited. A full DGM-style archive looks unjustified at machdoch's scale. The feasible version is offline: trace mining, small proposals, regression replay, human approval.

### Gaps
- I did not read the full text for most entries, so per-task variance and outer-loop costs are unknown. Evolution-loop cost is the main missing number.
- No study found measures a learned lessons store in a real multi-week coding deployment with a control arm. Memory as Infrastructure comes closest, with N=1 and no control.
- A JAWs 2026 paper reporting a 28.64% faster median completion with AGENTS.md appeared only in secondary summaries, so it is not verified. It concerns speed, not success, and should be checked before use.

## Cost and model routing: cheap vs expensive models, budget-aware planning, early stopping, token efficiency

### Takeaway
The best-supported savings are simple: turn limits at about the 75th percentile, and preparatory handoffs that let cheaper models perform. Sophisticated routers show large numbers with weaker evidence. Early stopping is actively disputed, and the largest study finds that attempt-level prediction is near chance and continuing beats restarting.

### Cited Findings

#### Peer-reviewed

**More with Less: An Empirical Study of Turn-Control Strategies for Efficient Coding Agents.** Gao, Peng. [ICSE 2026 Research Track](https://conf.researchr.org/details/icse-2026/icse-2026-research-track/208/More-with-Less-An-Empirical-Study-of-Turn-Control-Strategies-for-Efficient-Coding-Ag). `[PEER: main]`
- Mechanism: on SWE-bench with Claude 4 Sonnet, Gemini 2.5 Pro and GPT 4.1, compares unrestricted runs, fixed limits with reminders, and dynamic extra turns on demand.
- Evidence: a limit at the baseline's 75th percentile cuts cost 24-68% with minimal solve-rate impact; dynamic turns cut another 12-24%. Task and run counts not on the page.
- Credibility: High for venue and simplicity. Models are older, and SWE-bench tasks are shorter than multi-session work.
- Feature: **percentile-based turn budgets in the adaptive controller,** learned per provider and task class from machdoch's own history, with a reminder near the limit and on-demand extension.

**AgentRouter: Heterogeneous Model Routing for Cost-Optimal Multi-Step Agentic Workflows.** Paul, Nandy. [arXiv:2609.22951](https://arxiv.org/abs/2609.22951), Sep 2026. `[PEER: workshop]` AgenticUQ Workshop, ICML 2026, per arXiv.
- Mechanism: a 12M-parameter classifier routes each step to one of four tiers using five features.
- Evidence: trained on 50,000 annotated steps. 72% cost reduction at 97.3% of frontier quality, under 3% task-completion loss, vs 31% for RouteLLM and 44% for FrugalGPT.
- Credibility: Low-Medium. Workshop paper, unnamed "enterprise" waste premise, and I did not establish how end-to-end quality was measured.
- Feature: per-step switching is mostly unavailable to a host running a CLI, except where a CLI allows model change mid-session. Use it per flow step instead.

#### Preprints

**Scrouting: Cost-Aware Routing of Coding Agents by Scouting the Repository First.** Bhola, Krishnan, NS. [arXiv:2608.04804](https://arxiv.org/abs/2608.04804), Aug 2026. `[PREPRINT]`
- Mechanism: a 7B searcher explores, produces a structured handoff with sandbox-verified reproduction claims (false claims removed), then routes to one of four fixers.
- Evidence: 266 SWE-bench Pro Python tasks. Solved 159 vs best single model's 158, at about one-fifth the cost per solve. **Always using the cheapest fixer with the handoff tied the router,** so the handoff drives the result. The calibration study (N=99) is directional: lifts three cheaper fixers, slightly hurts the strongest.
- Credibility: Medium-High for honest ablation, reasonable n. The authors built the searcher, so an independent run is needed.
- Feature: **cheap scout stage.** Run a low-cost model on read-only exploration with verified reproduction before the main agent. Try "scout + cheap fixer" before building a router.

**SeqRoute: Global Budget-Aware Sequential LLM Routing via Offline Reinforcement Learning.** Xu, Zheng, Wang. [arXiv:2605.25424](https://arxiv.org/abs/2605.25424), May 2026. `[PREPRINT]`
- Mechanism: routing as an MDP with remaining budget in state; replays history under hypothetical budgets.
- Evidence: 10,000 sessions becoming 2.38M transitions; 6.0-73.5% cost reduction; bankruptcy under 1%. Not coding-specific.
- Credibility: Medium-Low; offline, wide range.
- Feature: **budget relabeling for controller tuning.** Replay stored runs under hypothetical budgets to tune the adaptive controller offline, without RL.

**Continue or Restart? The Limits of Early Failure Prediction in Coding Agents.** Srinivasan et al. [arXiv:2610.35971](https://arxiv.org/abs/2610.35971), Oct 2026. `[PREPRINT]`
- Mechanism: compares issue context and early prefixes, and replays learned vs matched-random restarts under shared token budgets.
- Evidence: 147,002 traces, four settings. Within-task AUC about 0.50, including 32,406 attempts with a neural monitor (0.50 [0.48, 0.51]). Learned restarting beats random by at most 1.98 points, with attempt-level selection contributing -0.11 to +0.24. **Continuation had higher solve rates at lower token cost in all four settings at a 75k cap, and in 216 of 224 budget-threshold configurations.**
- Credibility: High relative to the field: largest sample, proper counterfactual, and a null result.
- Feature: **do not ship learned "kill and restart" in the goal loop** by default. Any stop policy must beat continuation in replay on machdoch's own traces first.

**StopLoss: Teaching Agents to Predict Failure and Stop Early.** Liang et al. [arXiv:2610.25525](https://arxiv.org/abs/2610.25525), Oct 2026. `[PREPRINT]`
- Mechanism: a small external monitor learns from verifier outcomes and aborts at a threshold calibrated on successful runs.
- Evidence: cost per retained solve down 4.5% on SWE-bench Verified with 99% of successes preserved; up to 31% on a costlier Pro subset (48% with a Qwen3-8B backbone). n not in abstract.
- Credibility: Medium. Note the modest 4.5% on the standard benchmark. Measures stop, not restart, which partly explains the difference from the entry above.
- Feature: **offline trial on expensive runs only.** Savings grow with cost per attempt.

**Automata from Agent Traces: Failure and Next-Step Prediction.** Cho et al. [arXiv:2608.23670](https://arxiv.org/abs/2608.23670), Aug 2026. `[PREPRINT]`
- Mechanism: merges traces into a 7-43 state FSM in milliseconds; per-state features score partial traces. Topology is shaped more by harness than model.
- Evidence: 12 public datasets; replay fitness at least 0.997; held-out AUROC up to 0.94. Search snippet for SWE-agent: trigger at 32% trace completion, 85.9% precision, 95.5% recall; not verified in the body.
- Credibility: Medium. AUROC likely benefits from between-task signal, which the Continue or Restart decomposition warns about. This is my inference, not tested.
- Feature: **cheap, inspectable run-state FSM** for stuck and loop detection and UI display, with no model calls. Use for alerts before it is used for aborts.

**Doomed from the Start: Early Abort via a Recall-Controlled Probe Cascade.** Ruan et al. [arXiv:2607.06503](https://arxiv.org/abs/2607.06503), Jul 2026. `[PREPRINT]`
- Mechanism: linear probes on hidden activations with calibrated gates and a recall guarantee.
- Evidence: 24 configurations on TextCraft and WebShop; 60.2% and 54.9% token cuts at 90% recall.
- Credibility: Medium for method; small models and non-coding. Hidden-state access is unavailable to a CLI host.
- Feature: not buildable directly. Borrow the **explicit recall target** for any stop policy.

**Testing-Driven Reliability Audit of Trajectory-Based Early Outcome Prediction.** Cao. [arXiv:2609.25647](https://arxiv.org/abs/2609.25647), Sep 2026. `[PREPRINT]`
- Evidence: broad calibration heterogeneity not supported, but persistent transfer errors for specific agent and target pairs (0.1377, 0.1107); did not replicate on TerminalBench. Pre-registered criteria.
- Credibility: Medium. Single author, careful method.
- Feature: **calibrate monitors per provider and model;** do not transfer thresholds.

**The Devil Is in the Interface: How Tool Architecture Shapes Coding Agent Behavior.** Xu et al. [arXiv:2608.11386](https://arxiv.org/abs/2608.11386), Aug 2026. `[PREPRINT]`
- Evidence: 11,700 trajectories, six architectures. Python CodeAct-style tools matched performance with 41.6% fewer steps and 56.3% fewer tokens. Structured low-level tools raised consistency up to 4.7x vs bash-only. Natural-language search gave 11%+ more relevant-file access. Note-taking tools had limited effect.
- Credibility: High relative to the field for scale. Cost savings depend on the agents tested.
- Feature: **test an MCP tool bundle.** Offer code-execution and semantic search tools; do not invest in "scratchpad" tools.

**Tokenomics: Quantifying Where Tokens Are Used in Agentic Software Engineering.** Salim et al. [arXiv:2601.14470](https://arxiv.org/abs/2601.14470), Jan 2026. `[PREPRINT]` The paper's template mentions MSR '26 per search results; the arXiv page lists no venue, so acceptance is unconfirmed.
- Evidence: 30 tasks, ChatDev, GPT-5. Code Review averages 59.4% of tokens; input is 53.9%.
- Credibility: Low-Medium. One framework, small n, self-described as preliminary.
- Feature: **per-stage token attribution** in flow runs, so budget tuning targets review loops first.

**Cost-Utility Alignment in LLM Agent Trajectories.** Liu, Li. [arXiv:2608.26195](https://arxiv.org/abs/2608.26195), Aug 2026. `[PREPRINT]` Conceptual review, no empirical results. Five misalignment types and an evidence hierarchy from proxies to counterfactual replay. Feature: **label each controller decision with an evidence level.**

**Engineering Reliable Coding Agents.** Jarmak. [arXiv:2608.13867](https://arxiv.org/abs/2608.13867), Aug 2026. `[PREPRINT]` 314-page structured review of 164 scholarly and 100 practitioner sources. A search snippet of its text treats general cheapest-sufficient routing as a decision to test rather than an established cost reduction; I did not open the body. Useful catalog, 206 records.

### Inferences
- Before building a router, build a scout. Scrouting's ablation says the handoff carried the benefit, and the ICSE turn-control paper shows large savings with no model selection at all.
- Stop and restart are different decisions. Continue or Restart undermines restarting and within-task discrimination. StopLoss reports modest savings from stopping, mostly on expensive tasks. A host should start with no automatic restart, and use hard budget stops with a recall target.
- Per-step routing mostly does not fit a CLI host. Per-flow-step or per-session routing is the feasible granularity.

### Gaps
- No independent, controlled evidence was found that model routing reduces cost per resolved task in real coding-agent deployments. Vendor guides claiming 40-60% savings ([Augment](https://www.augmentcode.com/guides/ai-model-routing-guide)) were seen only as search results and are not peer reviewed.
- Budget-aware routing by boundary-guided training is cited with two different arXiv IDs (2512.21227 and 2602.21227) in secondary lists. I did not verify it, so it is excluded. ACRouter was also not verified.

## Negative or contested findings

### Takeaway
Negative results are now common and often come from the larger, better-controlled studies (CooperBench, Continue or Restart, Compaction-Friendly). Positive claims mostly come from authors testing their own systems. Some negatives share that bias: STORM and Co-Coder report baselines losing to the system they propose, so their baseline figures deserve the same caution.

### Cited Findings

Each item links to the primary paper; details are in the sections above.

**Mostly negative**
- Two coding agents together are about 30% less successful than alone — [CooperBench](https://arxiv.org/abs/2601.13295).
- Git-worktree multi-agent scored below single-agent on Commit0 across three models, and single-agent had the best cost efficiency everywhere — [STORM](https://arxiv.org/abs/2605.20563).
- Claude Code Agent Teams was faster but below sequential in quality, and file-based parallel raised cost 44-60% — [Co-Coder](https://arxiv.org/abs/2606.00953).
- The highest reliability gain came with 96.7% serialization and no useful speedup; dynamic fail-closed blocking lowered success to 22.2% — [Claim Plane](https://arxiv.org/abs/2608.00947).
- Multi-agent ranged down to -70.0% on sequential planning — [Scaling Agent Systems](https://arxiv.org/abs/2512.08296).
- Teams did worse than a single coordinator in all four environments — [Worse Together](https://arxiv.org/abs/2610.00583).
- A named coordinator gave no reliable gain, and agents sought hidden grading files in about 80% of replication runs — [When Agents Coordinate](https://arxiv.org/abs/2608.16801).
- Ralph loop lowest of four profiles at 7.84%, and fresh context did not remove regressions — [LoopsBench](https://arxiv.org/abs/2608.00267).
- No compaction method beat default self-summarization — [Compaction-Friendly](https://arxiv.org/abs/2610.31778).
- Compactors kept 17% of side constraints — [Lost in Context Compaction](https://arxiv.org/abs/2608.11242).
- Learned restart prediction near chance; continuation beat restarting in 216 of 224 configurations — [Continue or Restart](https://arxiv.org/abs/2610.35971).
- Context files gave no general success gain and raised cost over 20% — [Gloaguen et al.](https://arxiv.org/abs/2602.11988); no measurable correctness effect in 288 runs — [Khatri](https://arxiv.org/abs/2607.27250); no file-structure effect in 1,650 sessions — [McMillan](https://arxiv.org/abs/2605.10039).
- Self-generated skills gave no average benefit — [SkillsBench v1](https://arxiv.org/abs/2602.12670v1). Self-memory scored 42% vs 47% for retrieval — [MemDelta](https://arxiv.org/abs/2606.29914). All memory frameworks fell below no-memory on trap tasks — [MemTrapBench](https://arxiv.org/abs/2608.20202). Replay can propagate errors — [ACL 2026](https://aclanthology.org/2026.acl-long.27/).
- Harness evolution gave no gain beyond the model's capability on NLE — [Hierarchical Self-Improvement](https://arxiv.org/abs/2608.08466).
- Checkpoint and resume frameworks re-execute effects or fail on resume — [Resume Means Resume](https://arxiv.org/abs/2608.03836); restored states can enable attacks — [Safe to Resume?](https://arxiv.org/abs/2608.29381).

**Directly contested pairs**
| Question | One side | Other side | How I would resolve it |
|---|---|---|---|
| How often do parallel patches fail together? | 97% on constructed tasks, 30% drop in [CooperBench](https://arxiv.org/abs/2601.13295) | 1 interference in 834 mined runs, [Passes Alone](https://arxiv.org/abs/2609.25396) | Selection: reviewed PRs are already compatible. Measure on machdoch's own runs. |
| Does central management help? | Centralized verification limits errors, [Scaling](https://arxiv.org/abs/2512.08296); coordinator beats teams, [Worse Together](https://arxiv.org/abs/2610.00583) | Heavy oversight hurts, [MSEval](https://arxiv.org/abs/2607.27877); coordinator label gives nothing, [When Agents Coordinate](https://arxiv.org/abs/2608.16801); integrator bottleneck, [Cursor](https://cursor.com/blog/scaling-agents) (vendor) | Verification and allocation yes, relay management no. |
| Does a compaction method matter? | [Slipstream](https://arxiv.org/abs/2605.08580), [AutoCompact](https://arxiv.org/abs/2610.02163), [CliffCompaction](https://arxiv.org/abs/2609.26779) | [Compaction-Friendly](https://arxiv.org/abs/2610.31778): none beat default | Mostly self-reported vs neutral. Differences may emerge at small context and on constraints. |
| Can early failure be predicted? | [StopLoss](https://arxiv.org/abs/2610.25525), [Automata](https://arxiv.org/abs/2608.23670) AUROC up to 0.94 | [Continue or Restart](https://arxiv.org/abs/2610.35971): within-task AUC 0.50 | Different targets and metrics. Within-task, counterfactual replay is the right test for a restart decision. |
| Do rules and context files help? | +13.8 from rules, including random ones, [Guardrails](https://arxiv.org/abs/2604.11088); curated skills +16.6, [SkillsBench](https://arxiv.org/abs/2602.12670) | No gain and higher cost, [Gloaguen](https://arxiv.org/abs/2602.11988); [Khatri](https://arxiv.org/abs/2607.27250) | Possibly a task-difficulty effect, as Khatri suggests with agent-specific borderline tasks. Software-engineering skill gains were the smallest in SkillsBench v1 (+4.5). Unresolved. |
| Can agents write useful skills themselves? | No average benefit, [SkillsBench v1](https://arxiv.org/abs/2602.12670v1) | +11.03, [CODESKILL](https://arxiv.org/abs/2605.25430); +17.2, [SkillGLoW](https://arxiv.org/abs/2609.02217) | Unaided, no. With a curator and execution gate, reportedly yes. |
| Prompts or machinery? | Prompts mattered most, [Cursor](https://cursor.com/blog/scaling-agents) (vendor); prompt optimization gains, [GEPA](https://arxiv.org/abs/2507.19457) | Gains from tools, middleware and memory rather than prompt, [AHE](https://arxiv.org/abs/2604.25850) | Unresolved. Depends on the baseline harness's maturity. |

### Inferences

**Ranked build list for machdoch (my judgment: evidence strength, then host feasibility, then cost)**
1. **Pinned constraint ledger, re-injected after compaction and new sessions.** Two independent studies; host-side; no model calls needed beyond extraction.
2. **Verifier isolation and combined-patch test gate.** Keep oracles outside agent-readable trees, and test merges separately from solo patches.
3. **Percentile turn budgets with on-demand extension in the adaptive controller.** ICSE main track; simple.
4. **Parallelizability gate, plus default-serial intent ledger.** Fan-out must be earned; overlaps serialize. Report actual parallelism.
5. **Reasoning bank upgrade.** Verifier-outcome labels, itemized entries, dead-end records, replay commit gate, demotion from later outcomes, and a size cap.
6. **Crash-conformance suite and resume safety check for RALPH.** Six contract properties, kill-at-every-step testing, invalidated approvals on restore.
7. **Cheap scout stage with verified reproduction.** Try before any learned router.
8. **Local LLM proxy** with retry first, then budgets and backpressure. Also the hosting point for optional proxy-side compaction.
9. **Benchmark machdoch's goal loop and RALPH flows on LoopsBench-style DAG tasks,** and use CooperBench pairs for parallel mode, before further tuning.
10. **Offline harness tuner.** Trace mining, minimal proposals, prediction changelog, regression replay, human approval. Later and optional.

**What not to build yet, on current evidence:** learned kill-and-restart, generated repository overview files, custom compaction summarizers, per-step learned routers, an agent-to-agent chat layer as a coordination mechanism, and a DGM-style self-modifying archive.

- Evidence hierarchy for any machdoch self-evaluation: the field's most useful results came from paired designs, frozen inputs, and counterfactual replay under shared budgets. machdoch's stored runs could support all three, so its controller and memory changes could be A/B tested against its own data.

### Gaps
- Peer-reviewed evidence is thin. Of the entries here, only the ICSE 2026, ACL 2026 (main and Findings), ICLR 2026 and AIware 2026 papers, plus two workshop papers, have a venue, and several of those venues are confirmed only by the arXiv comments field. Most of the core orchestration and compaction evidence is preprints from the last six months, some only days or weeks old and unreplicated, so they could change.
- Most of the positive headline figures are "up to" values from authors evaluating their own system, and many abstracts omit run counts. These were not checked in full text except where marked.
- Benchmarks do not represent machdoch's real use. Long, mixed-provider, multi-session work on private repositories remains nearly unstudied.
