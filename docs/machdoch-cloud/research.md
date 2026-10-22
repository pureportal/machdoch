# Research and design decisions

Follow-up: [automation research](automation-research.md) adds current scheduled/event product findings, Temporal/cron semantics, CloudEvents, remote-test infrastructure, orchestration alternatives and two additional reliability papers. The [integration audit](integration-audit.md) ties these decisions to exercised local code.

Checked **22 October 2026**. This review uses first-party product documentation/changelogs and original research. It combines current repository inspection with online searches for coding agents, planning workflows, MCP, delegation, isolation, and long-running reliability.

Dates below are publication/revision dates where available, not search-engine crawl dates. Undated documentation is described as observed on the research date. A vendor announcement establishes what the vendor offers or claims, not independently verified performance. Paper results are not Machdoch benchmarks. Proposed requirements are engineering conclusions drawn from this evidence.

The search reached OpenAI updates dated October 21 and research published in October, including SPROUT on October 9. It is not an exhaustive literature review or a claim to have found every publication. Mutable sources and preview APIs must be rechecked when implementation starts.

## 1. Linear: the competitive baseline has moved

| Verified capability | Evidence and status | Decision for machdoch.cloud |
| --- | --- | --- |
| Issues, projects, initiatives, cycles | Current [conceptual model](https://linear.app/docs/conceptual-model) separates these concepts. | Adopt a similarly clear planning hierarchy, while keeping repository/client workspaces distinct from projects. |
| Cycle scheduling and capacity | [Cycles](https://linear.app/docs/use-cycles) documents repeating team cycles, cooldown, carryover and capacity. [Estimates](https://linear.app/docs/estimates) supports planning metrics. | Include complete cycle planning; add separate human review and agent execution capacity. |
| Planning poker integration | Linear lists [PlanningPoker.live](https://linear.app/integrations/planningpoker-live) for rooms, voting, and issue estimates. | Deliver native private poker plus an integration contract. The verified Linear example is an external integration, not evidence of native poker. |
| Agents as delegates | [Agent developer docs](https://linear.app/developers/agents) distinguishes a delegate from the human assignee; the API page still labels itself Developer Preview. | Preserve human accountability and agent identity separately; provide scoped installed-agent integrations. |
| Workspace context and agent guidance | [AI Agents](https://linear.app/docs/agents-in-linear) documents mentions, delegation, guidance, and activity. | Give agents explicit context/instruction revisions and verify delivery across handoffs. |
| Autonomous coding sessions | [Coding sessions](https://linear.app/docs/coding-sessions) describes Claude Code/Codex writing and testing code in cloud environments, then returning a draft PR. Introduced [June 11, 2026](https://linear.app/changelog/2026-06-11-coding-sessions). | Treat issue-to-tested-PR as baseline; add equivalent execution on linked Machdoch clients. |
| Recurring and event-driven work | [Loops](https://linear.app/docs/loops) can react to planning/review events and schedules. [July 20 launch](https://linear.app/changelog/2026-07-20-introducing-loops) establishes the initial release. | Include versioned workflows, dry runs, causal IDs, replay, budgets, and recursion prevention. |
| Model routing, secrets, team organization | [September 24 update](https://linear.app/changelog/2026-09-24-new-controls-for-linear-coding-agent) documents adaptive routing, environment secrets, open-weight sessions, lead teams, and durable project/initiative IDs. | Add policy-bound routing, setup-secret separation, durable readable IDs, and team ownership. |
| Stacked PRs, live diffs, spending controls | [October 8 update](https://linear.app/changelog/2026-10-08-stacked-pull-requests) adds stack navigation, changing code visibility, and usage/spend controls. | Full review inbox, live diff, stack dependencies, and budget accounting belong in the target release. |
| Customer context | [Customer Requests](https://linear.app/docs/customer-requests) links feedback to issues/projects and customer attributes. | Connect source feedback to planning and delivery, without copying sensitive customer data into every agent prompt. |

The opportunity is not to claim that Linear only tracks issues. Machdoch can combine this planning/review experience with its own runtime, existing desktop/headless fleet, device-specific capabilities, self-hosted execution, and explicit transfer between execution locations. That differentiation still needs validated product quality; feature count alone does not establish it.

## 2. OpenAI: local harnesses and managed agents are separate integration choices

| Evidence | Observed capability/status | Consequence |
| --- | --- | --- |
| [Agents API announcement](https://openai.com/index/introducing-the-agents-api/), September 10, 2026 | Announced in public beta as a managed Codex harness. | Offer a managed-harness adapter behind an explicit preview policy; do not make it a mandatory dependency of a self-hosted suite. |
| [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview) | Durable sessions, tools, MCP, context compaction, subagents, continuation and steering. | Normalize provider sessions into Machdoch runs while keeping issue admission and permissions in Machdoch. |
| [Self-hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) | `codex exec-server` executes in the selected environment and connects outbound; OpenAI runs the harness. | Evaluate this as one provider mode on owned runners. Isolate each workload; do not equate self-hosted execution with local inference. |
| [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) | Local programmable agent execution and app-server integration. The page says the old `codex mcp-server` interface has been removed. | Use the supported SDK/app-server contract for native Codex integration, with pinned runtime versions and capability tests. |
| [API changelog](https://developers.openai.com/api/docs/changelog), October 9–21 | Documents sandbox prewarming, artifact tooling, service-tier controls, and extended prompt caching. | Add warm environments, artifact-producing tasks, explicit performance/cost policies, and cache accounting. Caching must respect data policy. |

The same changelog documents October 16 voice additions. They are relevant to preserving and improving Machdoch's existing speech interaction, but do not justify adding unrelated voice controls to every planning screen. A voice instruction should produce the same attributable issue/run action as a typed instruction.

Do not hardcode the current model family into workflow semantics. Record a concrete model/harness/capability selection per attempt, and separately expose an administrator-approved routing policy. New model names alone are not new product architecture.

## 3. Anthropic: harness design and self-hosted tools

| Evidence | Observed capability/status | Consequence |
| --- | --- | --- |
| [Managed Agents environment choices](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment) | The documentation marks Managed Agents beta and supports vendor cloud or self-hosted sandbox execution. | Add a certified managed-agent adapter; keep the owned Machdoch/Claude harness path usable independently. |
| [Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes) | An outbound worker claims work and executes tools; tool inputs/results still reach Anthropic. Self-hosted resource limitations are documented. | Stage repositories/files through Machdoch's controlled environment preparation; explicitly document vendor data flow and supported resource types. |
| [Harness design for long-running applications](https://www.anthropic.com/research/harness-design-long-running-apps), March 24, 2026 | Describes planner/generator/evaluator roles and structured artifacts across long sessions. | Use explicit acceptance artifacts, bounded specialist work, and independent validation; do not rely on an ever-growing chat transcript. |
| [Claude Agent SDK plan usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), updated October 7 | Describes evolving subscription/API-credit arrangements. | Check the actual credential/entitlement mode for shared execution. Never assume a desktop subscription can be redistributed across company workers. |

The engineering article is a vendor experiment, not evidence that its architecture guarantees reliable multi-hour work on arbitrary repositories. Its useful lesson is explicit state and evaluation, not unbounded agent multiplication.

## 4. Perplexity: research, routing, and external computer work

| Evidence | Observed capability/status | Consequence |
| --- | --- | --- |
| [Agent API](https://docs.perplexity.ai/docs/agent-api/quickstart) | Multi-provider API with web-grounded results, tool/reasoning configuration, and budgets. | Add a cited research provider and bounded tool integration; keep cost and sources attached to the run. |
| [Orchestrator API](https://docs.perplexity.ai/docs/router/quickstart) | A documented routing/API surface with multiple model interfaces. | Evaluate as an explicit provider route; no silent data-destination changes or inherited routing assumptions. |
| [Computer MCP](https://docs.perplexity.ai/docs/getting-started/integrations/computer-mcp-server) | Starts/continues tasks, returns progress, handles questions/actions, uses browser/code capabilities, and connects services. | Support as an external scoped agent where policy permits. It is not the self-hosted Machdoch sandbox or proof of identical cancellation semantics. |
| [API changelog](https://docs.perplexity.ai/docs/resources/changelog), September/October 2026 | Current entries cover document input, image search, cost reporting, Decisions API, and changing presets. | Add document research and structured classification as bounded tools. Preserve actual configuration/version; a preset may change its underlying model. |
| [Sonar transition announcement](https://community.perplexity.ai/t/sonar-is-moving-to-the-agent-api/5802), August 13, 2026 | Announced a September 27 retirement date for Sonar endpoints. | Base the new integration on current Agent/Search API contracts; verify the existing client's Perplexity implementation during migration. |
| [NVIDIA/Perplexity Portable Computer announcement](https://blogs.nvidia.com/blog/local-ai-perplexity-windows-pcs/), September 14, 2026 | Documents local agent workflows on compatible Windows RTX hardware with cloud orchestration options. | Validate local/private routing as a product direction; do not infer that Machdoch's clients satisfy those hardware or product requirements. |

A structured Decisions/classification model can suggest triage labels, retrieval routing, or likely duplicate issues. It must never be the authorization engine or automatically accept a risk score as permission to publish. Source citations and actual execution evidence remain separate kinds of evidence.

## 5. Cursor, GitHub, and Google

| Evidence | Verified direction | Machdoch decision |
| --- | --- | --- |
| [Cursor Projects](https://cursor.com/blog/projects), September 10, 2026 | Coordinator-led project work and recurring delegation. Large agent-count statements are vendor claims. | Add project-level orchestration, but enforce finite task graphs, review capacity, budget, and isolated writes. |
| [Cursor self-hosted cloud agents](https://cursor.com/blog/self-hosted-cloud-agents) | The retrieved page documents running tool execution in customer infrastructure. | Bring-your-own runner infrastructure is part of the baseline design; retain explicit inference/data boundaries. |
| [Cursor Cloud Agents release notes](https://prod.cursor.com/docs/release-notes/cloud-agents), through week of October 5 | Document coordinator messaging, live child progress, environment builds, and agent relinquishment during human desktop control. | Include visible subtask progress, fresh environment builds, and exclusive control transfer. Do not reproduce model/vendor-specific UI. |
| [GitHub agents documentation](https://docs.github.com/en/copilot/concepts/agent-capabilities/about-agents/about-github-copilot-agents) | Local/cloud and parallel agent sessions, asynchronous delegation, and supported third-party agents. | Keep native GitHub review and agent integration available; let Machdoch own cross-client planning and execution history. |
| [Agent HQ update](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/), February 4, 2026 | Announced Claude and Codex public previews inside GitHub/VS Code. | Historical availability evidence only; use current integration docs for entitlement and supported behavior. |
| [Jules API update](https://jules.google/docs/changelog/2026-01-26-4), January 26, 2026 | Repoless tasks, patch/file outputs, and immutable session activities. [Current changelog](https://jules.google/docs/changelog/) also documents MCP connections. | Support artifact-only tasks and replayable activity as native concepts. A Jules-specific adapter is an integration candidate, not a prerequisite for the complete owned runtime. |

The common direction is a persistent agent workspace with progress, artifacts, review, and multiple execution locations. Machdoch should avoid fragmentation between a cloud agent product and a remote-control product; both should operate on the same work records.

## 6. Protocol and infrastructure findings

| Source | Finding | Decision |
| --- | --- | --- |
| [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) and [transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) | Stateless per-request semantics and current discovery/transport replace older assumptions. | Implement the current cloud contract and update client integration deliberately. |
| [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview) | Long operations have durable handles, progress, input, and completion through an extension. | Bind handles to real durable Machdoch runs, not process memory. |
| [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | Defines authorization discovery and resource/audience constraints. | Use scoped auth; prohibit credential passthrough and organization selection by untrusted arguments. |
| [MCP roadmap](https://blog.modelcontextprotocol.io/posts/mcp-roadmap/), August 22, 2026 | Distinguishes shipped changes from future work on events, task maturation, identity, and transport. | Implement shipped contracts, track proposals separately, and avoid dependency on promised future semantics. |
| [A2A 1.0](https://a2a-protocol.org/v1.0.0/specification/) | Agent discovery, tasks, artifacts, streaming, and asynchronous interaction. | Support an external-agent adapter; do not replace internal lease/admission semantics. |
| [ACP registry](https://github.com/agentclientprotocol/registry) | Registry of coding agents implementing the client/agent protocol. | Evaluate adapters with real provider evidence; registry presence alone does not establish Machdoch integration quality. |
| [Git worktree](https://git-scm.com/docs/git-worktree) | Linked checkouts share repository-level state; submodule limitations remain documented. | Separate worktrees for trusted client code, clones for cloud/untrusted or explicitly incompatible repositories; isolate external resources separately. |
| [Firecracker](https://firecracker-microvm.github.io/) | VM-level isolation foundation using KVM. | Use an isolated execution pool; independently implement lifecycle, network policy, quotas, and recovery. |
| [Temporal activity execution](https://docs.temporal.io/activity-execution) | Durable activity lifecycle, retries and cancellation. | Use it for workflow durability, with domain receipts and reconciliation for external effects. |
| [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) and [webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) | Installation-scoped permissions, delivery identity, short acknowledgment deadlines, and missed-delivery handling. | Central broker plus inbox/outbox and reconciliation. |
| [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | Row policies provide isolation with important owner/privileged-role exceptions. | Combine tenant-aware schemas, non-owner application roles, RLS, and application authorization. |

## 7. Research: findings, limits, and actionable consequences

### SPROUT — October 9, 2026

[SPROUT: Scaling Agentic Reinforcement Learning for Long-Horizon Software Engineering](https://arxiv.org/abs/2610.14405) studies resuming/branching from paired context and execution checkpoints. The [full-text boundary definition](https://arxiv.org/html/2610.14405v1) assumes synchronous commands and no surviving background processes. This is research in rollout/training efficiency, not production failover evidence.

**Apply:** consistent checkpoint manifests and bounded recovery from verified boundaries. **Do not infer:** that restoring a directory restores browser sessions, daemons, external actions, or a vendor's private state. Do not reproduce its reported percentage improvements as Machdoch targets.

### Formal runtime verification — October 7, 2026

[Formal Runtime Verification for Tool-Using LLM Agents](https://arxiv.org/abs/2610.09793) evaluates temporal policies by replaying existing traces offline. It explicitly reports false positives and limitations from missing approvals/timestamps; it is not a live production enforcement trial.

**Apply:** record trustworthy timestamps, identities, approval provenance, resource revisions, and policy decisions so temporal invariants can be evaluated. **Do not infer:** formal syntax proves safety when the event history is untrusted or incomplete.

### HERMES / Dev-Primitives — October 6, 2026

[Harness Engineering via Modular Executable Dev-Primitives](https://arxiv.org/abs/2610.07832) explores dependency-aware component agents and diagnosis. Its [limitations](https://arxiv.org/html/2610.07832v1) include added inference/latency, dependence on selecting relevant components, and limited evaluated settings.

**Apply:** repository dependency maps, targeted specialist activation, and evidence-guided repair. **Experiment only:** a persistent agent per file/component. Require a controlled comparison against one well-equipped agent before enabling this execution policy; resident agents across the entire repository are not the default architecture.

### Executable-contract benchmark audit — September 29, 2026

[Do Agent Benchmarks Do What They Say?](https://arxiv.org/abs/2609.37315) examines whether tool environments match their advertised contracts.

**Apply:** test real tool side effects and end state, not just tool descriptions or mocked success messages. **Limit:** benchmark-contract defects do not establish an error rate for Machdoch; verify the actual adapters.

### Bounded Agents — August 16, 2026

[Bounded Agents: Delegation Security for Multi-Agent AI Systems](https://arxiv.org/abs/2608.15888) develops narrowing delegation and runtime authorization. The [full paper](https://arxiv.org/html/2608.15888v1) conditions its guarantees on enforcement assumptions and reports synthetic evaluation without production deployment data.

**Apply:** shrinking scopes, cumulative budgets, trusted approval records, and one enforcement path for tool/shell side effects. **Do not infer:** selecting a policy library or writing a restrictive prompt guarantees those assumptions hold.

### Safety benchmark validity — July 30, 2026

[Safety, or Just Capability?](https://arxiv.org/abs/2607.28685) compares what several agent-safety benchmarks actually measure and finds that scores are not interchangeable.

**Apply:** report task completion, policy adherence, injection resilience, recovery, and cost separately. Identify benchmark version, target behavior, model/harness configuration, and repeated-run methodology. A single safety percentage is not a release certificate.

### MirrorCode — June 29, revised July 17, 2026

[MirrorCode](https://arxiv.org/abs/2606.30182) evaluates rebuilding entire programs from behavior, including held-out tests and large time/token budgets. This is long-horizon capability research, not a prediction that ordinary issue work completes without review.

**Apply:** precise outcome contracts, held-out verification, multi-day durable work, and explicit resource accounting. **Limit:** its reconstruction setting differs from maintaining a live multi-user repository with permissions and production dependencies.

### MalSkillBench — June 5, revised June 19, 2026

[MalSkillBench](https://arxiv.org/abs/2606.07131) treats skills as both code and instructions and evaluates malicious behavior in instrumented environments. The authors describe limits in the distribution of observed malicious samples.

**Apply:** immutable skill provenance, permission review, isolated execution, and combined code/instruction attack tests. **Do not infer:** a scanner's high score on one subset protects arbitrary agent control flows.

### SWE-EVO — December 2025, revised May 22, 2026

[SWE-EVO](https://arxiv.org/abs/2512.18470) tests sustained software evolution across multiple files and iterations.

**Apply:** an evaluation set that includes multi-issue changes, regression preservation, and cross-file coordination, alongside small bug fixes. **Limit:** do not directly compare headline scores from different models, harnesses, or benchmarks as a single success probability.

### ReliabilityBench — January 3, 2026

[ReliabilityBench](https://arxiv.org/abs/2601.06112) evaluates repeated execution, task perturbations, and tool/API faults. Its evaluated models/domains are a bounded sample, not current coding-fleet evidence.

**Apply:** repeat scenarios under timeouts, rate limits, partial responses, and altered task wording; assert final state rather than merely similar text. Report success across repetitions as well as best-of-many success.

### MAST — March 2025, revised October 2025

[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) organizes observed failures around system design, agent alignment, and verification.

**Apply:** explicit subtask contracts, dependency graphs, termination conditions, bounded communication, and independent acceptance evidence. It remains useful even though it is older than the October papers. **Limit:** more agents are not assumed to outperform a single capable agent.

## 8. Upcoming changes and uncertain availability

| Item | Status as checked | What the plan does |
| --- | --- | --- |
| Perplexity model retirement | Its [changelog](https://docs.perplexity.ai/docs/resources/changelog) schedules selected older OpenAI model IDs to retire on **October 24, 2026 at 00:00 UTC**. | Discover current model capabilities, validate pinned selections, and stop incompatible new attempts. Require an explicit revised route; no silent model substitution. |
| MCP identity/event/task work | The [August roadmap](https://blog.modelcontextprotocol.io/posts/mcp-roadmap/) discusses DPoP finalization, workload identity/delegation, event channels, and task maturation. No universal completion date is established here. | Keep extensible adapter boundaries and token/grant models, but use released semantics until an implemented revision passes conformance. |
| OpenAI Agents API | Announcement establishes public beta; current docs evolve. | Certify a pinned adapter and entitlement/data policy; preserve the owned execution mode. |
| Claude Managed Agents | Current environment docs carry a beta label. | Same explicit preview gate and conformance requirements. |
| Linear external agent APIs | Developer docs still state Developer Preview. | Do not treat them as an immutable protocol for the cloud's internal domain model. |
| Emerging provider capabilities | Public changelogs show fast changes in artifacts, routing, speech, and hosted execution. | Track model/harness capabilities and deprecations as operational data with reviewed updates. |

No private or unannounced OpenAI, Linear, or Perplexity roadmap was available. Future features are not assumed to ship or made dependencies of the full Machdoch specification. “Upcoming” above means a documented date or published roadmap, not a prediction.

## 9. What to include, what to evaluate, and what to avoid

| Classification | Decision |
| --- | --- |
| Full-release requirement | Issues, cycles/poker, project knowledge, feedback intake, review/release workflows, cloud/client execution, current MCP, budgets, recovery, multi-user identity, and remote capability preservation |
| Full-release integration capability, disabled unless configured | Managed provider agents, external MCP/A2A agents, local inference, collaboration/incident connectors, SSO/SCIM, and external poker |
| Measured policy experiment | Component-level resident agents, alternative-candidate search, automatic model escalation, and learned triage routing; enable only after task-specific evaluation and explicit policy |
| Future commercial hosting | Subscription/billing platform, public marketplace, regional commercial SLAs, and multi-company operations |
| Avoid | Shared working directories, universal write credentials, silent provider switching, unconditional autonomous merge, unbounded agent loops, opaque memory accumulation, and success based only on agent prose |

The strongest combination is **customer/incident evidence → planned issue → isolated execution on the appropriate machine → independently verified change → review/release → observed outcome**. Review capacity, reproducible environments, and recoverable authority are as important as model quality.

## Evidence limits

Repository conclusions are based on the listed source files and existing dated verification reports. No live cloud implementation, paid provider comparison, sandbox penetration test, physical-device campaign, or benchmark reproduction was performed for this planning task.

The SPROUT, HERMES, and Bounded Agents full texts were inspected for execution assumptions and limitations; other paper entries rely on their original abstracts/metadata rather than full reproduction. Vendor API access, account eligibility, regional availability, and implementation-time licensing remain checks for delivery, not facts inferred from a product announcement.
