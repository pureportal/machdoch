# Integration audit and specification corrections

Reviewed **22 October 2026**, repository HEAD `c434cf99` plus the then-current shared working tree. This audit distinguishes inspected behavior, directly exercised helpers, specification decisions and future release tests. Other workspace edits existed before this work; the task changes only `docs/machdoch-cloud`.

## What the repository already provides

| Foundation | Source evidence | Reuse and boundary |
| --- | --- | --- |
| Local durable scheduler | [scheduler](../../apps/client/src/core/scheduler.ts), `DurableSmartScheduler`, `recordEventAndEnqueueRuns`, `pruneRunHistory` | Cron/interval/delay, prompt/RALPH targets, retries, TTL, queue keys, local claim tokens, heartbeats, event/state triggers and receipts exist. This is workspace/user storage, not organization-wide admission. |
| Local persistence | [file locking and durable replacement](../../apps/client/src/core/_helpers/scheduler-file-storage.helper.ts), [workspace storage](../../apps/client/src/core/_helpers/scheduler-workspace-storage.helper.ts) | Keep appropriate private-client storage. Filesystem locks do not provide cross-machine ownership, revocation or tenant isolation. |
| Multiple workspace polling | [scheduler service](../../apps/client/src/core/scheduler-fleet-service.ts) | Existing service rotates registered workspaces and caps concurrent workspace workers at two. This is a local service despite its Fleet name, not the future cloud scheduler. |
| Recurrence calculation | [cron evaluator](../../apps/client/src/core/_helpers/parse-cron-expression.helper.ts), [misfire helper](../../apps/client/src/core/_helpers/split-due-times-by-missed-policy.helper.ts) | Reuse tests and vocabulary; explicitly resolve cloud recurrence semantics before extraction. |
| Event filtering | [matching/state/cooldown/rate-limit helpers](../../apps/client/src/core/_helpers/scheduler-event-trigger-matching.helper.ts) | Reuse typed concepts; cloud needs per-subject state, durable windows and trusted producer metadata. |
| File observers and RALPH | [watches](../../apps/client/src/core/ralph-watches.ts), [watch-to-job definition](../../apps/client/src/core/_helpers/create-ralph-watch-scheduler-job-input.helper.ts) | Existing observers feed local scheduled RALPH work. Preserve file event producers and local watch behavior; add an explicitly scoped cloud event projection. |
| Shared scheduler UI/protocol | [contract](../../packages/fleet-protocol/src/scheduler-contract.ts), [panel](../../packages/client-ui/src/scheduler/scheduler-panel.tsx), [native handler](../../apps/client/src-tauri/src/fleet_control/scheduler.rs) | Extend canonical product controls with ownership and cloud lifecycle. Do not create a competing scheduler editor with different meanings. |
| Session placement | [Fleet session routes](../../apps/fleet-manager/src/server/fleet-sessions.ts), [route schema](../../apps/fleet-manager/src/server/migrations/005-fleet-session-routes.sql) | Command ID and target digest persist, with selected device/workspace. Keep placement identity; a route/session is not an issue run or a renewable execution grant. |
| Remote transport | [gateway](../../apps/fleet-manager/src/server/gateway.ts), [relay](../../apps/fleet-manager/src/server/instance-relay.ts), [client service](../../apps/client/src/core/fleet-service.ts) | Evolve outbound connections and correlation, preserving remote operations and priority control traffic. |
| Local tool server | [MCP server](../../apps/client/src/core/local-mcp/server.ts), [client dependencies](../../apps/client/package.json) | The server imports the SDK server/tool schemas and exposes local tools. Existing SDK dependency is `^1.29.0`; do not infer current cloud protocol conformance from a dependency range. |
| Isolated work and runtime | [RALPH worktree setup](../../apps/client/src/core/_helpers/ralph-run-worktree.helper.ts), [provider adapters](../../apps/client/src/core/_helpers/provider-adapters.ts) | Share actual execution/instruction/tool behavior. Keep user checkout snapshots an explicit operation; add cloud ownership, mediated credentials and environment isolation. |

No source map entry is a claim that the whole remote workflow passed in this review. Existing remote audits remain dated observations; current device/provider behavior must meet D-02/D-04.

## Findings and resolved specification decisions

| ID | Evidence or logical problem | Required resolution | Acceptance |
| --- | --- | --- | --- |
| F-01 | The earlier foundation table omitted the existing scheduler/event/watch implementation. | Explicit reuse map and one authority per schedule; AU-01/AU-02. | T-36 |
| F-02 | Cloud and client recurrence could both fire a promoted job, especially while disconnected. | Transfer intent, local disable/drain acknowledgment, watermark, then cloud enable; no offline speculative transfer. | T-36 |
| F-03 | Local cron combines constrained day-of-month/weekday with OR. Temporal's contract combines with AND. | One canonical recurrence evaluator and Temporal durable timers; no raw cron pass-through. | T-37 |
| F-04 | Direct probes show two Berlin autumn occurrences, a skipped spring occurrence, and leap-day rejection beyond one-year lookahead. | Explicit DST policy and sparse recurrence support; AU-03 defines new defaults. | T-37 |
| F-05 | Original event dedupe key included automation revision, which could allow redelivery after an edit to execute again. | Stable trigger-decision identity; evaluated revision is pinned data. Intentional replay needs its own command. | T-38 |
| F-06 | Local event history and mutation receipts are capped at 1,000; run history is separately pruned. Dedupe and rate checks inspect these retained collections. | Cloud correctness uses durable receipts/tombstones and window counters independent of display history. Do not claim indefinite local replay protection. | T-39 |
| F-07 | Stateful local matching stores `lastState`/`lastFiredAt` on a trigger and evaluates repeats when an event arrives. | Key cloud state by subject and schedule durable recovery/repeat/absence timers. | T-40 |
| F-08 | `debounceMs` is carried in scheduler definitions, but the inspected generic event-enqueue path immediately creates runs. File-watch debounce is a separate producer path. | Do not infer generic durable debounce from the field. Define persistent trailing windows and max wait. This is a source-level gap, not a reproduced end-to-end file-watch defect. | T-40 |
| F-09 | A catch-up limit per evaluator page can still flood work over successive polls; “latest” per page is not latest over the outage. | Bounded whole-window accounting, cursors and skipped/coalesced ranges. | T-41 |
| F-10 | RALPH retries, Temporal retries and runner retries could each restart the same agent. | Shared StepExecution identity and one lifecycle owner; retries reconcile before executing. | T-42 |
| F-11 | “No legacy paths” conflicts with casually relying on old Temporal workers for indefinitely running workflows. | Current interpreter, admission drain and portable checkpoint upgrade contract; no permanent compatibility runtime. | T-43 |
| F-12 | Run was defined only in terms of an issue, but research, maintenance and test campaigns need durable work without inventing tickets. | Run subject union; every repository implementation still requires the canonical issue constraint. | T-44 |
| F-13 | Suggested 24-hour wall deadline and seven-day human wait were inconsistent unless their clocks were defined. | One explicit wall deadline includes waiting; project policy must extend it for a seven-day wait. Each phase uses the earlier applicable deadline. | T-45 |
| F-14 | “Nonterminal runs” uniqueness was ambiguous if a terminal result still had unresolved effects. | Explicit implementation reservation, released only by reconciliation; terminal outcome is recorded after that boundary. | T-46 |
| F-15 | High-level “remote testing” did not define complete shard evidence, test data/account isolation or native/physical capability distinctions. | RT-01–RT-07 define campaign/result/environment/control/repair/operations behavior. | T-47–T-52 |
| F-16 | Local MCP availability did not prove current stateless cloud MCP/Tasks support or multi-user delegated auth. | Upgrade current shared client/server binding deliberately and certify it with two users, revocation and durable run handles. | T-53 |
| F-17 | A WebSocket cursor, webhook ordering and a runner's local sequence were easily conflated with trusted domain order. | Separate ingress/source/run identities, authenticate producers and reject stale state projections. | T-38, T-54 |
| F-18 | Periodic and event automation could continuously generate review debt or quietly overspend through descendants. | Shared causal budgets, no-op output, review capacity admission and bounded improvement loops. | T-55 |
| F-19 | Workflow pause, schedule disable, kill switch and cancellation had no distinct edit/race contract. | AU-04/AU-11 set an atomic effective boundary and explicit queued/running behavior. | T-56 |
| F-20 | Tests could assess only a successful final answer while missing harmful intermediate effects. | Require action receipts/invariants and independent outcome evidence; include new reliability research in evaluation. | T-57 |

These are resolved requirements and integration risks. The underlying application gaps are implementation work; this review does not claim to repair them.

## Integration sequence within the full release

1. Define cloud domain identities, run subjects, authority, canonical recurrence and event/action contracts. Add fixture-level TypeScript/Rust conformance where contracts cross the device boundary.
2. Extract shared recurrence/conditions and execution/step semantics only where client and cloud both consume them. Keep desktop hardware and private local persistence in the client. Keep cloud business data outside the runtime package.
3. Implement PostgreSQL admission, occurrence/trigger/action receipts, inbox/outbox, Temporal coordinators, budgets and reconciliation together. Exercise concurrent admission and schedule ownership transfer before enabling automated writers.
4. Extend Fleet protocol with authenticated claim/accept/execute/reconcile, scoped event ingress, capability inventory and current cloud MCP registration. Preserve remote editor/control behavior through the same domain services.
5. Implement cloud sandboxes and managed client workspaces using the shared runtime; attach RT test campaigns and evidence. Implement automation actions through these paths rather than direct untracked process launches.
6. Preserve private device schedules. During Fleet cutover import cloud-intended schedules explicitly, transfer ownership and verify next occurrences; do not silently upload all personal scheduled prompts or local context.
7. Qualify the complete planning, identity, GitHub/provider, automation, remote-control and recovery journeys. Full delivery remains all requirements, not just this automation increment.

## Executed baseline checks

On 22 October 2026, from `apps/client`:

```powershell
pnpm exec vitest run src/core/_helpers/parse-cron-expression.helper.spec.ts src/core/_helpers/scheduler-event-trigger-matching.helper.spec.ts src/core/_helpers/split-due-times-by-missed-policy.helper.spec.ts src/core/scheduler-fleet-service.spec.ts
```

Result: **4 files, 40 tests passed**. These exercise existing local helpers/service behavior; they do not implement or certify the proposed cloud semantics. No dev server was started.

Direct Node 24.14.1 calls to the existing exported `getNextCronRunAfter` produced:

| Probe | Inputs | Observed result |
| --- | --- | --- |
| Autumn fold | `30 2 * * *`, Europe/Berlin, after `2026-10-24T23:59Z` | `2026-10-25T00:30Z`, then `2026-10-25T01:30Z` |
| Spring gap | Same expression/zone, after `2026-03-28T23:59Z` | Next occurrence `2026-03-30T00:30Z` |
| Day OR weekday | `0 9 1 * MON`, UTC, after `2026-10-22T00:00Z` | October 26, then November 1, both at 09:00Z |
| Sparse recurrence | `0 0 29 2 *`, UTC, after `2026-10-22T00:00Z` | Throws `Unable to find next cron run within one year` |

These demonstrate why source-level conformance examples are necessary before replacing recurrence evaluation. New DST defaults and leap-day support remain future acceptance criteria, not successful checks against new code.
