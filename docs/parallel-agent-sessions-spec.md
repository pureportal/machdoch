# Parallel agent sessions

Status: Draft; date: 2026-08-28

## Goal

Let one Machdoch execution delegate independent parts of a task to concurrent AI
worker sessions, then validate and integrate their results into one parent result.
Parallelism should reduce elapsed time without weakening execution boundaries or
changing the meaning of chat and Ralph completion.

## Scope

- Add an opt-in `Parallel agents` toggle to the chat composer and Ralph run
  controls. It permits delegation; it does not require it.
- Persist the chat choice as a session preference and copy it into each user
  message's immutable settings. Copy the Ralph choice into the run record and
  every checkpoint. Retries, branches, and resumes use the copied value.
- Default to at most three concurrent workers. Enforce a product hard cap of
  four and any lower provider, model, process, or resource cap.
- Use the selected parent provider and model for fresh worker sessions. Do not
  support heterogeneous worker models in v1.
- Support independent read work first. Permit concurrent writes only when
  Machdoch can enforce disjoint read/write and shared-resource claims for the
  selected execution adapter.
- Do not allow nested delegation, dynamic worker spawning, or background workers
  after parent completion. Do not use provider-native subagent systems to
  implement this feature.
- In Ralph, parallelism may occur only within one `PROMPT` or `VALIDATOR` block.
  Join it into one atomic block result before routing. Groups remain visual
  organization and are never executable units.

## Non-goals

- Starting multiple desktop tasks from React or bypassing the existing active
  task and workspace-writer ownership rules.
- Running Ralph blocks or graph branches concurrently.
- A durable distributed queue, work stealing, dependency DAG, or mid-task chat
  resume.
- Automatic worktree creation, merging, rollback, or conflict resolution.
- Reimplementing a provider's Fleet, team, or native subagent feature.

## Execution model

Parallel orchestration belongs in the provider-neutral core and runs inside one
parent `TaskExecutionController` or Ralph block execution:

```text
snapshot -> plan -> validate -> bounded schedule -> all-settled join
         -> integrate and verify -> one result
```

The parent owns the task id, immutable settings and instructions, permissions,
workspace and Ralph leases, baseline and file-change capture, cancellation,
total timeout and usage accounting, persistence, final memory consolidation,
and terminal result. Each worker owns only a fresh provider session, scoped
context, child progress stream, timeout state, and structured result.

Do not implement workers by recursively running the complete parent lifecycle.
Use a worker execution primitive that omits parent-only capture, persistence,
memory consolidation, and terminal-result emission.

## Plan contract

Planning must produce schema-validated data, not prose:

```ts
type DelegationPlan =
  | { strategy: "direct"; reasonCode: string }
  | {
      strategy: "parallel";
      integrationObjective: string;
      workers: Array<{
        id: string;
        objective: string;
        access: "read-only" | "write";
        readPaths: string[];
        writePaths: string[];
        exclusiveResources: string[];
      }>;
    };
```

Before starting a worker, deterministic validation must ensure:

- there are between two and the effective worker limit, with unique stable ids;
- every objective is self-contained and has no dependency on a sibling result;
- all paths are canonical, inside authorized roots, and allowed by the parent;
- workers have no write/write or write/read overlap, including ancestor paths,
  rename sources and destinations, deletes, symlinks or junctions, and
  case-insensitive aliases;
- canonical resource claims are not shared by concurrent workers. Git index/HEAD
  changes, package or lockfile mutation, servers and ports, UI control, browser
  state, scheduler mutation, and stateful or side-effecting MCP calls require
  exclusive ownership and should normally use direct execution;
- `ask` workers are read-only, and `machdoch` write workers are used only when
  the adapter can enforce their claims. Instructions alone are not enforcement;
- native delegation is disabled during Machdoch-managed planning, worker, and
  integration calls. A provider that cannot guarantee this is ineligible for
  Machdoch-managed parallel execution.

A valid `direct` decision or deterministic suitability rejection uses the
ordinary single-agent path and records its reason code. A malformed plan fails
preflight. Never restart the whole task sequentially after any worker has
started, because that can duplicate side effects.

## Worker behavior

- Derive every worker from the same frozen parent settings, resolved instruction
  snapshot, conversation and attachment snapshot, and workspace baseline.
  Reattach Machdoch instructions explicitly; do not assume provider-native
  inheritance.
- Give the worker only its objective, claims, relevant context, allowed tools,
  and result schema. Remove delegation capabilities from its tool surface.
- Keep provider conversations, tool state, output buffers, and memory updates
  isolated. Workers do not see live sibling output or publish memory directly.
- Narrow permissions and tools; workers can never expand parent authority.
  Read-only workers receive no mutating tools. Writable workers must be fenced
  at the adapter/tool boundary, including shell or external CLI execution.
- Preserve results in plan order regardless of completion order. Cap worker
  output before adding it to integration context and treat it as untrusted data,
  not parent instructions.
- Record parent and worker usage separately and report their sum. The parent
  deadline and budget remain global; creating workers must not multiply them.

The scheduler starts no more than the effective limit. An ordinary worker
failure or timeout does not discard sibling results; the join is all-settled.
Parent cancellation or a safety-boundary violation cancels queued and running
workers, waits a bounded grace period, and terminates owned child processes.

## Integration and result semantics

The parent receives the original task, validated plan, ordered worker outcomes,
observed workspace changes, and failures. It must evaluate task coverage and the
current workspace; concatenating worker answers is not integration.

- Report success only when every required objective and final verification pass.
- A failed, blocked, cancelled, or timed-out required worker prevents an
  unqualified success, even if other workers completed.
- Capture workspace changes once around the complete parent execution. Validate
  the final change set against the union of worker claims and preserve pre-run
  dirty changes. A new out-of-scope or unattributable concurrent change blocks
  completion instead of being assigned to a worker.
- Run memory consolidation once, from the integrated parent result.
- Do not automatically roll back successful writes when another worker or the
  integrator fails. Return the truthful status and observed changes.
- Emit one parent terminal result. Child events are grouped by worker id in the
  existing timeline and must not be interleaved into the final answer.

## Ralph lifecycle

- A block attempt owns the plan, workers, join, integration, and result. Ralph
  routes exactly once after that result becomes terminal.
- Journal worker start and terminal events with the block attempt id. A
  checkpoint stores the immutable parallel setting and only references a block
  result after the join and integration complete.
- A crash may leave worker writes without a block result. Resume must reconcile
  the journal, operation evidence, and current workspace before retrying; it
  must not assume the block was clean or blindly replay mutating workers.
- Ralph block retry policy remains the only orchestration-level retry policy.
  Do not independently reschedule a worker that may already have produced side
  effects.

## Failure handling

| Failure                          | Required behavior                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Malformed plan                   | Fail preflight; launch nothing.                                                           |
| Unsafe or conflicting plan       | Select direct execution before launch and record the rejection reason.                    |
| Provider cap below two           | Execute the validated direct strategy and record the effective cap.                       |
| Worker provider/rate-limit error | Apply only existing safe request retries, then settle that worker as failed.              |
| Worker inactivity/timeout        | Cancel that worker, continue settling siblings, and prevent false success.                |
| Parent cancel/timeout            | Cancel all children and queued work; emit one cancelled/timed-out parent result.          |
| Worker escapes a claim           | Stop remaining writes, block the parent result, and retain evidence and observed changes. |
| Integrator fails after writes    | Report failure and the consolidated change set; do not rerun or roll back implicitly.     |
| Process crash or restart         | Reap owned children; chat is interrupted, while Ralph follows block reconciliation.       |

## Logical errors to avoid

- Treating the toggle as a command to parallelize unsuitable work.
- Counting the parent as an extra unbounded worker or applying the cap per queue.
- Sharing one provider conversation, abort controller, mutable tool registry, or
  memory accumulator across workers.
- Using prompt text as a path, permission, nesting, or side-effect boundary.
- Checking only write/write overlap while ignoring read/write overlap, renames,
  path aliases, shared state, and external effects.
- Failing fast with `Promise.all`, losing successful sibling evidence, or routing
  a Ralph edge on the first completed worker.
- Capturing file changes or consolidating memory once per worker.
- Assuming a clean Git worktree, attributing all observed changes to workers, or
  reporting partial work as complete.
- Retrying a mutating worker or the whole task without reconciliation and stable
  operation identity.
- Relying on undocumented provider-native scheduling or instruction inheritance.

## Acceptance criteria

1. With the toggle off, execution behavior and provider-session count are
   unchanged.
2. A suitable enabled task runs two or more fresh sessions concurrently, never
   exceeding the effective cap, and returns one parent result.
3. Unsuitable, overlapping, unsupported, or effectively single-worker plans
   start no parallel workers.
4. Settings survive chat retry/branch and Ralph checkpoint/resume without being
   read again from mutable UI state.
5. Cancellation, timeout, partial failure, and claim violations cannot produce
   success or leave owned child processes running.
6. File changes, usage, progress, instructions, and memory have one coherent
   parent record with worker-level evidence.
7. A Ralph `PROMPT` or `VALIDATOR` attempt emits one atomic block result and one
   route decision; groups never schedule work.

## Verification

Add unit coverage for plan schema and caps, Windows path aliases, symlink and
rename conflicts, read/write overlap, immutable setting snapshots, all-settled
status reduction, cancellation, and result/usage aggregation.

Add integration tests that:

- use delayed read workers to prove real overlap and cap enforcement;
- perform independent folder renames through an adapter with enforced claims;
- reject overlapping writes and a write through an unenforceable adapter;
- let one worker fail while siblings settle, then verify the parent is not
  successful and file/memory capture ran once;
- cancel a run and confirm queued work and child processes are gone;
- run and resume Ralph with parallel `PROMPT` and `VALIDATOR` blocks, confirming
  immutable settings, atomic routing, and crash reconciliation;
- verify each worker received the expected instruction digest and that native
  subagents remained disabled.
