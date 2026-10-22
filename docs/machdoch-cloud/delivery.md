# Delivery plan and acceptance

The release objective is the entire specification. The stages below define engineering dependencies and evidence gates; none is a reduced-scope product launch. No calendar estimate is asserted without staffing, infrastructure, and repository-specific measurements.

## D-01 — Implementation workstreams and order

| Stage | Deliverable | Dependencies | Exit evidence |
| --- | --- | --- | --- |
| 1. Domain and contracts | Organization/team/project/repository/workspace identity, run/attempt/grant model, schema, API/error/event contracts, permission model | Baseline inventory | Reviewed schema constraints, transition model, API examples, tenant/authorization tests |
| 2. Durable control plane | PostgreSQL persistence, inbox/outbox, Temporal integration, schedule/occurrence and trigger receipts, idempotency, budgets, audit and artifact services | Stage 1 | Crash/replay/admission campaign; no double writer, dual scheduler authority or lost accepted command |
| 3. Identity and client continuity | Multi-user auth, SSO/magic links, device identity, scoped remote sessions, shared UI preservation, capability registry | Stage 1; ledger from stage 2 | Two organizations/users and real desktop/headless clients exercise permissions, remote controls, revoke/reconnect |
| 4. Planning and collaboration | Issues, projects, initiatives, cycles, poker, documents, search, inbox, intake, customer feedback, analytics | Stages 1–3 | Complete planning/poker/collaboration journeys including conflicts and permissions |
| 5. Owned execution | Shared runtime extraction, cloud sandbox controller, client worker claims, isolated repositories/services, checkpoints, handoffs, test campaigns and environment lifecycle | Stages 2–3 | Real cloud/client and required-platform tests, complete shard evidence, failure injection, preserved source workspace, bounded cleanup |
| 6. Source, agents, and integrations | GitHub App, publication broker, PR review/stacks, release linkage, provider adapters, cloud MCP/client registration, external agents/connectors | Stages 2–5 | Real repository/provider/MCP workflows with revoked access and ambiguous-action reconciliation |
| 7. Autonomous workflows | AU-01–AU-14: shared recurrence/conditions and RALPH semantics, trigger/state/join workflows, continuing goals, 24 template families, dry-run and operations | Stages 4–6 | End-to-end combined journeys, recurrence/replay/budget/deadlock/loop tests, ownership and workflow changes during execution |
| 8. Production qualification and cutover | Reference deployments, upgrade/import/export/restore, scale, security, accessibility, operator docs, complete remote/provider matrix | All previous stages | Every release gate below met with attributable artifacts and remaining limitations explicitly resolved |

Stages 3–5 can proceed concurrently once their shared contracts stabilize. Security and observability are implemented with each feature, not postponed to stage 8. Assign responsible engineering owners to product planning, runtime/runners, identity/integrations, and operations/evaluation; one owner must maintain the cross-system lifecycle contract.

Deliver each stage as coherent changes with focused tests. Expand to complete end-to-end and fault campaigns at the integration gates. Do not repeatedly run the whole repository suite after every edit, or call isolated component passes proof of distributed recovery.

## D-02 — Fleet preservation gate

Create a machine-readable capability inventory from the actual commands and UI. Each entry records implementation location, controller surfaces, supported runner platforms, authorization scope, and acceptance evidence. The October 6 audit is the starting inventory, not the final truth after implementation.

| Existing capability | Required result after cutover |
| --- | --- |
| Enrollment, revocation, reconnect | Preserved devices or explicit verified reenrollment; no silent credential loss |
| Global clients/workspaces/sessions | Same selected device/session can be opened and controlled with the user's scoped rights |
| Chat, GOAL, composer, queues, model/reasoning controls | Actual shared controls and target runtime behavior; draft/attachment preservation |
| Instructions and context packs | Full authorized document handling, history, variables, import/export, conflict behavior |
| Scheduler and RALPH | Shared editors, execution, progress, human input, resume, stop, and durable results |
| Workspace tools | Files, Git, configuration, memory, MCP, processes, terminal, and service controls where the target supports them |
| Settings profiles and secrets | Revisions, assignments, encryption, capture/merge, delivery and application acknowledgments |
| Previews | Authenticated HTTP/WebSocket, origin/cookie isolation, disconnect/revocation behavior |
| Media and speech | Existing generation and voice capabilities retained on capable targets; actual hardware/provider evidence required |
| Browser/mobile/Android | Authenticated control, file picking/export, reconnect, keyboard/focus and responsive behavior |
| Failures and telemetry | Active/recent failures, device resource status, unavailable capability reasons, and operational recovery |

Close the previously documented gaps in transcript/session interaction and headless transport where they are applicable to a headless target. For genuinely device-only features, preserve the capable-device route and do not present a nonfunctional cloud equivalent. A missing transport cannot be disguised as an intentional platform limitation.

No existing feature is considered preserved merely because its label still appears. Test observable behavior, native handler invocation, storage ownership, permission boundaries, and recovery.

## D-03 — Functional and distributed acceptance scenarios

| ID | Scenario | Required observable result |
| --- | --- | --- |
| T-01 | New organization, SSO user, magic-link user, guest, service account | Correct roles and sessions; identity linking cannot take over an existing account |
| T-02 | Expired/reused magic link, scanner GET, changed redirect | No unexpected login or token consumption; intentional completion works once |
| T-03 | Issue intake replay, duplicate merge, cross-team move | One intake result, stable references, valid cycle/estimate mapping, no bypass of active-run constraints |
| T-04 | Live/asynchronous poker, multiple tabs, disconnect, facilitator transfer | Hidden votes remain private, vote/round identity is stable, estimate decision writes once |
| T-05 | Concurrent poker writeback and issue edit | Conflict visible; no overwrite of a newer estimate or stale description assumption |
| T-06 | Cycle boundary, DST, service restart, scope/estimate change | One transition/carryover; original commitment and historical metrics preserved |
| T-07 | Two users, MCP and an automation start one issue simultaneously | Exactly one admitted implementation run; remaining calls return stable conflict/existing-run results |
| T-08 | Replayed queue claim and dropped acceptance receipt | One target attempt/process tree; stable receipt; no speculative second placement |
| T-09 | Crash between run transaction and workflow start | Same run starts through the outbox; no lost command or duplicate workflow |
| T-10 | Two distinct issues execute concurrently on one project/client | Separate files, branches, runtime state, ports, databases, caches and process groups; original user checkout unchanged |
| T-11 | Two projects reference the same repository/ref | Global repository/ref ownership prevents conflicting publication |
| T-12 | Client sleeps or loses network, then returns after lease expiry | Watchdog/epoch enforcement; old attempt cannot publish or overwrite successor state |
| T-13 | Gateway overwhelmed with preview/media/log data | Cancel, heartbeat, and authority updates remain within their tested bounds |
| T-14 | Cloud → client → cloud handoff with source changes and services | Verified checkpoint/evidence chain; no duplicate writer; destination restores declared state and reruns relevant checks |
| T-15 | Handoff fails before and after source fencing | Defined paused/retry states; no reactivation of stale source epoch or orphaned authority |
| T-16 | Provider/tool call times out during a consequential action | Safe retry or explicit unknown/reconciliation state; no blind duplicate side effect |
| T-17 | PR is created but response is lost | Same PR recovered by receipt/identity; no duplicate PR or branch overwrite |
| T-18 | Upstream branch moves or reviewer changes approval | Rebase/integration is explicit; stale evidence/approval rejected |
| T-19 | Child fan-out exhausts budget or creates a dependency cycle | Bounded stop; cycle rejected; parent does not deadlock holding required child capacity |
| T-20 | Cancel during provider execution, browser use, build and publication | Process tree and children stop; external outcomes reconciled; late success cannot revive cancellation |
| T-21 | Malicious issue/repository/skill/MCP output requests secrets or broader authority | Scope enforcement denies action even through shell/network paths; audit identifies the attempt |
| T-22 | User/repository/device revoked mid-run and mid-stream | New actions denied, streams/control revoked, ongoing grant reconciled, no continued privileged publication |
| T-23 | Two organizations share infrastructure | No cross-org records, searches/counts, artifacts, previews, caches, credentials, event topics or exports |
| T-24 | Workflow retrigger storm, self-generated events, schedule catch-up | Causal deduplication, finite fan-out/retries, budget and rate limits, visible operational state |
| T-25 | Partial multi-repository change and stacked PR conflict | Correct dependency/order/status; no false atomic delivery or issue completion |
| T-26 | Disk full, partial checkpoint, corrupt artifact, changed cleanup path | No invalid checkpoint advertised; user data retained; actionable failure and cleanup record |
| T-27 | Restore old DB/workflow/object backup while old runners exist | Recovery epoch rejects old authority; external effects reconciled before scheduling |
| T-28 | Self-hosted fresh install and upgrade/import/rollback rehearsal | Documented commands work; settings/identity/keys/devices/evidence retain integrity |
| T-29 | Real remote desktop/headless and physical Android/media/voice paths | Complete applicable preservation matrix, not just mocked controls |
| T-30 | Feedback → poker → cycle → run → PR → release → requester update | Source attribution and permissions preserved; release completion reflects actual deployment evidence |
| T-31 | Cloud research → Windows/macOS reproduction → reviewed fix | Platform-specific placement, portable evidence, privacy policy and handoff semantics hold |
| T-32 | Provider model retired or entitlement removed during queued work | Admission/resume rejects incompatible selection; user/policy explicitly selects a supported route |
| T-33 | Document/search permission changes while indexing and notifying | Derived content, caches, snippets and deliveries obey current authorization |
| T-34 | Human takes browser/terminal control during agent work | One input controller; the agent relinquishes control and resumes only through a new grant |
| T-35 | Team rejects candidate or deployment reverts | Correct issue/release state and linked follow-up; no manufactured success metrics |
| T-36 | Transfer a local schedule to cloud ownership; crash at each step and disconnect device | One admission authority, acknowledged local drain and watermark, no premature cloud enable, private schedules preserved |
| T-37 | Cron OR/AND fixture, both Berlin DST transitions, leap day beyond one year, month-end, RRULE exclusions, calendar update | Preview and actual occurrences agree; explicit fold/gap policy, valid sparse recurrence, interval anchor and unsupported syntax handled correctly |
| T-38 | Redeliver one event across an automation edit, copied workflow and intentional replay | Original decision/revision retained; no accidental rerun, semantic action and issue constraints hold, explicit replay attributable |
| T-39 | Prune event/run history, exceed 1,000 arrivals, replay old receipt and exceed a rate window | Durable consumption/rate state survives log retention; closed replay horizons reject old events; no duplicate effect |
| T-40 | Interleave two incidents, recovery, silence, continuous file events and out-of-order PR/check join inputs | Subject-isolated state, persisted debounce with max wait, repeat/absence timers survive restart, joins use the same PR head |
| T-41 | Long outage with multi-page catch-up, latest/bounded-all/skip, manual backfill and overlapping active run | Latest computed across the whole window, count/age/budget bounded, accounted cursor durable, no competing issue writer |
| T-42 | Crash provider activity after action, then retry Temporal/RALPH/runner delivery | Stable StepExecution and receipts reconcile; one logical agent step and no duplicate external action |
| T-43 | Upgrade while executions wait, have children, or approach history limit | Drain/checkpoint with settled effects, safe continue-as-new cursor transfer, current interpreter resumes once; unsafe drain blocks upgrade |
| T-44 | Recurring project report, maintenance task, test-only campaign, and implementation request | Non-issue subjects retain grants/evidence/budgets; every repository writer requires canonical issue admission |
| T-45 | Human wait/pause crosses wall deadline, explicit extension, late approval and client clock jump | Earlier applicable deadline enforced by server time, active time accounted separately, expired approval cannot revive work |
| T-46 | Cancel/fail/succeed while external action is ambiguous; concurrently admit another run | Implementation reservation retained through reconciliation; terminal transition and release atomic |
| T-47 | Parallel test matrix with missing/duplicate/stale shard and PR head changing | Required denominator stable, candidate-bound results, no false pass; complete valid shard set aggregates correctly |
| T-48 | Concurrent browser tests mutate accounts, database, ports and service state | Independent accounts/data/resources or explicit reservation; auth state absent from artifacts and reused caches |
| T-49 | Linux/browser, native Windows/macOS, Android/emulator, physical media/GPU matrix | Actual platform and native handler evidence recorded; unsupported cell remains unverified/unavailable |
| T-50 | Malicious devcontainer/setup metadata, wrong service already on port, production fixture request | Host privileges denied, readiness checks verify ownership/candidate, synthetic or explicitly sanitized fixture data used |
| T-51 | Remote inspection, human takeover, manual environment change and permission revocation | One input controller, scoped preview, changed assumptions revalidated, revoked viewer/control cannot reconnect with stale grant |
| T-52 | Flaky assertion, infrastructure retry, agent edits acceptance/baselines and repair budget expires | Failures retained, quarantine has owner/expiry, no self-approved weaker gate, finite repair loop and protected evaluator |
| T-53 | Two users connect cloud MCP directly from clients; start/inspect/cancel and reconnect Tasks | Correct current protocol/auth, scoped identities, durable handles and one domain admission path; enrollment token rejected as user token |
| T-54 | Forged device success, cross-tenant event, poison schema, late source revision and webhook outage | Trusted ingress/source identity, quarantine and fair progress, authoritative state recheck, no tenant leak or fabricated success |
| T-55 | Continuing goal and child/replay work exhaust total budget or review capacity | No budget reset, bounded queue, explicit no-op/attention outcomes, finite descendants and admitted review demand |
| T-56 | Race trigger with edit, disable, re-enable, cancel-and-replace and kill switch | Serialized revision boundary, queued-work rules applied, no disabled-period surprise run, replacement waits for fencing |
| T-57 | Candidate ends with passing tests but deletes protected data or makes unauthorized intermediate writes | Independent action/invariant evidence rejects completion; failure localization and final outcome reported separately |
| T-58 | Simulate/shadow/replay with privileged connectors configured | Separate evaluation receipts/cursors, no production writes/messages/device dispatch; optional model cost explicitly metered |
| T-59 | Configure and run all 24 automation template families on controlled fixtures | Each input/trigger/action/output contract demonstrated; recurring issue/run/continuing goal distinct; unavailable connectors disclosed |
| T-60 | Guest reads automation, owner leaves, service principal rotates, scoped backfill/rollback requested | Current authorization at read/admission/action; no leaked history or restored removed credential; service ownership transfer auditable |
| T-61 | Prewarm/suspend/resume environment, expire token, fill disk, fail cleanup and exceed pin quota | No data/credential leakage, fresh grant on resume, owned resource reaping and residual-cost record; immutable evidence retained |
| T-62 | Merge then deploy different SHA, fail canary, request rollback across repositories/database change | Candidate/deployed outcomes distinct; exact deployment grant, approved reversible rollback or explicit forward repair |
| T-63 | Canary Fleet update and isolated cloud restore rehearsal while old runners remain active | Failed cohort stops rollout; restored installation cannot write production; stale authority rejected and RPO/RTO measured |
| T-64 | Complete planning/document/search/automation UI with keyboard, screen reader, narrow viewport and reconnect | Authorized data, working forms/navigation, preserved drafts, actionable conflicts and access changes; no dead remote controls |
| T-65 | Overnight cycle batch, research-to-spec-to-issue, local-context promotion, and project coordination | Full attributable flow through accepted work and required tests, review capacity respected, unrelated local history stays private |

Each failure scenario must assert durable end state, actual external effects, process/resource inventory, and evidence recovery. Mock tests are useful for determinism but do not replace live cases for transport, provider cancellation, publication, sandbox boundaries, or hardware.

T-36–T-65 extend the original campaign to cover the follow-up audit. They are specified tests, not executed cloud tests. Fixtures must include two organizations, two same-repository projects, multiple clients, current/obsolete PR heads, and controlled failure injection. T-37 must exercise both the shared evaluator and the real coordinator; helper tests alone cannot prove dispatch semantics.

## D-04 — Provider and protocol certification

Every provider advertised as supported must map to an implemented runtime and usable workflow. The installed model catalog is not a support certificate.

| Provider/interface | Required delivery evidence |
| --- | --- |
| Existing OpenAI, Anthropic, Google and Langdock API adapters | Cloud/client execution, tools, streaming, usage, cancellation, failures, instruction delivery, supported attachments |
| Existing Codex, Claude and Copilot native adapters | Supported executable/SDK version, auth mode, process-tree control, session resume, event mapping, environment isolation |
| OpenAI Agents API | Current beta contract, actual session lifecycle, owned/vendor environment behavior, external cancellation and result reconciliation |
| Claude Managed Agents | Current beta contract, actual worker claim/session lifecycle, file/repository preparation limits, data-flow and cancellation behavior |
| Perplexity research/Agent API | Current endpoints/models, citations, search/tool cost, document input, limits, and connector policy |
| Perplexity Computer or other external agent | Explicit installation/permissions, progress, questions, action approval, artifacts, interruption and documented transfer limits |
| Local/open-weight model route | Selected runtime/model conformance, actual tool/format capabilities, hardware requirements and throughput; no assumed equivalence from API shape |
| Cloud MCP and direct Machdoch client connection | Current discovery/auth/transport, delegated scopes, Tasks where negotiated, revoke/reconnect, idempotency and run lifecycle |
| A2A/external-agent adapter | Current negotiated version, identity, task/artifact/cancel behavior, bounded authority, and no independent issue admission path |

Model-specific features such as native subagents, reasoning modes, computer use, file formats, and context limits require capability evidence. If unavailable in a target, reject that selection explicitly. Preview integrations may be disabled by default but must not be described as production-certified until their certification passes.

Do not create a long-lived matrix of historical binaries. Certify the release's current supported contract/runtime versions. Preserve user data through the explicit cutover and offer actionable upgrades for incompatible clients.

## D-05 — Quality, security, scale, and operability gates

The full release requires:

- **Functional coverage:** all P requirements and the combined journeys operate end to end, including remote client preservation.
- **Automation and testing:** all AU and RT requirements pass their mapped scenarios, including all template families, recurrence/ownership/replay cases, current-interpreter upgrades, complete test matrices and environment cleanup.
- **Distributed correctness:** T-07–T-28 pass repeated fault campaigns with reordered/duplicated messages, process crashes, partitions, clock changes, and storage failures.
- **Security:** independent review of the threat model and exposed API/MCP/device/preview boundaries; sandbox escape and credential-exfiltration testing appropriate to the deployed profiles; no unresolved critical findings.
- **Identity isolation:** SSO enforcement, magic-link abuse cases, deprovisioning, guest isolation, service identities, tenant isolation, and resource-specific authority tested against real sessions.
- **Provider evidence:** the advertised matrix is completed with real provider access and recorded limitations; mocks do not count as provider certification.
- **Recovery:** a fresh restore using stored backups and separate keys meets the documented target and rejects stale workers. Test operator instructions with someone other than their author.
- **Performance:** publish results against S-07's proposed certification envelope, or revise the declared supported envelope before release with explicit measurements. Do not advertise unmeasured capacity.
- **Accessibility/mobile:** focused browser interaction checks, keyboard/screen-reader review, representative screen sizes, and physical Android verification for the supported flows.
- **Agent quality:** versioned evaluation corpus of representative bug fixes, features, multi-file evolution, browser changes, research and adversarial inputs; report repeated-run outcomes and cost, with a held-out component.
- **Operational completion:** installation, upgrade, diagnostics, quota management, cleanup, provider outage, compromised device and recovery runbooks exercised.

Quality evaluations must distinguish harness/tool/environment failures from model failures. A test blocked by missing credentials or hardware is unverified, not skipped-and-passed. Successful reruns after a fault do not establish that the original failure cause is fixed without evidence.

## D-06 — Cutover plan

1. Inventory live Fleet devices, profile revisions, settings encryption keys, sessions/routes, installation identity, and client versions. Capture the current capability evidence.
2. Freeze administrative writes for the cutover window and take verified backups. Independent local client work is not deleted.
3. Import into the new organization model with a dry-run report, row counts, integrity checks, secret re-encryption, owner-to-user mapping, and explicit unresolved items.
4. Upgrade the supported client/gateway contract, rotate or reenroll device credentials deliberately, and verify every workspace binding. Preserve local histories through their native stores. Inventory schedule ownership; transfer only explicitly cloud-owned definitions with acknowledged local drain and recurrence preview validation (AU-02). Keep private device schedules private.
5. Exercise remote-control parity and restricted multi-user access before enabling cloud job dispatch.
6. Enable cloud execution and integration publication only after stale workers/grants are fenced and GitHub/provider actions reconciled.
7. Validate export/restore and the complete target workflows. Retire the old service and obsolete persistence path after acceptance; keep encrypted backups under retention policy.

This is a data-preserving replacement, not an indefinite compatibility project. Never dual-run old and new schedulers against the same client/project authority.

## D-07 — Decisions and tradeoffs

| Decision | Benefit | Cost or limit accepted |
| --- | --- | --- |
| PostgreSQL plus Temporal | Clear relational constraints and durable long-running workflow semantics | More self-hosted services to operate; cannot outsource business invariants to the workflow engine |
| Outbound client gateway | Works behind NAT and preserves current remote model | Reconnect, backpressure, revocation and gateway clustering remain substantial engineering work |
| MicroVM cloud environments | Stronger boundary for arbitrary code and dependency installation | Linux/KVM host requirements and a real sandbox operations burden |
| Worktrees on eligible clients | Efficient concurrent source work | Shared Git metadata and external resources still need control; not a malicious-code sandbox |
| Brokered publication | Narrow credentials, observable side effects, fencing | Ambiguous external outcomes can temporarily block availability |
| One implementation run per issue | Prevents competing retries and agent handoffs | Alternative candidates must be explicit children under one bounded run |
| Separate human review capacity | Prevents uncontrolled PR generation and preserves accountability | Maximum useful automation throughput may be lower than compute capacity |
| Native poker | Private integrated planning and full self-hosted operation | Real-time collaboration, vote privacy, and conflict handling are product work |
| Explicit managed-provider adapters | Uses new vendor capabilities without abandoning owned execution | Preview churn, differing data policies, and imperfect checkpoint portability |
| Tenant-aware design now | Avoids single-company assumptions becoming security debt | Additional constraints/tests before there is a commercial hosting product |

## D-08 — Traceability

The [individual requirement coverage register](requirement-coverage.csv) maps every normative requirement and delivery section to acceptance evidence. The table below remains the workstream overview. [Verification notes](verification.md) distinguish this specification review from future runtime certification.

| Requirement group | Delivery stages | Primary acceptance coverage |
| --- | --- | --- |
| P-01–P-03, A-03–A-04 | 1, 3, 4 | T-01, T-03, T-11, T-23, T-33 |
| P-04–P-05 | 4 | T-04–T-06, T-30 |
| P-06, P-11–P-15 | 4, 7, 8 | T-24, T-30–T-35; accessibility and quality gates |
| P-07, A-02, A-05, A-09 | 2, 5, 6 | T-07–T-20, T-31–T-32; provider certification |
| P-08, A-01, A-06 | 3, 5, 8 | D-02 inventory, T-12–T-15, T-29, T-34 |
| P-09, A-10 | 6 | T-16–T-18, T-22, T-25, T-30, T-35 |
| P-10 | 7 | T-19, T-24, T-30 |
| A-07–A-08 | 6 | T-07, T-21–T-23; MCP/external-agent certification |
| A-11, S-09 | 8 | T-26–T-28; D-06 cutover |
| E-01–E-04 | 2, 5 | T-07–T-13, T-16–T-17, T-27 |
| E-05–E-08 | 5 | T-10–T-11, T-19, T-21, T-25–T-26 |
| E-09–E-11 | 5, 6 | T-14–T-18, T-25, T-31, T-35 |
| E-12–E-15 | 2, 5, 7, 8 | T-12–T-28; repeated fault campaign |
| S-01–S-05 | 1, 3, 6, 8 | T-01–T-02, T-21–T-23, T-33; security/identity gates |
| S-06–S-08 | 2, 5, 8 | T-23, T-26–T-29; performance/operations gates |
| AU-01–AU-04 | 1, 2, 3, 7 | T-36–T-37, T-41, T-44–T-46, T-56, T-59 |
| AU-05–AU-08 | 1, 2, 7 | T-38–T-40, T-54, T-56, T-58 |
| AU-09–AU-14 | 2, 5, 6, 7, 8 | T-42–T-43, T-53, T-55–T-60, T-65 |
| RT-01–RT-07 | 3, 5, 6, 7, 8 | T-47–T-52, T-61–T-65 |

## D-09 — Remaining assumptions and implementation-time decisions

The proposed architecture assumes an operator can provide Linux/KVM execution hosts, PostgreSQL/workflow/object storage, TLS, and appropriate provider/GitHub accounts. Those are deployment prerequisites, not properties established by this research task. Windows/macOS/GPU coverage requires capable clients or dedicated worker pools.

The first supported deployment is self-hosted for one company, with tenant boundaries tested for more than one organization. A shared commercial service is not being launched by this plan.

Repository identity, scope, and permissions must be configured explicitly. No company membership, actual repository allowlist, monthly budget, domain ownership, SSO issuer, hosting capacity, or provider credential has been invented. The timeout and performance figures are proposed defaults/targets to validate, not known operational measurements.

Implementation must select and pin maintained libraries for identity, collaborative documents, protocol schemas, and deployment packaging after compatibility/security review. The requirements and boundaries are fixed here; no requirement depends on an unannounced vendor feature. Provider-managed sessions and external agents may have weaker portability than owned Machdoch execution, and those limits must remain visible in placement policy.

This planning task does not deploy services, run paid agents, import live data, or change repository code. Its verification is specification structure, source attribution, local references, requirement traceability, and consistency against inspected code; runtime claims remain subject to the gates above.
