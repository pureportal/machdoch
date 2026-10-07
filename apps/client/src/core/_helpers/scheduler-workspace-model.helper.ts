import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getNextCronRunAfter } from "./parse-cron-expression.helper.js";
import type {
  ScheduledJob,
  ScheduledJobProvenance,
  ScheduledJobSchedule,
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

export const DEFINITION_SCHEMA = "machdoch.smartScheduler.definitions" as const;
export const RUNTIME_SCHEMA = "machdoch.smartScheduler.runtime" as const;
export const STORAGE_SCHEMA_VERSION = 1 as const;

const JOB_RUNTIME_FIELDS = [
  "updatedAt",
  "nextRunAt",
  "lastEnqueuedAt",
  "lastStartedAt",
  "lastFinishedAt",
] as const;
export const TRIGGER_RUNTIME_FIELDS = [
  "updatedAt",
  "nextRunAt",
  "lastMatchedAt",
  "lastFiredAt",
  "lastSkippedAt",
  "lastState",
  "lastStateChangedAt",
] as const;
export const FLOW_RUNTIME_FIELDS = [
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

export interface SchedulerDefinitions {
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

export interface SchedulerRuntime extends Omit<
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

export const omitFields = <T extends object, K extends string>(
  value: T,
  fields: readonly K[],
): T extends unknown ? Omit<T, K> : never => {
  const result = { ...value } as Record<string, unknown>;
  for (const field of fields) {
    delete result[field];
  }
  return result as T extends unknown ? Omit<T, K> : never;
};

export const selectFields = <T extends object, K extends string>(
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

export const fingerprint = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalValue(value ?? null)))
    .digest("hex");

export const createCanonicalWorkspaceQueueKey = (
  workspaceRoot: string,
): string => {
  const normalized = resolve(workspaceRoot).replaceAll("\\", "/");
  const canonical =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
    concurrencyKey:
      job.queue.concurrencyKey ===
      createCanonicalWorkspaceQueueKey(workspaceRoot)
        ? "ralph-workspace:."
        : job.queue.concurrencyKey,
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

export const splitState = (
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
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

export const parseDefinitions = (
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

export const parseRuntime = (
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

export const parseCombinedStateForMigration = (
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
