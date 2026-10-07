import {
  withSchedulerStateLock,
  writeSchedulerFileDurably,
} from "./scheduler-file-storage.helper.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getNextCronRunAfter } from "./parse-cron-expression.helper.js";
import { migrateWorkspacePathReferences } from "./migrate-workspace-storage-references.helper.js";
import type {
  ScheduledJob,
  ScheduledJobProvenance,
  ScheduledJobSchedule,
  ScheduledJobTrigger,
  ScheduledRalphFlowTarget,
  ScheduledTimeTrigger,
  ScheduledEventTrigger,
  SmartSchedulerState,
} from "../scheduler.js";

export const getNextSchedulerRunAfter = (
  schedule: ScheduledJobSchedule,
  afterTimestamp: number,
): number | undefined => {
  switch (schedule.type) {
    case "cron":
      return getNextCronRunAfter(
        schedule.expression,
        schedule.timezone,
        afterTimestamp,
      );
    case "interval": {
      const elapsed = afterTimestamp - schedule.anchorAt;
      const intervalsElapsed =
        elapsed < 0 ? 0 : Math.floor(elapsed / schedule.intervalMs) + 1;

      return schedule.anchorAt + intervalsElapsed * schedule.intervalMs;
    }
    case "delay":
      return schedule.runAt > afterTimestamp ? schedule.runAt : undefined;
  }
};

const DEFINITION_SCHEMA = "machdoch.smartScheduler.definitions" as const;
const RUNTIME_SCHEMA = "machdoch.smartScheduler.runtime" as const;
const STORAGE_SCHEMA_VERSION = 1 as const;

const JOB_RUNTIME_FIELDS = [
  "updatedAt",
  "nextRunAt",
  "lastEnqueuedAt",
  "lastStartedAt",
  "lastFinishedAt",
] as const;
const TRIGGER_RUNTIME_FIELDS = [
  "updatedAt",
  "nextRunAt",
  "lastMatchedAt",
  "lastFiredAt",
  "lastSkippedAt",
  "lastState",
  "lastStateChangedAt",
] as const;
const FLOW_RUNTIME_FIELDS = [
  "flowSnapshot",
  "flowFingerprint",
  "flowSnapshotAt",
  "flowSnapshotRefreshError",
  "flowSnapshotRefreshFailedAt",
] as const;

type TriggerRuntimeField = (typeof TRIGGER_RUNTIME_FIELDS)[number];
type TriggerDefinition =
  | Omit<ScheduledTimeTrigger, TriggerRuntimeField>
  | Omit<ScheduledEventTrigger, TriggerRuntimeField>;
type FlowRuntime = Pick<
  ScheduledRalphFlowTarget,
  (typeof FLOW_RUNTIME_FIELDS)[number]
>;
type JobDefinition = Omit<
  ScheduledJob,
  | (typeof JOB_RUNTIME_FIELDS)[number]
  | "schedule"
  | "triggers"
  | "target"
  | "status"
> & {
  status: Exclude<ScheduledJob["status"], "completed">;
  triggers: TriggerDefinition[];
  target: Omit<ScheduledJob["target"], "ralphFlow"> & {
    ralphFlow?: Omit<
      ScheduledRalphFlowTarget,
      (typeof FLOW_RUNTIME_FIELDS)[number]
    >;
  };
};

interface SchedulerDefinitions {
  schema: typeof DEFINITION_SCHEMA;
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  jobs: JobDefinition[];
}

interface TriggerRuntime {
  id: string;
  definitionFingerprint: string;
  updatedAt: number;
  nextRunAt?: number;
  lastMatchedAt?: number;
  lastFiredAt?: number;
  lastSkippedAt?: number;
  lastState?: "idle" | "active";
  lastStateChangedAt?: number;
}

interface JobRuntime extends Pick<
  ScheduledJob,
  (typeof JOB_RUNTIME_FIELDS)[number]
> {
  id: string;
  definitionFingerprint: string;
  status: ScheduledJob["status"];
  triggers: TriggerRuntime[];
  deletedDefinition?: JobDefinition;
  ralphFlow?: FlowRuntime & { definitionFingerprint: string };
}

interface SchedulerRuntime extends Omit<
  SmartSchedulerState,
  "schema" | "schemaVersion" | "jobs"
> {
  schema: typeof RUNTIME_SCHEMA;
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  jobs: JobRuntime[];
  definitionUpdate?: {
    previousFingerprint: string;
    definitions: SchedulerDefinitions;
  };
}

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

const omitFields = <T extends object, K extends string>(
  value: T,
  fields: readonly K[],
): T extends unknown ? Omit<T, K> : never => {
  const result = { ...value } as Record<string, unknown>;
  for (const field of fields) {
    delete result[field];
  }
  return result as T extends unknown ? Omit<T, K> : never;
};

const selectFields = <T extends object, K extends string>(
  value: T,
  fields: readonly K[],
): Pick<T, Extract<keyof T, K>> =>
  Object.fromEntries(
    fields.flatMap((field) =>
      field in value
        ? [[field, (value as Record<string, unknown>)[field]]]
        : [],
    ),
  ) as Pick<T, Extract<keyof T, K>>;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
};

const fingerprint = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalValue(value ?? null)))
    .digest("hex");

export const createCanonicalWorkspaceQueueKey = (workspaceRoot: string): string => {
  const normalized = resolve(workspaceRoot).replaceAll("\\", "/");
  const canonical = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `ralph-workspace:${canonical}`;
};

const toJobDefinition = (
  job: ScheduledJob,
  workspaceRoot: string,
): JobDefinition => ({
  ...omitFields(job, [
    ...JOB_RUNTIME_FIELDS,
    "schedule",
    "triggers",
    "target",
    "status",
  ]),
  status: job.status === "completed" ? "active" : job.status,
  queue: {
    ...job.queue,
    concurrencyKey: job.queue.concurrencyKey === createCanonicalWorkspaceQueueKey(workspaceRoot)
      ? "ralph-workspace:." : job.queue.concurrencyKey,
  },
  triggers: job.triggers.map((trigger) =>
    omitFields(trigger, TRIGGER_RUNTIME_FIELDS),
  ),
  target: {
    ...omitFields(job.target, ["ralphFlow"]),
    workspaceRoot:
      resolve(job.target.workspaceRoot) === resolve(workspaceRoot)
        ? "."
        : job.target.workspaceRoot,
    ...(job.target.ralphFlow
      ? { ralphFlow: omitFields(job.target.ralphFlow, FLOW_RUNTIME_FIELDS) }
      : {}),
  },
});

const splitState = (
  state: SmartSchedulerState,
  workspaceRoot: string,
): {
  definitions: SchedulerDefinitions;
  runtime: SchedulerRuntime;
} => ({
  definitions: {
    schema: DEFINITION_SCHEMA,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    jobs: state.jobs
      .filter((job) => job.status !== "deleted")
      .map((job) => toJobDefinition(job, workspaceRoot)),
  },
  runtime: {
    ...omitFields(state, ["schema", "schemaVersion", "jobs"]),
    schema: RUNTIME_SCHEMA,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    jobs: state.jobs.map((job) => ({
      ...selectFields(job, JOB_RUNTIME_FIELDS),
      id: job.id,
      definitionFingerprint: fingerprint(toJobDefinition(job, workspaceRoot)),
      status: job.status,
      updatedAt: job.updatedAt,
      ...(job.status === "deleted"
        ? { deletedDefinition: toJobDefinition(job, workspaceRoot) }
        : {}),
      triggers: job.triggers.map((trigger) => ({
        ...selectFields(trigger, TRIGGER_RUNTIME_FIELDS),
        id: trigger.id,
        definitionFingerprint: fingerprint(
          omitFields(trigger, TRIGGER_RUNTIME_FIELDS),
        ),
        updatedAt: trigger.updatedAt,
      })),
      ...(job.target.ralphFlow
        ? {
            ralphFlow: {
              ...selectFields(job.target.ralphFlow, FLOW_RUNTIME_FIELDS),
              definitionFingerprint: fingerprint(
                omitFields(job.target.ralphFlow, FLOW_RUNTIME_FIELDS),
              ),
            },
          }
        : {}),
    })),
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isProvenance = (value: unknown): value is ScheduledJobProvenance =>
  isRecord(value) &&
  ((value.kind === "user" && Object.keys(value).length === 1) ||
    (value.kind === "workspace-prompt" &&
      Object.keys(value).length === 2 &&
      typeof value.definitionPath === "string" &&
      value.definitionPath.length > 0) ||
    (value.kind === "ralph-watch" &&
      Object.keys(value).length === 2 &&
      typeof value.watchId === "string" &&
      value.watchId.length > 0));

const hasUniqueIds = (entries: unknown[]): boolean =>
  entries.every(
    (entry) =>
      isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0,
  ) &&
  new Set(entries.map((entry) => (entry as { id: string }).id)).size ===
    entries.length;

const isSchedule = (value: unknown): boolean =>
  isRecord(value) &&
  ((value.type === "cron" &&
    typeof value.expression === "string" &&
    typeof value.timezone === "string") ||
    (value.type === "interval" &&
      isTimestamp(value.intervalMs) &&
      value.intervalMs > 0 &&
      isTimestamp(value.anchorAt)) ||
    (value.type === "delay" && isTimestamp(value.runAt)));

const isJobConfiguration = (value: unknown): value is ScheduledJob =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  ["active", "paused", "completed", "deleted"].includes(String(value.status)) &&
  isTimestamp(value.createdAt) &&
  isRecord(value.target) &&
  (value.target.type === "prompt" || value.target.type === "ralph-flow") &&
  typeof value.target.workspaceRoot === "string" &&
  typeof value.target.prompt === "string" &&
  Array.isArray(value.target.contextPaths) &&
  Array.isArray(value.target.imagePaths) &&
  Array.isArray(value.target.contextPacks) &&
  Array.isArray(value.target.macros) &&
  (value.target.ralphFlow === undefined ||
    (isRecord(value.target.ralphFlow) &&
      typeof value.target.ralphFlow.id === "string" &&
      (value.target.ralphFlow.scope === "workspace" ||
        value.target.ralphFlow.scope === "user") &&
      isRecord(value.target.ralphFlow.params))) &&
  isRecord(value.retry) &&
  isRecord(value.queue) &&
  Array.isArray(value.triggers) &&
  value.triggers.length > 0 &&
  hasUniqueIds(value.triggers) &&
  value.triggers.every(
    (trigger) =>
      isRecord(trigger) &&
      typeof trigger.enabled === "boolean" &&
      isTimestamp(trigger.createdAt) &&
      (trigger.kind === "time"
        ? isSchedule(trigger.schedule)
        : typeof trigger.kind === "string" &&
          typeof trigger.eventType === "string"),
  );

const unsupportedStorage = (path: string): Error =>
  new Error(`Unsupported workspace scheduler storage: ${path}`);

const isJobDefinition = (value: unknown): value is JobDefinition =>
  isJobConfiguration(value) &&
  isProvenance(value.provenance) &&
  value.status !== "completed" &&
  !("schedule" in value) &&
  !JOB_RUNTIME_FIELDS.some((field) => field in value) &&
  value.triggers.every(
    (trigger) => !TRIGGER_RUNTIME_FIELDS.some((field) => field in trigger),
  ) &&
  (!value.target.ralphFlow ||
    !FLOW_RUNTIME_FIELDS.some((field) => field in value.target.ralphFlow!));

const parseDefinitions = (
  value: unknown,
  path: string,
): SchedulerDefinitions => {
  if (
    !isRecord(value) ||
    value.schema !== DEFINITION_SCHEMA ||
    value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    !Array.isArray(value.jobs) ||
    !hasUniqueIds(value.jobs) ||
    !value.jobs.every((job) => isJobDefinition(job) && job.status !== "deleted")
  ) {
    throw unsupportedStorage(path);
  }
  return value as unknown as SchedulerDefinitions;
};

const emptyRuntime = (timestamp: number): SchedulerRuntime => ({
  schema: RUNTIME_SCHEMA,
  schemaVersion: STORAGE_SCHEMA_VERSION,
  createdAt: timestamp,
  updatedAt: timestamp,
  jobs: [],
  runs: [],
  events: [],
  mutationReceipts: [],
});

const parseRuntime = (
  value: unknown,
  path: string,
  timestamp: number,
): SchedulerRuntime => {
  if (value === undefined) {
    return emptyRuntime(timestamp);
  }
  if (
    !isRecord(value) ||
    value.schema !== RUNTIME_SCHEMA ||
    value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.jobs) ||
    !hasUniqueIds(value.jobs) ||
    !value.jobs.every(
      (job) =>
        isRecord(job) &&
        typeof job.definitionFingerprint === "string" &&
        isTimestamp(job.updatedAt) &&
        ["active", "paused", "completed", "deleted"].includes(
          String(job.status),
        ) &&
        (job.deletedDefinition === undefined ||
          (job.status === "deleted" &&
            isJobDefinition(job.deletedDefinition) &&
            job.deletedDefinition.status === "deleted" &&
            job.deletedDefinition.id === job.id)) &&
        (job.ralphFlow === undefined ||
          (isRecord(job.ralphFlow) &&
            typeof job.ralphFlow.definitionFingerprint === "string")) &&
        Array.isArray(job.triggers) &&
        hasUniqueIds(job.triggers) &&
        job.triggers.every(
          (trigger) =>
            isRecord(trigger) &&
            typeof trigger.definitionFingerprint === "string" &&
            isTimestamp(trigger.updatedAt),
        ),
    ) ||
    !Array.isArray(value.runs) ||
    !hasUniqueIds(value.runs) ||
    !Array.isArray(value.events) ||
    !hasUniqueIds(value.events) ||
    !Array.isArray(value.mutationReceipts) ||
    !value.mutationReceipts.every(
      (receipt) => isRecord(receipt) && typeof receipt.key === "string",
    )
  ) {
    throw unsupportedStorage(path);
  }
  if (value.definitionUpdate !== undefined) {
    if (
      !isRecord(value.definitionUpdate) ||
      typeof value.definitionUpdate.previousFingerprint !== "string"
    ) {
      throw unsupportedStorage(path);
    }
    parseDefinitions(value.definitionUpdate.definitions, path);
  }
  return value as unknown as SchedulerRuntime;
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

const inferMigratedProvenance = (job: {
  dedupeKey?: string;
}): ScheduledJobProvenance => {
  if (
    job.dedupeKey?.startsWith("ralph-watch:") &&
    job.dedupeKey.length > "ralph-watch:".length
  ) {
    return {
      kind: "ralph-watch",
      watchId: job.dedupeKey.slice("ralph-watch:".length),
    };
  }
  if (
    job.dedupeKey?.startsWith("prompt:") &&
    job.dedupeKey.length > "prompt:".length
  ) {
    return {
      kind: "workspace-prompt",
      definitionPath: job.dedupeKey.slice("prompt:".length),
    };
  }
  return { kind: "user" };
};

const parseCombinedStateForMigration = (
  value: unknown,
  path: string,
): SmartSchedulerState => {
  if (
    !isRecord(value) ||
    value.schema !== "machdoch.smartScheduler" ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.jobs) ||
    !hasUniqueIds(value.jobs) ||
    !value.jobs.every(
      (job) =>
        isJobConfiguration(job) &&
        isTimestamp(job.updatedAt) &&
        job.triggers.every((trigger) => isTimestamp(trigger.updatedAt)) &&
        (value.schemaVersion === 1
          ? !("provenance" in job)
          : isProvenance(job.provenance)),
    ) ||
    !Array.isArray(value.runs) ||
    !hasUniqueIds(value.runs) ||
    !Array.isArray(value.events) ||
    !hasUniqueIds(value.events) ||
    !Array.isArray(value.mutationReceipts) ||
    !value.mutationReceipts.every(
      (receipt) => isRecord(receipt) && typeof receipt.key === "string",
    )
  ) {
    throw unsupportedStorage(path);
  }
  const state = value as unknown as SmartSchedulerState;
  return {
    ...state,
    schemaVersion: 2,
    jobs: state.jobs.map((job) => ({
      ...job,
      provenance:
        value.schemaVersion === 1
          ? inferMigratedProvenance(job)
          : job.provenance,
    })),
  };
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
          concurrencyKey: definition.queue.concurrencyKey === "ralph-workspace:."
            ? createCanonicalWorkspaceQueueKey(workspaceRoot) : definition.queue.concurrencyKey,
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
  if (definitions.jobs.some((job) =>
    runtimeJobs.get(job.id)?.definitionFingerprint !== fingerprint(job),
  )) {
    state.updatedAt = timestamp;
    await writeJsonDurably(getSchedulerStatePath(workspaceRoot), splitState(state, workspaceRoot).runtime);
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
