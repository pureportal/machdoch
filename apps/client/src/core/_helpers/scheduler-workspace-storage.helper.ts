import {
  withSchedulerStateLock,
  writeSchedulerFileDurably,
} from "./scheduler-file-storage.helper.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { migrateWorkspacePathReferences } from "./migrate-workspace-storage-references.helper.js";
import type {
  ScheduledJob,
  ScheduledJobTrigger,
  ScheduledTimeTrigger,
  SmartSchedulerState,
} from "../scheduler.js";
import {
  DEFINITION_SCHEMA,
  STORAGE_SCHEMA_VERSION,
  TRIGGER_RUNTIME_FIELDS,
  FLOW_RUNTIME_FIELDS,
  omitFields,
  selectFields,
  fingerprint,
  splitState,
  isRecord,
  parseDefinitions,
  parseRuntime,
  parseCombinedStateForMigration,
  getNextSchedulerRunAfter,
  createCanonicalWorkspaceQueueKey,
  type SchedulerDefinitions,
  type SchedulerRuntime,
} from "./scheduler-workspace-model.helper.js";
export const getSchedulerDefinitionPath = (workspaceRoot: string): string =>
  join(workspaceRoot, ".machdoch", "scheduler.json");

export const getSchedulerStatePath = (workspaceRoot: string): string =>
  join(workspaceRoot, ".machdoch", "local", "state", "scheduler.json");

export const getSchedulerStorageWorkspaceRoot = (
  statePath: string,
): string | undefined => {
  const absolutePath = resolve(statePath);
  const workspaceRoot = dirname(dirname(dirname(dirname(absolutePath))));
  const expectedPath = getSchedulerStatePath(workspaceRoot);
  const normalize = (path: string): string =>
    process.platform === "win32" ? path.toLowerCase() : path;

  return normalize(absolutePath) === normalize(expectedPath)
    ? workspaceRoot
    : undefined;
};

const readOptionalJson = async (path: string): Promise<unknown> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Scheduler storage must be a regular file: ${path}`);
    }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const writeJsonDurably = async (
  path: string,
  value: unknown,
  beforeCommit?: () => Promise<void>,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeSchedulerFileDurably(
      tempPath,
      path,
      `${JSON.stringify(value, null, 2)}\n`,
      beforeCommit,
    );
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
};

const finishDefinitionUpdateUnlocked = async (
  workspaceRoot: string,
  runtime: SchedulerRuntime,
): Promise<SchedulerRuntime> => {
  const update = runtime.definitionUpdate;
  if (!update) {
    return runtime;
  }
  const definitionPath = getSchedulerDefinitionPath(workspaceRoot);
  const current = await readOptionalJson(definitionPath);
  const currentFingerprint = fingerprint(current);
  if (currentFingerprint !== fingerprint(update.definitions)) {
    if (currentFingerprint !== update.previousFingerprint) {
      throw new Error(
        `Workspace scheduler definitions changed during a pending update: ${definitionPath}`,
      );
    }
    await writeJsonDurably(definitionPath, update.definitions, async () => {
      if (
        fingerprint(await readOptionalJson(definitionPath)) !==
        currentFingerprint
      ) {
        throw new Error(
          `Workspace scheduler definitions changed during a pending update: ${definitionPath}`,
        );
      }
    });
  }
  const committed = omitFields(runtime, ["definitionUpdate"]);
  await writeJsonDurably(getSchedulerStatePath(workspaceRoot), committed);
  return committed;
};

const writeDocumentsUnlocked = async (
  workspaceRoot: string,
  definitions: SchedulerDefinitions,
  runtime: SchedulerRuntime,
  previousDefinitions: unknown,
): Promise<SchedulerRuntime> => {
  if (fingerprint(definitions) === fingerprint(previousDefinitions)) {
    await writeJsonDurably(getSchedulerStatePath(workspaceRoot), runtime);
    return runtime;
  }
  const staged: SchedulerRuntime = {
    ...runtime,
    definitionUpdate: {
      previousFingerprint: fingerprint(previousDefinitions),
      definitions,
    },
  };
  await writeJsonDurably(getSchedulerStatePath(workspaceRoot), staged);
  return finishDefinitionUpdateUnlocked(workspaceRoot, staged);
};

const mergeRecords = <T>(
  previous: T[],
  current: T[],
  key: (value: T) => string,
): T[] => {
  const records = new Map(previous.map((value) => [key(value), value]));
  for (const value of current) {
    const id = key(value);
    const existing = records.get(id);
    if (
      existing !== undefined &&
      fingerprint(existing) !== fingerprint(value)
    ) {
      throw new Error(
        `Workspace scheduler storage conflict for ${id}. Move one of the conflicting files and reload the workspace.`,
      );
    }
    records.set(id, value);
  }
  return [...records.values()];
};

const migrateWorkspaceSchedulerStorageUnlocked = async (
  workspaceRoot: string,
  timestamp: number,
): Promise<{
  definitions: SchedulerDefinitions;
  runtime: SchedulerRuntime;
  storedDefinitions: unknown;
}> => {
  const definitionPath = getSchedulerDefinitionPath(workspaceRoot);
  const statePath = getSchedulerStatePath(workspaceRoot);
  const documents = await Promise.all([
    readOptionalJson(definitionPath),
    readOptionalJson(statePath),
  ]);
  let [storedDefinitions] = documents;
  const storedRuntime = documents[1];
  let runtime = parseRuntime(storedRuntime, statePath, timestamp);
  if (runtime.definitionUpdate) {
    storedDefinitions = runtime.definitionUpdate.definitions;
    runtime = await finishDefinitionUpdateUnlocked(workspaceRoot, runtime);
  }
  if (storedDefinitions === undefined) {
    return {
      definitions: {
        schema: DEFINITION_SCHEMA,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        jobs: [],
      },
      runtime,
      storedDefinitions,
    };
  }
  if (
    isRecord(storedDefinitions) &&
    storedDefinitions.schema === DEFINITION_SCHEMA
  ) {
    const definitions = parseDefinitions(storedDefinitions, definitionPath);
    return {
      definitions: {
        ...definitions,
        jobs: definitions.jobs.map((job) => ({
          ...job,
          target: {
            ...job.target,
            workspaceRoot:
              resolve(workspaceRoot, job.target.workspaceRoot) ===
              resolve(workspaceRoot)
                ? "."
                : job.target.workspaceRoot,
          },
        })),
      },
      runtime,
      storedDefinitions,
    };
  }
  const split = splitState(
    parseCombinedStateForMigration(
      migrateWorkspacePathReferences(storedDefinitions, workspaceRoot),
      definitionPath,
    ),
    workspaceRoot,
  );
  const merged: SchedulerRuntime = {
    ...split.runtime,
    createdAt:
      storedRuntime === undefined
        ? split.runtime.createdAt
        : Math.min(split.runtime.createdAt, runtime.createdAt),
    updatedAt:
      storedRuntime === undefined
        ? split.runtime.updatedAt
        : Math.max(split.runtime.updatedAt, runtime.updatedAt),
    jobs: mergeRecords(split.runtime.jobs, runtime.jobs, (job) => job.id),
    runs: mergeRecords(split.runtime.runs, runtime.runs, (run) => run.id),
    events: mergeRecords(
      split.runtime.events,
      runtime.events,
      (event) => event.id,
    ),
    mutationReceipts: mergeRecords(
      split.runtime.mutationReceipts,
      runtime.mutationReceipts,
      (receipt) => receipt.key,
    ),
  };
  runtime = await writeDocumentsUnlocked(
    workspaceRoot,
    split.definitions,
    merged,
    storedDefinitions,
  );
  return {
    definitions: split.definitions,
    runtime,
    storedDefinitions: split.definitions,
  };
};

export const migrateWorkspaceSchedulerStorage = async (
  workspaceRoot: string,
): Promise<void> => {
  await withSchedulerStateLock(
    getSchedulerStatePath(workspaceRoot),
    async () => {
      await migrateWorkspaceSchedulerStorageUnlocked(workspaceRoot, Date.now());
    },
  );
};

export const readWorkspaceSchedulerStateUnlocked = async (
  workspaceRoot: string,
  timestamp = Date.now(),
): Promise<{ state: SmartSchedulerState; definitionFingerprint: string }> => {
  const { definitions, runtime, storedDefinitions } =
    await migrateWorkspaceSchedulerStorageUnlocked(workspaceRoot, timestamp);
  const runtimeJobs = new Map(runtime.jobs.map((job) => [job.id, job]));
  const definedIds = new Set(definitions.jobs.map((job) => job.id));
  const deletedDefinitions = runtime.jobs.flatMap((job) =>
    !definedIds.has(job.id) && job.deletedDefinition
      ? [job.deletedDefinition]
      : [],
  );
  const jobs = [...definitions.jobs, ...deletedDefinitions].map(
    (definition): ScheduledJob => {
      const saved = runtimeJobs.get(definition.id);
      const sameDefinition =
        saved?.definitionFingerprint === fingerprint(definition);
      const triggerStates = new Map(
        saved?.triggers.map((trigger) => [trigger.id, trigger]),
      );
      const triggers = definition.triggers.map(
        (trigger): ScheduledJobTrigger => {
          const savedTrigger = triggerStates.get(trigger.id);
          const sameTrigger =
            savedTrigger?.definitionFingerprint === fingerprint(trigger);
          const restored = {
            ...trigger,
            ...(sameTrigger && savedTrigger
              ? selectFields(savedTrigger, TRIGGER_RUNTIME_FIELDS)
              : {}),
            updatedAt:
              sameTrigger && savedTrigger ? savedTrigger.updatedAt : timestamp,
          } as ScheduledJobTrigger;
          if (restored.kind === "time" && !sameTrigger) {
            const nextRunAt = getNextSchedulerRunAfter(
              restored.schedule,
              savedTrigger ? timestamp : trigger.createdAt,
            );
            if (nextRunAt !== undefined) {
              restored.nextRunAt = nextRunAt;
            }
          }
          return restored;
        },
      );
      const ralphFlow = definition.target.ralphFlow;
      const savedFlow = saved?.ralphFlow;
      const flowRuntime =
        ralphFlow && savedFlow?.definitionFingerprint === fingerprint(ralphFlow)
          ? selectFields(savedFlow, FLOW_RUNTIME_FIELDS)
          : {};
      const schedule = triggers.find(
        (trigger): trigger is ScheduledTimeTrigger => trigger.kind === "time",
      )?.schedule;
      const nextRunAt = triggers
        .flatMap((trigger) =>
          trigger.kind === "time" && trigger.nextRunAt !== undefined
            ? [trigger.nextRunAt]
            : [],
        )
        .sort((left, right) => left - right)[0];
      return {
        ...definition,
        ...(saved
          ? selectFields(saved, [
              "lastEnqueuedAt",
              "lastStartedAt",
              "lastFinishedAt",
            ])
          : {}),
        status: sameDefinition && saved ? saved.status : definition.status,
        updatedAt: sameDefinition && saved ? saved.updatedAt : timestamp,
        queue: {
          ...definition.queue,
          concurrencyKey:
            definition.queue.concurrencyKey === "ralph-workspace:."
              ? createCanonicalWorkspaceQueueKey(workspaceRoot)
              : definition.queue.concurrencyKey,
        },
        triggers,
        target: {
          ...definition.target,
          workspaceRoot: resolve(
            workspaceRoot,
            definition.target.workspaceRoot,
          ),
          ...(ralphFlow ? { ralphFlow: { ...ralphFlow, ...flowRuntime } } : {}),
        },
        ...(schedule ? { schedule } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      };
    },
  );
  const state: SmartSchedulerState = {
    schema: "machdoch.smartScheduler",
    schemaVersion: 2,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    jobs,
    runs: runtime.runs,
    events: runtime.events,
    mutationReceipts: runtime.mutationReceipts,
  };
  if (
    definitions.jobs.some(
      (job) =>
        runtimeJobs.get(job.id)?.definitionFingerprint !== fingerprint(job),
    )
  ) {
    state.updatedAt = timestamp;
    await writeJsonDurably(
      getSchedulerStatePath(workspaceRoot),
      splitState(state, workspaceRoot).runtime,
    );
  }
  return { state, definitionFingerprint: fingerprint(storedDefinitions) };
};

export const writeWorkspaceSchedulerStateUnlocked = async (
  workspaceRoot: string,
  state: SmartSchedulerState,
  expectedDefinitionFingerprint?: string,
): Promise<void> => {
  const { definitions, storedDefinitions } =
    await migrateWorkspaceSchedulerStorageUnlocked(
      workspaceRoot,
      state.updatedAt,
    );
  if (
    expectedDefinitionFingerprint !== undefined &&
    expectedDefinitionFingerprint !== fingerprint(storedDefinitions)
  ) {
    throw new Error(
      `Workspace scheduler definitions changed during a mutation: ${getSchedulerDefinitionPath(workspaceRoot)}`,
    );
  }
  const split = splitState(state, workspaceRoot);
  if (fingerprint(definitions) === fingerprint(split.definitions)) {
    await writeJsonDurably(getSchedulerStatePath(workspaceRoot), split.runtime);
    return;
  }
  await writeDocumentsUnlocked(
    workspaceRoot,
    split.definitions,
    split.runtime,
    storedDefinitions,
  );
};
