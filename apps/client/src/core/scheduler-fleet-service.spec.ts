import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DurableSmartScheduler,
  getWorkspaceSchedulerStatePath,
  type ScheduledTaskExecutor,
} from "./scheduler.js";
import { runSchedulerFleetService } from "./scheduler-fleet-service.js";
import type { TaskExecutionResult } from "./types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-scheduler-fleet-service-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function queueJob(name: string): Promise<DurableSmartScheduler> {
  const workspaceRoot = join(root, name);
  await mkdir(workspaceRoot, { recursive: true });
  const scheduler = new DurableSmartScheduler({
    workspaceRoot,
    statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
  });
  const job = await scheduler.upsertJob({
    name,
    triggers: [{ kind: "manual", eventType: "manual.test" }],
    target: { type: "prompt", workspaceRoot, prompt: "Review files." },
  });
  await scheduler.triggerJobNow(job.id);
  return scheduler;
}

function completed(
  status: TaskExecutionResult["status"] = "executed",
): TaskExecutionResult {
  return {
    task: "Review files.",
    mode: "machdoch",
    status,
    summary: "Test executor finished.",
    executedTools: [],
    outputSections: [],
  };
}

it("limits concurrent workspace workers and discovers new roots while running", async () => {
  const schedulers = await Promise.all(
    ["alpha", "beta", "gamma"].map(queueJob),
  );
  let roots = [join(root, "alpha"), join(root, "beta")];
  let active = 0;
  let peak = 0;
  let released = false;
  const started = new Set<string>();
  const release = new Set<() => void>();
  const errors = vi.fn();
  const controller = new AbortController();
  const executor: ScheduledTaskExecutor = {
    execute: async (request, { signal }) => {
      active += 1;
      peak = Math.max(peak, active);
      started.add(request.workspaceRoot);
      try {
        if (!released)
          await new Promise<void>((resolve) => {
            const finish = (): void => {
              signal?.removeEventListener("abort", finish);
              release.delete(finish);
              resolve();
            };
            release.add(finish);
            signal?.addEventListener("abort", finish, { once: true });
          });
        return completed();
      } finally {
        active -= 1;
      }
    },
  };
  const service = runSchedulerFleetService({
    workspaceRoots: async () => roots,
    executor,
    signal: controller.signal,
    pollIntervalMs: 10,
    onError: errors,
  });
  try {
    await expect.poll(() => started.size, { timeout: 30000 }).toBe(2);
    roots = [...roots, join(root, "gamma")];
    await expect
      .poll(async () => (await schedulers[2]!.listRuns())[0]?.status, {
        timeout: 30000,
      })
      .toBe("queued");
    expect(active).toBe(2);
    released = true;
    for (const finish of release) finish();
    await expect.poll(() => started.size, { timeout: 30000 }).toBe(3);
    await expect
      .poll(
        async () =>
          Promise.all(
            schedulers.map(
              async (scheduler) => (await scheduler.listRuns())[0]?.status,
            ),
          ),
        { timeout: 30000 },
      )
      .toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(peak).toBe(2);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    for (const finish of release) finish();
    await service;
  }
});

it("reports a corrupt workspace without stopping work in healthy roots", async () => {
  const scheduler = await queueJob("healthy");
  const corruptRoot = join(root, "corrupt");
  const corruptState = getWorkspaceSchedulerStatePath(corruptRoot);
  await mkdir(dirname(corruptState), { recursive: true });
  await writeFile(corruptState, "{invalid-json");
  const errors = vi.fn();
  const controller = new AbortController();
  const service = runSchedulerFleetService({
    workspaceRoots: async () => [corruptRoot, join(root, "healthy")],
    executor: { execute: async () => completed() },
    signal: controller.signal,
    pollIntervalMs: 10,
    onError: errors,
  });
  try {
    await expect
      .poll(async () => (await scheduler.listRuns())[0]?.status, {
        timeout: 30000,
      })
      .toBe("succeeded");
    expect(errors).toHaveBeenCalledWith(expect.anything(), corruptRoot, "poll");
  } finally {
    controller.abort();
    await service;
  }
});

it("stops active workers and resumes their durable runs after restart", async () => {
  const scheduler = await queueJob("cancel");
  let aborted = false;
  let started = false;
  const controller = new AbortController();
  const service = runSchedulerFleetService({
    workspaceRoots: async () => [join(root, "cancel")],
    executor: {
      execute: async (_request, { signal }) => {
        started = true;
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            aborted = true;
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          if (signal?.aborted) finish();
          else signal?.addEventListener("abort", finish, { once: true });
        });
        return completed("cancelled");
      },
    },
    signal: controller.signal,
    pollIntervalMs: 10,
    onError: (error) => {
      throw error;
    },
  });
  try {
    await expect.poll(() => started, { timeout: 30000 }).toBe(true);
    await expect
      .poll(async () => (await scheduler.listRuns())[0]?.status, {
        timeout: 30000,
      })
      .toBe("running");
  } finally {
    controller.abort();
    await service;
  }
  expect(aborted).toBe(true);
  const interrupted = (await scheduler.listRuns())[0]!;
  expect(interrupted.status).toBe("queued");
  expect(interrupted.attemptHistory).toEqual([
    expect.objectContaining({ attempt: 1, status: "failed" }),
  ]);
  const restarted = await runSchedulerFleetService({
    workspaceRoots: async () => [join(root, "cancel")],
    executor: { execute: async () => completed() },
    signal: new AbortController().signal,
    maxIterations: 1,
    onError: (error) => {
      throw error;
    },
  });
  expect(restarted.finishedRuns).toBe(1);
  expect((await scheduler.listRuns())[0]).toMatchObject({
    id: interrupted.id,
    status: "succeeded",
    attempt: 2,
  });
});
