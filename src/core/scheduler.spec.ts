import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DurableSmartScheduler,
  createScheduledRalphExecutionSnapshot,
  getNextCronRunAfter,
  getWorkspaceSchedulerStatePath,
  syncScheduledPromptJobs,
  type ScheduledTaskExecutor,
} from "./scheduler.ts";
import {
  createRalphFlowFingerprint,
  deleteRalphFlow,
  writeRalphFlow,
  type RalphFlow,
} from "./ralph.ts";
import type { TaskExecutionResult } from "./types.ts";

const workspacesToClean: string[] = [];

const createSimpleFlow = (
  id: string,
  options: Partial<RalphFlow> = {},
): RalphFlow => ({
  schemaVersion: 1,
  id,
  name: options.name ?? id,
  ...options,
  blocks: options.blocks ?? [
    { id: "start", type: "START", title: "Start" },
    { id: "done", type: "END", title: "Done", status: "success" },
  ],
  edges: options.edges ?? [
    {
      id: "start-done",
      from: "start",
      fromOutput: "SUCCESS",
      to: "done",
    },
  ],
});

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-scheduler-"));
  workspacesToClean.push(workspaceRoot);

  for (const id of [
    "autonomous-improvement",
    "autonomous-ui-improvement",
    "isolated-improvement",
    "legacy-flow",
    "security-analysis",
  ]) {
    await writeRalphFlow(workspaceRoot, createSimpleFlow(id));
  }

  return workspaceRoot;
};

const createClock = (initialTimestamp = 0): {
  now(): number;
  set(timestamp: number): void;
  advance(durationMs: number): void;
} => {
  let timestamp = initialTimestamp;

  return {
    now: () => timestamp,
    set: (nextTimestamp: number): void => {
      timestamp = nextTimestamp;
    },
    advance: (durationMs: number): void => {
      timestamp += durationMs;
    },
  };
};

const defer = <T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} => {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: (value: T): void => {
      resolvePromise?.(value);
    },
    reject: (error: unknown): void => {
      rejectPromise?.(error);
    },
  };
};

const sleep = async (durationMs: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
};

const getExpectedWorkspaceQueueKey = (workspaceRoot: string): string => {
  const normalized = resolve(workspaceRoot).replaceAll("\\", "/");
  return `ralph-workspace:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
};

const createSuccessfulResult = (
  summary = "Scheduled task completed.",
): TaskExecutionResult => ({
  task: "scheduled task",
  mode: "machdoch",
  status: "executed",
  summary,
  executedTools: [],
  outputSections: [],
});

afterEach(async () => {
  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("getNextCronRunAfter", () => {
  it("calculates cron runs in the configured IANA timezone", () => {
    const after = Date.UTC(2026, 0, 1, 13, 59, 0);
    const next = getNextCronRunAfter("0 9 * * *", "America/New_York", after);

    expect(new Date(next).toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });

  it("rejects cron expressions with seconds", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    await expect(
      scheduler.upsertJob({
        schedule: {
          type: "cron",
          expression: "0 */5 * * * *",
        },
        target: {
          workspaceRoot,
          prompt: "inspect workspace",
        },
      }),
    ).rejects.toThrow(/five fields/u);
  });
});

describe("DurableSmartScheduler", () => {
  it("strips nested starter provenance without changing execution fingerprint", () => {
    const flow = createSimpleFlow("snapshot-flow", {
      source: {
        kind: "starter",
        id: "source-starter",
        version: 2,
        templateFingerprint: "template-sha",
        templateVariableDefaults: { goal: "default" },
        templateSnapshot: createSimpleFlow("source-starter"),
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });

    const snapshot = createScheduledRalphExecutionSnapshot(flow);

    expect(snapshot.source?.templateSnapshot).toBeUndefined();
    expect(snapshot.source?.templateVariableDefaults).toBeUndefined();
    expect(snapshot.createdAt).toBeUndefined();
    expect(snapshot.updatedAt).toBeUndefined();
    expect(createRalphFlowFingerprint(snapshot)).toBe(
      createRalphFlowFingerprint(flow),
    );
  });

  it("rejects unattended targets with missing variables or human-only blocks", async () => {
    const workspaceRoot = await createWorkspace();
    await writeRalphFlow(
      workspaceRoot,
      createSimpleFlow("readiness-flow", {
        variables: [
          { name: "goal", type: "string", required: true },
        ],
      }),
    );
    await writeRalphFlow(
      workspaceRoot,
      createSimpleFlow("human-flow", {
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "approval",
            type: "ASK_USER",
            title: "Approval",
            mode: "alwaysAsk",
            fields: [{ id: "approved", label: "Approved", type: "boolean" }],
          },
          { id: "done", type: "END", title: "Done", status: "success" },
        ],
        edges: [
          { id: "to-approval", from: "start", fromOutput: "SUCCESS", to: "approval" },
          { id: "to-done", from: "approval", fromOutput: "SUBMITTED", to: "done" },
        ],
      }),
      { allowInvalid: true },
    );
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
    });

    await expect(scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: { id: "readiness-flow", executionProfile: "unattended" },
      },
    })).rejects.toThrow("Missing required Ralph parameter `goal`");

    await expect(scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "readiness-flow",
          params: { goal: "Improve it", typoGoal: "unknown" },
          executionProfile: "unattended",
        },
      },
    })).rejects.toThrow("parameter `typoGoal` is not declared");

    await expect(scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: { id: "human-flow" },
      },
    })).rejects.toThrow("cannot pause at ASK_USER");

    await expect(scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: { id: "human-flow", executionProfile: "unattended" },
      },
    })).resolves.toMatchObject({
      target: {
        ralphFlow: {
          executionProfile: "unattended",
          flowSnapshot: expect.objectContaining({ id: "human-flow" }),
        },
      },
    });
  });

  it("persists unresolved external flow references but will not enqueue them unpinned", async () => {
    const workspaceRoot = await createWorkspace();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
    });
    const forgedSnapshot = createSimpleFlow("external-flow", {
      name: "Untrusted caller snapshot",
    });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.external-flow" }],
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "external-flow",
          executionProfile: "unattended",
          flowSnapshot: forgedSnapshot,
          flowFingerprint: createRalphFlowFingerprint(forgedSnapshot),
        },
      },
    });

    expect(job.target.ralphFlow).toMatchObject({
      id: "external-flow",
      flowSnapshotRefreshError: expect.stringContaining("was not found"),
    });
    expect(job.target.ralphFlow?.flowSnapshot).toBeUndefined();
    await expect(scheduler.triggerJobNow(job.id)).rejects.toThrow(
      "Scheduled Ralph flow revision could not be refreshed",
    );

    await writeRalphFlow(
      workspaceRoot,
      createSimpleFlow("external-flow", { name: "Installed external flow" }),
    );
    const queued = await scheduler.triggerJobNow(job.id);

    expect(queued.run.targetSnapshot?.ralphFlow).toMatchObject({
      id: "external-flow",
      flowSnapshot: expect.objectContaining({ name: "Installed external flow" }),
    });
  });

  it("pins each queued Ralph revision while refreshing later occurrences", async () => {
    const workspaceRoot = await createWorkspace();
    await writeRalphFlow(
      workspaceRoot,
      createSimpleFlow("versioned-flow", { name: "Version One" }),
    );
    const observedNames: string[] = [];
    const executor: ScheduledTaskExecutor = {
      execute: async (request) => {
        observedNames.push(request.ralphFlow?.flowSnapshot?.name ?? "missing");
        return createSuccessfulResult();
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      executor,
    });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.versioned" }],
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "versioned-flow",
          executionProfile: "unattended",
        },
      },
    });

    const first = await scheduler.triggerJobNow(job.id);
    await writeRalphFlow(
      workspaceRoot,
      createSimpleFlow("versioned-flow", { name: "Version Two" }),
      { createRevision: true },
    );
    expect(first.run.targetSnapshot?.ralphFlow?.flowSnapshot?.name).toBe("Version One");
    await scheduler.runQueuedRuns();

    const second = await scheduler.triggerJobNow(job.id);
    expect(second.run.targetSnapshot?.ralphFlow?.flowSnapshot?.name).toBe("Version Two");
    await scheduler.runQueuedRuns();

    expect(observedNames).toEqual(["Version One", "Version Two"]);
  });

  it("deduplicates manual triggers and retries by durable idempotency key", async () => {
    const workspaceRoot = await createWorkspace();
    const statePath = getWorkspaceSchedulerStatePath(workspaceRoot);
    const executor: ScheduledTaskExecutor = {
      execute: async () => createSuccessfulResult("Run exactly once"),
    };
    const scheduler = new DurableSmartScheduler({ statePath, executor });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.remote" }],
      target: { workspaceRoot, prompt: "Run exactly once" },
    });

    const first = await scheduler.triggerJobNow(job.id, "remote-trigger-1");
    const reloaded = new DurableSmartScheduler({ statePath, executor });
    const duplicate = await reloaded.triggerJobNow(
      job.id,
      "remote-trigger-1",
    );

    expect(duplicate).toEqual(first);
    expect((await reloaded.listRuns(job.id))).toHaveLength(1);

    const [completed] = await reloaded.runQueuedRuns({ maxRuns: 1 });
    expect(completed?.status).toBe("succeeded");
    const retry = await reloaded.retryRun(
      completed!.id,
      "remote-retry-1",
    );
    const duplicateRetry = await new DurableSmartScheduler({
      statePath,
      executor,
    }).retryRun(completed!.id, "remote-retry-1");

    expect(duplicateRetry).toEqual(retry);
    expect((await reloaded.listRuns(job.id))).toHaveLength(2);
  });

  it("replays job mutations across restarts without undoing newer operations", async () => {
    const workspaceRoot = await createWorkspace();
    const statePath = getWorkspaceSchedulerStatePath(workspaceRoot);
    const clock = createClock(1_000);
    const input = {
      schedule: { type: "interval" as const, intervalMs: 60_000 },
      target: { workspaceRoot, prompt: "Keep the original mutation result" },
    };
    const scheduler = new DurableSmartScheduler({ statePath, clock });
    const created = await scheduler.upsertJob(input, "create-request");
    const updated = await scheduler.updateJob(
      created.id,
      { name: "First update" },
      "update-request",
    );
    await scheduler.updateJob(
      created.id,
      { name: "Newer update" },
      "newer-update-request",
    );

    const paused = await scheduler.pauseJob(
      created.id,
      "initial-pause-request",
    );
    clock.advance(10_000);

    const reloaded = new DurableSmartScheduler({ statePath, clock });
    const replayedCreate = await reloaded.upsertJob(input, "create-request");
    const replayedUpdate = await reloaded.updateJob(
      created.id,
      { name: "First update" },
      "update-request",
    );
    const replayedPause = await reloaded.pauseJob(
      created.id,
      "initial-pause-request",
    );

    expect(replayedCreate).toEqual(created);
    expect(replayedUpdate).toEqual(updated);
    expect(replayedPause).toEqual(paused);
    expect((await reloaded.getJob(created.id))?.status).toBe("paused");
    expect((await reloaded.getJob(created.id))?.name).toBe("Newer update");

    const resumed = await reloaded.resumeJob(created.id, "resume-request");
    const deleted = await reloaded.deleteJob(created.id, "delete-request");
    const stateBeforeReplay = await reloaded.getState();

    clock.advance(90_000);

    const replayedResume = await new DurableSmartScheduler({
      statePath,
      clock,
    }).resumeJob(created.id, "resume-request");
    const replayedDelete = await reloaded.deleteJob(
      created.id,
      "delete-request",
    );
    const stateAfterReplay = await reloaded.getState();

    expect(replayedResume).toEqual(resumed);
    expect(replayedDelete).toEqual(deleted);
    expect(stateAfterReplay.updatedAt).toBe(stateBeforeReplay.updatedAt);
    expect(stateAfterReplay.jobs.find((job) => job.id === created.id)?.status).toBe(
      "deleted",
    );
  });

  it("rejects reuse of a mutation key for another operation, target, or payload", async () => {
    const workspaceRoot = await createWorkspace();
    const statePath = getWorkspaceSchedulerStatePath(workspaceRoot);
    const scheduler = new DurableSmartScheduler({ statePath });
    const firstInput = {
      triggers: [{ kind: "manual" as const, eventType: "manual.first" }],
      target: { workspaceRoot, prompt: "First payload" },
    };
    const first = await scheduler.upsertJob(firstInput, "shared-request");

    await expect(
      scheduler.upsertJob(
        {
          ...firstInput,
          target: { workspaceRoot, prompt: "Changed payload" },
        },
        "shared-request",
      ),
    ).rejects.toThrow("Scheduler mutation idempotency conflict");
    await expect(
      scheduler.pauseJob(first.id, "shared-request"),
    ).rejects.toThrow("Scheduler mutation idempotency conflict");

    const second = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.second" }],
      target: { workspaceRoot, prompt: "Second target" },
    });
    await scheduler.pauseJob(first.id, "target-request");

    await expect(
      scheduler.pauseJob(second.id, "target-request"),
    ).rejects.toThrow("Scheduler mutation idempotency conflict");
  });

  it("replays trigger, retry, and cancel results after their runs are pruned", async () => {
    const workspaceRoot = await createWorkspace();
    const statePath = getWorkspaceSchedulerStatePath(workspaceRoot);
    const executor: ScheduledTaskExecutor = {
      execute: async () => createSuccessfulResult("completed for pruning"),
    };
    const scheduler = new DurableSmartScheduler({ statePath, executor });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.pruning" }],
      target: { workspaceRoot, prompt: "Exercise receipt pruning" },
      historyLimit: 1,
    });
    const triggered = await scheduler.triggerJobNow(job.id, "trigger-request");

    await scheduler.runQueuedRuns({ maxRuns: 1 });
    const retry = await scheduler.retryRun(
      triggered.run.id,
      "retry-request",
    );
    await scheduler.runQueuedRuns({ maxRuns: 1 });

    const cancelTarget = await scheduler.triggerJobNow(job.id);
    const cancelled = await scheduler.cancelRun(
      cancelTarget.run.id,
      "No longer needed.",
      "cancel-request",
    );
    await scheduler.triggerJobNow(job.id);
    await scheduler.runQueuedRuns({ maxRuns: 1 });

    expect(await scheduler.getRun(triggered.run.id)).toBeUndefined();
    expect(await scheduler.getRun(retry.runId)).toBeUndefined();
    expect(await scheduler.getRun(cancelTarget.run.id)).toBeUndefined();

    const reloaded = new DurableSmartScheduler({ statePath, executor });
    await expect(
      reloaded.triggerJobNow(job.id, "trigger-request"),
    ).resolves.toEqual(triggered);
    await expect(
      reloaded.retryRun(triggered.run.id, "retry-request"),
    ).resolves.toEqual(retry);
    await expect(
      reloaded.cancelRun(
        cancelTarget.run.id,
        "No longer needed.",
        "cancel-request",
      ),
    ).resolves.toEqual(cancelled);
    expect(await reloaded.listRuns(job.id)).toHaveLength(1);
  });

  it("requeues infrastructure-aborted work without consuming its execution attempts", async () => {
    const workspaceRoot = await createWorkspace();
    const executionStarted = defer<void>();
    let executionCount = 0;
    const executor: ScheduledTaskExecutor = {
      execute: async (request, options) => {
        executionCount += 1;
        if (executionCount > 1) {
          return createSuccessfulResult(request.task);
        }
        executionStarted.resolve();
        await new Promise<void>((resolveExecution) => {
          if (options.signal?.aborted) {
            resolveExecution();
            return;
          }
          options.signal?.addEventListener("abort", () => resolveExecution(), {
            once: true,
          });
        });

        return {
          task: request.task,
          mode: "machdoch",
          status: "cancelled",
          summary: "service stopped",
          reason: "service stopped",
          executedTools: [],
          outputSections: [],
        };
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      executor,
    });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.cancel" }],
      target: { workspaceRoot, prompt: "long work" },
    });
    await scheduler.triggerJobNow(job.id);
    const controller = new AbortController();
    const worker = scheduler.runQueuedRuns({ signal: controller.signal });
    await executionStarted.promise;
    controller.abort("fleet shutdown");
    const [interruptedRun] = await worker;

    expect(interruptedRun).toMatchObject({
      id: expect.any(String),
      status: "queued",
      attempt: 1,
      attemptHistory: [expect.objectContaining({ status: "failed" })],
    });
    await expect(scheduler.listRuns()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "running" })]),
    );

    const [retriedRun] = await scheduler.runQueuedRuns();
    expect(retriedRun).toMatchObject({
      id: interruptedRun?.id,
      status: "succeeded",
      attempt: 2,
    });
    expect(retriedRun?.targetSnapshot).toEqual(interruptedRun?.targetSnapshot);
  });

  it("aborts and fails a run when its durable heartbeat cannot be persisted", async () => {
    const workspaceRoot = await createWorkspace();
    let heartbeatClaim:
      | { runId: string; claimToken: string }
      | undefined;
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      runningHeartbeatMs: 5,
      heartbeatRun: async (runId, claimToken) => {
        heartbeatClaim = { runId, claimToken };
        throw new Error("disk unavailable");
      },
      executor: {
        execute: async (request, options) => {
          await new Promise<void>((resolveExecution) => {
            if (options.signal?.aborted) {
              resolveExecution();
              return;
            }
            options.signal?.addEventListener("abort", () => resolveExecution(), {
              once: true,
            });
          });
          return createSuccessfulResult(request.task);
        },
      },
    });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.heartbeat" }],
      target: { workspaceRoot, prompt: "heartbeat-sensitive work" },
    });
    await scheduler.triggerJobNow(job.id);

    const [run] = await scheduler.runQueuedRuns();

    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("heartbeat persistence failed");
    expect(heartbeatClaim).toEqual({
      runId: run?.id,
      claimToken: run?.attemptHistory[0]?.claimToken,
    });
  });

  it("fences a stale worker after recovery reclaims the same run", async () => {
    const workspaceRoot = await createWorkspace();
    const statePath = getWorkspaceSchedulerStatePath(workspaceRoot);
    const clock = createClock(10_000);
    const firstExecutionStarted = defer<void>();
    const firstExecution = defer<TaskExecutionResult>();
    const secondExecutionStarted = defer<void>();
    const secondExecutionAborted = defer<void>();
    let executionCount = 0;
    const scheduler = new DurableSmartScheduler({
      statePath,
      clock,
      executor: {
        execute: async (request, options) => {
          executionCount += 1;
          if (executionCount === 1) {
            firstExecutionStarted.resolve();
            return firstExecution.promise;
          }

          secondExecutionStarted.resolve();
          await new Promise<void>((resolveExecution) => {
            if (options.signal?.aborted) {
              secondExecutionAborted.resolve();
              resolveExecution();
              return;
            }

            options.signal?.addEventListener(
              "abort",
              () => {
                secondExecutionAborted.resolve();
                resolveExecution();
              },
              { once: true },
            );
          });
          return createSuccessfulResult(request.task);
        },
      },
    });
    const recoveryScheduler = new DurableSmartScheduler({ statePath, clock });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual", eventType: "manual.claim-fence" }],
      target: { workspaceRoot, prompt: "claim-fenced work" },
      retry: {
        maxAttempts: 2,
        minTimeoutMs: 1,
        maxTimeoutMs: 1,
        randomize: false,
      },
    });
    await scheduler.triggerJobNow(job.id);

    const staleWorker = scheduler.runQueuedRuns();
    const staleWorkerResult = expect(staleWorker).rejects.toThrow(
      "Scheduled run claim is no longer current",
    );
    await firstExecutionStarted.promise;
    const firstClaim = (await scheduler.listRuns()).find(
      (run) => run.status === "running",
    );

    expect(firstClaim?.claimToken).toEqual(expect.any(String));
    clock.advance(10);
    await expect(
      recoveryScheduler.recoverAbandonedRuns("Recovered stale claim.", 1),
    ).resolves.toEqual([
      expect.objectContaining({
        runId: firstClaim?.id,
        previousStatus: "running",
        status: "queued",
      }),
    ]);
    const recoveredRun = await scheduler.getRun(firstClaim?.id ?? "");
    expect(recoveredRun).toMatchObject({
      status: "queued",
      attempt: 1,
      attemptHistory: [
        expect.objectContaining({
          claimToken: firstClaim?.claimToken,
          status: "failed",
        }),
      ],
    });
    expect(recoveredRun?.claimToken).toBeUndefined();

    clock.set(recoveredRun?.nextAttemptAt ?? clock.now());
    const currentWorker = scheduler.runQueuedRuns();
    await secondExecutionStarted.promise;
    const secondClaim = await scheduler.getRun(firstClaim?.id ?? "");

    expect(secondClaim).toMatchObject({ status: "running", attempt: 2 });
    expect(secondClaim?.claimToken).toEqual(expect.any(String));
    expect(secondClaim?.claimToken).not.toBe(firstClaim?.claimToken);

    firstExecution.resolve(createSuccessfulResult("stale worker returned"));
    await staleWorkerResult;

    const afterStaleFinish = await scheduler.getRun(firstClaim?.id ?? "");
    expect(afterStaleFinish).toMatchObject({
      status: "running",
      attempt: 2,
      claimToken: secondClaim?.claimToken,
      attemptHistory: [expect.objectContaining({ status: "failed" })],
    });
    expect(afterStaleFinish?.attemptHistory).toHaveLength(1);
    await expect(scheduler.listEvents()).resolves.toEqual([]);

    await scheduler.cancelRun(firstClaim?.id ?? "", "Stop current claim.");
    await secondExecutionAborted.promise;
    const [cancelledRun] = await currentWorker;

    expect(cancelledRun).toMatchObject({
      status: "cancelled",
      attempt: 2,
    });
    expect(cancelledRun?.claimToken).toBeUndefined();
    expect(cancelledRun?.attemptHistory).toHaveLength(2);
    expect(cancelledRun?.attemptHistory.map((attempt) => attempt.claimToken)).toEqual([
      firstClaim?.claimToken,
      secondClaim?.claimToken,
    ]);
  });

  it("rekeys the default Ralph queue when its canonical workspace changes", async () => {
    const firstWorkspace = await createWorkspace();
    const secondWorkspace = await createWorkspace();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(firstWorkspace),
    });
    const job = await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot: firstWorkspace,
        ralphFlow: { id: "legacy-flow", executionProfile: "unattended" },
      },
    });
    const updated = await scheduler.updateJob(job.id, {
      target: {
        workspaceRoot: secondWorkspace,
        ralphFlow: { id: "legacy-flow", executionProfile: "unattended" },
      },
    });

    expect(updated.queue.concurrencyKey).toBe(
      getExpectedWorkspaceQueueKey(secondWorkspace),
    );
  });

  it("uses a last-known valid Ralph snapshot without starving unrelated due jobs", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const executedFlowIds: string[] = [];
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
      executor: {
        execute: async (request) => {
          executedFlowIds.push(request.ralphFlow?.id ?? "prompt");
          return createSuccessfulResult();
        },
      },
    });
    await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: { id: "legacy-flow", executionProfile: "unattended" },
      },
      queue: { concurrencyLimit: 2 },
    });
    await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: { id: "security-analysis", executionProfile: "unattended" },
      },
      queue: { concurrencyLimit: 2 },
    });
    await deleteRalphFlow(workspaceRoot, "legacy-flow");
    clock.set(1_000);

    const result = await scheduler.runDueJobs();

    expect(result.runs).toHaveLength(2);
    expect(executedFlowIds.sort()).toEqual(["legacy-flow", "security-analysis"]);
    const fallbackRun = result.runs.find(
      (run) => run.targetSnapshot?.ralphFlow?.id === "legacy-flow",
    );
    expect(fallbackRun?.targetSnapshot?.ralphFlow?.flowSnapshotRefreshError)
      .toContain("was not found");
  });

  it("applies the unattended RALPH capability, recovery, and retry profile", async () => {
    const workspaceRoot = await createWorkspace();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
    });

    const job = await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "autonomous-improvement",
          executionProfile: "unattended",
        },
      },
    });

    expect(job.target.ralphFlow).toMatchObject({
      id: "autonomous-improvement",
      executionProfile: "unattended",
      resumePolicy: "recoverable",
      permissions: {
        allowedRoots: [workspaceRoot],
        allowCommands: true,
        allowWrites: true,
        allowNetwork: true,
        allowMcpTools: true,
      },
    });
    expect(job.retry).toMatchObject({
      maxAttempts: 3,
      minTimeoutMs: 1_000,
      maxTimeoutMs: 60_000,
      factor: 2,
      randomize: true,
    });
    expect(job.queue).toEqual({
      concurrencyKey: getExpectedWorkspaceQueueKey(workspaceRoot),
      concurrencyLimit: 1,
    });

    const sibling = await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 2_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "autonomous-ui-improvement",
          executionProfile: "unattended",
        },
      },
    });
    const isolated = await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 3_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "isolated-improvement",
          executionProfile: "unattended",
        },
      },
      queue: {
        concurrencyKey: "isolated-worktree",
        concurrencyLimit: 2,
      },
    });

    expect(sibling.queue).toEqual(job.queue);
    expect(isolated.queue).toEqual({
      concurrencyKey: "isolated-worktree",
      concurrencyLimit: 2,
    });
  });

  it("preserves explicit scheduled RALPH permissions and retry defaults", async () => {
    const workspaceRoot = await createWorkspace();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
    });

    const job = await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "legacy-flow",
          permissions: {
            allowedRoots: [workspaceRoot],
            allowCommands: true,
            allowWrites: false,
            allowNetwork: false,
            allowMcpTools: false,
          },
        },
      },
    });

    expect(job.target.ralphFlow?.permissions).toEqual({
      allowedRoots: [workspaceRoot],
      allowCommands: true,
      allowWrites: false,
      allowNetwork: false,
      allowMcpTools: false,
    });
    expect(job.target.ralphFlow?.executionProfile).toBeUndefined();
    expect(job.target.ralphFlow?.resumePolicy).toBeUndefined();
    expect(job.retry.maxAttempts).toBe(1);

    const upgraded = await scheduler.updateJob(job.id, {
      target: {
        ralphFlow: {
          id: "legacy-flow",
          executionProfile: "unattended",
        },
      },
    });

    expect(upgraded.target.ralphFlow).toMatchObject({
      executionProfile: "unattended",
      resumePolicy: "recoverable",
      permissions: {
        allowCommands: true,
        allowWrites: true,
        allowNetwork: true,
        allowMcpTools: true,
      },
    });
    expect(upgraded.retry.maxAttempts).toBe(3);
    expect(upgraded.queue).toEqual({
      concurrencyKey: getExpectedWorkspaceQueueKey(workspaceRoot),
      concurrencyLimit: 1,
    });
  });

  it("upserts jobs by dedupe key", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    const first = await scheduler.upsertJob({
      dedupeKey: "daily-review",
      schedule: { type: "interval", intervalMs: 60_000 },
      target: {
        workspaceRoot,
        prompt: "first prompt",
      },
    });
    const second = await scheduler.upsertJob({
      dedupeKey: "daily-review",
      schedule: { type: "interval", intervalMs: 120_000 },
      target: {
        workspaceRoot,
        prompt: "second prompt",
      },
    });
    const jobs = await scheduler.listJobs();

    expect(second.id).toBe(first.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.target.prompt).toBe("second prompt");
    expect(jobs[0]?.schedule).toMatchObject({
      type: "interval",
      intervalMs: 120_000,
    });
    expect(jobs[0]?.triggers[0]).toMatchObject({
      kind: "time",
      schedule: {
        type: "interval",
        intervalMs: 120_000,
      },
    });
  });

  it("serializes concurrent mutations from separate scheduler instances", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const statePath = getWorkspaceSchedulerStatePath(workspaceRoot);
    const jobNames = Array.from({ length: 8 }, (_value, index) => `job-${index}`);

    await Promise.all(
      jobNames.map((name, index) => {
        const scheduler = new DurableSmartScheduler({
          statePath,
          clock,
        });

        return scheduler.upsertJob({
          name,
          schedule: { type: "delay", runAt: index + 1 },
          target: {
            workspaceRoot,
            prompt: name,
          },
        });
      }),
    );

    const scheduler = new DurableSmartScheduler({
      statePath,
      clock,
    });
    const jobs = await scheduler.listJobs();

    expect(jobs.map((job) => job.name).sort()).toEqual(jobNames);
  });

  it("commits one receipt and result for concurrent duplicate requests", async () => {
    const workspaceRoot = await createWorkspace();
    const statePath = getWorkspaceSchedulerStatePath(workspaceRoot);
    const input = {
      triggers: [{ kind: "manual" as const, eventType: "manual.concurrent" }],
      target: { workspaceRoot, prompt: "Create once across processes" },
    };
    const firstScheduler = new DurableSmartScheduler({ statePath });
    const secondScheduler = new DurableSmartScheduler({ statePath });

    const [first, duplicate] = await Promise.all([
      firstScheduler.upsertJob(input, "concurrent-create-request"),
      secondScheduler.upsertJob(input, "concurrent-create-request"),
    ]);

    expect(duplicate).toEqual(first);
    expect(await firstScheduler.listJobs()).toHaveLength(1);
    expect((await firstScheduler.getState()).mutationReceipts).toHaveLength(1);
  });

  it("syncs enabled prompt frontmatter into scheduled jobs", async () => {
    const workspaceRoot = await createWorkspace();
    const promptsRoot = join(workspaceRoot, ".machdoch", "prompts");
    const clock = createClock();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    await mkdir(promptsRoot, { recursive: true });
    await writeFile(
      join(promptsRoot, "daily.prompt.md"),
      [
        "---",
        "name: daily",
        "schedule-enabled: true",
        "schedule-name: Daily Review",
        "schedule-cron: 0 9 * * *",
        "schedule-timezone: Europe/Berlin",
        "schedule-arguments: --scope repo",
        "schedule-context: [src, README.md]",
        "schedule-mode: machdoch",
        "schedule-provider: openai",
        "schedule-model: gpt-5",
        "schedule-retry-attempts: 4",
        "schedule-queue-key: workspace-review",
        "schedule-concurrency-limit: 2",
        "schedule-ttl-ms: 300000",
        "---",
        "Review the workspace.",
      ].join("\n"),
      "utf8",
    );

    const result = await syncScheduledPromptJobs(scheduler, workspaceRoot);
    const job = result.syncedJobs[0];

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.warnings).toEqual([]);
    expect(result.syncedJobs).toHaveLength(1);
    expect(job?.name).toBe("Daily Review");
    expect(job?.target.prompt).toBe("/daily --scope repo");
    expect(job?.target.contextPaths).toEqual(["src", "README.md"]);
    expect(job?.target.mode).toBe("machdoch");
    expect(job?.target.provider).toBe("openai");
    expect(job?.target.model).toBe("gpt-5");
    expect(job?.dedupeKey).toBe("prompt:.machdoch/prompts/daily.prompt.md");
    expect(job?.schedule).toMatchObject({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "Europe/Berlin",
    });
    expect(job?.retry.maxAttempts).toBe(4);
    expect(job?.queue).toEqual({
      concurrencyKey: "workspace-review",
      concurrencyLimit: 2,
    });
    expect(job?.ttlMs).toBe(300_000);

    await writeFile(
      join(promptsRoot, "daily.prompt.md"),
      [
        "---",
        "name: daily",
        "schedule-enabled: false",
        "schedule-cron: 0 9 * * *",
        "schedule-timezone: Europe/Berlin",
        "---",
        "Review the workspace.",
      ].join("\n"),
      "utf8",
    );

    const disabledResult = await syncScheduledPromptJobs(
      scheduler,
      workspaceRoot,
    );

    expect(disabledResult.syncedJobs).toHaveLength(0);
    expect(disabledResult.pausedJobs[0]?.id).toBe(job?.id);
    expect((await scheduler.getJob(job?.id ?? ""))?.status).toBe("paused");
  });

  it("enqueues interval catch-up runs and tracks skipped history", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    const job = await scheduler.upsertJob({
      schedule: { type: "interval", intervalMs: 1_000 },
      target: {
        workspaceRoot,
        prompt: "summarize changes",
      },
      missedRunPolicy: "enqueue-latest",
    });

    clock.set(3_500);

    const enqueued = await scheduler.enqueueDueRuns();
    const runs = await scheduler.listRuns(job.id);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.run.scheduledFor).toBe(3_000);
    expect(enqueued[0]?.handle.runId).toBe(enqueued[0]?.run.id);
    expect(enqueued[0]?.deduplicated).toBe(false);
    expect(runs.filter((run) => run.status === "skipped")).toHaveLength(2);
    expect((await scheduler.getJob(job.id))?.nextRunAt).toBe(4_000);
  });

  it("supports one-shot delay jobs", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    const job = await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 500 },
      target: {
        workspaceRoot,
        prompt: "run later",
      },
    });

    clock.set(500);

    const enqueued = await scheduler.enqueueDueRuns();
    const updatedJob = await scheduler.getJob(job.id);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.run.scheduledFor).toBe(500);
    expect(updatedJob?.status).toBe("completed");
    expect(updatedJob?.nextRunAt).toBeUndefined();
  });

  it("creates event-only jobs and enqueues runs from matching trigger events", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock(1_000);
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    const job = await scheduler.upsertJob({
      name: "Summarize invoices",
      triggers: [
        {
          kind: "workspace-file",
          eventType: "workspace-file.created",
          filters: {
            "payload.path": "invoices/*.pdf",
          },
          dedupeKeyTemplate: "invoice:{payload.path}:{payload.mtime}",
        },
      ],
      target: {
        workspaceRoot,
        prompt: "Summarize the new invoice PDF.",
      },
      dedupeKey: "invoice-summary",
    });

    expect(job.schedule).toBeUndefined();
    expect(job.nextRunAt).toBeUndefined();
    expect(job.triggers[0]).toMatchObject({
      kind: "workspace-file",
      eventType: "workspace-file.created",
    });

    const ignored = await scheduler.recordEventAndEnqueueRuns({
      type: "workspace-file.created",
      kind: "workspace-file",
      workspaceRoot,
      payload: {
        path: "invoices/readme.txt",
        mtime: 1,
      },
      dedupeKey: "file:readme",
    });

    expect(ignored.enqueued).toHaveLength(0);
    expect(ignored.event.matches[0]).toMatchObject({
      jobId: job.id,
      matched: false,
      skippedReason: "Event did not match trigger filters.",
    });

    const fired = await scheduler.recordEventAndEnqueueRuns({
      type: "workspace-file.created",
      kind: "workspace-file",
      workspaceRoot,
      payload: {
        path: "invoices/june.pdf",
        mtime: 2,
      },
      dedupeKey: "file:june",
    });

    expect(fired.enqueued).toHaveLength(1);
    expect(fired.enqueued[0]?.run.source).toBe("event");
    expect(fired.enqueued[0]?.run.triggerId).toBe(job.triggers[0]?.id);
    expect(fired.enqueued[0]?.run.eventId).toBe(fired.event.id);
    expect(fired.enqueued[0]?.run.dedupeKey).toBe(
      "invoice-summary:invoice:invoices/june.pdf:2",
    );

    const duplicate = await scheduler.recordEventAndEnqueueRuns({
      type: "workspace-file.created",
      kind: "workspace-file",
      workspaceRoot,
      payload: {
        path: "invoices/june.pdf",
        mtime: 2,
      },
      dedupeKey: "file:june-redelivery",
    });

    expect(duplicate.enqueued).toHaveLength(1);
    expect(duplicate.enqueued[0]?.deduplicated).toBe(true);
    expect((await scheduler.listRuns(job.id))).toHaveLength(1);
    expect(await scheduler.listEvents()).toHaveLength(3);
  });

  it("repeats stateful threshold triggers only after recovery or repeat interval", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock(1_000);
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    const job = await scheduler.upsertJob({
      name: "Disk pressure cleanup",
      triggers: [
        {
          kind: "system",
          eventType: "system.disk-threshold",
          firingMode: "state",
          filters: {
            "payload.usedPercent": { op: ">=", value: 90 },
          },
          recoveryFilters: {
            "payload.usedPercent": { op: "<=", value: 80 },
          },
          repeatIntervalMs: 60_000,
          dedupeKeyTemplate: "disk:{payload.path}",
        },
      ],
      target: {
        workspaceRoot,
        prompt: "Clean temporary files when disk pressure is high.",
      },
      dedupeKey: "disk-cleanup",
    });

    const first = await scheduler.recordEventAndEnqueueRuns({
      type: "system.disk-threshold",
      kind: "system",
      workspaceRoot,
      payload: { path: "C:", usedPercent: 91 },
      dedupeKey: "disk:C:first",
    });

    expect(first.enqueued).toHaveLength(1);

    clock.advance(10_000);

    const repeatedTooSoon = await scheduler.recordEventAndEnqueueRuns({
      type: "system.disk-threshold",
      kind: "system",
      workspaceRoot,
      payload: { path: "C:", usedPercent: 95 },
      dedupeKey: "disk:C:second",
    });

    expect(repeatedTooSoon.enqueued).toHaveLength(0);
    expect(repeatedTooSoon.event.matches[0]?.skippedReason).toContain(
      "stateful trigger remains active",
    );

    clock.advance(60_000);

    const repeatedAfterInterval = await scheduler.recordEventAndEnqueueRuns({
      type: "system.disk-threshold",
      kind: "system",
      workspaceRoot,
      payload: { path: "C:", usedPercent: 96 },
      dedupeKey: "disk:C:third",
    });

    expect(repeatedAfterInterval.enqueued).toHaveLength(1);

    clock.advance(1_000);

    const recovered = await scheduler.recordEventAndEnqueueRuns({
      type: "system.disk-threshold",
      kind: "system",
      workspaceRoot,
      payload: { path: "C:", usedPercent: 70 },
      dedupeKey: "disk:C:recovered",
    });

    expect(recovered.enqueued).toHaveLength(0);
    expect(recovered.event.matches[0]?.skippedReason).toBe(
      "Stateful trigger recovered.",
    );

    clock.advance(1_000);

    const firedAfterRecovery = await scheduler.recordEventAndEnqueueRuns({
      type: "system.disk-threshold",
      kind: "system",
      workspaceRoot,
      payload: { path: "C:", usedPercent: 92 },
      dedupeKey: "disk:C:new-pressure",
    });

    expect(firedAfterRecovery.enqueued).toHaveLength(1);
    expect(await scheduler.listRuns(job.id)).toHaveLength(3);
    expect((await scheduler.getJob(job.id))?.triggers[0]).toMatchObject({
      lastState: "active",
    });
  });

  it("rate limits noisy event triggers inside a rolling window", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock(1_000);
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
    });

    await scheduler.upsertJob({
      name: "Process changed files",
      triggers: [
        {
          kind: "workspace-file",
          eventType: "workspace-file.changed",
          filters: {
            "payload.path": "src/*.ts",
          },
          maxEventsPerWindow: {
            maxEvents: 2,
            windowMs: 60_000,
          },
        },
      ],
      target: {
        workspaceRoot,
        prompt: "Review changed TypeScript files.",
      },
    });

    const first = await scheduler.recordEventAndEnqueueRuns({
      type: "workspace-file.changed",
      kind: "workspace-file",
      workspaceRoot,
      payload: { path: "src/a.ts" },
    });
    clock.advance(1_000);
    const second = await scheduler.recordEventAndEnqueueRuns({
      type: "workspace-file.changed",
      kind: "workspace-file",
      workspaceRoot,
      payload: { path: "src/b.ts" },
    });
    clock.advance(1_000);
    const third = await scheduler.recordEventAndEnqueueRuns({
      type: "workspace-file.changed",
      kind: "workspace-file",
      workspaceRoot,
      payload: { path: "src/c.ts" },
    });

    expect(first.enqueued).toHaveLength(1);
    expect(second.enqueued).toHaveLength(1);
    expect(third.enqueued).toHaveLength(0);
    expect(third.event.matches[0]?.skippedReason).toContain(
      "trigger rate limit",
    );
  });

  it("passes composed prompt, context, and max duration into the executor", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const requests: Parameters<ScheduledTaskExecutor["execute"]>[] = [];
    const executor: ScheduledTaskExecutor = {
      execute: async (...args) => {
        requests.push(args);
        return createSuccessfulResult();
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
      executor,
    });

    await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        workspaceRoot,
        prompt: "review the release",
        contextPaths: ["CHANGELOG.md"],
        contextPacks: [
          {
            name: "Release",
            instructions: "Use version {version}.",
            prompt: "Check regressions.",
            contextPaths: ["src"],
            variableValues: { version: "1.2.3" },
          },
        ],
        macros: [
          {
            name: "browser-smoke",
            promptInvocation: "/browser-smoke env=staging",
          },
        ],
      },
      maxDurationMs: 5_000,
    });

    clock.set(1_000);

    const { runs: [run] } = await scheduler.runDueJobs();

    expect(run?.status).toBe("succeeded");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[0].task).toContain("## Context Pack: Release");
    expect(requests[0]?.[0].task).toContain("Use version 1.2.3.");
    expect(requests[0]?.[0].task).toContain("/browser-smoke env=staging");
    expect(requests[0]?.[0].contextPaths).toEqual(["CHANGELOG.md", "src"]);
    expect(requests[0]?.[1].maxDurationMs).toBe(5_000);
  });

  it("emits Ralph completion events and runs chained jobs through the service", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const requests: string[] = [];
    const executor: ScheduledTaskExecutor = {
      execute: async (request) => {
        requests.push(request.job.name);

        if (request.job.name === "Security analysis") {
          return {
            task: request.task,
            mode: "machdoch",
            status: "cancelled",
            summary: "Ralph flow stopped.",
            reason: "Ralph flow stopped.",
            executedTools: [],
            metadata: {
              ralphFlow: {
                flowId: "security-analysis",
                flowName: "Security analysis",
                scope: "workspace",
                runId: "ralph-run-1",
                status: "stopped",
                runLogScope: "workspace",
              },
            },
            outputSections: [],
          };
        }

        return createSuccessfulResult("follow-up completed");
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
      executor,
    });
    const sourceJob = await scheduler.upsertJob({
      name: "Security analysis",
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        type: "ralph-flow",
        workspaceRoot,
        ralphFlow: {
          id: "security-analysis",
          scope: "workspace",
          params: {},
          permissions: {
            allowedRoots: [workspaceRoot],
            allowCommands: false,
            allowWrites: false,
            allowNetwork: false,
            allowMcpTools: false,
          },
        },
      },
    });
    const chainedJob = await scheduler.upsertJob({
      name: "Stopped flow follow-up",
      triggers: [
        {
          kind: "job-event",
          eventType: "job-event.ralph-flow.stopped",
          filters: { "payload.ralph.flowId": "security-analysis" },
        },
      ],
      target: {
        workspaceRoot,
        prompt: "Summarize the stopped run.",
      },
    });

    clock.set(1_000);

    const { runs: [sourceRun] } = await scheduler.runDueJobs();

    expect(sourceRun?.jobId).toBe(sourceJob.id);
    expect(sourceRun?.status).toBe("cancelled");

    const events = await scheduler.listEvents();
    const stoppedEvent = events.find(
      (event) => event.type === "job-event.ralph-flow.stopped",
    );

    expect(stoppedEvent?.parentRunId).toBe(sourceRun?.id);
    expect(stoppedEvent?.matches[0]?.queuedRunId).toBeDefined();

    const queuedFollowUp = (await scheduler.listRuns()).find(
      (run) => run.jobId === chainedJob.id,
    );

    expect(queuedFollowUp?.status).toBe("queued");
    expect(queuedFollowUp?.parentRunId).toBe(sourceRun?.id);

    const serviceResult = await scheduler.runService({
      maxIterations: 2,
      pollIntervalMs: 1,
    });

    expect(serviceResult.finishedRuns).toBe(1);
    expect(requests).toEqual(["Security analysis", "Stopped flow follow-up"]);
  });

  it("retries failed runs with backoff", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    let calls = 0;
    const executor: ScheduledTaskExecutor = {
      execute: async () => {
        calls += 1;

        if (calls === 1) {
          throw new Error("temporary failure");
        }

        return createSuccessfulResult("retry succeeded");
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
      executor,
      rng: () => 0,
    });

    await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        workspaceRoot,
        prompt: "retry me",
      },
      retry: {
        maxAttempts: 2,
        minTimeoutMs: 500,
        maxTimeoutMs: 5_000,
        randomize: false,
      },
    });

    clock.set(1_000);

    const { runs: [firstAttempt] } = await scheduler.runDueJobs();

    expect(firstAttempt?.status).toBe("queued");
    expect(firstAttempt?.attempt).toBe(1);
    expect(firstAttempt?.nextAttemptAt).toBe(1_500);

    clock.set(1_499);
    await expect(scheduler.runQueuedRuns()).resolves.toEqual([]);

    clock.set(1_500);

    const [secondAttempt] = await scheduler.runQueuedRuns();

    expect(secondAttempt?.status).toBe("succeeded");
    expect(secondAttempt?.attempt).toBe(2);
    expect(secondAttempt?.attemptHistory).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("keeps a cancelled running run cancelled even if the executor returns", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const execution = defer<TaskExecutionResult>();
    const executorStarted = defer<void>();
    const executor: ScheduledTaskExecutor = {
      execute: async () => {
        executorStarted.resolve();
        return execution.promise;
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
      executor,
    });

    await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        workspaceRoot,
        prompt: "cancel me",
      },
      retry: {
        maxAttempts: 3,
      },
    });

    clock.set(1_000);

    const runPromise = scheduler.runDueJobs();
    await executorStarted.promise;

    const runningRun = (await scheduler.listRuns()).find(
      (run) => run.status === "running",
    );

    expect(runningRun).toBeDefined();

    await scheduler.cancelRun(runningRun?.id ?? "", "No longer needed.");
    execution.resolve(createSuccessfulResult("executor returned after cancel"));

    const { runs: [finishedRun] } = await runPromise;

    expect(finishedRun?.status).toBe("cancelled");
    expect(finishedRun?.attemptHistory).toHaveLength(1);
    expect(finishedRun?.attemptHistory[0]?.status).toBe("cancelled");
    expect(finishedRun?.nextAttemptAt).toBeUndefined();
  });

  it("retries max-duration expiry and preserves the same queued run", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    const executor: ScheduledTaskExecutor = {
      execute: async () => {
        await sleep(10);
        return createSuccessfulResult("executor returned after timeout");
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
      executor,
    });

    await scheduler.upsertJob({
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        workspaceRoot,
        prompt: "timeout me",
      },
      maxDurationMs: 1,
      retry: {
        maxAttempts: 2,
      },
    });

    clock.set(1_000);

    const { runs: [finishedRun] } = await scheduler.runDueJobs();

    expect(finishedRun?.status).toBe("queued");
    expect(finishedRun?.attemptHistory).toHaveLength(1);
    expect(finishedRun?.attemptHistory[0]?.status).toBe("timed_out");
    expect(finishedRun?.nextAttemptAt).toEqual(expect.any(Number));
    const originalRunId = finishedRun?.id;
    clock.set(finishedRun?.nextAttemptAt ?? 0);

    const [retriedRun] = await scheduler.runQueuedRuns();

    expect(retriedRun?.id).toBe(originalRunId);
    expect(retriedRun?.status).toBe("timed_out");
    expect(retriedRun?.attemptHistory.map((attempt) => attempt.status)).toEqual([
      "timed_out",
      "timed_out",
    ]);
  });

  it("enforces queue concurrency limits across jobs", async () => {
    const workspaceRoot = await createWorkspace();
    const clock = createClock();
    let calls = 0;
    const executor: ScheduledTaskExecutor = {
      execute: async () => {
        calls += 1;
        return createSuccessfulResult();
      },
    };
    const scheduler = new DurableSmartScheduler({
      statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
      clock,
      executor,
    });
    const queue = {
      concurrencyKey: "workspace-maintenance",
      concurrencyLimit: 1,
    };

    await scheduler.upsertJob({
      name: "first",
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        workspaceRoot,
        prompt: "first",
      },
      queue,
    });
    await scheduler.upsertJob({
      name: "second",
      schedule: { type: "delay", delayMs: 1_000 },
      target: {
        workspaceRoot,
        prompt: "second",
      },
      queue,
    });

    clock.set(1_000);
    await scheduler.enqueueDueRuns();

    const firstBatch = await scheduler.runQueuedRuns();
    const queuedAfterFirstBatch = (await scheduler.listRuns()).filter(
      (run) => run.status === "queued",
    );

    expect(firstBatch).toHaveLength(1);
    expect(calls).toBe(1);
    expect(queuedAfterFirstBatch).toHaveLength(1);

    const secondBatch = await scheduler.runQueuedRuns();

    expect(secondBatch).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
