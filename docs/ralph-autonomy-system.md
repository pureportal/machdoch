# RALPH autonomy system

Status: implemented and verified on 2026-07-31

This document records the research and engineering decisions behind Machdoch's
RALPH autonomy runtime. The incident analysis and original phased proposal
remain in [ralph-autonomy-refactoring-plan.md](./ralph-autonomy-refactoring-plan.md).

## Design goal

RALPH is a durable work loop, not a graph-completion loop. A run may claim
success only when the engine can point to repository output, comparable
verification, scope evidence, and a completed final report. Reaching a green
`END` block is only a request to evaluate completion.

The runtime distinguishes these semantic outcomes:

| Outcome                     | Verified | Resumable        | Meaning                                                                    |
| --------------------------- | -------- | ---------------- | -------------------------------------------------------------------------- |
| `succeeded`                 | yes      | no               | Meaningful output passed all required evidence gates                       |
| `no-op`                     | yes      | no               | A final report justified doing nothing and the repository stayed unchanged |
| `deferred`                  | no       | yes              | Work intentionally awaits a prerequisite or later retry                    |
| `blocked`                   | no       | yes              | A concrete blocker prevents completion                                     |
| `stalled`                   | no       | yes              | Repeated semantic states or prolonged no-progress were detected            |
| `budget-exhausted`          | no       | policy-dependent | The bounded transition budget ended                                        |
| `verification-inconclusive` | no       | yes              | Output or comparable verification evidence is missing                      |
| `failed`                    | no       | usually yes      | Verification regressed, scope failed, or execution crashed                 |
| `cancelled`                 | no       | yes              | The operator or scheduler stopped the run                                  |

Lifecycle state (`running`, `completed`, `blocked`, `crashed`, `stopped`, or
`waiting-for-input`) is retained separately. CLI exit codes, scheduler
reconciliation, final reports, and the desktop UI use the semantic outcome.

## Research that shaped the implementation

The design uses techniques that survived comparison with Machdoch's actual
failure evidence:

| Source                                                                                                                                                                              | Useful result                                                                                                      | Machdoch decision                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| [Original Ralph loop](https://github.com/ghuntley/how-to-ralph-wiggum)                                                                                                              | Fresh contexts and durable files can sustain work longer than one conversation                                     | Keep bounded work units and durable handoffs, but do not treat iteration count or a completion phrase as proof                |
| [Anthropic Ralph Wiggum plugin](https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md)                                                                 | Stop hooks can feed the same task back until a condition is met                                                    | Preserve graph loops while putting an engine-owned evaluator and circuit breaker outside the prompt                           |
| [Anthropic CWC long-running agents](https://github.com/anthropics/cwc-long-running-agents)                                                                                          | Default-fail evaluators, explicit handoffs, and independent verification reduce false completion                   | Candidate checks default to inconclusive unless they are comparable with a frozen baseline; reports cannot promote themselves |
| [Anthropic harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)                                                                                  | Small feature increments, clean state, and explicit progress artifacts improve long-horizon reliability            | Persist objective progress and operation state at bounded block boundaries                                                    |
| [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)                                                                                        | Simple composable workflows are more reliable than unnecessary agent complexity                                    | Retain one coherent runner and utility contract instead of adding an orchestration hierarchy                                  |
| [Demystifying agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)                                                                                  | Outcomes need task-level graders and inspectable evidence                                                          | Outcome derivation is deterministic and stores evidence fingerprints                                                          |
| [OpenHands conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)                                                                                       | Event streams and resumable state are separate concerns                                                            | Use an append-only journal plus immutable checkpoint generations                                                              |
| [LangGraph fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) and [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Checkpointed tasks can resume without repeating completed work, while retries stay scoped to the failing operation | Classify every block by replay semantics and persist intent only where reconciliation or at-most-once execution requires it   |
| [OpenHands stuck detector](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py)                                    | Content-based repeated action, observation, and error patterns are detectable without another model call           | Detect semantic cycles of length one through four and consecutive no-progress while ignoring volatile metadata                |
| [OpenHands context condenser](https://docs.openhands.dev/sdk/guides/context-condenser)                                                                                              | Long histories need bounded active context with durable backing                                                    | Bound checkpoints and keep full execution history in append-only logs                                                         |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/agents.py)                                                                                              | Per-attempt trajectories and bounded review-driven retries keep recovery inspectable                               | Persist attempt evidence and route concrete verifier feedback into bounded repair cycles                                      |
| [Agentless](https://arxiv.org/abs/2407.01489)                                                                                                                                       | Staged localization, repair, and validation can outperform unconstrained looping                                   | Starter flows freeze selection and verification before implementation                                                         |
| [Reflexion](https://arxiv.org/abs/2303.11366)                                                                                                                                       | Compact feedback retained across attempts can improve later decisions                                              | Store failure fingerprints, recovery attempts, and next actions rather than replaying raw analysis                            |
| [AutoCodeRover](https://arxiv.org/abs/2404.05427), [SWE-Search](https://arxiv.org/abs/2410.20285), and [TDFlow](https://arxiv.org/abs/2510.23761)                                   | Search should be structured, budgeted, and evaluated rather than endless                                           | Use explicit transition/recovery budgets and stop polishing when evidence is sufficient                                       |

No source was copied wholesale. In particular, an infinite prompt replay loop
does not meet Machdoch's persistence, Windows filesystem, nested-repository, or
truthful scheduler requirements.

### 2025-2026 evidence review

Recent research strengthened the case for deterministic state feedback rather
than more model-authored orchestration:

- [Plan-and-Act](https://arxiv.org/abs/2503.09572) reports gains from separating
  high-level planning from execution on long-horizon web tasks.
- [ML-Tool-Bench](https://arxiv.org/abs/2512.00672) finds inconsistent
  model-based state scoring in ReAct/tree-search agents and reports a 16.52
  median-percentile-position improvement from deterministic shaped rewards,
  structured feedback, and subtask decomposition.
- [MLE-Dojo](https://proceedings.neurips.cc/paper_files/paper/2025/hash/0603c69125ad4b964bc9c4832f7b9f8f-Abstract-Datasets_and_Benchmarks_Track.html)
  shows that executable iterative feedback helps, while current agents still
  struggle with long horizons and complex error recovery.
- A 2025 [agent failure study](https://arxiv.org/abs/2508.13143) observes about
  50% completion across its tested systems and separates planning, execution,
  and final-response failures.
- [VerificAgent](https://arxiv.org/abs/2506.02539) shows the value and risk of
  durable memory: verified memory improved its OSWorld task success, while
  unchecked learned rules introduced false guidance. Machdoch therefore does
  not promote model prose into durable autonomy evidence.
- The July 2026 [progress-mirage preprint](https://arxiv.org/abs/2607.25152)
  is preliminary but directly relevant: self-reported improvement was
  uninformative in its controlled loop, reinforcing Machdoch's existing
  repository- and verification-grounded progress gates.
- [SentinelBench](https://www.microsoft.com/en-us/research/publication/sentinelbench-a-benchmark-for-long-running-monitoring-agents/)
  distinguishes waiting from continuous action and measures completion,
  reaction time, and resource use. Existing `WAIT`, `POLL`, deferred state, and
  scheduler resume paths already cover that capability without adding another
  agent loop.

These are research results, not general guarantees for repository agents. The
production-system review supplied complementary engineering evidence:

- [Temporal](https://docs.temporal.io/workflow-execution) records durable state
  transitions and replays from event history; its
  [retry guidance](https://docs.temporal.io/encyclopedia/retry-policies)
  distinguishes transient/intermittent failures from permanent input or logic
  failures.
- [n8n](https://github.com/n8n-io/n8n) demonstrates explicit graph routing,
  execution metadata, approvals, and observability. Its
  [MCP execution API](https://github.com/n8n-io/n8n-docs/blob/main/docs/connect/connect-to-n8n-mcp-server/mcp-server-tools-reference.md)
  defaults to lightweight metadata and makes full or node-filtered data
  opt-in.
- [OpenCrawl](https://github.com/janhq/OpenCrawl) uses queues, batching,
  backpressure, parallel workers, and per-domain rate limits. Those are useful
  throughput patterns for independent work, but do not justify parallel
  repository writers that would contaminate Machdoch's frozen baseline.
- Anthropic's
  [long-running harness](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  keeps explicit planning and skeptical evaluation while warning that stale
  scaffolding adds latency and cost. Machdoch adds a deterministic assessor
  rather than another planner/evaluator model call.

## Runtime architecture

### Frozen repository context

`DETECT_PROJECT_COMMANDS` resolves and records:

- workspace root;
- detected project root;
- actual Git worktree root, including nested repositories;
- workspace-relative project path; and
- a stable repository-identity digest.

Model-backed blocks inherit the detected project root. Git snapshot, diff, and
scope utilities in every starter use the detected worktree root. A resumed run
re-resolves the context and stops if the worktree or project identity changed.
Changing `HEAD` inside the same worktree is legitimate and does not change the
identity.

Before capturing a baseline, every autonomy-enabled run acquires
`.machdoch/ralph/runs/.workspace-writer.ralph.lock`. The heartbeat-backed lease
serializes writers across parent and nested repositories in the same workspace,
refuses to evict a live owner, and recovers an expired lease whose owner is no
longer alive. Separate workspaces can still run concurrently. This conservative
workspace boundary avoids baseline contamination even when two detected Git
worktrees overlap on disk.

### Objective progress

The progress detector tracks independent channels:

- repository fingerprints;
- durable work-item state;
- scope-gate state; and
- semantic verification disposition.

Channel identity is stored as a discriminated structure, including separate
work-item path and block identities. Fingerprint lookup never depends on a
delimiter-built string key.

Model prose, routing, notifications, and repeated analysis are not objective
progress. Complete, machine-observed file-change sets from agent execution are.
A repeated repair counts as progress only when its content fingerprints change;
editing the same filenames again is neither automatically productive nor
automatically stagnant.
Starter work-yield gates use the same deterministic repository transform. It
compares content signatures across the union of baseline and current paths,
scopes repetition to the selected task identity, excludes lifecycle state
files, and keeps verification reachable when the final observation fails.
Starter routing uses structured condition trees for enum validation, task-list
requirements, identity equality, and all/any composition. Invalid declared
states fail closed instead of being inferred from JavaScript expression text.
Verification selection, code-plan identity, repository yield, and visual
runtime capability resolution are deterministic engine transforms.
A run stops as `stalled` when it repeats a semantic cycle (length one through
four) for the configured count or exceeds the no-progress threshold. Before
declaring a stall in a Git-backed run, the engine performs one lightweight
repository observation. A changed product fingerprint resets the stagnation
counter, allowing productive repeated routes to continue; unchanged work stops.
`.machdoch/**` is excluded from both evidence channels, so loop counters,
leases, journals, and other engine bookkeeping cannot manufacture progress. The
evidence, reason, checkpoint, and suggested next action remain visible.

### Deterministic task-plan assessment

`ASSESS_JSON_TASKS` reads a persisted task plan without claiming or mutating
work and emits one of:

- `READY` with a preview of the next eligible bounded task batch;
- `COMPLETE` only when a non-empty plan has no unfinished tasks;
- `BLOCKED` with dependency, cycle, deferred-time, or foreign-lease evidence;
- `EMPTY`, which is explicitly not completion;
- `NOT_FOUND`, `INVALID`, or `ERROR`.

The assessor uses the same status, dependency, lease, eligibility, batching,
and strategy rules as `SELECT_JSON_TASK`. It reports structural versus
temporarily retryable blockage and the earliest known retry time. Task,
candidate, blocker, dependency, and cycle details are capped at 100 items while
full-plan counts and the routing decision still use every task.

Lease refresh folds task selections and lifecycle mutations in chronological
order. Completed and deferred tasks leave the active claim set immediately,
and archiving a lifecycle file retires every remaining claim for that file.
Claim identity keeps file path, JSON path, and task ids as separate fields.
Durability checkpoints therefore refresh only work that can still be resumed.
Scope registries accept only schema version 2 and its explicit outcome enum;
arbitrary labels are never interpreted as lifecycle outcomes.

The Autonomous Feature Generation and Feature Implementation Checklist
starters now assess before every task claim and after every completed or
repairing transition. A selection race that returns `EMPTY` or `INVALID` loops
through a fresh assessment; it cannot turn a stale observation into false
completion. Empty or malformed plans route to invalid outcomes. Blocked plans
retain their state and journal the bounded assessment evidence as `BLOCKED`, so
the shared outcome evaluator cannot misreport them as generic recovery
exhaustion. Only `COMPLETE` reaches completion evidence. This replaces
duplicated JavaScript conditions with one inspectable runtime contract and
requires no model call.

### Comparative verification

Starter flows establish a frozen verification plan before implementation:

1. The selector chooses the work scope and verification tier.
2. A baseline `RUN_CHECK` records command, normalized working directory, exit
   code, failure identifiers, missing dependencies, and semantic/output
   fingerprints.
3. Work executes.
4. The candidate runs the identical command and working directory.
5. The engine classifies it as `PASSED`, `REGRESSION`,
   `BASELINE_EQUIVALENT_FAILURE`, `IMPROVED_WITH_BASELINE_FAILURES`, or
   `ENVIRONMENT_UNAVAILABLE`, `TIMEOUT`, or `INCONCLUSIVE`.

Timing, ANSI sequences, and other volatile output are normalized. A failing
candidate can be accepted only when its semantic failures do not exceed the
frozen baseline. Missing dependencies, timeouts, mismatched plans, and unsafe
comparisons are unverified, never source regressions or success.

### Evidence-based finalization

For every autonomy-enabled flow, the engine fails closed and requires:

- a candidate verification result that is not a regression or inconclusive;
- repository output that differs from the engine baseline, or an explicitly
  justified unchanged repository for `no-op`;
- an in-scope final diff; and
- an executed final report.

The engine captures the repository before work and requires an engine-owned
snapshot after the final potentially mutating block. Adjacent diff and scope
gates reuse the same snapshot rather than repeating identical Git work.
Finalization may reuse that snapshot only when every later block is provably
repository-preserving; prompts, checks, writes, MCP/media actions, configured
report outputs, and unknown blocks force a fresh capture. Reuse provenance is
stored in the result.

This comparison takes precedence over graph-reported changes. Each durable run
writes `autonomy-evidence.json` with the semantic outcome, progress state,
repository identity, repository fingerprints, capture time, and reused
snapshot block when applicable. Git evidence excludes `.machdoch/**`, so
RALPH's own counters, work registries, leases, and growing logs cannot
masquerade as product work even when the target repository does not ignore that
directory.

### Durable execution

A run directory contains:

```text
run.json                 observable projection, updated at a bounded cadence
execution-history.jsonl  append-only block results
journal.jsonl            checksummed route/checkpoint/outcome journal
checkpoints/              immutable checksummed generations, newest eight kept
run-lease.json           tiny independently heartbeated ownership record
autonomy-evidence.json   final evidence and semantic outcome
simple.jsonl / simple.md / trace.jsonl
```

Heartbeats validate and update only the small lease; they neither parse nor
rewrite `run.json`. Blocks declare one of three effect policies: replay-safe,
reconcilable, or at-most-once. Replay-safe operations checkpoint once after
routing. Reconcilable and at-most-once operations force an intent projection
and a completion projection. `APPEND_JSONL` reconciles through its operation
ledger. The ledger has a versioned, discriminated schema; malformed operation
state fails before the JSONL target is mutated. Default `ARCHIVE_FILE`
destinations derive from the durable operation
identity, so a resume can recognize an already completed rename without
overwriting another archive.
Task-lease refresh treats an active typed mutation lock as transient contention
and retries on a later heartbeat or block boundary without degrading the run.

The newest valid immutable checkpoint is authoritative when `run.json` lags or
its newest checkpoint is damaged. Journal appends are flushed before they are
acknowledged. Initialization removes a crash-truncated final append or restores
its missing newline before assigning the next sequence; corruption in a
terminated entry and non-transient I/O errors fail closed.

The operation ledger prevents blind replay after an indeterminate side effect.
Waiting input blocks replay from their durable request. Final blocked, stopped,
and waiting states persist another immutable checkpoint before releasing the
lease.

## Starter-flow coverage

All six starters use the same evidence contract:

- Autonomous Feature Generation Loop
- Autonomous Code Improvement Loop
- Autonomous UI Improvement Loop
- Repository Refactor & Validation Loop
- Feature Implementation Checklist Loop
- Security Review & Fix Loop

Each has one baseline/candidate pair with the same frozen command, fallback,
working directory, and plan id. The baseline dominates the candidate in the
graph. Candidate `INCONCLUSIVE` routes through evidence collection and
reporting, but final outcome derivation keeps the run resumable and unverified.
Every terminal declares an outcome, every Git gate uses the detected worktree,
and every flow uses bounded stagnation/cycle settings.

## Verification evidence

Focused and integration coverage includes:

- premature successful `END` converted to a resumable
  `verification-inconclusive` outcome;
- real Git-backed artifact creation, baseline/candidate syntax checks, diff,
  scope gate, final report, durable run record, and
  `autonomy-evidence.json`;
- semantic-cycle stopping before the transition budget;
- productive repeated routes continuing when an on-demand Git fingerprint
  proves new product output;
- the real Security Review & Fix starter completing a durable, verified no-op
  when every discovered scope is deferred;
- baseline-equivalent failures, regressions, missing dependencies, and unsafe
  comparisons;
- corrupt newest checkpoint fallback, truncated journal recovery, independent
  lease heartbeat, checkpoint retention, and stale `run.json` recovery;
- journal tail repair before a recovery append and fail-closed terminated-entry
  corruption;
- waiting-input resume, operation reconciliation, competing owners, lease
  theft, interruption, and final-report recovery;
- completed task-claim retirement before lifecycle archive, deterministic
  archive reconciliation, and content-sensitive same-file repair progress;
- concurrent autonomous writers blocked before baseline and abandoned
  workspace-writer lease recovery;
- structural validation of the evidence contract across all six starters; and
- CLI and scheduler behavior for verified and resumable outcomes.

Task-plan assessment coverage additionally verifies non-mutation, non-empty
completion, empty-plan rejection, deterministic ready-task preview, temporary
retry timestamps, malformed retry timestamps, structural dependency blockers,
bounded nested output, durable blocker evidence, and truthful blocked outcomes.

The Git-backed scenario initially exceeded 90 seconds while the old
three-persistence-boundaries-per-block behavior was still active. After
replay-safe checkpoint coalescing and bounded `run.json` projection, the same
scenario completed in 18.66 seconds. Heavy concurrent process contention then
exposed duplicate Git capture in adjacent diff/scope/final gates and caused two
bounded 180-second test failures after useful work had completed. Safe snapshot
reuse removed that duplication. The final hardened run, with no `.machdoch`
ignore in its fixture, completed in 7.16 seconds and asserted the resulting file
contents, candidate disposition, changed-file fingerprint, scope decision,
final report, run record, journal, and `autonomy-evidence.json`. These are
test-level measurements, not a general performance guarantee.

The current broad validation contains 1,033 passing RALPH tests across 96 files.
The complete 115-test engine file, repository-wide checks, full workspace
typechecking, formatting checks, and the client production TypeScript build
also pass.

## Residual risks

- Verification normalization is deliberately generic. Framework-specific
  parsers can improve failure identifiers without weakening the default-fail
  comparison.
- The workspace writer lease deliberately serializes autonomous runs targeting
  disjoint repositories inside one workspace. This trades some throughput for
  deterministic baselines and nested-repository safety.
- External editors and processes do not honor the RALPH lease. Final
  fingerprints and scope gates detect most interference, but cannot prevent an
  external write after the final snapshot.
- Repository evidence covers Git worktrees. Non-Git tasks must provide
  explicit graph evidence and cannot claim a repository-verified outcome.
- Task-plan assessment is diagnostic and read-only. It does not repair malformed
  dependencies or schedule the exact retry instant; the scheduler or operator
  must resume later. Detail arrays are capped at 100 while counts and routing
  still cover the full plan.
- Real unattended quality still depends on the selected model, task
  specificity, available tools, and the correctness of project-owned test
  commands.
- Long production runs under antivirus/indexer contention need continued
  observation, although heartbeat write amplification and transient
  rename-related false crashes are removed from the hot path.
