# Specification review and coverage

Review date: **22 October 2026**. Scope: further research, source inspection, error analysis and refinement of the full machdoch.cloud specification. This is a completed planning artifact with future implementation acceptance criteria; it is not delivery of the cloud application.

## Requested outcome coverage

| Requested outcome | Review evidence and concrete result | Implementation acceptance |
| --- | --- | --- |
| Issues assigned and executed on clients | Product/domain model plus current Fleet route and scheduler inspection | P-02/P-07; T-03, T-07–T-10 |
| Cycle planning and planning poker | Native/private vote, estimate-conflict, capacity and carryover contracts retained | P-04/P-05; T-04–T-06, T-30 |
| Direct cloud MCP in clients | Current protocol/Tasks documentation and existing local server/dependency inspection; shared authorization boundary | A-07/A-08; T-53 |
| Full sandboxed cloud agent and GitHub | Shared runtime, per-attempt environment, provider modes and brokered effects retained and clarified | E-05–E-11; D-04; T-16–T-21 |
| Project and workspace management | Canonical repository/workspace identities and non-issue run subjects defined | P-03/A-03; T-11, T-44 |
| Concurrent handoffs without interference | Explicit issue reservation, isolated writers/resources, checkpoints, fencing and deadline corrections | E-01–E-15; T-10–T-20, T-45–T-46 |
| Preserve Fleet remote client access | Current transport/editor source map and applicable real-device preservation gate | D-02; T-29, T-49, T-51 |
| Multi-user, SSO and magic link | Identity, guest, automation-principal and revocation requirements reviewed with asynchronous execution | S-01–S-04; T-01–T-02, T-22–T-23, T-60 |
| Self-host now; future tenant readiness | Owned orchestration, KVM/capable pools, tenant isolation, current-interpreter upgrades and recovery requirements | S-06–S-09; T-27–T-28, T-43, T-63 |
| Recurring AI tasks and continuing goals | Existing scheduler/helper probes; dedicated recurrence/authority/misfire/overlap contracts | AU-01–AU-04; T-36–T-37, T-41, T-44, T-55–T-56 |
| Events, triggers and automation | Source event/state/watch audit; durable ingress/decisions/windows/joins/causation and controls | AU-05–AU-14; T-38–T-43, T-54–T-60 |
| Develop, remote test, sandbox and manage | Test campaigns, complete matrices, environment lifecycle, safe repair, previews, Fleet update and restore workflows | RT-01–RT-07; T-47–T-52, T-61–T-65 |
| Broader useful features and deep research | Original planning/agent capabilities retained; 24 automation template families; current primary-source comparisons and 13 papers across both research documents | P-06/P-09–P-15; AU-12/AU-13; T-59, T-65 and D-05 |

The [coverage register](requirement-coverage.csv) maps **71 normative requirement sections and nine delivery sections** individually to acceptance scenarios and required evidence. It explicitly labels runtime work unverified. The [delivery plan](delivery.md) defines **65 scenarios**, including 30 added by this review. Scenario presence establishes coverage intent, not a passing implementation test.

## Findings and decisions

The [integration audit](integration-audit.md) records 20 findings, source paths, resolutions and scenarios. The most consequential decisions are one cloud scheduling authority, shared recurrence semantics, persistent event/action receipts independent of log retention, one RALPH/Temporal step lifecycle, typed non-issue run subjects, consistent wall deadlines, explicit writer reservations through reconciliation, and candidate-bound remote-test aggregation.

The architecture remains an evolution of Fleet with shared Machdoch runtime/UI, PostgreSQL domain authority, Temporal durability, isolated owned runners and outbound clients. The refinement adds exact contracts and reuses the existing local scheduler instead of assuming scheduling is a new client feature. Full planning, identity, remote access and provider scope remains required; no smaller release is substituted.

## Verification performed

- Inspected the current scheduler, persistence, trigger matching, file watches, shared scheduler UI/contract, Fleet session placement, local MCP and runtime integration points listed in the audit.
- Ran the four focused existing scheduler test files documented in the audit: **40 tests passed**.
- Called the existing recurrence helper directly for Berlin DST, cron OR semantics and leap-day lookahead. Recorded exact inputs/results, including the sparse-recurrence failure. New cloud behavior has not been implemented or tested.
- Retrieved primary vendor/protocol/infrastructure documentation for the new decisions and rechecked central existing MCP/provider claims. Rechecked the original eleven paper abstracts/metadata and read original metadata plus relevant full-text portions for the two added research papers; no benchmark reproduction.
- Structural validation passed across **12 Markdown documents, 80 local file links and 45 tables**. All **80 requirement/delivery IDs** have unique coverage rows, all references resolve, all **65 scenarios** are defined and mapped, and code fences balance. The 20 findings and 24 template families were counted against their tables. One table-delimiter defect found during this check was corrected before the successful run. This checks local references and document consistency, not every external website's future availability.

## Limits and remaining assumptions

No application source was changed, dev server started, live data imported, provider run purchased, or cloud service deployed. Existing unrelated shared-workspace edits remain outside this task. Source inspection and successful local scheduler tests do not establish physical-device parity, cloud recovery, authorization correctness, sandbox security or provider certification.

Delivery still requires real Linux/KVM and native/GPU/device pools, installation identity/network configuration, repository/provider entitlements, licensed dependencies and controlled integration accounts. These were not invented. Provider APIs and published roadmaps are dated evidence; revalidate supported versions when implementing. The selected recurrence library must prove the declared grammar/DST/sparse-date behavior. The current-interpreter upgrade strategy accepts a drain window; measured availability and workload targets remain subject to S-07/D-05.

Neither this review nor any feature list proves coverage of every conceivable failure or future product feature. The defined scenarios, invariants, capability certification and operational controls make the full proposed outcome reviewable and testable. Runtime failures discovered during delivery must update the same requirements and evidence register.
