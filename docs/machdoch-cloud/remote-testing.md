# Remote testing and environment management

Full-release requirements extending P-03, P-07, P-08 and E-07/E-11. These are proposed capabilities, not new runtime verification results.

## RT-01 — Test campaigns and evidence

A `TestCampaign` binds a candidate/source manifest, acceptance contract revision, test plan, required platform matrix, dataset, environments, budget and deadline. It may verify an issue run, PR, release, project baseline or scheduled regression. `TestShard` records required cases, platform, assigned attempt, actual tool versions, result and artifact manifest. These are validation children using the same run/attempt/grant/resource model, not a parallel scheduler.

Support targeted unit/integration/API checks, browser journeys, visual comparisons, accessibility checks, native desktop/mobile interactions, platform reproduction, performance/load tests and explicitly authorized fault campaigns. Preserve repository test tools and configuration; an agent may propose additional tests without silently replacing required ones.

A campaign completes only when all required cells and shards are accounted for against the same candidate. Results distinguish pass, assertion failure, infrastructure failure, timeout, canceled, unavailable and not run. A missing shard, disconnected device, unsupported browser or expired credential cannot count as a pass. Optional cells are declared before execution. Re-running a subset does not erase the original failure or inflate the denominator.

Store command/config/test identifiers, candidate and dependency revisions, image/tool/browser versions, actual OS/hardware, test seed/data revision, start/end/exit status, and checksummed reports. Produce standard machine-readable results plus scoped logs, traces, screenshots/video where needed. Evidence retention and access follow the source project; raw auth state and secrets are excluded. A signed runner receipt proves origin, not that a compromised runner told the truth; high-assurance policy requires a trusted independent validator.

## RT-02 — Placement and parallel execution

Resolve each matrix cell to a capability profile: Linux/cloud browser, native Windows/Tauri, native macOS, Android emulator or physical device, GPU/media, microphone/speaker, private-network service or licensed tool. Distinguish browser emulation from actual Android/native UI. Capability absence is an explicit result. Do not claim a successful web test verified a Tauri command or physical audio path.

Parallelize independent shards across eligible pools with resource quotas and reserved interactive capacity. Pin shard topology and test enumeration so repartitioning cannot drop or double-count cases. All shards use the candidate manifest; a newer PR head starts a new campaign or invalidates the old campaign's applicability. Merge-queue validation targets the actual integration candidate where repository rules require it.

Browser contexts isolate browser state, while accounts, databases, ports and services need independent test isolation. For tests that mutate server state, allocate separate accounts/data partitions per worker or explicitly reserve a shared resource. Playwright documents per-worker authentication and report merging across shards; these support the design but do not establish backend or security isolation. [Authentication](https://playwright.dev/docs/auth), [sharding](https://playwright.dev/docs/test-sharding).

## RT-03 — Reproducible environments

An `EnvironmentRevision` resolves image/toolchain digests, repository commits, setup commands, package sources/locks, services, ports, health checks, data seed, permitted network, resource requirements and secret references. Distinguish immutable environment definitions from a particular provisioned instance. Provisioning, setup, readiness, testing and cleanup each have bounded state and diagnostics.

Import approved development-container metadata as an input to the environment compiler. Validate lifecycle commands, mounts, privilege flags, features and host requirements against installation policy. Such metadata describes environment setup; it is not sandbox authorization. Host-side initialization commands must not run on the control plane, and untrusted metadata cannot request privileged mode or a host Docker socket. [Development container configuration reference](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainerjson-reference.md).

Allocate isolated databases/schemas, namespaces, queues, browser profiles, test tenants, local ports and preview hostnames. Production snapshots require explicit export authorization, sanitization and retention rules; default to synthetic data. Do not embed secrets or customer data in reusable images, dependency caches, checkpoints or saved browser authentication. Test secrets expire with the attempt and are revoked on cleanup/reassignment.

Use readiness checks and condition-based waits. Reuse a running service only after verifying its ownership, candidate and configuration match the test; never assume an open port belongs to this run. The workflow must explicitly authorize starting services on a personal client. OS-native app testing uses its own installation/profile and owned process group, preserving the person's active application.

## RT-04 — Remote inspection and control

Provide live status, logs, permitted file/diff inspection, private previews, terminal and browser/desktop observation through the existing Fleet transport. Keep ordinary client sessions separate from managed test environments. A user opens the specific test attempt rather than landing in an unrelated workspace.

One input-control grant exists per terminal/browser/desktop session. Human takeover pauses agent input, records the control transfer and invalidates assumptions affected by manual changes. Resume reacquires authority and rechecks the environment. Multiple read-only viewers are permitted. Revocation/disconnect expires control and preview grants; it does not expose an unauthenticated debug port.

Route test browsers through authorized preview/service paths. Test fixtures for SSO, external integrations and callbacks use explicit test accounts and approved redirect origins. Never loosen origin, certificate, CSRF or authorization checks just to make an agent's browser test pass. Capture recovery diagnostics when an interaction fails; do not collect all desktop activity by default.

## RT-05 — Repair, flakiness and baselines

Classify failure before retry or repair. Permit finite retries for diagnosed infrastructure failures; preserve every attempt. Assertion retries can diagnose flakiness but cannot silently convert an intermittent failure into clean acceptance. Quarantine requires an owner, reason, expiry, and explicit effect on the release gate. Report how many required tests remain quarantined.

An automated repair receives the failing test, logs, environment and source manifest, creates an isolated candidate and runs relevant checks. It uses the original issue's implementation admission/reservation or a bounded continuation; test failure cannot spawn a second competing writer. Limit repair count and cost; unchanged failures or oscillating patches stop with evidence.

Visual/performance/accessibility baselines have provenance and review. A candidate cannot approve its own new screenshots, remove checks, lower thresholds or classify its failures as optional. Compare performance under recorded hardware, data, load and warmup conditions with explicit variance tolerances. Agent-generated tests supplement the independent acceptance layer.

## RT-06 — Sandboxes, previews and maintenance

Expose environment builds, compatible runner pools, instance lifecycle, queue reasons, resource use, image updates, retained evidence and cleanup failures. Support prewarming, bounded checkpoint retention, idle suspension, explicit resume, device drain and approved update campaigns. Automatic scaling is bounded by pool, organization, infrastructure and spend limits; unavailable hardware does not authorize a different platform.

Shared warm capacity contains no run data or credentials. Resuming a paused VM recreates authority and validates image/configuration policy before tools run. A snapshot holding a live expired token cannot regain permission just because the filesystem was restored. Pin retention has an owner, reason, quota and expiry.

Cleanup covers processes/services, checkout/volume, temporary databases/accounts, ports, preview/DNS grants, provider sessions and object-storage retention. Use the ownership manifest and current epoch; independently retry cleanup without rerunning the task. Show residual resources and costs until reconciled. Expiring a preview never deletes its immutable test evidence.

## RT-07 — Delivery and operational verification

Support pre-merge validation, preview review, staged release smoke tests, canary observation and post-deployment regression tracking. Distinguish candidate verification from deployed revision verification. Correlate incident, issue, candidate, PR, deployed artifact and observed outcome.

Deploy/rollback permissions are separate from sandbox execution. Automated rollback follows a preauthorized reversible release procedure and checks current deployment identity; database changes may require a forward repair. Do not claim distributed atomic rollback across repositories/services. Destructive tests and fault injection execute only in declared test environments with a bounded blast radius.

Ship repeatable diagnostics and recovery-rehearsal workflows for the cloud itself: restore into an isolated installation, revoke stale workers, exercise synthetic issue/automation/test cases, verify no production integration writes, and record achieved RPO/RTO. Fleet updates use staged device cohorts and observable success criteria; a failed update stops expansion and retains a working recovery route.
