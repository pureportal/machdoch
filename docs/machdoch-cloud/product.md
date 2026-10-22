# Product requirements

This is the full target experience. Requirements are normative for the proposed product. Technical guarantees and their limits are defined in [execution](execution.md) and [security](security-operations.md).

## P-01 — Organization and work model

Use these distinct concepts consistently:

| Object | Meaning |
| --- | --- |
| Organization | Membership, identity policy, data boundary, integrations, budgets, and audit ownership |
| Team | People, issue workflow, intake, cycle cadence, estimation scale, and responsibilities |
| Initiative | Outcome spanning projects, with an owner, progress, target dates, and dependencies |
| Project | Persistent body of work linked to repositories, documents, milestones, and execution policies |
| Repository | Canonical source-control identity, independent of its URL or local checkout |
| Client workspace binding | An authorized link from a project/repository to a specific client's workspace |
| Issue | A unit of accountable work with a human owner and optional agent delegate |
| Run | One authorized effort for an issue, project, maintenance task or test campaign; implementation always binds a canonical issue; contains attempts and subtasks |
| Attempt | One execution placement with its own environment, credentials, lease, and evidence |
| Change set | The candidate commits, PRs, artifacts, and review state produced by work |

Organizations contain teams and projects. Projects may involve multiple teams and repositories. A repository can serve several projects with the same underlying source identity; project naming must not bypass repository concurrency controls. A folder is never silently linked based only on its name or remote URL.

Support private teams and projects, project guests, archived work, ownership transfer, team membership changes, and repository renames/transfers. Membership revocation affects search, notifications, documents, artifacts, MCP, running work, and remote sessions.

## P-02 — Issues and intake

Provide keyboard-first list and board views, saved filters, search, bulk operations, and persistent shareable URLs. Every issue has an immutable internal ID and a readable team key. Renaming teams preserves historical references.

Required issue capabilities:

- Title, rich description, acceptance criteria, attachments, priority, severity, type, labels, due date, estimate, custom typed fields, subscribers, and audit history.
- A single accountable human owner; an agent delegate and execution target are separate fields. Team queues can hold unassigned work.
- Configurable workflow states mapped to stable semantic categories, such as backlog, ready, active, blocked, review, complete, and canceled.
- Parent/sub-issues, blocking and related links, duplicate merging, templates, recurring issues, checklists, comments, mentions, reactions, and versioned edits.
- Triage inbox, rotation or named triage responsibility, routing rules, snooze, SLA targets, escalation, and duplicate suggestions.
- Intake from the web UI, MCP/API, GitHub, email, and installed collaboration/incident connectors. Preserve source identity and attribution.
- Drafts, optimistic edits with revision conflicts, undo for reversible mutations, archive/restore, controlled permanent deletion, and export.

An issue may be planned before it is executable. Starting an implementation requires a selected repository or an explicit artifact-only task, acceptance criteria, execution policy, and sufficient authorization. Missing information is requested at the start point; a background agent must not invent product requirements.

AI may propose decomposition, priorities, labels, and duplicates. Applying changes follows the actor's permission and automation policy. An agent-generated comment cannot authorize a new run merely by containing an imperative sentence.

**Acceptance:** creating the same issue through a retried intake delivery creates one issue; users lacking access cannot infer a private issue through counts, references, or search snippets; workflow changes preserve recorded cycle and run history.

## P-03 — Projects, repositories, and workspace bindings

Projects provide an overview, issues, documents, milestones, dependencies, roadmap/timeline, updates, change sets, runs, environment definitions, and linked clients. Project status, health, lead, participating teams, target dates, and labels are editable and versioned.

Link one or more repositories, pin a default development branch per repository, and support monorepo subpaths. Store repository access separately from project visibility. Link client workspaces through a device-side verification step that checks repository identity, actual root, supported tools, and trust policy.

Allow creating a project from a repository, linking an existing client folder, provisioning a clean checkout, and importing an existing project. A non-Git project can produce artifacts but cannot pretend to provide branch/merge isolation. It must use a per-run directory or an exclusive workspace reservation.

Environment definitions include image/toolchain versions, setup commands, dependency sources, service requirements, network policy, architecture/OS, resource requests, secrets references, and validation commands. Configuration changes create new revisions. Users can inspect setup failures and request an agent-assisted fix as a separate change.

A project's identity survives relocation of a client folder, replacement of a device, renaming of a repository, and archival of an environment. Broken bindings become unavailable and offer a relink action; the system must never silently choose a similarly named directory.

## P-04 — Cycles and capacity

Support team-specific recurring cycles with explicit local timezone, start/end dates, optional cooldown, capacity, cycle goal, backlog planning, and historical snapshots. Cycles and releases are independent.

Required behavior includes drag/drop planning, future cycles, backlog refinement, configurable carryover, scope change history, burndown/burnup, completed versus carried work, and cycle retrospectives. Prevent overlapping cycles within one cadence. A team may use continuous flow instead of enabling cycles.

Capacity includes people availability, holidays, allocation across teams, historical throughput, and review capacity. Agent execution capacity is tracked separately as runner slots, provider quotas, cost allowance, and expected review demand. Do not add agent tokens to story points or rank people by agent-generated code volume.

Provide probabilistic delivery forecasts with the underlying sample size and assumptions available on inspection. With insufficient history, show no manufactured forecast. Changes in estimates after the cycle begins must not rewrite the original commitment. Cross-team moves cannot leave an issue in an invalid cycle or estimation scale.

**Acceptance:** cycle transitions occur once through restarts and daylight-saving changes; carryover preserves original scope; execution completion alone does not inflate delivered work before the team's completion rule is met.

## P-05 — Planning poker

Deliver native planning poker so self-hosted planning has no mandatory external dependency. Also expose an authenticated integration contract for an external poker tool to read the permitted issue agenda and submit agreed estimates. Do not claim compatibility with a named service until its API and authentication are tested.

Required capabilities:

- Live and asynchronous rooms scoped to a team/project; ordered issue agenda; facilitator, participants, observers, and invitations constrained by issue access.
- Team-defined card sets, including Fibonacci, T-shirt sizes, unknown, and abstain. Store the scale/version with every round.
- Hidden votes until reveal, one effective vote per participant per round, reconnect recovery, late-join rules, timers, discussion, revoting, facilitator transfer, and explicit close.
- Reveal is a server-authorized state transition. Hidden vote values must never be present in broadcast payloads, browser caches, ordinary analytics, or MCP responses before reveal.
- Distribution and disagreement view after reveal; facilitator records an agreed estimate and rationale. Never silently write an average as team consensus.
- Version-checked estimate writeback. Concurrent estimate edits surface a conflict; a changed issue description can mark a round stale and request a new round.
- A participant cannot vote through multiple tabs as multiple people. Withdrawal, expulsion, session expiry, and invitation revocation have deterministic rules.

An AI estimate is a separately labeled suggestion with evidence and uncertainty. Keep it hidden until human votes are revealed to reduce anchoring; it is not a human vote and cannot see unrevealed votes. Capacity forecasts use the team's finalized value.

**Acceptance:** unauthorized users and agents cannot retrieve hidden votes; server restart preserves the current round; a lost writeback response cannot apply the estimate twice; closing or restarting a round rejects late votes for the previous round.

## P-06 — Documents, context, and discovery

Provide collaborative project/initiative/cycle documents with comments, history, restore, templates, attachments, and links to source issues and code. Use a proven collaborative editing mechanism for document bodies; scalar issue properties use revision-checked updates.

Search issues, projects, documents, decisions, permitted code indexes, run evidence, and artifacts. Support exact IDs, structured filters, full-text search, and an optional semantic layer. Search authorization applies before retrieval/ranking; vector retrieval cannot become a side channel into another project.

Project knowledge consists of explicit documents and evidence-backed facts, not an unreviewable accumulation of conversation summaries. Every durable fact has provenance, scope, author, timestamp, and a revision/invalidation mechanism. Code-derived facts include the repository and commit. Expired facts do not silently become authoritative instructions.

Research agents produce cited findings with publication/access dates, distinguish vendor statements from independently evaluated results, and can create proposed issues or update a draft specification. They must not transform external text into execution authority.

## P-07 — Agent execution experience

Users can start work from an issue, a project instruction, a comment addressed to an installed agent, a cycle selection, or a configured automation. Multi-issue starts display which issues were admitted, already active, blocked, or ineligible.

Execution policies select a cloud runner pool, a particular client binding, an eligible client pool, or an explicitly configured automatic placement policy. Show target, provider/harness, permitted side effects, and budget where the user chooses execution. A target being offline does not grant permission to export code to another target.

The run view includes current phase, responsible actor, target, elapsed time, cost/usage, significant activity, live diff, test results, artifacts, pending questions, and failure/recovery state. Users can steer, supply attachments, pause at a safe boundary, cancel, inspect, resume, or take over according to permission.

Required agent abilities include repository investigation, planning, implementation, test execution, browser verification, debugging, code review, documentation, research, and PR preparation. Existing RALPH flows, GOAL modes, media generation, and audio workflows remain available through supported runner capabilities.

Complex work supports an explicit subtask graph and bounded specialist agents. The orchestrator decides when to parallelize using dependencies and budgets. Each writer owns an isolated checkout. Reviewers receive evidence and can reproduce checks. No agent can make its own assertion of success count as independent verification.

Permit autonomous completion through PR publication and, where an administrator has configured it, merge and deployment actions. Repository rules, protected environments, and action-specific policy always apply. Avoid per-tool prompts for work already covered by a grant; request a decision only when the operation exceeds that grant or requires human judgment.

**Acceptance:** the same issue workflow runs on a cloud sandbox and a linked client with equivalent context, lifecycle, evidence, and review controls; unavailable capabilities are rejected before execution; cancellation survives closing the browser.

## P-08 — Clients and preserved remote access

Keep Clients as a primary suite area, with inventory, enrollment, health, resource availability, workspace bindings, active sessions, recent failures, settings profiles, and remote opening of a specific session.

Preserve the existing product surfaces: Chat/composer, sessions, instructions, context packs, scheduler, workspaces/files/Git, terminal/processes, service controls, private previews, settings, RALPH, Media Studio, speech, and Android/browser access. Share the actual product components and native/headless commands where applicable.

Every feature must have a capability entry identifying desktop, headless, browser-controller, Android, and cloud-runner support. Remote hardware actions require a device possessing that hardware. A browser controller is not itself a worker. Existing headless gaps and incomplete transcript/session interactions must be explicitly resolved or classified as genuinely device-only capabilities, with a usable device route.

Remote browsing and execution rights are independent. A project guest must not gain the ability to control the entire device. Connections are scoped to the chosen workspace/session. Multiple viewers can observe; terminal input, desktop control, and destructive workspace mutations require a single active control grant with visible transfer.

Local work continues to exist independently of the cloud. A device owner can stop accepting cloud jobs, set working hours/resource limits, drain existing work, and revoke access. Cloud-managed issue work still follows the cloud's lease and partition policy.

## P-09 — GitHub, review, and releases

Use a GitHub App for installation-scoped repository access and event ingestion. Support GitHub.com and configured GitHub Enterprise hosts; installation permissions and repository selection are explicit.

Required workflow:

- Link issues, branches, commits, PRs, review comments, checks, deployments, and releases using durable identifiers.
- Publish a draft PR with issue context, implementation summary, verification evidence, limitations, and artifact links.
- Review live and committed diffs, file history, comments, resolved threads, checks, merge conflicts, and stacked PR dependencies within the suite.
- A reviewer can turn a comment into a bounded follow-up run. The current PR head and comment revision become inputs.
- Respect CODEOWNERS, required checks, approvals, merge queues, branch protection, and GitHub's authorization. Re-evaluate when the head SHA changes.
- Provide a personal/team review inbox, attention filters, notifications, batch navigation, and mobile review.
- Track release stages, changelogs, included issues, deployment evidence, regressions, and revert/change links. A merged PR does not prove successful deployment.

Issue completion is policy-driven: for example merged, deployed, or explicitly accepted. One PR can address multiple issues and one issue can require multiple PRs; the relationship must express whether all or selected changes are required. A closed-unmerged PR, reverted commit, or partial cross-repository release cannot blindly complete its issue.

## P-10 — Automation

Provide versioned workflows with event triggers, schedules, conditions, actions, bounded agent steps, human decisions, and run history. The complete behavioral contract is [AU-01–AU-14](automation.md), including the required template library. Author through a structured editor or natural language that produces a reviewable workflow definition. RALPH is the shared authoring and step-semantics foundation; Temporal supplies durable cloud orchestration through one lifecycle owner.

Triggers include intake, issue transitions, cycle boundaries, project updates, PR/check events, incidents, repository changes, and schedules. Actions include triage, research, drafting updates, delegating implementation, checking delivery, and notifying authorized channels.

Each workflow has an owner/service principal, permitted scope, concurrency policy, cost limits, maximum duration, retry policy, causal event ID, recursion limit, and kill switch. Include dry-run against recorded events. Loops cannot repeatedly trigger themselves through their own comments or status changes.

Queued executions retain the workflow revision that admitted them. Editing, disabling and canceling follow AU-04's serialized boundary and queue/running rules. Scheduled catch-up after downtime is configurable as skip, latest, or bounded replay, independently of overlap policy. Private local schedules remain device-owned; cloud schedules dispatch explicit attempts and are never independently evaluated on both sides. Removed users cannot leave uncontrolled personal automations running.

Recurring issue generation, recurring agent runs, and checkpointed continuing goals are separate choices. Event/state/absence triggers, bounded joins, debounce/coalescing, dry-run/shadow evaluation, backfill, causal loop limits and kill switches are full requirements. Remote test campaigns and environment operations follow [RT-01–RT-07](remote-testing.md).

## P-11 — Customer feedback and incident linkage

Maintain customer/request records linked to issues and projects, with source conversations, affected versions, impact, and deduplication. Keep customer attributes and sensitive attachments permission-scoped. Combine repeated reports into a proposed issue without losing who requested it or promising a delivery date.

Support installed Slack/Teams, email, and incident/error-monitoring connectors through typed contracts. A connector unavailable in a self-hosted network reports its state; it does not silently export data through another provider.

An incident-to-fix workflow can collect sanitized evidence, reproduce in a sandbox, create a regression test, propose a patch, and link deployment validation back to the incident. Production actions require their own permission boundary and do not follow automatically from permission to read an alert.

## P-12 — Inbox and collaboration

Provide mentions, assignments, subscriptions, digests, questions awaiting response, approvals, review requests, failures, and completion notifications. Group updates by issue/run; allow snooze and quiet hours. Actionable failures must remain discoverable when notifications are muted.

Presence indicates who is viewing or controlling a session, not whether a job is safe to steal. Read/unread state synchronizes per user. Notification delivery is deduplicated, retries are bounded, and permission is checked again at delivery and when opening a deep link.

## P-13 — Analytics and budgets

Track lead/cycle time, throughput, aging, blocked time, review time, carryover, accepted changes, escaped defects, reverts, agent intervention rate, and cost per accepted outcome. Separate model spend, sandbox time, storage, integration calls, and local estimates.

Budgets apply to organization, team/project, workflow, user, run, and delegated child work. Reserve before dispatch, reconcile reported usage, and show unknown costs as unknown. Stop admission when limits are reached; in-flight overshoot is bounded by the execution contract.

Compare providers and harness versions using the same task cohorts and acceptance criteria. Never use benchmark marketing scores or generated lines of code as evidence of business productivity.

## P-14 — Interface and accessibility

Use the existing shared design system, with compact navigation around My work, Issues, Cycles, Projects, Reviews, Runs, Automations, and Clients. Tests and Environments are project/run views; advanced administrative configuration remains in Settings. Contextual actions should act on the selected object, with stable URLs and a global command menu.

Provide responsive browser and Android-controller flows, keyboard navigation, screen-reader semantics, focus restoration, reduced motion, accessible contrast, localization-ready strings, and timezone-aware dates. Preserve drafts through navigation, reconnect, permission errors, and refresh where local storage policy permits.

Do not fill pages with implementation explanations. Show only labels, necessary state, input constraints, and actionable errors. Raw logs, protocol diagnostics, and full activity traces belong behind inspection controls.

## P-15 — Combined workflows that justify the suite

| Workflow | Required end-to-end result |
| --- | --- |
| Feedback → planning → delivery | Customer report links to a deduplicated issue, poker estimate, cycle commitment, run, PR, release, and authorized requester update. |
| Cloud investigation → client reproduction → cloud review | A Linux agent investigates, a Windows/macOS client reproduces a platform-specific issue, and the same run retains evidence and authority across placements. |
| Overnight execution → morning review | A bounded cycle batch completes isolated changes while review capacity limits avoid an unmanageable PR queue. |
| Failed CI → bounded repair | A verified check failure triggers one repair effort for the exact head; stale or repeated events do not spawn competing writers. |
| Research → specification → implementation | Cited research creates a reviewable specification; accepted requirements become issues and evidence-based acceptance checks. |
| Release → observed regression → fix | A deployment failure links back to the originating change and creates a separate, traceable remediation effort. |
| Client session → project work | A user promotes selected local context into an issue, links the workspace, and delegates without uploading unrelated history or credentials. |

Each workflow is part of delivery acceptance, not merely a demonstration mockup.
