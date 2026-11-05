# Experts are verifiers, not personas: the target design for Machdoch's agents

**Yes, build specialists, including narrow ones like React, UI and Unreal Engine. Build them as Expert Packs that the host activates inside one agent, not as "You are a senior X" personas and not as a fleet of separate agents.** A pack holds a few rules the model would otherwise miss, a version-pinned docs index, the right tools, and above all executable verifiers. This is what the evidence supports and what the vendors' specialist products mostly are. Anthropic's finance agents are [skills, connectors and subagents](https://anthropic.com/news/finance-agents), with no model listed as a component. The Vals [Finance Agent leaderboard](https://www.vals.ai/benchmarks/fabv2-1) is led by Claude Opus 5.5 at 67.85%, and general coding CLIs reach 57.3% on Microsoft's [HealthAgentBench](https://microsoft.github.io/HealthAgentBench/).

The four numbers behind the design:

| Finding | Number | Source |
|---|---|---|
| Curated skills raise resolution | 33.9% to 50.5% across 18 configurations | [SkillsBench 1.1](https://www.skillsbench.ai/blogs/skillsbench-1-1) |
| Skills a model writes for itself before solving lower it | -8.1 to -11.5 points | SkillsBench 1.1 |
| Most public software skills do nothing | 92 of 98 no significant effect, +0.3 average, range +17.7 to -17.0 | [SWE-Skills-Bench](https://arxiv.org/abs/2603.15401) |
| Passing a build is not doing the task | 42-50% of on-time Blueprint submissions that passed asset checks failed runtime assertions | [CraftBench-UE](https://arxiv.org/abs/2609.23142) |

So specialist knowledge helps when it is curated, short, task-matched and measured. A pack that can't show a gain against a pack-off baseline doesn't ship.

Nearly all of this rests on recent preprints, usually read through a summarizing fetch. Effect sizes come mostly from the authors' own benchmarks, often on older or smaller models. Design decisions below are my judgment. Nothing here has been built or tested in Machdoch.

## Fixed defect: knowledge and research were broken in 39.0.0

In the 39.0.0 desktop app, `search_workspace_knowledge` and `list_research_projects` both fail with `no such module: fts5`. The embedded runtime is Node 22.13.1, and official Windows builds only include FTS5 from 22.16.0.

The source fix moves the embedded runtime to Node 24.22, raises `engines` to `>=24`, and makes distributable builds fail if the runtime can't create the search index. It reaches installs with the next release. Earlier reports treat FTS5 as the memory foundation, which holds from that release on.

A smaller finding: `%LOCALAPPDATA%\machdoch\runtime` holds 138 entries totalling 5.84 GB, reaching back to version 10.2.0.

## What to build, and why

| Option | Verdict | Evidence |
|---|---|---|
| Persona prompts ("You are an expert in...") | **No.** Remove any that exist | No accuracy gain in an [IEEE-published GPT-5.3 test](https://www.computer.org/csdl/proceedings-article/rew/2026/453500a399/2jPmWPDSiAw) and [Wharton's study](https://arxiv.org/abs/2512.05858). In [PRISM](https://arxiv.org/html/2603.18507v1), coding quality fell on small models (Mistral 9.00 to 7.35, Qwen 7.40 to 6.75). Personas written from model memory misstated documented positions in 1-4 of 20 answers ([mimeo](https://arxiv.org/abs/2609.00453)) |
| Training or fine-tuning domain models | **No** | [Mint-Agent](https://arxiv.org/abs/2608.16386) reports +3.00 to +3.66 points over frontier models, self-reported and not attributed between training and harness. [Cura 1T](https://arxiv.org/abs/2607.15314) claims the top score on five of six healthcare benchmarks, with no margins on the page I read. [GPT-Rosalind](https://openai.com/index/introducing-gpt-rosalind/) is a real specialist model, restricted to trusted access. Specialist models may well win in their niche, but Machdoch shouldn't train them. Route to them when a user has access |
| One separate agent per domain | **No** | Compiling multi-agent systems into one agent with skills cut tokens 53.7% and latency 49.5%, with accuracy +0.7 on average ([Single-agent with skills](https://arxiv.org/html/2601.04748v2); small benchmarks, GPT-4o-mini). A [2025 framework comparison](https://arxiv.org/abs/2511.00872) also favored single agents on code |
| Subagents for independence | **Yes, narrowly** | The same paper says compilation fails for adversarial setups, parallel independent sampling, private information and mixed models. Those four cases are the only reasons to spawn |
| Short, curated, evaluated knowledge | **Yes, the core** | SkillsBench: every domain gained, software +11.6, natural science +28.8, finance +14.2. Best at 2-3 skills (+19.0, against +10.1 at 4+) and compact to standard length (+19.0 to +21.5, against +0.7 for comprehensive) |
| Executable domain checks | **Yes, the highest value** | CraftBench-UE; [WebUIProof](https://arxiv.org/html/2610.02617) (69.74% build success, 35.05% full completion); [TDAD](https://arxiv.org/abs/2603.17973) (regressions 6.08% to 1.82% with an impact map, 9.94% with TDD instructions alone) |

The pattern across the last row matters: **give the agent evidence, not procedure.** Prescribing a workflow raised regressions in TDAD, and excessive procedure is 62.6% of the efficiency regressions in [Agent Skills Can Be Harmful](https://arxiv.org/html/2608.11888v1). Machdoch should run the check itself and hand back the failure.

## The final design: Expert Packs

Packs extend the existing `managed-skills.ts` and instruction library. A pack is one directory, and this is the only specialist mechanism. It replaces the flat skill catalog and manually assigned instruction tags.

```yaml
id: react
version: 7
parent: frontend
applies:
  manifests: { package.json: [react] }
  paths: ["**/*.tsx", "**/*.jsx"]
knowledge:
  rules: rules.md
  docsIndex: { source: react, version: detected }
  resources: references/
tools: [playwright]
verify:
  - { id: types, run: "{pm} exec tsc --noEmit", on: edit }
  - { id: impacted-tests, run: impacted-tests, on: edit }
  - { id: flow, run: browser-flow, on: done }
review: none
contracts:
  - { kind: package-major, name: react, range: ">=19 <20" }
source: { origin: first-party, digest: "sha256:..." }
eval: { tasks: evals/, baseline: pack-off, status: confirmed }
```

### Knowledge only the model lacks

- **Rules** stay around 500 tokens per pack, and that cap is my decision. The [SkillOpt](https://arxiv.org/html/2605.23904v2) authors counted human-written skills at 145-516 tokens, and SkillsBench found comprehensive documents gained only +0.7.
- **Every rule must add new information.** Rules naming a command or path the old skill lacked drove most of the gain in [Agent Skill Evolution](https://arxiv.org/html/2610.04832v1), which also advises sizing a skill for the smallest model that reads it.
- **No repository overviews or anything the repo already shows.** Context files raise cost by over 20% with no general success gain ([ETH](https://arxiv.org/abs/2602.11988)) and showed no measurable correctness change across 288 runs ([Khatri](https://arxiv.org/abs/2607.27250)), whose failures were mostly implementation skill rather than missing repository knowledge.
- **Version-pinned docs as an index, not as text.** Vercel's 8 KB index of Next.js 16 docs passed 100% of its evals, against 53% for no docs and 79% for a skill with explicit instructions ([Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals), vendor, narrow test). I read this as compatible with the ETH result, since the index points at knowledge newer than the model's training. Domain documents helped only specification-dependent bugs in [SWE-Bench 5G](https://arxiv.org/abs/2604.26278). Context7 is already a preset but off by default, and I found no independent evaluation of it. Packs should bundle a local docs index per detected version.

### The host activates packs, not the model

Waiting for a model to pick a skill loses much of the value. In Vercel's test the skill went uninvoked in 56% of cases. Invocation ranges from 46% to 99% across SkillsBench configurations. Agent Skill Evolution found that on-demand loading kept 51% of the action gain (CI 28-75%), and carrying a skill body cost 37-57% more tokens per episode.

Machdoch's current design relies on exactly this choice: it sends a catalog and tells the agent to read what is relevant (`managed-skill-delivery.ts:17`). On Claude CLI, skills aren't even materialized as files (`materializer.ts:1083`).

**On this machine, the specialist system is empty:** no managed skills, no instruction profile with a match rule, and no workspace tags. The tag-rule engine exists, but it needs manual setup, and that hasn't happened here. Automatic detection is what makes this feature real.

- **Stack Snapshot.** The host reads manifests deterministically: `package.json`, `Cargo.toml`, `.uproject`, `*.Build.cs`, `tauri.conf.json`, `fabric.mod.json`, `go.mod`, `pyproject.toml`. It records versions and passes them to the agent. No model call.
- **Selection uses structure, not task words.** Candidates come from the snapshot. A pack's rules are injected when the task's attachments, recently edited files or a run's edits match its paths. Single-word matching is what [already fails memory retrieval here](Inject%20less%20prove%20more.md). Use `internal-task-model.ts` only for ambiguous cases, and measure its precision on hand-judged tasks.
- **At most three active packs.** This follows SkillsBench's 2-3 skill optimum.
- **Hierarchy keeps selection reliable.** Domain, then stack, then task type (`software` > `frontend` > `react` > `react-migration`). Selection accuracy held above 90% up to about 20 skills, fell to about 20% at 200, and confusable neighbours cut it by 7-63%. Hierarchy reached 72-85% at 60+ skills against 45-63% for flat selection ([same paper](https://arxiv.org/html/2601.04748v2), synthetic libraries, older models). Filtering by stack keeps the visible set small. Lint descriptions for overlap when a pack is saved.
- **User instructions always win.** The main harm mode is a relevant-looking skill overriding the task: 68.8% of 125 confirmed functional failures were wrong or omitted required elements, rarely irrelevant skills ([Harmful](https://arxiv.org/html/2608.11888v1)). The host's conflict detection must cover packs.
- **Per-turn delivery.** Active packs enter as a turn delta. The provider-session digest includes the skill catalog (`external-agent-provider.ts:2578`), so putting pack changes there would invalidate session resume.

The UI shows active packs in the existing context chips, and a verifier result only when one failed.

### Verifiers carry the expertise

A shared verifier library lives in core, and packs reference it. Machdoch runs verifiers itself, scoped to what changed, and returns only failures as evidence. The agent doesn't spend tokens re-running checks, which also addresses excessive verification, the largest single regression type at 36.8% of 182 cases. `on: edit` applies where the CLI offers a hook, and otherwise at the end of the run.

| Verifier | Checks |
|---|---|
| `impacted-tests` | Tests linked to changed code through imports and co-change history (TDAD; [Stratum](https://arxiv.org/abs/2610.36153)) |
| `browser-flow` | Interaction tests on the real app, from a spec |
| `visual-review` | Fresh-context vision check on screenshots at set breakpoints, plus accessibility scan and design-token lint. Scored separately from `browser-flow`, because WebUIProof found neither signal sufficient alone |
| `engine-runtime` | Headless engine build and runtime assertions, for Unreal and similar |
| `claim-check` | Each cited claim traced to a retrieved source, numbers recomputed from data |
| `requirement-check` | Each requirement linked to its proving check, feeding the 39.0.0 goal checklist on every run |

Visual debugging gave most of the visual gain in [InteractGUI Bench](https://arxiv.org/html/2604.19750): +2.85 of +3.50 points in resolution (single run, Gemini-3-Flash). Structural design input also matters: Figma JSON raised localization most in [VISTA](https://arxiv.org/html/2605.26144v3), but its payoff needed a free stack, and pinning the stack cost more than screenshots gained.

**Tools must also declare their limits.** In [Puget's Unreal MCP test](https://www.pugetsystems.com/blog/2026/07/09/unreal-engine-mcp-hands-on-testing-ai-inside-the-editor/) (informal), the agent couldn't build PCG graphs, so it placed static meshes by hand without saying so at the time. A pack lists what its tools can't do, and `requirement-check` flags a requested technique that was substituted.

### Reviewers only where independence matters

A pack can set `review` to run a separate reviewer: fresh context, the pack's checklist, no sight of the author's reasoning. Use it for security, finance, health, legal and architecture, and when the user asks.

Every reviewer runs as a Machdoch-managed process using the existing `verification` delegation mode and `review-model.ts`, not as a native subagent. That gives one path across CLIs. Codex agent files [ignore `sandbox_mode` and `mcp_servers`, and no flag to select an agent is documented](https://learn.chatgpt.com/docs/agent-configuration/subagents), so native subagents can't deliver this uniformly.

Reviewers must return evidence and explicit disagreements. Naive reviewer-critic pairs fell into false consensus until disagreement was forced ([Adversarial Review](https://arxiv.org/abs/2608.18167), ICML workshop, no figures on the page I read). Cross-provider review stays optional until measured.

### Packs earn their place

- **Paired evaluation is the gate.** `machdoch eval` runs each pack on and off on the same tasks and scores with its verifiers. Status moves through draft, provisional, confirmed and retired. Only provisional and confirmed packs activate.
- **Passive outcome ledger.** Every run records active packs, verifier results, later user corrections, tokens and time. A pack whose runs repeatedly fail or cost far more gets flagged and queued for paired re-evaluation. Ledger data is observational, so it raises flags and doesn't prove effects. Variance is high: [Identical Runs](https://arxiv.org/html/2609.33812v1), cited in the earlier report, needed about 39-113 runs per arm to detect differences.
- **Automatic improvement is proposal-only.** Never generate a skill at run start, since that's the self-generated case that hurts. A gated loop is different: SkillOpt reports +24.8 points in Codex and +19.1 in Claude Code on GPT-5.5, accepting an edit only if a held-out split improves. It is self-reported, and it requires a reliable automatic verifier. So improvement runs only for packs with verifiers, and the result is a reviewable diff. Learned lessons from the reasoning bank flow into pack proposals here.
- **Drift contracts.** Packs declare the versions, commands and APIs they depend on. Checking only those gave 0 false alarms in 599 cases against 40% false positives for contract-free probes, and raised one-round repair from 10% to 78%, with 76% recall on known drift ([Skill Drift](https://arxiv.org/abs/2605.10990)). A violated contract deactivates the pack for that workspace and queues a repair proposal.

### Supply chain

Skills are executable influence. One audit found [341 malicious entries among 2,857 ClawHub skills](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html), and Snyk found [critical issues in 13.4% of 3,984 skills](https://codex.danielvaughan.com/2026/06/07/agent-skill-supply-chain-crisis-clawhavoc-toxicskills-skillsieve-codex-cli-defence/) (both secondary reports). [SkillCorpus](https://arxiv.org/abs/2607.15557) kept 96,401 of about 821,000 crawled skills and gained +7.5 points on SkillsBench, which is well below the curated lift.

So there's no open marketplace. Packs come from first-party curation, official vendor sources (shadcn, Figma, Epic, framework authors) or the user's own repository. Every pack is pinned by digest, re-approved on any change, and evaluated before activation. This extends the pinning already proposed for MCP definitions.

## First-party packs

The list starts from the MCP servers and workspaces on this machine, plus the domains you named.

| Pack | Knowledge the model lacks | Verifiers | Review |
|---|---|---|---|
| `frontend` | Design tokens, component library in use, target breakpoints | `browser-flow`, `visual-review` | |
| `react`, `nextjs` | Version-pinned docs index, framework-specific rules | Type check, `impacted-tests`, `browser-flow` | |
| `tauri` | IPC contract, permissions, desktop and mobile differences | `cargo check`, IPC calls through the Tauri MCP | |
| `rust` | Workspace layout, feature flags | `cargo check`, `clippy`, `impacted-tests` | |
| `unreal` | Engine version index, Epic's MCP capability limits, default to C++ when the user has no preference | Headless build, `engine-runtime` assertions | |
| `game-assets` | Blockbench and PixelLab conventions and limits | Format validation, `visual-review` | |
| `minecraft-modding` | Loader and game version index | Gradle build, loaded-mod smoke test | |
| `cad` | build123d session workflow | `validate`, `measure`, `analyze_printability` from the existing MCP | |
| `security` | Threat model of the stack | Dependency audit, secret scan | Required |
| `research` | Source rules, read-depth labelling | `claim-check` | |
| `writing` | The user's style guide and audience | `claim-check`, fresh-reader review | Optional |
| `finance`, `health`, `legal` | Governed data connectors, firm or jurisdiction conventions | `claim-check`, numeric recomputation | Required, plus human approval before anything leaves the machine |

Three notes on that table:

- **Unreal defaults to C++ because of CraftBench-UE.** C++ completion beat equivalent Blueprint by 30.0-42.9 points. Epic's [UE 5.8 MCP](https://www.pugetsystems.com/blog/2026/07/09/unreal-engine-mcp-hands-on-testing-ai-inside-the-editor/) is experimental. Exact headless commands need checking against the installed engine.
- **High-stakes packs need a human.** The best scores I found are 67.85% on Vals' finance benchmark and 57.3% on HealthAgentBench, so about a third or more of tasks fail there. Packs never claim compliance or clinical validity. One review reports that [specialization can raise safety failures](https://kili-technology.com/blog/domain-specific-llm-benchmarks-guide) (secondary).
- **Writing has the weakest evidence.** I found no controlled benchmark of writing skills. [GDPval](https://arxiv.org/abs/2510.04374) relies on expert pairwise grading because automatic scoring is hard, so this pack can't use the automated improvement loop.

## The rest of the target system

Details and sources for items marked with † are in [Inject less, prove more](Inject%20less%20prove%20more.md). I re-checked the SWE-Clar and Memory Tax figures against the papers for this report; the others weren't re-read.

**Understanding**

- **Clarify gate †.** A cheap pass detects when two plausible readings would change behavior, then asks before work starts. Pass rates went from 5-6% with no interaction to 39-49% with clarification first, while asking during coding gave 13-26% ([SWE-Clar](https://arxiv.org/html/2610.31854)).
- **Requirement ledger †.** Every chat keeps requirements and prohibitions, each linked to code and to its proving check, and restated after compaction and on resume.
- **Rules become checks †.** "Make this rule checkable" turns an instruction into a deterministic verifier. Agents violated 43.1% of applicable policies while still producing correct patches. Instruction compliance also drops as a session lengthens, by about 5.6% lower odds per generated function ([McMillan](https://arxiv.org/abs/2605.10039), post hoc), and file structure made no detectable difference. Restructuring instruction files is therefore not worth the effort.

**Context**

- **Evidence over reminders †.** Show changed files and state on resume. In one EnvOS task, Opus 5 went from 2/16 when reminded to 15/16 when shown the value. In another it re-checked unprompted (10/10), so the effect varies by model and interface.
- **Budgeted, honest tool output †.** No silent truncation, degrade before dropping, tool definitions filtered by the active packs. Packs give the cleanest filter available, since a React task needs neither CAD nor pixel-art tools.
- **Context cost visible per source †,** including cache share per run.

**Memory**

- **Pinned items by default, everything else pulled †.** Replaces single-word matching, which the replay measured at 16-36% useful.
- **Immutable episodes plus claims with a lifecycle †.** No memory system beat two-round RAG over raw history on LongMemEval-s ([Memory Tax](https://arxiv.org/html/2610.34073), 81.4 against 58.8-79.4 on Qwen3.6-27B), though some beat one-round RAG. Memory earns its keep on what raw search can't find: failed attempts and root causes.
- **Pack-scoped knowledge.** A lesson about Unreal lives with the `unreal` pack and is only reachable when that pack is active. This is my design inference, and it removes a whole class of unrelated retrievals such as the VAE lesson the earlier report caught.

**Features and new capabilities**

- **Proof gap on every run †.** If an edit has no later check, run one before reporting done.
- **Best-of-N in isolated worktrees †,** selected by verifiers, never by an LLM judge.
- **MCP proxy reliability †.** Bounded retries, typed errors, breaker, schema checks.
- **Untrusted-input run profile †** for scheduled and Fleet runs, with sandbox, credential proxy and egress rules.
- **Model choice from local results.** Replace task-regex heuristics in `adaptive-controller.ts` with a table of verified outcome and cost per pack and model, and keep the user's selection authoritative. Model versions differ widely: Opus 5.5 scored 57.3% at $4.7 per task against Sonnet 5.5's 50.7% at $1.8, and Opus 5 managed 32.0% (HealthAgentBench). Prompt-content routing is not justified: [one evaluation](https://arxiv.org/abs/2608.14641) found no task-specific advantage over content-blind allocation in its configurations, and [ACRouter](https://arxiv.org/html/2606.22902v1) gained +6.15 points over always-Opus 4.6 while a standalone GPT-5.4 run beat it out-of-distribution, 75.00% against 62.50%.

## Don't build

| Don't build | Why |
|---|---|
| Persona prompts or named expert characters | No accuracy gain, can reduce it, and misstate documented positions |
| A "fleet" of always-on specialist agents | Costs tokens and latency without the independence that justifies it |
| An open skill marketplace | Malware prevalence, and public skills mostly have no effect |
| A model that writes itself a skill at run start | -8.1 to -11.5 points |
| Comprehensive skills or large always-on context | +0.7 points for comprehensive skills, over 20% extra cost for context files |
| A prompt-content model router | No demonstrated task-specific advantage in the most neutral evaluation |
| "Follow TDD" and similar procedural rules | Regressions rose to 9.94% in TDAD |
| A graph database or third-party memory backend † | Below RAG in nearly every Memory Tax comparison |
| Auto-applied self-improvement † | Requires a gate, and held-out gains are contested |

## Benchmarks to adopt in `machdoch eval`

Borrow the task designs. Treat scores as context only, since harness and model interact.

| Area | Benchmark | Latest result I saw |
|---|---|---|
| Skills overall | [SkillsBench 1.1](https://www.skillsbench.ai/blogs/skillsbench-1-1) | OpenHands + GPT-5.5, 67.3% with skills. [Vals' board](https://www.vals.ai/benchmarks/skillsbench) shows a different top (search snippet) |
| Software skills | [SWE-Skills-Bench](https://arxiv.org/abs/2603.15401) | Average +0.3 points |
| Clarification | [SWE-Clar](https://arxiv.org/abs/2610.31854) | GPT-6 Astra, 67% pass |
| Unreal | [CraftBench-UE](https://arxiv.org/abs/2609.23142) | 70 tasks, deterministic. Harness release pending |
| Web UI | [WebUIProof](https://arxiv.org/html/2610.02617) | 219 tasks. Claude Sonnet 4 46.10% (older models) |
| Design to code | [VISTA](https://arxiv.org/html/2605.26144v3) | Best combined score 0.264 |
| Desktop GUI | [InteractGUI](https://arxiv.org/html/2604.19750) | 984 tasks. VF-Coder 28.29% |
| Finance | [Vals Finance Agent v2.1](https://www.vals.ai/benchmarks/fabv2-1) | Opus 5.5 67.85%, Gemini 4 Argon 67.66% (Oct 29) |
| Health | [HealthAgentBench](https://microsoft.github.io/HealthAgentBench/) | Claude Code + Opus 5.5, 57.3% |
| Skill drift | [Skill Drift](https://arxiv.org/abs/2605.10990) | 880 drift pairs |

## Limits of this research

- **Read depth varies.** SkillsBench 1.1, Agent Skill Evolution, Agent Skills Can Be Harmful, Single-agent with skills, SkillOpt, PRISM, VISTA, InteractGUI, WebUIProof and ACRouter were read in large part through a summarizing fetch. Many others are abstract-only, as listed in the [notes](../research_notes/Experts%20are%20verifiers%20not%20personas/README.md). The OpenAI Rosalind pages returned 403, so those facts come from search snippets. Check PDFs before quoting anything publicly.
- **Benchmarks conflict with each other.** SkillsBench and SWE-Skills-Bench disagree on how much skills help software work (+11.6 against +0.3). They differ in design, and the task-matched reading is my inference. Vercel's result and the ETH result are similarly reconciled by inference.
- **No direct study exists for much of this.** I found no controlled test of host-activated packs, of pack-scoped memory, of React-specific or Unreal-specific skills, or of writing skills. CraftBench-UE measures agents, not packs. The caps of 500 tokens and three packs are judgment calls to tune with evals.
- **Local evidence is one machine.** The empty specialist configuration may differ for other users. The FTS5 failure was reproduced on Windows only.
- **Nothing was implemented.** This report and its notes are the only additions, and no application code changed.
