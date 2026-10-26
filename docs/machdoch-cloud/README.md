# machdoch.cloud — full product specification

Research date: **22 October 2026**. Status: proposed target specification; no product implementation is claimed. Repository baseline: `c434cf99`, plus the working tree inspected on that date.

Current implementation and runtime checks are recorded separately in [implementation evidence](implementation.md). The specification below remains the complete release target.

Build machdoch.cloud as a self-hosted product development and agent execution suite: plan work, delegate it to Machdoch, execute it in cloud sandboxes or linked clients, review the evidence and changes, and follow delivery. Preserve machdoch.cloud's remote access as a first-class part of the suite.

The distinguishing capability should be **one accountable workflow across planning, private infrastructure, personal clients, cloud execution, and review**. A ticket with an agent button is insufficient. The product must manage the entire lifecycle, including uncertainty, interrupted execution, review capacity, failed integrations, and recovery.

## Specification map

| Document | Contents |
| --- | --- |
| [Product requirements](product.md) | Issues, projects, cycles, planning poker, agents, collaboration, remote clients, and complete user journeys |
| [Architecture and integration](architecture.md) | Existing code, target components, domain model, APIs, MCP, client connectivity, and provider integration |
| [Execution and recovery](execution.md) | Isolation, worktrees versus clones, admission, leases, duplicate prevention, handoffs, GitHub publication, timeouts, and failure matrix |
| [Automation, recurrence, and events](automation.md) | Schedule ownership, occurrence identities, misfires/overlap, event delivery, RALPH durability, controls, and 24 template families |
| [Remote testing and environments](remote-testing.md) | Test campaigns, platform matrices, data isolation, previews, repair loops, environment lifecycle, and operational verification |
| [Security and operations](security-operations.md) | Identity, SSO, magic links, authorization, sandbox security, self-hosting, observability, disaster recovery, and future tenancy |
| [Research and decisions](research.md) | Dated vendor findings, current and upcoming capabilities, papers, source links, and adoption decisions |
| [Automation research](automation-research.md) | Current vendor automation, scheduling alternatives, protocol/test infrastructure, and two additional reliability papers |
| [Integration audit](integration-audit.md) | Existing scheduler/runtime source map, 20 findings, corrected decisions, and executed baseline checks |
| [Delivery and acceptance](delivery.md) | Complete implementation sequence, acceptance scenarios, release gates, traceability, and unresolved deployment assumptions |
| [Verification and coverage](verification.md) | Review evidence, requirement-to-acceptance mapping, validation results, and remaining implementation limits |

These documents form one specification. **All numbered requirements are part of the full target**, unless explicitly classified as a research experiment or future commercial hosting. Implementation stages describe dependency order, not smaller product editions. An integration can be disabled by an installation's policy without being omitted from the delivered capability.

## Principal decisions

| Decision | Rationale |
| --- | --- |
| Separate organization, team, project, repository, and client workspace | A project can span repositories and machines; a local path is not a global project identity. |
| Keep a human accountable; record an agent delegate separately | Assigning automation must not erase ownership or review responsibility. |
| One durable execution model for cloud and clients | Switching execution location must preserve issue context, authority, evidence, budgets, and history. |
| One active implementation run per issue, enforced transactionally | UI disabling and in-memory locks cannot prevent concurrent starts from web, MCP, automation, and reconnects. |
| A separate filesystem and branch for every writer | Concurrent tickets must not edit the user's working directory or one another's checkout. |
| Worktrees for eligible trusted client jobs; independent clones in isolated cloud jobs | Worktrees are a useful Git mechanism, not an operating-system or security boundary. |
| A durable workflow engine plus a PostgreSQL execution ledger | Long-running work needs persisted waits, retries, scheduling, cancellation, and reconciliation. |
| One authority per schedule; shared recurrence semantics | Preserve private local schedules, transfer cloud ownership explicitly, and avoid client/cloud double firing or cron semantic drift. |
| Durable event and action receipts independent of history retention | Redelivery, automation edits, replay and integration round trips must not create new authority or duplicate repairs. |
| Test campaigns require complete candidate-bound evidence | Missing shards, unsupported hardware, disconnected clients and agent-written summaries cannot count as successful verification. |
| Reuse the Machdoch runtime and product UI | Preserve provider behavior, instruction delivery, RALPH, media, settings, and remote interaction instead of creating a second agent implementation. |
| Separate agent proposals from permission enforcement and publication | A model cannot award itself access, approve its own escalation, or declare a merge authorized. |
| Current protocol contracts and an explicit cutover | Preserve functionality and data; do not maintain a parallel legacy Fleet implementation. |

## Coverage of the requested scope

| Requested outcome | Requirement location |
| --- | --- |
| Issues with direct client assignment and execution | P-02, P-07, P-08; E-01–E-04 |
| Cycles and planning poker | P-04, P-05 |
| Cloud MCP directly available in Machdoch clients | A-07, A-08; S-04 |
| Full autonomous cloud agent, providers, checkout, GitHub | P-07, P-09; A-09; E-05–E-11 |
| Project/workspace management | P-01, P-03; A-03 |
| Parallel handoffs, duplicate runs, deadlines, deadlocks, automation | E-01–E-15; P-10 |
| Preserve remote access to clients | P-08; A-01, A-06; D-02 |
| Multiple users, SSO, magic links | S-01–S-03 |
| Self-host now; organizational isolation suitable for future hosting | S-06–S-09 |
| Additional Linear-inspired features and useful combinations | P-06, P-09–P-15; research decision tables |
| Current research and upcoming vendor changes | Research evidence and watch list |
| Recurring AI tasks, continuing goals, events and triggers | AU-01–AU-14; T-36–T-46, T-54–T-60 |
| Remote testing, sandbox and fleet automation | RT-01–RT-07; T-47–T-52, T-61–T-65 |

## Current evidence changes the plan

The follow-up audit found an existing client scheduler that should be reused, plus concrete integration hazards: cron OR/AND differences, ambiguous DST behavior, sparse recurrence limits, history-bound local deduplication, revision-dependent trigger replay, overlapping scheduler ownership, and unspecified remote-test aggregation. The [audit](integration-audit.md) records the evidence; [automation](automation.md) and [remote testing](remote-testing.md) define the corrected contracts. Four focused existing test files passed all 40 tests; this verifies those local foundations, not a cloud implementation.

Linear already offers cloud coding sessions, event-driven and scheduled Loops, and integrated review. Its October 8 update adds stacked PR presentation, live coding diffs, and AI spending controls. These belong in the competitive baseline. [Coding sessions](https://linear.app/docs/coding-sessions), [Loops](https://linear.app/docs/loops), [October 8 update](https://linear.app/changelog/2026-10-08-stacked-pull-requests).

Managed agent harnesses are also becoming integration options: OpenAI announced its Agents API in public beta on September 10; Claude Managed Agents documents both vendor-hosted and self-hosted execution. Machdoch should support these as explicit provider choices while retaining its own orchestration and execution capability. Self-hosted tools do not imply that prompts and tool results remain local. [OpenAI announcement](https://openai.com/index/introducing-the-agents-api/), [Claude environment model](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment).

The repository already contains real foundations: durable Fleet session routes, outbound gateways, shared remote views, headless execution, provider adapters, and RALPH worktrees. Existing audits also record unfinished remote interactions and unverified physical-device/provider workflows. Preserve what exists and close those documented gaps; do not assume remote parity is already complete. [Current baseline and source map](architecture.md), [latest inspected parity audit](../fleet-manager-parity-audit-2026-10-06.md).

## Product boundaries

The full solution includes planning, autonomous implementation, review, bounded delivery automation, remote client control, research, documents, and existing Machdoch media capabilities. A complete agent can operate for hours or days with explicit resource limits and resumable checkpoints; autonomy does not mean unlimited spending or uncontrolled access.

Future commercial hosting, subscriptions, tax handling, reseller billing, and a public marketplace are outside this self-hosted release. Organizational isolation, export, quotas, and installation-independent identifiers are required now. The suite is not intended to replace GitHub's repository protections, a company's identity provider, or its production deployment platform.

No document promises exhaustive coverage of every possible failure. The execution matrix and release gates define the failure classes that must be demonstrated, and the operations model provides a way to diagnose and safely stop cases outside them.
