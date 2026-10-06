import {
  DurableSmartScheduler,
  getWorkspaceSchedulerStatePath,
  syncScheduledPromptJobs,
  type ScheduledTaskExecutor,
  type SchedulerServiceResult,
} from "./scheduler.js";

export const MAX_CONCURRENT_SCHEDULER_FLEET_WORKERS = 2;

export interface SchedulerFleetIteration {
  workspaces: number;
  recovered: number;
  queued: number;
  active: number;
}

export interface SchedulerFleetServiceOptions {
  workspaceRoots: () => Promise<readonly string[]>;
  executor: ScheduledTaskExecutor;
  signal: AbortSignal;
  pollIntervalMs?: number;
  idleShutdownMs?: number;
  maxIterations?: number;
  maxRunsPerTick?: number;
  beforePoll?: () => Promise<void>;
  onIteration?: (iteration: SchedulerFleetIteration) => void | Promise<void>;
  onError: (
    error: unknown,
    workspace: string,
    phase: "poll" | "worker",
  ) => void;
  settleWorkers?: (workers: Iterable<Promise<void>>) => Promise<void>;
}

async function waitForPoll(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runSchedulerFleetService(
  options: SchedulerFleetServiceOptions,
): Promise<SchedulerServiceResult> {
  const controller = new AbortController();
  const stop = (): void => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const workers = new Map<string, Promise<void>>();
  const result: SchedulerServiceResult = {
    iterations: 0,
    recoveredRuns: 0,
    queuedRuns: 0,
    finishedRuns: 0,
  };
  const idleShutdownMs = Math.max(0, options.idleShutdownMs ?? 0);
  const settle = (): Promise<unknown> =>
    options.settleWorkers
      ? options.settleWorkers(workers.values())
      : Promise.allSettled(workers.values());
  let idleSince: number | undefined;
  try {
    while (!controller.signal.aborted) {
      await options.beforePoll?.();
      const roots = [...new Set(await options.workspaceRoots())];
      const offset = roots.length ? result.iterations % roots.length : 0;
      const orderedRoots = [...roots.slice(offset), ...roots.slice(0, offset)];
      const polls = await Promise.all(
        orderedRoots.map(async (workspaceRoot) => {
          try {
            const scheduler = new DurableSmartScheduler({
              workspaceRoot,
              statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
              executor: options.executor,
            });
            await syncScheduledPromptJobs(scheduler, workspaceRoot);
            const jobs = await scheduler.listJobs();
            if (!jobs.length || controller.signal.aborted)
              return { recovered: 0, queued: 0, hasJobs: jobs.length > 0 };
            const recovered = await scheduler.recoverAbandonedRuns(
              "Scheduler fleet service recovered an abandoned running run.",
            );
            const queued = await scheduler.enqueueDueRuns();
            if (
              !controller.signal.aborted &&
              !workers.has(workspaceRoot) &&
              workers.size < MAX_CONCURRENT_SCHEDULER_FLEET_WORKERS
            ) {
              const worker = scheduler
                .runQueuedRuns({
                  signal: controller.signal,
                  ...(options.maxRunsPerTick !== undefined
                    ? { maxRuns: options.maxRunsPerTick }
                    : {}),
                })
                .then((runs) => {
                  result.finishedRuns += runs.length;
                })
                .catch((error: unknown) =>
                  options.onError(error, workspaceRoot, "worker"),
                )
                .finally(() => workers.delete(workspaceRoot));
              workers.set(workspaceRoot, worker);
            }
            return {
              recovered: recovered.length,
              queued: queued.length,
              hasJobs: true,
            };
          } catch (error) {
            options.onError(error, workspaceRoot, "poll");
            return { recovered: 0, queued: 0, hasJobs: true };
          }
        }),
      );
      const recovered = polls.reduce(
        (total, poll) => total + poll.recovered,
        0,
      );
      const queued = polls.reduce((total, poll) => total + poll.queued, 0);
      result.iterations += 1;
      result.recoveredRuns += recovered;
      result.queuedRuns += queued;
      await options.onIteration?.({
        workspaces: roots.length,
        recovered,
        queued,
        active: workers.size,
      });
      if (polls.some((poll) => poll.hasJobs) || workers.size)
        idleSince = undefined;
      else idleSince ??= Date.now();
      if (
        options.maxIterations !== undefined &&
        result.iterations >= options.maxIterations
      ) {
        await settle();
        break;
      }
      if (
        idleShutdownMs > 0 &&
        idleSince !== undefined &&
        Date.now() - idleSince >= idleShutdownMs
      )
        break;
      await waitForPoll(
        Math.max(1, options.pollIntervalMs ?? 30_000),
        controller.signal,
      );
    }
    return result;
  } finally {
    controller.abort("Scheduler fleet service stopped.");
    options.signal.removeEventListener("abort", stop);
    await settle();
  }
}
