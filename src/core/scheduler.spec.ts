import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableSmartScheduler,
  getNextCronRunAfter,
  getWorkspaceSchedulerStatePath,
  syncScheduledPromptJobs,
  type ScheduledTaskExecutor,
} from "./scheduler.ts";
import type { TaskExecutionResult } from "./types.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-scheduler-"));
  workspacesToClean.push(workspaceRoot);
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

  it("records max-duration expiry as timed out", async () => {
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

    expect(finishedRun?.status).toBe("timed_out");
    expect(finishedRun?.attemptHistory).toHaveLength(1);
    expect(finishedRun?.attemptHistory[0]?.status).toBe("timed_out");
    expect(finishedRun?.nextAttemptAt).toBeUndefined();
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
