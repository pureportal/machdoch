import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableSmartScheduler,
  getUserSchedulerWorkspaceRegistryPath,
  getWorkspaceSchedulerStatePath,
  registerSchedulerWorkspace,
  type ScheduledTaskExecutor,
} from "../../core/scheduler.js";
import {
  acquireSchedulerFleetServiceLock,
  awaitSchedulerFleetWorkerSettlement,
  isSchedulerFleetServiceHeartbeatFresh,
  pollSchedulerFleetWorkspaces,
  runSchedulerFleetIteration,
} from "./cli-scheduler-commands.js";

const deferred = <T>() => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
  };
};

describe.sequential("scheduler fleet", () => {
  it("a stale service cannot overwrite a replacement owner's token", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "machdoch-scheduler-owner-"));
    const previousConfigRoot = process.env.MACHDOCH_USER_CONFIG_DIR;
    const configRoot = join(testRoot, "user");
    process.env.MACHDOCH_USER_CONFIG_DIR = configRoot;

    try {
      await mkdir(configRoot, { recursive: true });
      const lock = await acquireSchedulerFleetServiceLock();
      const ownerPath = `${getUserSchedulerWorkspaceRegistryPath()}.service-lock/owner`;
      await writeFile(ownerPath, "replacement-owner", "utf8");

      await expect(lock.touch()).rejects.toThrow("lost its ownership lock");
      await lock.release();
      await expect(readFile(ownerPath, "utf8")).resolves.toBe("replacement-owner");
    } finally {
      if (previousConfigRoot === undefined) {
        delete process.env.MACHDOCH_USER_CONFIG_DIR;
      } else {
        process.env.MACHDOCH_USER_CONFIG_DIR = previousConfigRoot;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("uses the owner heartbeat instead of stale directory metadata", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "machdoch-scheduler-lock-"));
    const lockPath = join(testRoot, "service-lock");
    const ownerPath = join(lockPath, "owner");
    const now = Date.now();

    try {
      await mkdir(lockPath);
      await writeFile(ownerPath, "123:token", "utf8");
      await utimes(lockPath, new Date(now - 600_000), new Date(now - 600_000));
      await utimes(ownerPath, new Date(now - 1_000), new Date(now - 1_000));

      await expect(isSchedulerFleetServiceHeartbeatFresh(ownerPath, now))
        .resolves.toBe(true);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("keeps verifying lock ownership while shutdown workers settle", async () => {
    const worker = deferred<void>();
    const secondHeartbeat = deferred<void>();
    let heartbeatCount = 0;
    const settlement = awaitSchedulerFleetWorkerSettlement(
      [worker.promise],
      async () => {
        heartbeatCount += 1;
        if (heartbeatCount >= 2) {
          secondHeartbeat.resolve();
        }
      },
      5,
    );

    await secondHeartbeat.promise;
    expect(heartbeatCount).toBeGreaterThanOrEqual(2);
    worker.resolve();
    await settlement;
  });

  it("starts a second workspace while the first workspace executor is slow", async () => {
    const testRoot = await realpath(
      await mkdtemp(join(tmpdir(), "machdoch-scheduler-fleet-")),
    );
    const firstWorkspace = join(testRoot, "first");
    const secondWorkspace = join(testRoot, "second");
    const previousConfigRoot = process.env.MACHDOCH_USER_CONFIG_DIR;
    process.env.MACHDOCH_USER_CONFIG_DIR = join(testRoot, "user");
    const releaseSlowRun = deferred<void>();
    const fastRunStarted = deferred<void>();

    try {
      await Promise.all([
        mkdir(firstWorkspace, { recursive: true }),
        mkdir(secondWorkspace, { recursive: true }),
      ]);
      await Promise.all([
        registerSchedulerWorkspace(firstWorkspace),
        registerSchedulerWorkspace(secondWorkspace),
      ]);
      const createExecutor = (slow: boolean): ScheduledTaskExecutor => ({
        execute: async (request) => {
          if (slow) {
            await releaseSlowRun.promise;
          } else {
            fastRunStarted.resolve();
          }

          return {
            task: request.task,
            mode: "machdoch",
            status: "executed",
            summary: "done",
            executedTools: [],
            outputSections: [],
          };
        },
      });
      const schedulers = new Map([
        [
          firstWorkspace,
          new DurableSmartScheduler({
            statePath: getWorkspaceSchedulerStatePath(firstWorkspace),
            executor: createExecutor(true),
          }),
        ],
        [
          secondWorkspace,
          new DurableSmartScheduler({
            statePath: getWorkspaceSchedulerStatePath(secondWorkspace),
            executor: createExecutor(false),
          }),
        ],
      ]);

      for (const [workspaceRoot, scheduler] of schedulers) {
        const job = await scheduler.upsertJob({
          triggers: [{ kind: "manual", eventType: "manual.fleet" }],
          target: { workspaceRoot, prompt: "run" },
        });
        await scheduler.triggerJobNow(job.id);
      }

      const fleetRun = runSchedulerFleetIteration({
        schedulerFactory: (workspaceRoot) => {
          const scheduler = schedulers.get(workspaceRoot);
          if (!scheduler) {
            throw new Error(`Unexpected scheduler workspace: ${workspaceRoot}`);
          }
          return scheduler;
        },
      });
      await Promise.race([
        fastRunStarted.promise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Second workspace was starved.")), 2_000);
        }),
      ]);
      releaseSlowRun.resolve();
      const result = await fleetRun;

      expect(result.workspaces).toHaveLength(2);
      expect(result.runs).toBe(2);
    } finally {
      if (previousConfigRoot === undefined) {
        delete process.env.MACHDOCH_USER_CONFIG_DIR;
      } else {
        process.env.MACHDOCH_USER_CONFIG_DIR = previousConfigRoot;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("desktop fleet polling never claims a long-running queued job", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "machdoch-scheduler-poll-"));
    const workspaceRoot = join(testRoot, "workspace");
    const previousConfigRoot = process.env.MACHDOCH_USER_CONFIG_DIR;
    process.env.MACHDOCH_USER_CONFIG_DIR = join(testRoot, "user");
    let executions = 0;

    try {
      await mkdir(workspaceRoot, { recursive: true });
      await registerSchedulerWorkspace(workspaceRoot);
      const scheduler = new DurableSmartScheduler({
        statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
        executor: {
          execute: async (request) => {
            executions += 1;
            await new Promise(() => undefined);
            return {
              task: request.task,
              mode: "machdoch",
              status: "executed",
              summary: "unreachable",
              executedTools: [],
              outputSections: [],
            };
          },
        },
      });
      const job = await scheduler.upsertJob({
        triggers: [{ kind: "manual", eventType: "manual.long" }],
        target: { workspaceRoot, prompt: "long autonomous run" },
      });
      const queued = await scheduler.triggerJobNow(job.id);

      const result = await pollSchedulerFleetWorkspaces({
        schedulerFactory: () => scheduler,
      });

      expect(result.runs).toBe(0);
      expect(executions).toBe(0);
      await expect(scheduler.getRun(queued.handle)).resolves.toMatchObject({
        status: "queued",
      });
    } finally {
      if (previousConfigRoot === undefined) {
        delete process.env.MACHDOCH_USER_CONFIG_DIR;
      } else {
        process.env.MACHDOCH_USER_CONFIG_DIR = previousConfigRoot;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("prunes deleted workspace roots without recreating them", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "machdoch-scheduler-prune-"));
    const deletedWorkspace = join(testRoot, "deleted-workspace");
    const previousConfigRoot = process.env.MACHDOCH_USER_CONFIG_DIR;
    process.env.MACHDOCH_USER_CONFIG_DIR = join(testRoot, "user");

    try {
      await registerSchedulerWorkspace(deletedWorkspace);

      const result = await pollSchedulerFleetWorkspaces();

      expect(result.workspaces).toEqual([]);
      await expect(stat(deletedWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
      const registry = JSON.parse(
        await readFile(getUserSchedulerWorkspaceRegistryPath(), "utf8"),
      ) as { workspaceRoots: string[] };
      expect(registry.workspaceRoots).not.toContain(deletedWorkspace);
    } finally {
      if (previousConfigRoot === undefined) {
        delete process.env.MACHDOCH_USER_CONFIG_DIR;
      } else {
        process.env.MACHDOCH_USER_CONFIG_DIR = previousConfigRoot;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
