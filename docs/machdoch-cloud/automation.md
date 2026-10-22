# Automation, recurring work, and events

Full-release requirements, reviewed 22 October 2026. This document makes P-10 and E-14 concrete. It defines product behavior; it does not claim that the cloud control plane exists. See the [integration audit](integration-audit.md) for the existing scheduler and the [research supplement](automation-research.md) for external evidence.

## AU-01 — Ownership and execution objects

An `Automation` has an organization, accountable human owner, execution principal, scope, enabled state, and immutable published revisions. Personal automation executes under that person's current grant; organization automation uses its own service principal. Changing the human owner does not silently change credentials or authority.

Distinguish these records:

| Record | Purpose and identity |
| --- | --- |
| AutomationRevision | Immutable trigger, action graph, configuration, permission ceiling, and evaluator version |
| Schedule | Recurrence and lifecycle owned by exactly one scheduler authority |
| Occurrence | One nominal schedule time, even if skipped, coalesced, late, or rejected |
| EventReceipt | One authenticated source event, independent of delivery attempts |
| TriggerDecision | The revision evaluated, match result, suppression reason, and selected occurrence/event |
| AutomationExecution | One admitted action graph; contains step executions and links to any agent runs |
| StepExecution | Stable action slot and iteration identity, input/output manifests, retries and side-effect receipts |
| Run | Agent work with an issue, project, maintenance or test-campaign subject; an implementation run always has a canonical issue |

Recurring issue creation, recurring agent execution, and a long-lived goal are different operations. Creating an issue does not authorize running it. Rechecking a project does not reopen its old implementation run. A continuing goal creates bounded executions with checkpoints, explicit completion/stop predicates, and an overall budget/deadline; it does not keep a model process alive indefinitely.

All agent runs use E-03 admission. Issue implementation retains the one-writer constraint. Project research and artifact-only reports need no fabricated issue, but still have grants, budgets, isolation, evidence, and resource reservations. An automation may create an issue and then admit its implementation as two attributable steps.

## AU-02 — One scheduling authority

Every schedule is either device-owned private work or cloud-owned work. A cloud schedule targeting a client is evaluated centrally even while that client is offline. The client accepts a particular attempt; it must not create its own recurring copy. Device-owned schedules continue independently and are remotely managed through Fleet with their ownership intact.

Promotion of a local schedule to cloud ownership is a transfer, not a copy: record the transfer intent, stop local admission, drain or reconcile existing claims, persist the final occurrence watermark and local acknowledgment, then enable the cloud schedule. A crash or offline device leaves the transfer pending and the cloud copy disabled. Returning ownership uses the same fenced transfer. Explicitly duplicating a schedule creates a separate disabled definition whose activation is a separate authorized action.

Reuse current scheduler editors, trigger vocabulary, RALPH definitions, and tested recurrence semantics after normalization. Extract a shared recurrence/condition module and execution contracts; keep storage and authority local for private jobs and in PostgreSQL for cloud jobs. Do not run the current workspace polling service as a second cloud scheduler.

**Cloud choice:** a Temporal schedule-coordinator workflow uses durable timers to wake the canonical recurrence evaluator. The evaluator transactionally advances a PostgreSQL cursor and materializes bounded pages of occurrences. Temporal supplies durability; it does not independently reinterpret raw cron or own business overlap policy. Do not also create native Temporal Schedules or host cron jobs for the same definition. This deliberately avoids conflicting cron semantics and supports one recurrence model in client and cloud. Compare the alternatives in the research supplement.

## AU-03 — Recurrence contract

Support one-time instants, fixed-rate intervals anchored to an instant, fixed-delay recurrence after the previous terminal outcome, and calendar recurrence. Calendar inputs include a structured editor, five-field cron, and a documented RFC 5545 RRULE subset sufficient for daily/weekly/monthly/yearly, selected weekdays, ordinal weekdays, end dates, counts, and exclusions. Reject unsupported RRULE clauses; never silently ignore them. Normalize all authoring inputs into one versioned recurrence definition before publishing.

Record IANA timezone, timezone-data version, start/end bounds, calendar/holiday revision, exclusions, nominal local time, resolved UTC instant, and recurrence policy. Fixed-rate intervals measure elapsed time; a daily calendar task preserves local clock time. Fixed-delay uses the domain terminal timestamp and never overlaps itself. Manual runs do not reset an interval's anchor or fixed-delay chain unless explicitly requested.

Required semantics:

- Cron day-of-month and weekday restrictions combine with OR when both are constrained. The grammar, including supported last-day/last-weekday syntax, is shared by preview and execution. Do not pass it unchanged to Temporal's different grammar.
- A nonexistent local time defaults to skipping that occurrence. An ambiguous local time defaults to the earlier instant once; an explicit `both` policy permits two independently identified occurrences. Show the next occurrences in the configured zone and UTC when editing a schedule near a clock change.
- For an invalid day such as February 31, skip; an explicit month-end rule means the last valid day. A leap-day schedule remains valid even if its next occurrence is more than a year away. Reject a truly unsatisfiable bounded recurrence distinctly from an evaluator/search limit.
- Business-day schedules use a configured, revisioned holiday calendar and explicit shift/skip behavior. Never infer a company's holidays from its timezone.
- Overlapping calendar rules within one trigger produce one occurrence per resolved instant. Multiple trigger slots may intentionally produce separate occurrences and remain subject to semantic action deduplication.
- Jitter is deterministic for an occurrence, bounded by its deadline, and changes dispatch time without changing nominal identity. Timezone/calendar changes create a new schedule revision; already admitted occurrences remain pinned.

Preview and coordinator must use the same evaluator and timezone data. The proposed defaults above are new product decisions, not claims about current client behavior.

## AU-04 — Misfires, overlap, and edit semantics

Missed-time policy and active-work overlap are separate settings:

| Dimension | Required options and behavior |
| --- | --- |
| Missed occurrence | `skip`, `latest`, or `bounded-all`; finite lookback, execution count, queue age, and spend limit |
| Active execution overlap | `skip`, `buffer-first`, `coalesce-latest`, `bounded-queue`, or `parallel` within declared distinct resource keys |
| Replacement | `cancel-and-replace` requests cancellation, waits for the old writer/effects to reconcile, then admits the new work |
| Existing issue run | Skip, record a bounded follow-up for after completion, or attach an observation; never create a competing writer or inject an unreviewed instruction |
| Stale input | Recheck current subject state before side effects; obsolete CI failures or resolved incidents become recorded no-ops |
| Failure storm | Pause-on-failure threshold/circuit breaker, operator-visible reason and controlled probe/re-enable |

Default overlap is `skip`; projects can select coalescing for continuously arriving alerts. `parallel` cannot override issue/ref/hardware reservations. Hard termination of a workflow is not proof its external activity stopped and is not an overlap mode.

For `latest`, compute the latest eligible occurrence across the entire missed window before enqueueing; do not emit one result for every pagination chunk. Persist an accounted-through cursor, including skipped/coalesced ranges, atomically with occurrence receipts. Very long outages cannot create unbounded scans, rows, execution queues, or costs. Manual backfill previews a bounded time range and cost ceiling, passes current authorization, and reuses original occurrence identities. Re-executing a completed occurrence requires a distinct explicit replay command and linked execution identity.

Publishing a revision establishes a serialized effective boundary. At first authenticated ingress, bind an event to the applicable active automation revision using the server's ordered receipt/effective boundary, not an untrusted source timestamp. Scheduled nominal times bind to their effective schedule revision, including overdue times; newly published revisions never apply retroactively without explicit backfill. Delayed delivery does not mean reevaluation against every revision. Disable blocks new admissions and invalidates queued work before its next step; running work continues under its pinned revision unless the user chooses `disable-and-cancel`. Policy revocation and the emergency kill switch stop new effects immediately regardless of revision. Re-enable does not execute disabled-period work unless its explicit catch-up/backfill policy admits it.

## AU-05 — Event envelope and catalog

Use a CloudEvents 1.0 envelope with a pinned released schema, plus Machdoch metadata. Required data: immutable event ID, authenticated source/installation, type/schema revision, organization, subject identity and revision, occurred/received times, origin actor, correlation/root-cause/parent IDs, trace context, data classification, and bounded payload or artifact reference. The receiver derives organization/source authority from credentials; payload fields cannot assert it. CloudEvents defines formatting, not delivery, ordering, trust, or exactly-once execution. [Released specification](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md).

| Event family | Required examples and authority |
| --- | --- |
| Planning | Issue created/changed/ready/blocked, assignment, dependency unblocked, cycle boundary, project milestone/health, approval decision; domain outbox |
| Source control | Push, PR head/review/check/merge/close, merge-queue candidate, release, deployment; authenticated repository installation |
| Execution | Run/step/checkpoint/question/timeout/budget/cleanup state; accepted ledger transitions, not arbitrary runner messages |
| Device | Online/offline, capacity, health, workspace binding, model/tool availability, drain/update result; device identity plus server observation |
| Workspace | Selected file/Git/build/service changes; scoped local observer with binding identity and scan cursor |
| External | Signed webhook, poll result, incident/error alert, customer request, permitted message/email/calendar change; configured connector |
| Time and absence | Schedule due, SLA exceeded, no heartbeat, missing expected result; durable timer plus recheck of current state |
| Manual | Authenticated Run now, API/MCP command, approved backfill/replay; attributable actor and request key |

Clipboard and raw desktop/activity monitoring stay device-local unless explicitly configured with consent and data scope. No automatic upload of local file bodies, chats, environment variables, or secrets. A trigger type string is not proof that an authenticated producer exists.

## AU-06 — Delivery, identity, and ordering

Domain mutation and its outbox event commit together. External webhook ingress verifies authenticity, applies size/rate limits, commits an inbox receipt, then acknowledges. Async workers validate payload schema and resolve permissions before evaluation. Invalid/unsupported events enter a bounded quarantine with an accessible reason; poison events do not block unrelated subjects.

Maintain these independent uniqueness boundaries:

| Boundary | Canonical key |
| --- | --- |
| Ingress delivery | Organization + authenticated source installation + source event ID; compare payload digest on reuse |
| Scheduled occurrence | Organization + schedule ID + schedule revision + nominal occurrence ordinal/UTC instant and fold identity |
| Event trigger decision | Organization + stable automation ID + stable trigger slot + event ID; evaluated automation revision is stored data, not a way to bypass prior consumption |
| External action | Semantic operation + target + expected target revision + originating execution/action slot; retry keeps the same receipt |
| CI repair or incident repair | Repository + head SHA + failing check identity, or incident + incident revision, plus the canonical issue writer constraint |

An ingress duplicate cannot start again after an automation edit. Separate automations can both match an event; semantic action receipts and issue admission still prevent competing repairs. A new automation with a copied definition is a distinct actor and must pass normal enablement/admission.

Per-subject revision order is meaningful; no global wall-clock ordering is promised. Late observations cannot regress current state. When a source supplies no trustworthy order, fetch current state before a consequential decision. Keep source sequence and accepted run sequence distinct. A compromised device cannot turn a fabricated `run.succeeded` message into an authoritative domain event.

Retention must not remove correctness: keep compact receipt/tombstone identities beyond supported redelivery/backfill windows. Closed source epochs or expired replay horizons reject old events explicitly after tombstone compaction; they do not treat them as new. Event logs can expire independently. Cross-source duplicates use a declared semantic key, never a guess based on identical text.

## AU-07 — Conditions and stateful triggers

Conditions are typed, bounded, deterministic expressions over an authorized event snapshot and explicitly fetched domain facts. No arbitrary JavaScript, shell, SQL, or network execution inside a filter. Compile/validate on publication, bound expression complexity, define null/missing/type behavior, and record the facts used. AI classification is a separately budgeted step with structured output and uncertainty; it is not an authorization condition.

Support all/any/not, field comparisons, transitions, path/branch/label filters, windows, debounce, throttle, cooldown, thresholds and recovery thresholds. State is partitioned by organization, trigger, and subject/correlation key: a recovered incident must not reset another incident's alarm. Persist window members, first/last arrival, next firing, and state transitions. Trailing debounce also has a maximum wait so continuous events cannot postpone work forever. Recovery and repeat timers survive restart and recheck state even when no new sample arrives; missing telemetry is unknown, not healthy.

Durable event joins specify correlation keys, required inputs, timeout, late-event behavior, and consumed members. For example, `PR updated AND required checks complete` must refer to the same head SHA. Absence triggers are timers canceled or invalidated by the expected event. A joined payload cannot be widened to include inaccessible projects.

## AU-08 — Loop prevention and backpressure

Propagate a trusted root cause, parent execution, and automation ancestry through domain mutations and outgoing integration metadata. Block re-entry of the same automation/action for the same causal subject unless an explicit bounded iteration permits it. Restrict total depth, descendants, actions per subject/time window, elapsed duration and cumulative cost. These limits apply to A → B → A cycles and to children created through MCP or connectors.

External systems may strip metadata. Persist source/action associations and semantic target fingerprints so a round-trip comment, label or PR update can still be recognized. Exclude runner-owned worktrees, generated outputs, dependency directories, and internal state from ordinary workspace watches by policy. Locally detect changes with hashes/cursors and reconnect rescan; filesystem notification delivery is not a reliable global event journal.

Reserve control/recovery capacity separately from event ingestion, artifact traffic, and LLM work. Apply per-organization/source/workflow quotas, bounded batches, fair queues, retry backoff, and dead-letter handling. Expose accepted, suppressed, expired, rejected, and dead-letter counts. A no-op is a legitimate outcome and should not create an issue or notification solely to demonstrate activity.

## AU-09 — Durable workflow and RALPH boundary

Use one versioned action graph with typed inputs/outputs, conditions, bounded iteration/fan-out, waits, parallel joins, deadlines, agent steps, deterministic actions, approvals, and compensation. RALPH remains the shared authoring and step-semantics foundation. Compile admitted cloud definitions to a durable orchestration representation; local step execution uses the same semantics. Do not nest a complete self-scheduling RALPH run inside a retrying Temporal activity with a second independent lifecycle.

Temporal workflow code performs deterministic orchestration. Provider calls, clocks from external systems, filesystem/network operations and LLM decisions run as recorded activities. An activity retry resumes/reconciles its StepExecution identity before starting work; it cannot blindly rerun a whole agent after a timeout. Human waits and remote execution wait for durable signals/ledger state without holding an activity worker or expensive sandbox indefinitely. Polling reconciliation remains bounded when callbacks are lost.

Store artifacts externally; workflow history carries bounded manifests/references. Continue-as-new transfers pending command IDs, cursors, child references and generation state at a safe boundary; the logical execution ID and receipts remain stable. Explicitly map logical run, Temporal workflow ID, engine execution ID, placement attempt, and provider session ID.

For the initial release, use a single current workflow interpreter and a drain/checkpoint upgrade contract. Stop admission, reach verified portable boundaries, reconcile effects, terminate drained engine executions, then start current code from domain checkpoints. A deployment that cannot safely drain cannot proceed. Do not introduce permanent old worker versions or runtime compatibility branches. Any future rolling-version strategy requires a separately approved current operational requirement and evidence for old in-flight work.

## AU-10 — Actions and permission ceilings

Deliver typed actions for issue/project/document updates, recurring issue generation, assignment, cycle planning suggestions, agent admission, RALPH execution, test campaigns, GitHub review/publication, permitted connectors, notifications, and resource lifecycle operations. Every consequential action uses the integration broker or revision-checked domain service.

Natural-language authoring produces a draft graph and scope diff. Publishing/activating follows current authorization; external content cannot activate workflows. A published grant has a maximum scope, data destinations, spend, concurrency, and expiration/review policy. Per-run grants are intersections with current policy. Pin skills, model/harness selection policy, context, and environment revisions. Automatic provider routing is permitted only among the explicitly authorized current choices and records actual selection.

Preauthorized workflows can investigate, implement, validate, publish, merge, deploy, or recover within their configured action ceiling. Approval records bind exact resource/diff/environment revisions; stale approvals cannot carry to a replacement candidate. Approval groups, escalation and expiry never turn silence into approval. A compensating action is a new authorized action; irreversible effects cannot be labeled rolled back merely because a workflow failed.

## AU-11 — Safe evaluation and operational controls

Offer definition validation, event simulation, recorded-event replay in a separate dry-run namespace, and shadow evaluation against live events. Dry-run does not use production write credentials, dispatch real devices, send messages, or mutate normal deduplication/cursor state. Optional live model evaluation is explicitly scoped and metered. Output previews show intended actions and reasons, not fabricated successful writes.

Promotion records the tested revision, representative events, permissions, expected actions, budget and accountable owner. Rollback publishes a new current revision; it does not rewrite past executions or reconnect a removed credential automatically. Support service-principal transfer, pause/resume, run now, bounded backfill, cancel, quarantine/retry, and an installation/organization/project kill switch.

The automation screen needs definition, trigger, owner, status, next run, recent outcomes and attention items. Detailed causation, source payload, skipped reasons and policy decisions appear on inspection. Show pending questions, stale credentials, missed work, and unknown side effects when they require action. Avoid permanently exposing internal scheduling rules as helper text.

## AU-12 — Required automation library

Ship configurable templates with declared inputs, scopes, output contracts and bounded execution. Templates start disabled; connection setup and scope selection are installation data. The table is a capability catalog, not preinstalled schedules for this workspace.

| Template family | Trigger → result | Required constraint |
| --- | --- | --- |
| Recurring work | Calendar → recurring issue, research report, or scheduled agent task | Separate issue creation from execution; explicit overlap |
| Continuous goals | Checkpoint/timer → next bounded goal iteration | Completion predicate, total budget, stop condition |
| Intake and triage | Report/message → deduplicated issue, proposed classification/owner | Provenance, private-source ACL, no fabricated requirements |
| Readiness and delegation | Ready issue/dependency resolved → admitted implementation | Acceptance criteria and eligible target |
| Cycle preparation | Cycle boundary → capacity/poker agenda and planning suggestions | Human estimates remain private until reveal |
| Cycle follow-through | Aging/blocker/SLA timer → escalation or bounded investigation | No automatic scope/estimate history rewrite |
| Project coordination | Milestone/dependency changes → bounded task graph | No cyclic dependencies or unlimited child generation |
| CI repair | Current failed check → reproduction/test/patch PR | One repair key per relevant head/check; obsolete events no-op |
| Review follow-through | Review comment → scoped fix and revalidation | Current PR head, authority and unresolved-thread identity |
| Repository gardening | Scheduled scan → dependency/security/docs/test improvement PR | Change limits, lockfiles, ownership and review capacity |
| Research and specification | Source/periodic change → cited findings and draft spec/issues | Retrieval dates, source provenance, reviewed durable facts |
| Drift detection | API/schema/docs/environment change → impact report or fix | Compare recorded versions; no silent environment mutation |
| Remote regression | PR/nightly/release → matrix campaign on cloud and clients | Required platforms/shards, reproducible data, complete evidence |
| Preview review | Candidate ready → private preview and acceptance checks | Isolated origin, expiring grant, cleanup ownership |
| Incident response | Alert → sanitized reproduction, regression test, fix proposal | Read-only production diagnosis unless separately granted |
| Release verification | Merge/deployment → smoke/canary checks and linked outcome | Separate release grant; rollback only when preauthorized |
| Customer follow-up | Delivered issue → draft or authorized source-channel reply | Current recipient/channel permissions and deduplication |
| Digests and meetings | Schedule → project update, change summary, agenda | Authorized sources/destination; no empty notification spam |
| Knowledge maintenance | Accepted change → proposed facts/skill improvement | Provenance, revision review, no unreviewed self-modification |
| Provider maintenance | Retirement/entitlement event → affected-run report and proposed route change | No silent model/data-destination switch |
| Fleet operations | Health/capacity/update event → diagnose, drain, approved update or recovery | Device ownership, working hours, canary verification |
| Environment operations | Setup failure/image change → rebuild or diagnosed fix | Separate image build authority, clean provenance |
| Resource stewardship | Budget/storage/idle threshold → drain/reap/report | Keep evidence and user files; fenced ownership checks |
| Recovery rehearsal | Approved schedule → isolated restore and synthetic fault campaign | Never target production by inferred URL or credentials |

The same building blocks support document/artifact processing, media generation, and non-code workflows on capable Machdoch runtimes. Connector availability and hardware determine placement; a template must not advertise an unavailable producer or tool as a working integration.

## AU-13 — Autonomous quality and spending

Optimize accepted outcomes per cost and human attention, not agent count. Admission considers review queue capacity and per-project open-change limits. Deterministic routing, filtering, timers and ledger operations must not spend model tokens. Reuse authorized, commit-bound evidence and content-addressed dependencies where valid; never reuse stale approvals or cross-tenant private caches.

Track separate outcomes for no-op, proposed change, accepted/rejected change, policy violation, recovery success, escaped defect, intervention, and unknown cost. Bound the entire causal tree's provider, runner, storage and integration usage. Failed/canceled children still consume budget; continuing a goal, replaying an occurrence, or switching providers cannot reset the limit.

Maintain versioned evaluations and human-reviewed samples of autonomous work. Test both final correctness and intermediate harmful effects. Automatic prompt/skill/policy improvement produces a candidate revision with evaluation evidence; it cannot modify its own permission ceiling or acceptance evaluator. Repeated failure pauses the affected workflow and preserves a diagnosable record.

## AU-14 — API and MCP integration

Extend A-04/A-07 with list/get/draft/publish/disable automation, preview schedule, simulate event, inspect occurrence/execution, run now, cancel, backfill, and transfer ownership. Use the same domain operations in web, CLI and cloud MCP. Publishing, enabling, replay and scope changes have separate permissions from reading and drafting.

All mutations have a request identity and expected revision. Return a durable execution/transfer handle for asynchronous work. Incoming webhook endpoints authenticate connector identities; they are not anonymous MCP tools. Event subscriptions are authorized reads and do not acquire authority to run matching actions. Return only accessible subjects in diagnostics, previews, replay results and suppressed-run references.
