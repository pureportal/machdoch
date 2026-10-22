# Security, identity, and operations

## S-01 — Multi-user identity and login

Replace the single-owner model with users, organization memberships, teams, service principals, and scoped roles. Support invitation-based membership, multiple organizations per user, ownership transfer, user suspension, and identity-provider deprovisioning.

Required authentication methods:

| Method | Required behavior |
| --- | --- |
| OIDC SSO | Authorization Code flow with PKCE, state/nonce verification, issuer/audience checks, exact redirect validation, key rotation, and explicit claim mapping |
| Enterprise SAML | Supported through an identity broker such as a configured Keycloak deployment; do not implement ad hoc assertion parsing in the app |
| Magic link | Verified email, short-lived single-use challenge, hashed stored token, controlled redirect, rate limits, and no account enumeration |
| Passkey/MFA | Passkeys for local accounts and a step-up mechanism for privileged operations; respect SSO authentication policy |
| Recovery | Audited administrator recovery and offline break-glass procedure with narrowly scoped recovery authority |
| Automation/device identity | Separate service accounts and device credentials; never a shared human session |

OIDC is a practical integration boundary with self-hosted identity systems. Keycloak documents discovery, authorization, token, userinfo, and logout endpoints; its role here is an optional broker, not a compulsory cloud dependency. [Keycloak OIDC documentation](https://www.keycloak.org/securing-apps/oidc-layers).

Magic links expire after a proposed ten minutes and are consumed atomically only by an intentional completion action, not by email-scanner GET requests. Avoid token leakage in logs, analytics, referrers, or third-party assets. A link must not silently switch the browser into an unexpected account. Support completion on a different device through an explicit confirmation flow without weakening one-use/expiry guarantees.

Linking identities requires an authenticated account-linking flow or administrator-controlled verified mapping. A matching email string or newly claimed domain is insufficient to merge accounts. SSO enforcement can disable magic links for an organization; a local recovery route must not become a normal bypass.

Use secure, HTTP-only browser sessions with CSRF/origin protection, absolute and idle expiration, session inventory, and revocation. Rotate tokens and invalidate dependent sessions on sensitive identity changes. Desktop/CLI sign-in uses supported browser/device authorization flows; store tokens in the OS credential store, not a repository or shell command history.

Provide SCIM provisioning/deprovisioning and team mapping where configured. Removing a person revokes sessions, grants, scheduled personal automation, and remote control. Organization-owned automation may continue only under its own service principal and explicit policy. Retain historical attribution without leaving the deleted user as an active authority.

## S-02 — Authorization and role boundaries

Use RBAC plus resource-level checks for projects, repositories, devices, runs, artifacts, and environments. Permission is the intersection of organizational policy, project/repository rights, the initiating actor, the execution grant, and the tool's allowed action.

| Role/capability | Typical scope |
| --- | --- |
| Owner | Organization lifecycle, recovery, membership policy, ownership transfer |
| Administrator | Identity/integrations, approved providers, runner pools, policies, and quotas |
| Team/project lead | Planning configuration, project membership, workflows within delegated limits |
| Member | Issue/document collaboration and allowed run initiation |
| Reviewer | Review/evidence access and allowed approval actions; merge is a separate capability |
| Guest | Explicitly granted projects/issues; no organization/client discovery by default |
| Device operator | Selected client/workspace controls; independent from project membership |
| Agent/service principal | Explicit installation scopes and run-specific narrowed grants |

Do not grant repository code access merely because someone can see a project description. Do not grant full device control merely because someone can execute a task in one bound workspace. Administrative configuration rights do not implicitly authorize reading every user's private local session.

Enforce permissions in APIs, database queries, event subscriptions, MCP tools, artifact downloads, exports, search indexes, webhook delivery, and preview/terminal channels. Recheck authorization after asynchronous work and at mutation/publication time. Long-lived signed links must not bypass a later revocation; sensitive artifacts need short-lived grants or an authenticated proxy.

Remote interactive controls use explicit scope, visible actor attribution, and control-transfer semantics. A human response to an agent question is data; it becomes an approval only through the appropriate authenticated action and revision-bound approval record.

## S-03 — Agent authority and approval policy

An execution grant includes actor/service identity, organization/project, allowed repositories and tools, permitted paths/actions, data destinations, duration, budget, child-delegation limits, and policy revision. Bind approvals to the exact operation and relevant source/diff/resource version.

Administrators can preauthorize low-risk work such as investigation, implementation in isolated workspaces, tests, and draft PR creation. Autonomous merge/deployment is supported when its explicit policy, required reviews/checks, and destination permissions allow it. The model does not determine its own permission level.

Sensitive actions include adding integrations, changing identity policy, accessing a new secret, widening network access, production mutations, force-updating protected resources, deleting shared data, and increasing an approved budget. These require separate grants or an authenticated decision at the point of need. Existing grants avoid repetitive prompts.

Subagents receive attenuated grants and inherited policy digests. Native harness subagents must be constrained and attributable through a verified integration. If a provider cannot establish those properties, that native delegation mode cannot run under a policy requiring them.

A trusted approval record contains approver identity, subject, action, scope, revision/hash, time, expiration, and consumption semantics. Never accept an agent-generated string, repository file, website, or tool output as proof of human approval.

## S-04 — Untrusted input, MCP, and secret boundaries

Automation event provenance, authority and retention follow AU-05–AU-11. Source credentials establish the organization and producer; a webhook or runner cannot assert a trusted actor in its payload. Dry-run/shadow evaluation uses separate receipts and no production write authority. Stateful trigger windows and causal metadata carry the source access constraints.

Threat sources include malicious issue descriptions, repository files, dependency/install scripts, attachments, MCP tools, retrieved web pages, generated previews, compromised clients, stolen integrations, and an agent attempting to exceed its task.

Required controls:

- Treat external content and tool results as untrusted data. Preserve provenance and separate it from trusted task/instruction metadata.
- Enforce consequential actions in code outside the model. A prompt-injection classifier is supplemental, not the permission boundary.
- Sign and version approved instruction/context manifests; record delivery evidence without exposing privileged instruction material in ordinary UI logs.
- Pin approved skills/plugins by immutable version/digest; inspect code and declared permissions; isolate execution; invalidate approvals when permissions change.
- Separate credential storage from prompts, provider history, repository files, previews, and model-visible environment variables wherever mediation is possible.
- Use secret references, envelope encryption, key rotation, narrowly scoped short-lived credentials, and redaction before persistent logs. Test redaction with encoded/structured variants; do not claim regex redaction prevents all exfiltration.
- Check OAuth audience, scope, actor, resource, issuer, revocation, and token lifetime. Never use enrollment tokens as broad MCP or organization API tokens.
- Restrict MCP/tool discovery by authorization; pin schemas and server identity; reject changed tool permissions until reapproved.
- Protect fetchers, webhooks, repository cloning, previews, and connectors against SSRF, DNS rebinding, private-network/metadata access, malicious redirects, and path/archive traversal.
- Render Markdown/HTML and terminal output safely; treat uploaded/generated files as untrusted; scan attachments and apply size/content limits.

Runtime enforcement must mediate every route to protected resources, including shell-initiated network requests. Restricting the formal `github` tool while leaving a general shell with the same write token is not enforcement.

The current MCP authorization specification is the protocol baseline, while token scoping and the execution ledger supply Machdoch-specific policy. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). Research on malicious skills supports testing both executable code and instructions; static supply-chain inspection alone does not address the combined problem. [MalSkillBench](https://arxiv.org/abs/2606.07131).

## S-05 — Data protection and provider policy

Classify data at organization/project level and restrict approved destinations accordingly. Include source code, customer reports, logs, screenshots, documents, prompts, generated artifacts, embeddings, traces, and backups. Access controls follow derived content, not just its source record.

Each provider/harness mode has a reviewed data-flow manifest: where inference, tools, state, caching, memory, logs, and artifacts reside; which credentials are used; supported deletion/export; and whether an external service retains session state. Cloud-owned execution does not imply local inference or zero retention.

Claude's documented self-hosted Managed Agents mode still sends tool inputs/results to its control plane and stores skills/memory there. That illustrates why placement and inference/data policy must be separate decisions. [Claude self-hosted boundary](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes).

Provide retention controls by data type, organization export, deletion jobs, audit of sensitive access, and legal-hold capability when an operator needs it. Do not claim regulatory certification or legal compliance based on architecture alone. Deletion from active systems, provider systems, and backups has separate completion records and documented limits.

Do not record hidden model reasoning as a product requirement. Keep user-visible explanations, actions, decisions, tool evidence, and outcomes. Offer diagnostic detail only to authorized operators and redact before external support export.

For offline installations, the control plane must function without vendor telemetry, cloud licensing checks, or mandatory external identity services. Fully offline agent execution additionally requires an approved locally available model/harness, tools, packages, and images. Online research, hosted models, email delivery, and external repository services are unavailable when their networks are unavailable; do not invent an equivalent result.

## S-06 — Self-hosted deployment

Ship a documented, version-pinned reference deployment with:

- Reverse proxy/TLS, application/API, client gateway, workflow workers and self-hosted Temporal, PostgreSQL, object storage, and sandbox-controller/runner services.
- Configurable hostname and base URL; installation URLs must not be hardcoded to `machdoch.cloud`.
- Optional SMTP and OIDC/SAML broker connections; bootstrap/recovery remains possible without external email.
- A small-install deployment manifest and a supported clustered deployment chart/profile using the same application semantics and current storage model.
- Dedicated execution hosts separated from the control plane's credentials and persistent stores.
- Explicit Linux/KVM prerequisites for the default sandbox pool, disk/resource sizing guidance backed by benchmark results, and capability checks before accepting jobs.
- Health, readiness, dependency status, upgrade/drain commands, backup/restore commands, and an operator diagnostics bundle.

Use immutable image digests, signed release artifacts and an SBOM, documented configuration/secrets injection, restricted filesystem/service accounts, and a supported vulnerability-update process. Do not execute tasks directly inside the web/API container.

Expose TLS on the configured reverse-proxy ingress and only the necessary internal service endpoints. Support corporate proxies, private CAs, DNS constraints, IPv4/IPv6, and disconnected clients without disabling certificate validation.

Previews require an independently isolated origin configuration. An installation without configured preview origins may execute jobs, but preview-dependent acceptance checks must report that capability as unavailable until configured; it cannot substitute an unsafe application-origin iframe.

Installation storage must separate application data, workflow persistence, artifacts/checkpoints, runner caches, encrypted secrets, and key backups. Document storage growth and cleanup costs, not just CPU requirements.

## S-07 — Observability and proposed service targets

Use structured logs, metrics, and distributed traces correlated by organization, run, attempt, command, external action, and device. Do not use sensitive prompts or entire repository paths as metric labels. Bound cardinality and retention.

Provide operator views for queue depth/age, eligible capacity, lease loss, stalled work, external actions with unknown outcomes, provider quota/errors, failed setup, cost, artifact growth, cleanup debt, gateway backpressure, webhook delivery, login abuse, and policy violations.

Include occurrence lateness, accounted schedule cursor, suppressed/coalesced/backfilled work, trigger-loop limits, dead letters, source silence, circuit-breaker state, required test-shard completion, review queue capacity and environment retention. Metrics and diagnostics must distinguish a legitimate no-op from lost or rejected work (AU-11/AU-13, RT-01/RT-06).

Audit events identify who/what acted, on whose behalf, on which resource, under which policy/grant, with the before/after revision, outcome, and trusted time. Append-only retention and integrity checks must make unauthorized mutation detectable. Historical attribution persists after account removal.

Proposed certification envelope and targets below are design requirements, not measurements or assumed customer demand. Publish the actual hardware, dataset, network, provider behavior, and concurrency with release evidence.

| Target | Proposed acceptance objective |
| --- | --- |
| Domain scale | 1 million issues, 500 concurrent authenticated users, 200 connected clients, 100 active attempts in the certification campaign |
| Interactive API | p95 under 300 ms, p99 under 1 second for indexed metadata operations; exclude documented external-provider waits |
| Authorized event visibility | p95 under 2 seconds from accepted event to connected UI |
| Dispatch | p95 under 5 seconds once a compatible warm target and budget are available |
| Sandbox start | p95 under 30 seconds warm and 5 minutes cold, measured separately from repository-specific setup |
| Connected cancellation | Control delivery p95 under 2 seconds; supervised shutdown within the policy deadline, with unconfirmed external work reported separately |
| Control-plane availability | 99.9% monthly objective for the supported redundant deployment; single-host deployments have no HA claim |
| Backup recovery | RPO at most 15 minutes and RTO at most 60 minutes for the documented reference dataset/profile |
| Revocation | Checked immediately on new sensitive operations; streaming/control subscriptions revoked within a bounded, measured interval of at most 30 seconds |
| Reliability | No duplicate authorized writer/publication in the defined fault campaign; repeat across randomized schedules |

No availability or latency objective guarantees that a selected model solves an arbitrary issue. Agent quality has a separate evaluation program with acceptance rate, repeated-run reliability, regression rate, intervention rate, and cost.

## S-08 — Tenant readiness without premature commercial hosting

Even a single-company installation creates an organization boundary. Tenant-scoped authorization, identifiers, encryption context, object paths, cache keys, search filters, events, quotas, and job placement must be correct from the beginning.

Use PostgreSQL row-level security as defense in depth, not as the only policy layer. Application database roles must not be table owners, superusers, or have `BYPASSRLS`; validate behavior under connection pooling and background jobs. Administrative maintenance roles are separate and audited. PostgreSQL explicitly documents that table owners normally bypass row security. [Row-security documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Test tenant isolation with at least two organizations even when the installation exposes only one in normal use. Include search, pagination counts, websocket topics, artifacts, logs, provider caches, previews, exports, user lookup, and repository integration lookups. Cross-organization joins must fail structurally or by explicit policy.

Future shared commercial hosting may add organization provisioning, regional placement, metered billing, stricter execution separation, tenant-aware support tooling, and a commercial SLA. Those require their own design and validation. Current code must avoid assumptions that there is only one owner, one GitHub installation, one provider key, or one hostname.

## S-09 — Backup, recovery, and upgrade

Back up PostgreSQL with point-in-time recovery, workflow persistence with its supported recovery method, immutable object manifests/data, installation configuration, identity configuration, and encrypted secret material. Protect encryption/signing keys separately and test their availability during restore.

A successful database restore is insufficient if checkpoints, workflow histories, or external side effects refer to a later state. Record backup manifests with consistent recovery positions. Keep external action receipts independently recoverable enough to reconcile effects after database rollback.

Recovery must start in a dispatch-disabled mode. Increment an installation recovery epoch, invalidate pre-restore leases/tokens, reconnect devices for inventory, reconcile open GitHub/provider actions, and only then resume scheduling. Never replay old publication intents blindly against a live external account.

Restore drills cover missing keys, missing objects, interrupted backups, corrupted manifests, and partial runner loss. A restored environment must prove that no old process can publish under a restored grant.

Upgrades drain gateways/workers, checkpoint or finish in-flight work according to policy, run verified schema changes, and restart the supported client/runtime contract. Rollback means restoring a tested deployment/data snapshot or applying a verified forward fix; it must not mean running an old binary against an incompatible new schema.

AU-09 defines the current-interpreter drain/checkpoint boundary, including pending commands and child executions. A failed drain prevents the upgrade. Backups include schedule/occurrence cursors, trigger decisions/windows, replay tombstones and ownership transfers; restoring display history without these records is not sufficient to safely resume automation. RT-07 defines isolated rehearsal and staged Fleet update evidence.

For the Fleet transformation, use one explicit cutover: inventory and export → backup → import and validate → upgrade/re-enroll clients as required → parity verification → activate cloud scheduling. Preserve managed settings, secrets, device mappings, and access to local histories. Retire the old server/data path after accepted verification; no indefinite dual-write or compatibility layer is required.
