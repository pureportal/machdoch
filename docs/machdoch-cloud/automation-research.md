# Automation research and integration decisions

Sources retrieved **22 October 2026**. This supplements [the broader vendor/paper review](research.md). Documentation is evidence of a published capability or contract, not proof of account entitlement or Machdoch interoperability. Product choices below are design inferences. No vendor benchmark was reproduced.

## Current product evidence

| Primary source | What was verified | Consequence for this specification |
| --- | --- | --- |
| [Linear Loops](https://linear.app/docs/loops) | Schedules and supported domain/Slack events, connectors, scoped capabilities, history and saved published versions. Some trigger/template combinations have limits. | AU-10/AU-11 include reviewable authoring, scope, history and revision restore. Do not claim every vendor event is available to every installation. |
| [OpenAI scheduled tasks](https://developers.openai.com/codex/app/automations), currently redirects to [ChatGPT Learn](https://learn.chatgpt.com/docs/automations?surface=app) | Current page distinguishes local project tasks, web/cloud tasks, team service accounts, event-trigger availability by surface, fresh versus continuing chat context, and RRULE editing. Local tasks require the machine/app running; event triggers and schedules cannot be combined in one task on the documented surface. | Machdoch owns recurrence and target availability. AU-01 separates recurring runs from continuing goals; AU-02 separates ownership from execution location. Do not describe a desktop feature as a hosted scheduling API. |
| [Cursor Projects](https://cursor.com/blog/projects), September 10, 2026 | Persistent project coordination and recurring delegation are published product capabilities. Agent-scale statements are vendor claims. | Explicit project work, finite graphs, shared context and review-capacity limits; no requirement for thousands of agents. |
| [Claude Managed Agents environment choices](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment) | Beta environment documentation offers cloud and self-hosted choices with different responsibilities. | Preserve the owned runtime and certify managed sessions as an explicit adapter; vendor orchestration is not the cloud's authoritative run ledger. |
| [GitHub Agentic Workflows architecture](https://github.github.com/gh-aw/introduction/architecture/) | Agent execution and external writes are staged separately; proposed outputs pass through trusted components. The documented trust base includes the host/runtime and mediating services. | Reinforces E-10 brokered publication and AU-10 typed actions. Adopt the separation principle; do not claim copying a pattern eliminates prompt injection or host compromise. |
| [Perplexity changelog](https://docs.perplexity.ai/docs/resources/changelog) | Current entries include document/search/cost features, mutable presets, and a scheduled October 24, 2026 00:00 UTC retirement of selected older OpenAI model IDs. | Provider-maintenance templates identify affected definitions and propose current routes. No silent model substitution or claim of future availability. |

The OpenAI scheduled-task page also reports a Codex ChatGPT-sign-in model retirement on October 14, 2026, distinguishing it from API-key usage. This is an example of why entitlement mode belongs in a capability record; it is not a blanket API retirement claim. Recheck the cited page when implementing provider selection.

## Scheduling and workflow evidence

| Primary source | Verified contract | Design inference |
| --- | --- | --- |
| [Temporal Schedules](https://docs.temporal.io/schedule) | Distinct overlap choices; `BufferOne` retains the first buffered action, while `TerminateOther` does not wait for cooperative completion. Schedule pause does not pause already started work. Manual backfill is not bounded by the ordinary catch-up window. | Define product semantics independently, especially latest-event coalescing, safe replacement, disable/cancel and backfill limits. Do not map similar labels without checking behavior. |
| [Temporal schedule API source](https://github.com/temporalio/api/blob/master/temporal/api/schedule/v1/message.proto) | Calendar fields use AND; the source explicitly excludes cron's day-of-month/weekday OR special case. Literal DST matching can omit or duplicate a local clock occurrence. | The local evaluator's observed OR behavior cannot be copied as raw Temporal cron. AU-02 selects a canonical evaluator plus durable timers. |
| [Temporal workflow definition](https://docs.temporal.io/workflow-definition) | Workflow replay requires determinism. External effects cannot simply execute again inside replayed workflow code. | RALPH/provider/filesystem steps are recorded activities with stable domain step receipts; orchestration remains deterministic. |
| [Temporal worker operations](https://docs.temporal.io/best-practices/worker) | Documents code-version management and history growth/continue-as-new. | AU-09 defines bounded histories and a single-current-interpreter drain/checkpoint upgrade. Native worker versioning is not automatically a requirement to retain old runtime paths. |
| [GitHub scheduled workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) | Scheduled runs can be delayed or dropped under load and operate on the default branch. Current docs support a timezone option and describe their own DST behavior. | Use GitHub for CI/integration execution, not the authoritative clock for Machdoch schedules. Avoid outdated “GitHub cron is UTC-only” claims. |
| [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) | Defines recurrence rules and calendar constructs. | Publish an exact supported subset and deterministic normalization. Do not claim arbitrary RRULE support or mix its semantics with an undocumented cron parser. |

The mismatch is directly demonstrated locally: `0 9 1 * MON` next fires on October 26 and November 1, 2026 after October 22. An AND interpretation asks for a Monday that is also the first. This is a semantic integration defect even if both schedulers are individually behaving as documented.

### Orchestration alternatives

| Option | Assessment for this repository |
| --- | --- |
| Extend the existing file scheduler into the cloud | Valuable local scheduler and shared authoring foundation. Replacing relational authority, cross-device grants, durable waits and recovery with shared files would require rebuilding a distributed control plane. Keep it for private local authority. |
| Native Temporal Schedules as direct product schedules | Mature timer/overlap surface, but raw cron and buffer/pause/backfill semantics differ from required behavior. Would still need normalization, receipts and business admission. Not selected as a second recurrence authority. |
| Temporal timer workflows plus canonical recurrence and PostgreSQL admission | Selected. Reuses durable timers/replay/signals, preserves a single recurrence contract, and keeps organization/issue authority in the ledger. Cost: recurrence evaluation, cursor paging, history bounds and drain upgrades need deliberate tests. |
| GitHub Actions/Agentic Workflows as the primary suite | Useful repository event/CI/agent integration, but repository schedules and execution do not replace private-client remote control, planning/poker, cloud tenant identity or Machdoch's run admission. Integrate through current broker/receipts. |
| Generic integration workflow platform | Potential connector execution behind a scoped action contract. Do not introduce a second owner for Machdoch runs, schedules or grants merely to gain a visual editor; RALPH and the shared scheduler already provide authoring foundations. |

Additional alternatives checked: [n8n queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) documents separate workers and deployment/storage responsibilities; [BullMQ Job Schedulers](https://docs.bullmq.io/guide/job-schedulers/) provides a recurring-job abstraction. Both are useful building blocks in their own contexts. Neither eliminates Machdoch's need to implement scoped issue admission, effect reconciliation, device handoff and test-evidence contracts. Adding either alongside Temporal as another workflow owner would increase integration complexity without satisfying an otherwise missing requirement. This is an architectural comparison, not a performance benchmark of these systems.

One canonical recurrence evaluator does not mean implementing a new durable workflow engine. Select a maintained recurrence library that passes the declared semantics and conformance corpus; Temporal owns durable waiting/replay and PostgreSQL owns occurrence/admission records. Library selection and pinned version are implementation decisions, with unsupported semantics rejected rather than approximated.

## Event and test infrastructure

| Primary source | Finding | Applied decision |
| --- | --- | --- |
| [CloudEvents v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) | Released envelope contract with source/type/id and metadata conventions. The repository's main branch labels its next revision work-in-progress. | Pin a released schema; add authenticated tenant/causation metadata. Envelope conformance does not supply durable transport or deduplication. |
| [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), [transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [Tasks](https://modelcontextprotocol.io/extensions/tasks/overview) | Published current protocol/transport and an extension for durable task interaction. | Certify cloud MCP and the client binding together. A negotiated task handle maps to a real run; local SDK imports do not prove support. |
| [Playwright authentication](https://playwright.dev/docs/auth) | Shared authentication is unsuitable when concurrent tests interfere through server-side state; per-worker accounts are documented. | RT-02/RT-03 isolate browser and backend state separately, keep auth material scoped and out of artifacts. |
| [Playwright sharding](https://playwright.dev/docs/test-sharding) | Splits tests across machines and documents result merging. | Record required shard topology and assert all results belong to the same candidate; missing reports are not passing tests. |
| [Development container specification](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainerjson-reference.md) | Declarative environment/lifecycle settings can include commands, mounts and host-related requirements. | Import as reviewed environment input; prohibit repository metadata from granting host privileges. |

No Kafka/NATS dependency is required by this spec. PostgreSQL inbox/outbox and durable consumers are the initial transport authority. A broker may later be selected for measured delivery/load needs while preserving the same receipt and authorization contracts; it must not become a competing business ledger.

## Additional research and its limits

### Incident-Arena — submitted September 30, 2026

[Original abstract](https://arxiv.org/abs/2610.00648), [full text](https://arxiv.org/html/2610.00648v1). Evaluates incident repair in deployed application environments with injected faults and functional/system-level verification. Its 20-task, three-substrate setting is a bounded evaluation, not proof of safe unrestricted production repair.

**Apply:** isolated incident reproduction, sustained smoke/canary checks, independent verifiers, and explicit stop conditions after repair. Use RT-07 fault campaigns rather than giving incident agents general production authority. Distinguish root-cause repair from hiding the symptom. Treat benchmark scale and deployment context as limits; do not adopt its measured scores as Machdoch reliability targets.

### Traverse / failure localization — submitted September 15, 2026

[Original abstract](https://arxiv.org/abs/2609.17930), [full text](https://arxiv.org/html/2609.17930v1). Analyzes long-horizon agent trajectories and first-error localization. It reports harmful intermediate behavior even in some ultimately successful runs and evaluates a trained verifier for candidate selection.

**Apply:** preserve action-level evidence and invariants, classify the first failure separately from final outcome, and evaluate recovery quality. AU-13 and T-57 require this. **Experiment only:** using a learned verifier to rank candidate traces. A judge model is not a permission boundary or independent proof of correct code, and results across the paper's domains do not certify Machdoch's providers.

These papers were checked at abstract and relevant full-text methods/limitations level. Their environments, traces, trained models and results were not reproduced. Together with the earlier eleven papers, they inform a 13-paper review; citation count is not evidence that every possible architecture has been evaluated.

## Published changes to track

Keep deprecations and capability changes as reviewed operational data. The Perplexity retirement above has a specific announced date. Temporal's schedule documentation labels Workflow Pause pre-release; Machdoch pause relies on its own checkpoint/authority contract and does not require that preview. Managed provider environments remain subject to the beta/entitlement limits stated by their documentation. No unannounced roadmap is a release dependency.

The current research supports a suite that combines recurring and event-driven work with issue planning, private-device execution, isolated cloud work, test evidence and review. It does not support guaranteeing a “perfect” autonomous agent or replacing measured release verification with vendor announcements.
