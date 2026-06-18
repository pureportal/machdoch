import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { getUserConfigPath } from "./env.js";
import { parseMarkdownDocument } from "./frontmatter.js";
import type {
  FrontmatterValue,
  TaskExecutionOptions,
  TaskExecutionResult,
} from "./types.js";
import type {
  ModelProvider,
  ReasoningMode,
  RunMode,
} from "./runtime-contract.generated.js";
import {
  getNextCronRunAfter,
  parseCronExpression,
} from "./_helpers/parse-cron-expression.helper.js";
import { splitDueTimesByMissedPolicy } from "./_helpers/split-due-times-by-missed-policy.helper.js";
export {
  getNextCronRunAfter,
  parseCronExpression,
} from "./_helpers/parse-cron-expression.helper.js";
export type {
  CronField,
  ParsedCronExpression,
  TimeZoneDateParts,
} from "./_helpers/parse-cron-expression.helper.js";

export const SMART_SCHEDULER_SCHEMA = "machdoch.smartScheduler" as const;
export const SMART_SCHEDULER_SCHEMA_VERSION = 1 as const;
export const SMART_SCHEDULER_FILE_NAME = "scheduler.json";

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_MISSED_RUN_POLICY: ScheduledMissedRunPolicy = "enqueue-latest";
const DEFAULT_MISSED_RUN_GRACE_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_EVENT_HISTORY_LIMIT = 1_000;
const DEFAULT_MAX_CATCH_UP_RUNS = 100;
const DEFAULT_CONCURRENCY_LIMIT = 1;
const DEFAULT_STATEFUL_TRIGGER_REPEAT_MS = 60 * 60_000;
const DEFAULT_RETRY_POLICY: ScheduledRetryPolicy = {
  maxAttempts: 1,
  factor: 2,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  randomize: true,
};
const SCHEDULER_STATE_LOCK_RETRY_MS = 25;
const SCHEDULER_STATE_LOCK_STALE_MS = 5 * 60_000;
const SCHEDULER_STATE_REPLACE_RETRY_DELAYS_MS = [
  0,
  10,
  25,
  50,
  100,
  250,
] as const;
const SCHEDULER_TIMEOUT_REASON_PREFIX = "Scheduled run exceeded max duration";

export type ScheduledJobStatus = "active" | "paused" | "completed" | "deleted";

export type ScheduledRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "expired"
  | "skipped";

export type ScheduledRunSource =
  | "schedule"
  | "manual"
  | "manual-retry"
  | "event";

export type ScheduledMissedRunPolicy = "skip" | "enqueue-latest" | "enqueue-all";

export type ScheduledTriggerKind =
  | "time"
  | "manual"
  | "app"
  | "workspace-file"
  | "git"
  | "job-event"
  | "webhook"
  | "poll"
  | "system"
  | "calendar"
  | "clipboard"
  | "integration";

export type ScheduledEventTriggerKind = Exclude<ScheduledTriggerKind, "time">;

export type ScheduledTriggerFiringMode = "event" | "state";

export type ScheduledTriggerState = "idle" | "active";

export type ScheduledJobSchedule =
  | {
      type: "cron";
      expression: string;
      timezone: string;
    }
  | {
      type: "interval";
      intervalMs: number;
      anchorAt: number;
    }
  | {
      type: "delay";
      runAt: number;
    };

export type ScheduledJobScheduleInput =
  | {
      type: "cron";
      expression: string;
      timezone?: string;
    }
  | {
      type: "interval";
      intervalMs: number;
      anchorAt?: number;
    }
  | {
      type: "delay";
      delayMs?: number;
      runAt?: number;
    };

export interface ScheduledTriggerRateLimitPolicy {
  maxEvents: number;
  windowMs: number;
}

export interface ScheduledTriggerGuard {
  kind: string;
  value?: string | number | boolean;
}

export interface ScheduledTriggerBase {
  id: string;
  kind: ScheduledTriggerKind;
  enabled: boolean;
  name?: string;
  filters?: Record<string, unknown>;
  recoveryFilters?: Record<string, unknown>;
  guards?: ScheduledTriggerGuard[];
  firingMode?: ScheduledTriggerFiringMode;
  debounceMs?: number;
  cooldownMs?: number;
  repeatIntervalMs?: number;
  dedupeKeyTemplate?: string;
  maxEventsPerWindow?: ScheduledTriggerRateLimitPolicy;
  createdAt: number;
  updatedAt: number;
  lastMatchedAt?: number;
  lastFiredAt?: number;
  lastSkippedAt?: number;
  lastState?: ScheduledTriggerState;
  lastStateChangedAt?: number;
}

export interface ScheduledTimeTrigger extends ScheduledTriggerBase {
  kind: "time";
  schedule: ScheduledJobSchedule;
  nextRunAt?: number;
}

export interface ScheduledEventTrigger extends ScheduledTriggerBase {
  kind: ScheduledEventTriggerKind;
  eventType: string;
}

export type ScheduledJobTrigger = ScheduledTimeTrigger | ScheduledEventTrigger;

export interface ScheduledTriggerInputBase {
  id?: string;
  kind: ScheduledTriggerKind;
  enabled?: boolean;
  name?: string;
  filters?: Record<string, unknown>;
  recoveryFilters?: Record<string, unknown>;
  guards?: ScheduledTriggerGuard[];
  firingMode?: ScheduledTriggerFiringMode;
  debounceMs?: number;
  cooldownMs?: number;
  repeatIntervalMs?: number;
  dedupeKeyTemplate?: string;
  maxEventsPerWindow?: Partial<ScheduledTriggerRateLimitPolicy>;
}

export interface ScheduledTimeTriggerInput extends ScheduledTriggerInputBase {
  kind: "time";
  schedule: ScheduledJobScheduleInput;
}

export interface ScheduledEventTriggerInput extends ScheduledTriggerInputBase {
  kind: ScheduledEventTriggerKind;
  eventType?: string;
}

export type ScheduledJobTriggerInput =
  | ScheduledTimeTriggerInput
  | ScheduledEventTriggerInput;

export interface ScheduledContextPackSnapshot {
  name: string;
  instructions?: string;
  prompt?: string;
  contextPaths?: string[];
  variableValues?: Record<string, string>;
}

export interface ScheduledMacroReference {
  name: string;
  promptInvocation?: string;
  inputValues?: Record<string, string>;
}

export type ScheduledJobTargetType = "prompt" | "ralph-flow";
export type ScheduledRalphFlowScope = "workspace" | "user";

export interface ScheduledRalphFlowTarget {
  scope: ScheduledRalphFlowScope;
  id: string;
  params: Record<string, string>;
  maxTransitions?: number;
  runLogScope?: ScheduledRalphFlowScope;
  permissions?: {
    allowedRoots: string[];
    allowCommands: boolean;
    allowWrites: boolean;
    allowNetwork: boolean;
    allowMcpTools: boolean;
  };
}

export interface ScheduledJobTarget {
  type: ScheduledJobTargetType;
  workspaceRoot: string;
  prompt: string;
  contextPaths: string[];
  imagePaths: string[];
  contextPacks: ScheduledContextPackSnapshot[];
  macros: ScheduledMacroReference[];
  ralphFlow?: ScheduledRalphFlowTarget;
  mode?: RunMode;
  profile?: string;
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
  reasoning?: ReasoningMode;
}

export interface ScheduledJobTargetInput {
  type?: ScheduledJobTargetType;
  workspaceRoot: string;
  prompt?: string;
  contextPaths?: string[];
  imagePaths?: string[];
  contextPacks?: ScheduledContextPackSnapshot[];
  macros?: ScheduledMacroReference[];
  ralphFlow?: Partial<ScheduledRalphFlowTarget> & { id: string };
  mode?: RunMode;
  profile?: string;
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
  reasoning?: ReasoningMode;
}

export interface ScheduledRetryPolicy {
  maxAttempts: number;
  factor: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  randomize: boolean;
}

export interface ScheduledQueuePolicy {
  concurrencyKey: string;
  concurrencyLimit: number;
}

export interface ScheduledJob {
  id: string;
  name: string;
  status: ScheduledJobStatus;
  schedule?: ScheduledJobSchedule;
  triggers: ScheduledJobTrigger[];
  target: ScheduledJobTarget;
  missedRunPolicy: ScheduledMissedRunPolicy;
  missedRunGraceMs: number;
  retry: ScheduledRetryPolicy;
  queue: ScheduledQueuePolicy;
  historyLimit: number;
  maxCatchUpRuns: number;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  dedupeKey?: string;
  ttlMs?: number;
  maxDurationMs?: number;
  lastEnqueuedAt?: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
}

export interface CreateScheduledJobInput {
  name?: string;
  schedule?: ScheduledJobScheduleInput;
  triggers?: ScheduledJobTriggerInput[];
  target: ScheduledJobTargetInput;
  missedRunPolicy?: ScheduledMissedRunPolicy;
  missedRunGraceMs?: number;
  retry?: Partial<ScheduledRetryPolicy>;
  queue?: Partial<ScheduledQueuePolicy>;
  historyLimit?: number;
  maxCatchUpRuns?: number;
  dedupeKey?: string;
  ttlMs?: number;
  maxDurationMs?: number;
}

export interface UpdateScheduledJobInput {
  name?: string;
  schedule?: ScheduledJobScheduleInput;
  triggers?: ScheduledJobTriggerInput[];
  target?: Partial<ScheduledJobTargetInput>;
  missedRunPolicy?: ScheduledMissedRunPolicy;
  missedRunGraceMs?: number;
  retry?: Partial<ScheduledRetryPolicy>;
  queue?: Partial<ScheduledQueuePolicy>;
  historyLimit?: number;
  maxCatchUpRuns?: number;
  dedupeKey?: string;
  ttlMs?: number;
  maxDurationMs?: number;
}

export interface ScheduledRunAttempt {
  attempt: number;
  startedAt: number;
  finishedAt: number;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  summary?: string;
  resultStatus?: TaskExecutionResult["status"];
  error?: string;
  nextRetryAt?: number;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  triggerId?: string;
  eventId?: string;
  source: ScheduledRunSource;
  status: ScheduledRunStatus;
  scheduledFor: number;
  enqueuedAt: number;
  updatedAt: number;
  attempt: number;
  maxAttempts: number;
  queueKey: string;
  concurrencyLimit: number;
  attemptHistory: ScheduledRunAttempt[];
  dedupeKey?: string;
  parentRunId?: string;
  expiresAt?: number;
  nextAttemptAt?: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequestedAt?: number;
  cancelReason?: string;
  result?: TaskExecutionResult;
  error?: string;
}

export interface SmartSchedulerState {
  schema: typeof SMART_SCHEDULER_SCHEMA;
  schemaVersion: typeof SMART_SCHEDULER_SCHEMA_VERSION;
  createdAt: number;
  updatedAt: number;
  jobs: ScheduledJob[];
  runs: ScheduledJobRun[];
  events: ScheduledTriggerEvent[];
}

export interface ScheduledTriggerEventInput {
  type: string;
  kind?: ScheduledEventTriggerKind;
  source?: string;
  workspaceRoot?: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  occurredAt?: number;
}

export interface ScheduledTriggerEventMatch {
  jobId: string;
  triggerId: string;
  matched: boolean;
  queuedRunId?: string;
  deduplicated?: boolean;
  skippedReason?: string;
}

export interface ScheduledTriggerEvent {
  id: string;
  type: string;
  kind: ScheduledEventTriggerKind;
  source: string;
  workspaceRoot?: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  occurredAt: number;
  receivedAt: number;
  matches: ScheduledTriggerEventMatch[];
}

export interface ScheduledTriggerEventResult {
  event: ScheduledTriggerEvent;
  enqueued: ScheduledRunEnqueueResult[];
}

export interface ScheduledRunHandle {
  jobId: string;
  runId: string;
}

export interface ScheduledRunEnqueueResult {
  handle: ScheduledRunHandle;
  run: ScheduledJobRun;
  deduplicated: boolean;
}

export interface ScheduledTaskExecutionRequest {
  job: ScheduledJob;
  run: ScheduledJobRun;
  event?: ScheduledTriggerEvent;
  targetType: ScheduledJobTargetType;
  task: string;
  workspaceRoot: string;
  contextPaths: string[];
  imagePaths: string[];
  ralphFlow?: ScheduledRalphFlowTarget;
  mode?: RunMode;
  profile?: string;
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
  reasoning?: ReasoningMode;
}

export interface ScheduledTaskExecutor {
  execute(
    request: ScheduledTaskExecutionRequest,
    options: Pick<TaskExecutionOptions, "signal" | "maxDurationMs">,
  ): Promise<TaskExecutionResult>;
}

export interface SchedulerClock {
  now(): number;
}

export interface DurableSmartSchedulerOptions {
  statePath: string;
  executor?: ScheduledTaskExecutor;
  clock?: SchedulerClock;
  rng?: () => number;
}

export interface RunQueuedScheduledJobsOptions {
  maxRuns?: number;
}

export interface RunQueuedScheduledJobsResult {
  runs: ScheduledJobRun[];
  queued: ScheduledJobRun[];
}

export interface ScheduledPromptDefinition {
  path: string;
  name: string;
  enabled: boolean;
  input?: CreateScheduledJobInput;
  warnings: string[];
}

export interface ScheduledPromptSyncResult {
  workspaceRoot: string;
  discovered: ScheduledPromptDefinition[];
  syncedJobs: ScheduledJob[];
  pausedJobs: ScheduledJob[];
}

const createEmptySchedulerState = (timestamp: number): SmartSchedulerState => ({
  schema: SMART_SCHEDULER_SCHEMA,
  schemaVersion: SMART_SCHEDULER_SCHEMA_VERSION,
  createdAt: timestamp,
  updatedAt: timestamp,
  jobs: [],
  runs: [],
  events: [],
});

export const getWorkspaceSchedulerStatePath = (workspaceRoot: string): string => {
  return join(workspaceRoot, ".machdoch", SMART_SCHEDULER_FILE_NAME);
};

export const getUserSchedulerStatePath = (): string => {
  return join(dirname(getUserConfigPath()), SMART_SCHEDULER_FILE_NAME);
};

const sleep = async (durationMs: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
};

const isErrorWithCode = (error: unknown, code: string): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
};

const isTransientStateReplaceError = (error: unknown): boolean => {
  return (
    isErrorWithCode(error, "EBUSY") ||
    isErrorWithCode(error, "EACCES") ||
    isErrorWithCode(error, "EPERM")
  );
};

const getSchedulerStateLockPath = (statePath: string): string => {
  return `${statePath}.lock`;
};

const removeStaleSchedulerStateLock = async (lockPath: string): Promise<void> => {
  try {
    const metadata = await stat(lockPath);

    if (Date.now() - metadata.mtimeMs <= SCHEDULER_STATE_LOCK_STALE_MS) {
      return;
    }

    await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
};

const releaseSchedulerStateLock = async (
  lockPath: string,
  token: string,
): Promise<void> => {
  const tokenPath = join(lockPath, "owner");

  try {
    const currentToken = (await readFile(tokenPath, "utf8")).trim();

    if (currentToken === token) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
};

const acquireSchedulerStateLock = async (
  statePath: string,
): Promise<() => Promise<void>> => {
  const lockPath = getSchedulerStateLockPath(statePath);
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;

  await mkdir(dirname(statePath), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);

      try {
        await writeFile(join(lockPath, "owner"), token, "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      return () => releaseSchedulerStateLock(lockPath, token);
    } catch (error) {
      if (!isErrorWithCode(error, "EEXIST")) {
        throw error;
      }

      await removeStaleSchedulerStateLock(lockPath);
      await sleep(SCHEDULER_STATE_LOCK_RETRY_MS);
    }
  }
};

const withSchedulerStateLock = async <T>(
  statePath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const releaseLock = await acquireSchedulerStateLock(statePath);
  let operationCompleted = false;

  try {
    const result = await operation();
    operationCompleted = true;
    await releaseLock();
    return result;
  } catch (error) {
    if (!operationCompleted) {
      try {
        await releaseLock();
      } catch {
        // Preserve the original scheduler failure; stale locks are reclaimed.
      }
    }

    throw error;
  }
};

const isRecordValue = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isScheduledEventTriggerKind = (
  value: string | undefined,
): value is ScheduledEventTriggerKind => {
  return (
    value === "manual" ||
    value === "app" ||
    value === "workspace-file" ||
    value === "git" ||
    value === "job-event" ||
    value === "webhook" ||
    value === "poll" ||
    value === "system" ||
    value === "calendar" ||
    value === "clipboard" ||
    value === "integration"
  );
};

const isScheduledTriggerFiringMode = (
  value: string | undefined,
): value is ScheduledTriggerFiringMode => {
  return value === "event" || value === "state";
};

const isScheduledTriggerState = (
  value: string | undefined,
): value is ScheduledTriggerState => {
  return value === "idle" || value === "active";
};

const inferEventTriggerKind = (eventType: string): ScheduledEventTriggerKind => {
  const prefix = eventType.split(".")[0];

  return isScheduledEventTriggerKind(prefix) ? prefix : "manual";
};

const getPrimaryTimeTrigger = (
  triggers: ScheduledJobTrigger[],
): ScheduledTimeTrigger | undefined => {
  return triggers.find(
    (trigger): trigger is ScheduledTimeTrigger => trigger.kind === "time",
  );
};

const getEarliestTriggerRunAt = (
  triggers: ScheduledJobTrigger[],
): number | undefined => {
  return triggers
    .flatMap((trigger) =>
      trigger.kind === "time" && trigger.nextRunAt !== undefined
        ? [trigger.nextRunAt]
        : [],
    )
    .sort((left, right) => left - right)[0];
};

const createLegacyTimeTrigger = (
  job: Pick<ScheduledJob, "id" | "schedule" | "createdAt" | "updatedAt" | "nextRunAt">,
): ScheduledTimeTrigger | undefined => {
  if (!job.schedule) {
    return undefined;
  }

  return {
    id: "trigger_time_primary",
    kind: "time",
    enabled: true,
    name: "Time Schedule",
    schedule: job.schedule,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.nextRunAt !== undefined ? { nextRunAt: job.nextRunAt } : {}),
  };
};

const migrateScheduledJobRecord = (job: ScheduledJob): ScheduledJob => {
  const candidate = job as ScheduledJob & { triggers?: unknown };
  const legacyTimeTrigger = createLegacyTimeTrigger(candidate);
  const triggers =
    Array.isArray(candidate.triggers) && candidate.triggers.length > 0
      ? (candidate.triggers as ScheduledJobTrigger[])
      : legacyTimeTrigger
        ? [legacyTimeTrigger]
        : [];
  const primaryTimeTrigger = getPrimaryTimeTrigger(triggers);
  const nextRunAt =
    getEarliestTriggerRunAt(triggers) ?? candidate.nextRunAt ?? undefined;
  const target = {
    ...candidate.target,
    type: candidate.target?.type === "ralph-flow" ? "ralph-flow" : "prompt",
  } as ScheduledJobTarget;
  const migrated: ScheduledJob = {
    ...candidate,
    target,
    triggers,
    ...(primaryTimeTrigger ? { schedule: primaryTimeTrigger.schedule } : {}),
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
  };

  if (!primaryTimeTrigger) {
    delete migrated.schedule;
    delete migrated.nextRunAt;
  }

  return migrated;
};

export const readSmartSchedulerState = async (
  statePath: string,
): Promise<SmartSchedulerState> => {
  if (!existsSync(statePath)) {
    return createEmptySchedulerState(Date.now());
  }

  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<SmartSchedulerState>;

  if (
    parsed.schema !== SMART_SCHEDULER_SCHEMA ||
    parsed.schemaVersion !== SMART_SCHEDULER_SCHEMA_VERSION ||
    !Array.isArray(parsed.jobs) ||
    !Array.isArray(parsed.runs)
  ) {
    throw new Error(`Unsupported smart scheduler state file: ${statePath}`);
  }

  return {
    schema: SMART_SCHEDULER_SCHEMA,
    schemaVersion: SMART_SCHEDULER_SCHEMA_VERSION,
    createdAt:
      typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    updatedAt:
      typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    jobs: parsed.jobs.map((job) => migrateScheduledJobRecord(job)),
    runs: parsed.runs,
    events: Array.isArray(parsed.events) ? parsed.events : [],
  };
};

const replaceSmartSchedulerStateFile = async (
  tempPath: string,
  statePath: string,
): Promise<void> => {
  let lastError: unknown;

  for (const delayMs of SCHEDULER_STATE_REPLACE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      await rename(tempPath, statePath);
      return;
    } catch (error) {
      if (!isTransientStateReplaceError(error)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const writeSmartSchedulerStateUnlocked = async (
  statePath: string,
  state: SmartSchedulerState,
): Promise<void> => {
  await mkdir(dirname(statePath), { recursive: true });

  const tempPath = `${statePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await replaceSmartSchedulerStateFile(tempPath, statePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
};

export const writeSmartSchedulerState = async (
  statePath: string,
  state: SmartSchedulerState,
): Promise<void> => {
  await withSchedulerStateLock(statePath, () =>
    writeSmartSchedulerStateUnlocked(statePath, state),
  );
};

const createJobId = (): string => `sched_${randomUUID()}`;

const createTriggerId = (): string => `trigger_${randomUUID()}`;

const createRunId = (): string => `run_${randomUUID()}`;

const createEventId = (): string => `event_${randomUUID()}`;

const normalizeText = (value: string | undefined): string | undefined => {
  const normalized = value?.replace(/\s+/gu, " ").trim();

  return normalized ? normalized : undefined;
};

const normalizeTrimmedText = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();

  return normalized ? normalized : undefined;
};

const normalizeMultilineText = (value: string | undefined): string => {
  return value?.trim() ?? "";
};

const normalizeStringList = (values: string[] | undefined): string[] => {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
};

const normalizePositiveInteger = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
};

const normalizePositiveNumber = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
};

const normalizeOptionalPositiveInteger = (
  value: number | undefined,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.max(1, Math.trunc(value));
};

const normalizeTimeZone = (value: string | undefined): string => {
  const timezone = normalizeText(value) ?? DEFAULT_TIMEZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new Error(`Expected scheduler timezone to be a valid IANA timezone: ${timezone}`);
  }
};

const normalizeSchedule = (
  input: ScheduledJobScheduleInput,
  timestamp: number,
): ScheduledJobSchedule => {
  switch (input.type) {
    case "cron": {
      const expression = normalizeText(input.expression);

      if (!expression) {
        throw new Error("Expected cron schedule to include an expression.");
      }

      parseCronExpression(expression);

      return {
        type: "cron",
        expression,
        timezone: normalizeTimeZone(input.timezone),
      };
    }
    case "interval": {
      const intervalMs = normalizeOptionalPositiveInteger(input.intervalMs);

      if (intervalMs === undefined) {
        throw new Error("Expected interval schedule to include a positive intervalMs.");
      }

      return {
        type: "interval",
        intervalMs,
        anchorAt:
          typeof input.anchorAt === "number" && Number.isFinite(input.anchorAt)
            ? Math.trunc(input.anchorAt)
            : timestamp,
      };
    }
    case "delay": {
      const runAt =
        typeof input.runAt === "number" && Number.isFinite(input.runAt)
          ? Math.trunc(input.runAt)
          : timestamp + normalizePositiveInteger(input.delayMs, 0);

      return {
        type: "delay",
        runAt,
      };
    }
  }
};

const cloneRecord = (
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!value || !isRecordValue(value)) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
};

const normalizeTriggerGuard = (
  guard: ScheduledTriggerGuard,
): ScheduledTriggerGuard | undefined => {
  const kind = normalizeText(guard.kind);

  if (!kind) {
    return undefined;
  }

  return {
    kind,
    ...(guard.value !== undefined ? { value: guard.value } : {}),
  };
};

const normalizeTriggerGuards = (
  guards: ScheduledTriggerGuard[] | undefined,
): ScheduledTriggerGuard[] | undefined => {
  const normalized = (guards ?? []).flatMap((guard) => {
    const normalizedGuard = normalizeTriggerGuard(guard);

    return normalizedGuard ? [normalizedGuard] : [];
  });

  return normalized.length > 0 ? normalized : undefined;
};

const normalizeRateLimitPolicy = (
  value: Partial<ScheduledTriggerRateLimitPolicy> | undefined,
): ScheduledTriggerRateLimitPolicy | undefined => {
  if (!value) {
    return undefined;
  }

  const maxEvents = normalizeOptionalPositiveInteger(value.maxEvents);
  const windowMs = normalizeOptionalPositiveInteger(value.windowMs);

  if (maxEvents === undefined || windowMs === undefined) {
    return undefined;
  }

  return { maxEvents, windowMs };
};

const normalizeTriggerCommon = (
  input: ScheduledTriggerInputBase,
  timestamp: number,
  existingTrigger?: ScheduledJobTrigger,
): Omit<ScheduledTriggerBase, "kind"> => {
  const name = normalizeText(input.name);
  const debounceMs = normalizeOptionalPositiveInteger(input.debounceMs);
  const cooldownMs = normalizeOptionalPositiveInteger(input.cooldownMs);
  const repeatIntervalMs = normalizeOptionalPositiveInteger(
    input.repeatIntervalMs,
  );
  const dedupeKeyTemplate = normalizeText(input.dedupeKeyTemplate);
  const filters = cloneRecord(input.filters);
  const recoveryFilters = cloneRecord(input.recoveryFilters);
  const guards = normalizeTriggerGuards(input.guards);
  const firingMode = isScheduledTriggerFiringMode(input.firingMode)
    ? input.firingMode
    : isScheduledTriggerFiringMode(existingTrigger?.firingMode)
      ? existingTrigger.firingMode
      : recoveryFilters || repeatIntervalMs !== undefined
        ? "state"
        : undefined;
  const maxEventsPerWindow = normalizeRateLimitPolicy(input.maxEventsPerWindow);

  return {
    id: normalizeText(input.id) ?? existingTrigger?.id ?? createTriggerId(),
    enabled: input.enabled ?? existingTrigger?.enabled ?? true,
    createdAt: existingTrigger?.createdAt ?? timestamp,
    updatedAt: timestamp,
    ...(name ? { name } : existingTrigger?.name ? { name: existingTrigger.name } : {}),
    ...(filters ? { filters } : existingTrigger?.filters ? { filters: existingTrigger.filters } : {}),
    ...(recoveryFilters
      ? { recoveryFilters }
      : existingTrigger?.recoveryFilters
        ? { recoveryFilters: existingTrigger.recoveryFilters }
        : {}),
    ...(guards ? { guards } : existingTrigger?.guards ? { guards: existingTrigger.guards } : {}),
    ...(firingMode ? { firingMode } : {}),
    ...(debounceMs !== undefined
      ? { debounceMs }
      : existingTrigger?.debounceMs !== undefined
        ? { debounceMs: existingTrigger.debounceMs }
        : {}),
    ...(cooldownMs !== undefined
      ? { cooldownMs }
      : existingTrigger?.cooldownMs !== undefined
        ? { cooldownMs: existingTrigger.cooldownMs }
        : {}),
    ...(repeatIntervalMs !== undefined
      ? { repeatIntervalMs }
      : existingTrigger?.repeatIntervalMs !== undefined
        ? { repeatIntervalMs: existingTrigger.repeatIntervalMs }
        : {}),
    ...(dedupeKeyTemplate
      ? { dedupeKeyTemplate }
      : existingTrigger?.dedupeKeyTemplate
        ? { dedupeKeyTemplate: existingTrigger.dedupeKeyTemplate }
        : {}),
    ...(maxEventsPerWindow
      ? { maxEventsPerWindow }
      : existingTrigger?.maxEventsPerWindow
        ? { maxEventsPerWindow: existingTrigger.maxEventsPerWindow }
        : {}),
    ...(existingTrigger?.lastMatchedAt !== undefined
      ? { lastMatchedAt: existingTrigger.lastMatchedAt }
      : {}),
    ...(existingTrigger?.lastFiredAt !== undefined
      ? { lastFiredAt: existingTrigger.lastFiredAt }
      : {}),
    ...(existingTrigger?.lastSkippedAt !== undefined
      ? { lastSkippedAt: existingTrigger.lastSkippedAt }
      : {}),
    ...(isScheduledTriggerState(existingTrigger?.lastState)
      ? { lastState: existingTrigger.lastState }
      : {}),
    ...(existingTrigger?.lastStateChangedAt !== undefined
      ? { lastStateChangedAt: existingTrigger.lastStateChangedAt }
      : {}),
  };
};

const normalizeTriggerInput = (
  input: ScheduledJobTriggerInput,
  timestamp: number,
  existingTrigger?: ScheduledJobTrigger,
): ScheduledJobTrigger => {
  const common = normalizeTriggerCommon(input, timestamp, existingTrigger);

  if (input.kind === "time") {
    const schedule = normalizeSchedule(input.schedule, timestamp);
    const nextRunAt = getNextRunAfter(schedule, timestamp);

    return {
      ...common,
      kind: "time",
      schedule,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    };
  }

  const eventType = normalizeText(input.eventType) ?? input.kind;

  return {
    ...common,
    kind: input.kind,
    eventType,
  };
};

const createTimeTriggerInput = (
  schedule: ScheduledJobScheduleInput,
): ScheduledTimeTriggerInput => ({
  kind: "time",
  name: "Time Schedule",
  schedule,
});

const replacePrimaryTimeTrigger = (
  triggers: ScheduledJobTrigger[],
  schedule: ScheduledJobScheduleInput,
  timestamp: number,
): ScheduledJobTrigger[] => {
  const existingTimeTrigger = getPrimaryTimeTrigger(triggers);
  const timeTrigger = normalizeTriggerInput(
    createTimeTriggerInput(schedule),
    timestamp,
    existingTimeTrigger,
  );
  let replaced = false;
  const updatedTriggers = triggers.map((trigger) => {
    if (!replaced && trigger.kind === "time") {
      replaced = true;
      return timeTrigger;
    }

    return trigger;
  });

  return replaced ? updatedTriggers : [timeTrigger, ...updatedTriggers];
};

const normalizeJobTriggers = (
  input: Pick<CreateScheduledJobInput, "schedule" | "triggers">,
  timestamp: number,
  existingJob?: ScheduledJob,
): ScheduledJobTrigger[] => {
  let triggers =
    input.triggers !== undefined
      ? input.triggers.map((triggerInput) => {
          const existingTrigger = existingJob?.triggers.find(
            (trigger) =>
              triggerInput.id !== undefined && trigger.id === triggerInput.id,
          );

          return normalizeTriggerInput(triggerInput, timestamp, existingTrigger);
        })
      : existingJob?.triggers ?? [];

  if (input.schedule) {
    triggers = replacePrimaryTimeTrigger(triggers, input.schedule, timestamp);
  }

  if (triggers.length === 0) {
    throw new Error("Expected scheduled job to include at least one trigger.");
  }

  return triggers;
};

const getJobScheduleSummary = (
  triggers: ScheduledJobTrigger[],
): ScheduledJobSchedule | undefined => {
  return getPrimaryTimeTrigger(triggers)?.schedule;
};

const normalizeContextPack = (
  pack: ScheduledContextPackSnapshot,
): ScheduledContextPackSnapshot | undefined => {
  const name = normalizeText(pack.name);

  if (!name) {
    return undefined;
  }

  const instructions = normalizeMultilineText(pack.instructions);
  const prompt = normalizeMultilineText(pack.prompt);
  const contextPaths = normalizeStringList(pack.contextPaths);

  return {
    name,
    ...(instructions ? { instructions } : {}),
    ...(prompt ? { prompt } : {}),
    ...(contextPaths.length > 0 ? { contextPaths } : {}),
    ...(pack.variableValues ? { variableValues: { ...pack.variableValues } } : {}),
  };
};

const normalizeMacroReference = (
  macro: ScheduledMacroReference,
): ScheduledMacroReference | undefined => {
  const name = normalizeText(macro.name);

  if (!name) {
    return undefined;
  }

  const promptInvocation = normalizeText(macro.promptInvocation);

  return {
    name,
    ...(promptInvocation ? { promptInvocation } : {}),
    ...(macro.inputValues ? { inputValues: { ...macro.inputValues } } : {}),
  };
};

const normalizeRalphFlowScope = (
  value: string | undefined,
  fallback: ScheduledRalphFlowScope,
): ScheduledRalphFlowScope => {
  return value === "user" || value === "workspace" ? value : fallback;
};

const normalizeRalphFlowTarget = (
  target: ScheduledJobTargetInput,
): ScheduledRalphFlowTarget | undefined => {
  if (target.type !== "ralph-flow" && !target.ralphFlow) {
    return undefined;
  }

  const flowId = normalizeTrimmedText(target.ralphFlow?.id);

  if (!flowId) {
    throw new Error("Expected scheduled Ralph target to include a flow id.");
  }

  const maxTransitions = target.ralphFlow?.maxTransitions;

  if (
    maxTransitions !== undefined &&
    (!Number.isInteger(maxTransitions) || maxTransitions < 1)
  ) {
    throw new Error("Expected scheduled Ralph maxTransitions to be an integer >= 1.");
  }

  return {
    scope: normalizeRalphFlowScope(target.ralphFlow?.scope, "workspace"),
    id: flowId,
    params: { ...(target.ralphFlow?.params ?? {}) },
    ...(maxTransitions !== undefined ? { maxTransitions } : {}),
    ...(target.ralphFlow?.runLogScope
      ? { runLogScope: normalizeRalphFlowScope(target.ralphFlow.runLogScope, "workspace") }
      : {}),
    ...(target.ralphFlow?.permissions
      ? {
          permissions: {
            allowedRoots: normalizeStringList(target.ralphFlow.permissions.allowedRoots),
            allowCommands: target.ralphFlow.permissions.allowCommands === true,
            allowWrites: target.ralphFlow.permissions.allowWrites === true,
            allowNetwork: target.ralphFlow.permissions.allowNetwork === true,
            allowMcpTools: target.ralphFlow.permissions.allowMcpTools === true,
          },
        }
      : {}),
  };
};

const normalizeTarget = (target: ScheduledJobTargetInput): ScheduledJobTarget => {
  const workspaceRoot = normalizeTrimmedText(target.workspaceRoot);

  if (!workspaceRoot) {
    throw new Error("Expected scheduled job target to include a workspace root.");
  }

  const ralphFlow = normalizeRalphFlowTarget(target);
  const targetType: ScheduledJobTargetType = ralphFlow ? "ralph-flow" : "prompt";
  const prompt = normalizeMultilineText(target.prompt);
  const contextPacks = (target.contextPacks ?? []).flatMap((pack) => {
    const normalized = normalizeContextPack(pack);

    return normalized ? [normalized] : [];
  });
  const macros = (target.macros ?? []).flatMap((macro) => {
    const normalized = normalizeMacroReference(macro);

    return normalized ? [normalized] : [];
  });

  if (
    targetType === "prompt" &&
    !prompt &&
    contextPacks.length === 0 &&
    macros.length === 0
  ) {
    throw new Error(
      "Expected scheduled job target to include a prompt, context pack, or macro.",
    );
  }

  return {
    type: targetType,
    workspaceRoot,
    prompt,
    contextPaths: normalizeStringList(target.contextPaths),
    imagePaths: normalizeStringList(target.imagePaths),
    contextPacks,
    macros,
    ...(ralphFlow ? { ralphFlow } : {}),
    ...(target.mode ? { mode: target.mode } : {}),
    ...(target.profile ? { profile: target.profile } : {}),
    ...(target.provider ? { provider: target.provider } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.reasoning ? { reasoning: target.reasoning } : {}),
  };
};

const normalizeRetryPolicy = (
  retry: Partial<ScheduledRetryPolicy> | undefined,
): ScheduledRetryPolicy => {
  const minTimeoutMs = normalizePositiveInteger(
    retry?.minTimeoutMs,
    DEFAULT_RETRY_POLICY.minTimeoutMs,
  );
  const maxTimeoutMs = Math.max(
    minTimeoutMs,
    normalizePositiveInteger(
      retry?.maxTimeoutMs,
      DEFAULT_RETRY_POLICY.maxTimeoutMs,
    ),
  );

  return {
    maxAttempts: normalizePositiveInteger(
      retry?.maxAttempts,
      DEFAULT_RETRY_POLICY.maxAttempts,
    ),
    factor: normalizePositiveNumber(retry?.factor, DEFAULT_RETRY_POLICY.factor),
    minTimeoutMs,
    maxTimeoutMs,
    randomize: retry?.randomize ?? DEFAULT_RETRY_POLICY.randomize,
  };
};

const normalizeQueuePolicy = (
  jobId: string,
  queue: Partial<ScheduledQueuePolicy> | undefined,
): ScheduledQueuePolicy => {
  return {
    concurrencyKey: normalizeText(queue?.concurrencyKey) ?? jobId,
    concurrencyLimit: normalizePositiveInteger(
      queue?.concurrencyLimit,
      DEFAULT_CONCURRENCY_LIMIT,
    ),
  };
};

const normalizeMissedRunPolicy = (
  value: ScheduledMissedRunPolicy | undefined,
): ScheduledMissedRunPolicy => {
  return value ?? DEFAULT_MISSED_RUN_POLICY;
};

const isRunModeValue = (value: string | undefined): value is RunMode => {
  return value === "ask" || value === "machdoch";
};

const isConfiguredProviderValue = (
  value: string | undefined,
): value is Exclude<ModelProvider, "unconfigured"> => {
  return value === "openai" || value === "anthropic" || value === "google";
};

const isMissedRunPolicyValue = (
  value: string | undefined,
): value is ScheduledMissedRunPolicy => {
  return value === "skip" || value === "enqueue-latest" || value === "enqueue-all";
};

const getFrontmatterString = (
  attributes: Record<string, FrontmatterValue>,
  key: string,
): string | undefined => {
  const value = attributes[key];

  return typeof value === "string" ? normalizeTrimmedText(value) : undefined;
};

const getFrontmatterBoolean = (
  attributes: Record<string, FrontmatterValue>,
  key: string,
): boolean | undefined => {
  const value = attributes[key];

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }

  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }

  return undefined;
};

const getFrontmatterNumber = (
  attributes: Record<string, FrontmatterValue>,
  key: string,
): number | undefined => {
  const value = attributes[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value.trim());

  return Number.isFinite(parsed) ? parsed : undefined;
};

const getFrontmatterStringList = (
  attributes: Record<string, FrontmatterValue>,
  key: string,
): string[] => {
  const value = attributes[key];

  if (Array.isArray(value)) {
    return normalizeStringList(value);
  }

  if (typeof value === "string") {
    return normalizeStringList(value.split(","));
  }

  return [];
};

const formatContextPathBlock = (paths: string[]): string => {
  if (paths.length === 0) {
    return "";
  }

  if (paths.length === 1) {
    const [path] = paths;

    return path ? `Use this path: "${path}"` : "";
  }

  return ["Use these paths:", ...paths.map((path) => `- path: "${path}"`)].join(
    "\n",
  );
};

const replaceSnapshotVariables = (
  value: string,
  variables: Record<string, string> | undefined,
): string => {
  if (!variables) {
    return value;
  }

  return Object.entries(variables).reduce((current, [key, replacement]) => {
    return current.replaceAll(`{${key}}`, replacement);
  }, value);
};

const formatContextPackSection = (
  pack: ScheduledContextPackSnapshot,
): string => {
  const lines = [`## Context Pack: ${pack.name}`];
  const instructions = replaceSnapshotVariables(
    pack.instructions ?? "",
    pack.variableValues,
  ).trim();
  const prompt = replaceSnapshotVariables(
    pack.prompt ?? "",
    pack.variableValues,
  ).trim();
  const contextPathBlock = formatContextPathBlock(pack.contextPaths ?? []);

  if (instructions) {
    lines.push(`### Instructions\n${instructions}`);
  }

  if (prompt) {
    lines.push(`### Prompt\n${prompt}`);
  }

  if (contextPathBlock) {
    lines.push(`### Context Paths\n${contextPathBlock}`);
  }

  return lines.join("\n\n");
};

const formatMacroSection = (macro: ScheduledMacroReference): string => {
  const lines = [`## Saved Macro: ${macro.name}`];

  if (macro.promptInvocation) {
    lines.push(`Run this saved prompt or macro invocation:\n${macro.promptInvocation}`);
  } else {
    lines.push(`Run the saved macro named "${macro.name}".`);
  }

  if (macro.inputValues && Object.keys(macro.inputValues).length > 0) {
    lines.push(
      [
        "Inputs:",
        ...Object.entries(macro.inputValues).map(
          ([key, value]) => `- ${key}: ${value}`,
        ),
      ].join("\n"),
    );
  }

  return lines.join("\n\n");
};

export const getScheduledJobContextPaths = (job: ScheduledJob): string[] => {
  return normalizeStringList([
    ...job.target.contextPaths,
    ...job.target.contextPacks.flatMap((pack) => pack.contextPaths ?? []),
  ]);
};

export const createScheduledJobTaskText = (job: ScheduledJob): string => {
  if (job.target.type === "ralph-flow") {
    return job.target.prompt.trim();
  }

  const sections = [
    ...job.target.contextPacks.map(formatContextPackSection),
    ...job.target.macros.map(formatMacroSection),
    job.target.prompt,
  ].filter((section) => section.trim().length > 0);
  const contextPathBlock = formatContextPathBlock(job.target.contextPaths);

  if (contextPathBlock) {
    sections.push(contextPathBlock);
  }

  return sections.join("\n\n").trim();
};

const toWorkspaceRelativePath = (
  workspaceRoot: string,
  absolutePath: string,
): string => {
  return relative(workspaceRoot, absolutePath).split("\\").join("/");
};

const walkFiles = async (directoryPath: string): Promise<string[]> => {
  if (!existsSync(directoryPath)) {
    return [];
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }

      return [fullPath];
    }),
  );

  return files.flat();
};

const derivePromptName = (
  filePath: string,
  attributes: Record<string, FrontmatterValue>,
): string => {
  const configuredName = getFrontmatterString(attributes, "name");

  if (configuredName) {
    return configuredName;
  }

  const fileName = basename(filePath);

  return fileName.endsWith(".prompt.md")
    ? fileName.slice(0, -".prompt.md".length)
    : fileName;
};

const parsePromptSchedule = (
  attributes: Record<string, FrontmatterValue>,
  warnings: string[],
): ScheduledJobScheduleInput | undefined => {
  const scheduleValue = attributes.schedule;
  const cron =
    getFrontmatterString(attributes, "schedule-cron") ??
    (typeof scheduleValue === "string" && scheduleValue.trim().includes(" ")
      ? scheduleValue.trim()
      : undefined);
  const timezone = getFrontmatterString(attributes, "schedule-timezone");

  if (cron) {
    return {
      type: "cron",
      expression: cron,
      ...(timezone ? { timezone } : {}),
    };
  }

  const intervalMs = getFrontmatterNumber(attributes, "schedule-interval-ms");
  const anchorAt = getFrontmatterNumber(attributes, "schedule-anchor-at");

  if (intervalMs !== undefined) {
    return {
      type: "interval",
      intervalMs,
      ...(anchorAt !== undefined ? { anchorAt } : {}),
    };
  }

  const delayMs = getFrontmatterNumber(attributes, "schedule-delay-ms");
  const runAt = getFrontmatterNumber(attributes, "schedule-run-at");

  if (delayMs !== undefined || runAt !== undefined) {
    return {
      type: "delay",
      ...(delayMs !== undefined ? { delayMs } : {}),
      ...(runAt !== undefined ? { runAt } : {}),
    };
  }

  warnings.push(
    "Missing schedule-cron, schedule-interval-ms, or schedule-delay-ms/schedule-run-at.",
  );
  return undefined;
};

const parsePromptScheduleInput = async (
  workspaceRoot: string,
  filePath: string,
): Promise<ScheduledPromptDefinition> => {
  const relativePath = toWorkspaceRelativePath(workspaceRoot, filePath);
  const warnings: string[] = [];

  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return {
      path: relativePath,
      name: basename(filePath),
      enabled: false,
      warnings: ["Prompt file was not readable."],
    };
  }

  const document = parseMarkdownDocument(content);
  const promptName = derivePromptName(filePath, document.attributes);
  const enabled =
    getFrontmatterBoolean(document.attributes, "schedule-enabled") ??
    getFrontmatterBoolean(document.attributes, "schedule") ??
    false;
  const schedule = parsePromptSchedule(document.attributes, warnings);

  if (!enabled || !schedule) {
    return {
      path: relativePath,
      name: promptName,
      enabled,
      warnings,
    };
  }

  const modeText = getFrontmatterString(document.attributes, "schedule-mode");
  const providerText = getFrontmatterString(
    document.attributes,
    "schedule-provider",
  );
  const missedRunPolicyText = getFrontmatterString(
    document.attributes,
    "schedule-missed-run-policy",
  );
  const scheduleArguments =
    getFrontmatterString(document.attributes, "schedule-arguments") ?? "";
  const promptInvocation = `/${promptName}${scheduleArguments ? ` ${scheduleArguments}` : ""}`;
  const missedRunPolicy = isMissedRunPolicyValue(missedRunPolicyText)
    ? missedRunPolicyText
    : undefined;
  const profile = getFrontmatterString(document.attributes, "schedule-profile");
  const model = getFrontmatterString(document.attributes, "schedule-model");
  const missedRunGraceMs = getFrontmatterNumber(
    document.attributes,
    "schedule-missed-run-grace-ms",
  );
  const retryAttempts = getFrontmatterNumber(
    document.attributes,
    "schedule-retry-attempts",
  );
  const retryMinMs = getFrontmatterNumber(
    document.attributes,
    "schedule-retry-min-ms",
  );
  const retryMaxMs = getFrontmatterNumber(
    document.attributes,
    "schedule-retry-max-ms",
  );
  const retryFactor = getFrontmatterNumber(
    document.attributes,
    "schedule-retry-factor",
  );
  const retryRandomize = getFrontmatterBoolean(
    document.attributes,
    "schedule-retry-randomize",
  );
  const concurrencyKey = getFrontmatterString(
    document.attributes,
    "schedule-queue-key",
  );
  const concurrencyLimit = getFrontmatterNumber(
    document.attributes,
    "schedule-concurrency-limit",
  );
  const ttlMs = getFrontmatterNumber(document.attributes, "schedule-ttl-ms");
  const maxDurationMs = getFrontmatterNumber(
    document.attributes,
    "schedule-max-duration-ms",
  );
  const historyLimit = getFrontmatterNumber(
    document.attributes,
    "schedule-history-limit",
  );
  const maxCatchUpRuns = getFrontmatterNumber(
    document.attributes,
    "schedule-max-catch-up-runs",
  );

  if (missedRunPolicyText && !missedRunPolicy) {
    warnings.push(
      `Unsupported missed-run policy \`${missedRunPolicyText}\`; using the default.`,
    );
  }

  const input: CreateScheduledJobInput = {
    name:
      getFrontmatterString(document.attributes, "schedule-name") ??
      `Prompt: ${promptName}`,
    schedule,
    target: {
      workspaceRoot,
      prompt: promptInvocation,
      contextPaths: getFrontmatterStringList(
        document.attributes,
        "schedule-context",
      ),
      imagePaths: getFrontmatterStringList(
        document.attributes,
        "schedule-image",
      ),
      ...(isRunModeValue(modeText) ? { mode: modeText } : {}),
      ...(profile ? { profile } : {}),
      ...(isConfiguredProviderValue(providerText)
        ? { provider: providerText }
        : {}),
      ...(model ? { model } : {}),
    },
    dedupeKey:
      getFrontmatterString(document.attributes, "schedule-dedupe-key") ??
      `prompt:${relativePath}`,
    ...(missedRunPolicy ? { missedRunPolicy } : {}),
    ...(missedRunGraceMs !== undefined ? { missedRunGraceMs } : {}),
    retry: {
      ...(retryAttempts !== undefined ? { maxAttempts: retryAttempts } : {}),
      ...(retryMinMs !== undefined ? { minTimeoutMs: retryMinMs } : {}),
      ...(retryMaxMs !== undefined ? { maxTimeoutMs: retryMaxMs } : {}),
      ...(retryFactor !== undefined ? { factor: retryFactor } : {}),
      ...(retryRandomize !== undefined ? { randomize: retryRandomize } : {}),
    },
    queue: {
      ...(concurrencyKey ? { concurrencyKey } : {}),
      ...(concurrencyLimit !== undefined ? { concurrencyLimit } : {}),
    },
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(historyLimit !== undefined ? { historyLimit } : {}),
    ...(maxCatchUpRuns !== undefined ? { maxCatchUpRuns } : {}),
  };

  return {
    path: relativePath,
    name: promptName,
    enabled,
    input,
    warnings,
  };
};

export const discoverScheduledPromptDefinitions = async (
  workspaceRoot: string,
): Promise<ScheduledPromptDefinition[]> => {
  const promptPaths = (await walkFiles(join(workspaceRoot, ".machdoch", "prompts")))
    .filter((filePath) => filePath.endsWith(".prompt.md"))
    .sort();

  return Promise.all(
    promptPaths.map((filePath) => parsePromptScheduleInput(workspaceRoot, filePath)),
  );
};

export const syncScheduledPromptJobs = async (
  scheduler: DurableSmartScheduler,
  workspaceRoot: string,
): Promise<ScheduledPromptSyncResult> => {
  const discovered = await discoverScheduledPromptDefinitions(workspaceRoot);
  const syncedJobs: ScheduledJob[] = [];
  const enabledPromptDedupeKeys = new Set<string>();

  for (const definition of discovered) {
    if (!definition.enabled || !definition.input) {
      continue;
    }

    const job = await scheduler.upsertJob(definition.input);

    syncedJobs.push(job);
    if (job.dedupeKey) {
      enabledPromptDedupeKeys.add(job.dedupeKey);
    }
  }

  const pausedJobs: ScheduledJob[] = [];
  const jobs = await scheduler.listJobs();

  for (const job of jobs) {
    if (
      job.dedupeKey?.startsWith("prompt:") &&
      !enabledPromptDedupeKeys.has(job.dedupeKey) &&
      job.status !== "paused"
    ) {
      pausedJobs.push(await scheduler.pauseJob(job.id));
    }
  }

  return {
    workspaceRoot,
    discovered,
    syncedJobs,
    pausedJobs,
  };
};

const createRunDedupeKey = (
  job: ScheduledJob,
  scheduledFor: number,
  suffix?: string,
): string | undefined => {
  if (suffix) {
    return `${job.dedupeKey ?? job.id}:${suffix}`;
  }

  return job.dedupeKey ? `${job.dedupeKey}:${scheduledFor}` : undefined;
};

const createRun = (
  job: ScheduledJob,
  status: ScheduledRunStatus,
  scheduledFor: number,
  enqueuedAt: number,
  source: ScheduledRunSource,
  options: {
    triggerId?: string;
    eventId?: string;
    parentRunId?: string;
    dedupeSuffix?: string;
  } = {},
): ScheduledJobRun => {
  const dedupeKey = createRunDedupeKey(job, scheduledFor, options.dedupeSuffix);
  const expiresAt = job.ttlMs ? enqueuedAt + job.ttlMs : undefined;

  return {
    id: createRunId(),
    jobId: job.id,
    ...(options.triggerId ? { triggerId: options.triggerId } : {}),
    ...(options.eventId ? { eventId: options.eventId } : {}),
    source,
    status,
    scheduledFor,
    enqueuedAt,
    updatedAt: enqueuedAt,
    attempt: 0,
    maxAttempts: job.retry.maxAttempts,
    queueKey: job.queue.concurrencyKey,
    concurrencyLimit: job.queue.concurrencyLimit,
    attemptHistory: [],
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
};

const isTerminalRunStatus = (status: ScheduledRunStatus): boolean => {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "expired" ||
    status === "skipped"
  );
};

const hasExistingScheduledRun = (
  state: SmartSchedulerState,
  jobId: string,
  triggerId: string | undefined,
  scheduledFor: number,
): ScheduledJobRun | undefined => {
  return state.runs.find(
    (run) =>
      run.jobId === jobId &&
      run.source === "schedule" &&
      run.triggerId === triggerId &&
      run.scheduledFor === scheduledFor,
  );
};

const findExistingRunByDedupeKey = (
  state: SmartSchedulerState,
  dedupeKey: string | undefined,
): ScheduledJobRun | undefined => {
  if (!dedupeKey) {
    return undefined;
  }

  return state.runs.find((run) => run.dedupeKey === dedupeKey);
};

const createRunHandle = (run: Pick<ScheduledJobRun, "jobId" | "id">): ScheduledRunHandle => ({
  jobId: run.jobId,
  runId: run.id,
});

const resolveRunId = (handleOrRunId: ScheduledRunHandle | string): string => {
  return typeof handleOrRunId === "string" ? handleOrRunId : handleOrRunId.runId;
};

const unrefTimer = (handle: ReturnType<typeof setTimeout>): void => {
  const candidate = handle as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };

  candidate.unref?.();
};

const createSchedulerTimeoutReason = (maxDurationMs: number): string => {
  return `${SCHEDULER_TIMEOUT_REASON_PREFIX} of ${maxDurationMs}ms.`;
};

const attachMaxDurationTimer = (
  controller: AbortController,
  maxDurationMs: number | undefined,
): (() => void) => {
  if (maxDurationMs === undefined) {
    return () => undefined;
  }

  const timeoutHandle = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(createSchedulerTimeoutReason(maxDurationMs));
    }
  }, maxDurationMs);
  unrefTimer(timeoutHandle);

  return () => clearTimeout(timeoutHandle);
};

const isTimeoutReason = (value: unknown): boolean => {
  return typeof value === "string" && value.startsWith(SCHEDULER_TIMEOUT_REASON_PREFIX);
};

const getNextRunAfter = (
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
      const intervalsElapsed = elapsed < 0 ? 0 : Math.floor(elapsed / schedule.intervalMs) + 1;

      return schedule.anchorAt + intervalsElapsed * schedule.intervalMs;
    }
    case "delay":
      return schedule.runAt > afterTimestamp ? schedule.runAt : undefined;
  }
};

const collectDueRunTimes = (
  job: ScheduledJob,
  now: number,
): {
  dueTimes: Array<{ triggerId: string; scheduledFor: number }>;
  nextRunAt?: number;
} => {
  const dueTimes: Array<{ triggerId: string; scheduledFor: number }> = [];
  const nextRunCandidates: number[] = [];

  for (const trigger of job.triggers) {
    if (trigger.kind !== "time" || !trigger.enabled) {
      continue;
    }

    let nextRunAt =
      trigger.nextRunAt ?? getNextRunAfter(trigger.schedule, job.createdAt);

    while (
      nextRunAt !== undefined &&
      nextRunAt <= now &&
      dueTimes.length < job.maxCatchUpRuns
    ) {
      dueTimes.push({
        triggerId: trigger.id,
        scheduledFor: nextRunAt,
      });
      nextRunAt = getNextRunAfter(trigger.schedule, nextRunAt);
    }

    if (nextRunAt !== undefined) {
      trigger.nextRunAt = nextRunAt;
      nextRunCandidates.push(nextRunAt);
    } else {
      delete trigger.nextRunAt;
    }
  }

  const nextRunAt = nextRunCandidates.sort((left, right) => left - right)[0];

  return {
    dueTimes,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
  };
};

const pruneRunHistory = (state: SmartSchedulerState): void => {
  const retainedRuns = new Set<string>();

  for (const job of state.jobs) {
    const jobRuns = state.runs.filter((run) => run.jobId === job.id);
    const nonTerminalRuns = jobRuns.filter(
      (run) => !isTerminalRunStatus(run.status),
    );
    const terminalRuns = jobRuns
      .filter((run) => isTerminalRunStatus(run.status))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, job.historyLimit);

    for (const run of [...nonTerminalRuns, ...terminalRuns]) {
      retainedRuns.add(run.id);
    }
  }

  state.runs = state.runs.filter((run) => retainedRuns.has(run.id));
  state.events = state.events
    .sort((left, right) => right.receivedAt - left.receivedAt)
    .slice(0, DEFAULT_EVENT_HISTORY_LIMIT);
};

const errorToMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const taskResultSucceeded = (result: TaskExecutionResult): boolean => {
  return result.status === "executed" || result.status === "planned";
};

const taskResultCancelled = (result: TaskExecutionResult): boolean => {
  return result.status === "cancelled";
};

const getRetryDelayMs = (
  retry: ScheduledRetryPolicy,
  completedAttempt: number,
  rng: () => number,
): number => {
  const baseDelay = Math.min(
    retry.maxTimeoutMs,
    Math.round(retry.minTimeoutMs * retry.factor ** Math.max(0, completedAttempt - 1)),
  );

  if (!retry.randomize) {
    return baseDelay;
  }

  return Math.max(1, Math.round(baseDelay * (0.5 + rng() * 0.5)));
};

const countRunningRunsByQueue = (
  state: SmartSchedulerState,
): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const run of state.runs) {
    if (run.status !== "running") {
      continue;
    }

    counts.set(run.queueKey, (counts.get(run.queueKey) ?? 0) + 1);
  }

  return counts;
};

const normalizeEventPayload = (
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  return cloneRecord(payload) ?? {};
};

const normalizeTriggerEventInput = (
  input: ScheduledTriggerEventInput,
  timestamp: number,
): ScheduledTriggerEvent => {
  const type = normalizeText(input.type);

  if (!type) {
    throw new Error("Expected scheduler event to include a type.");
  }

  const source = normalizeText(input.source) ?? "manual";
  const workspaceRoot = normalizeTrimmedText(input.workspaceRoot);
  const dedupeKey = normalizeText(input.dedupeKey);
  const occurredAt =
    typeof input.occurredAt === "number" && Number.isFinite(input.occurredAt)
      ? Math.trunc(input.occurredAt)
      : timestamp;
  const kind = input.kind ?? inferEventTriggerKind(type);

  return {
    id: createEventId(),
    type,
    kind,
    source,
    payload: normalizeEventPayload(input.payload),
    occurredAt,
    receivedAt: timestamp,
    matches: [],
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
  };
};

const getPathValue = (
  record: Record<string, unknown>,
  path: string,
): unknown => {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!isRecordValue(current)) {
      return undefined;
    }

    return current[part];
  }, record);
};

const matchStringPattern = (value: string, pattern: string): boolean => {
  if (pattern === "*") {
    return true;
  }

  if (!pattern.includes("*")) {
    return value === pattern;
  }

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");

  return new RegExp(`^${escaped}$`, "u").test(value);
};

const eventTypeMatches = (
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
): boolean => {
  if (trigger.kind !== event.kind) {
    return false;
  }

  if (trigger.eventType === "*" || trigger.eventType === event.type) {
    return true;
  }

  return matchStringPattern(event.type, trigger.eventType);
};

const coerceFilterNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const compareFilterNumbers = (
  actual: unknown,
  expected: unknown,
  predicate: (left: number, right: number) => boolean,
): boolean => {
  const actualNumber = coerceFilterNumber(actual);
  const expectedNumber = coerceFilterNumber(expected);

  return (
    actualNumber !== undefined &&
    expectedNumber !== undefined &&
    predicate(actualNumber, expectedNumber)
  );
};

const filterExpressionMatches = (
  actual: unknown,
  expression: Record<string, unknown>,
): boolean => {
  const operator = normalizeText(
    typeof expression.op === "string"
      ? expression.op
      : typeof expression.operator === "string"
        ? expression.operator
        : undefined,
  )?.toLowerCase();
  const expected =
    "value" in expression
      ? expression.value
      : "threshold" in expression
        ? expression.threshold
        : "equals" in expression
          ? expression.equals
          : undefined;

  switch (operator) {
    case ">":
    case "gt":
      return compareFilterNumbers(actual, expected, (left, right) => left > right);
    case ">=":
    case "gte":
      return compareFilterNumbers(actual, expected, (left, right) => left >= right);
    case "<":
    case "lt":
      return compareFilterNumbers(actual, expected, (left, right) => left < right);
    case "<=":
    case "lte":
      return compareFilterNumbers(actual, expected, (left, right) => left <= right);
    case "!=":
    case "neq":
    case "not":
      return !filterValueMatches(actual, expected);
    case "=":
    case "==":
    case "eq":
      return filterValueMatches(actual, expected);
    case "contains":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.includes(expected)
      );
    case "startswith":
    case "prefix":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.startsWith(expected)
      );
    case "endswith":
    case "suffix":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.endsWith(expected)
      );
    case "matches":
    case "pattern":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        matchStringPattern(actual, expected)
      );
    case "exists":
      return expression.value === false
        ? actual === undefined || actual === null
        : actual !== undefined && actual !== null;
    default:
      if (
        "min" in expression &&
        !compareFilterNumbers(actual, expression.min, (left, right) => left >= right)
      ) {
        return false;
      }

      if (
        "max" in expression &&
        !compareFilterNumbers(actual, expression.max, (left, right) => left <= right)
      ) {
        return false;
      }

      return expected !== undefined ? filterValueMatches(actual, expected) : false;
  }
};

const filterValueMatches = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) {
    return expected.some((entry) => filterValueMatches(actual, entry));
  }

  if (isRecordValue(expected)) {
    return filterExpressionMatches(actual, expected);
  }

  if (typeof expected === "string") {
    return typeof actual === "string" && matchStringPattern(actual, expected);
  }

  return Object.is(actual, expected);
};

const createEventFilterRecord = (
  event: ScheduledTriggerEvent,
): Record<string, unknown> => ({
  type: event.type,
  kind: event.kind,
  source: event.source,
  workspaceRoot: event.workspaceRoot,
  payload: event.payload,
});

const eventFilterRecordMatches = (
  filters: Record<string, unknown> | undefined,
  event: ScheduledTriggerEvent,
): boolean => {
  if (!filters || Object.keys(filters).length === 0) {
    return true;
  }

  const eventRecord = createEventFilterRecord(event);

  return Object.entries(filters).every(([path, expected]) => {
    return filterValueMatches(getPathValue(eventRecord, path), expected);
  });
};

const eventFiltersMatch = (
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
): boolean => eventFilterRecordMatches(trigger.filters, event);

const renderDedupeTemplate = (
  template: string,
  job: ScheduledJob,
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
): string => {
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/gu, (_match, path: string) => {
    const record: Record<string, unknown> = {
      jobId: job.id,
      triggerId: trigger.id,
      eventId: event.id,
      eventType: event.type,
      eventDedupeKey: event.dedupeKey,
      source: event.source,
      workspaceRoot: event.workspaceRoot,
      payload: event.payload,
    };
    const value = getPathValue(record, path);

    return value === undefined || value === null ? "" : String(value);
  });
};

const createEventRunDedupeSuffix = (
  job: ScheduledJob,
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
): string => {
  const baseSuffix = trigger.dedupeKeyTemplate
    ? renderDedupeTemplate(trigger.dedupeKeyTemplate, job, trigger, event)
    : `${trigger.id}:${event.dedupeKey ?? event.id}`;

  if (getTriggerFiringMode(trigger) !== "state") {
    return baseSuffix;
  }

  const repeatIntervalMs = getStatefulTriggerRepeatIntervalMs(trigger);
  const stateStartedAt = trigger.lastStateChangedAt ?? event.receivedAt;
  const repeatBucket = Math.max(
    0,
    Math.floor((event.receivedAt - stateStartedAt) / repeatIntervalMs),
  );

  return `${baseSuffix}:state:${stateStartedAt}:${repeatBucket}`;
};

const getTriggerFiringMode = (
  trigger: ScheduledEventTrigger,
): ScheduledTriggerFiringMode => trigger.firingMode ?? "event";

const getStatefulTriggerRepeatIntervalMs = (
  trigger: ScheduledEventTrigger,
): number =>
  trigger.repeatIntervalMs ??
  trigger.cooldownMs ??
  DEFAULT_STATEFUL_TRIGGER_REPEAT_MS;

const getTriggerRecoveryMatched = (
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
  activationMatched: boolean,
): boolean => {
  if (trigger.recoveryFilters) {
    return eventFilterRecordMatches(trigger.recoveryFilters, event);
  }

  return !activationMatched;
};

const getStatefulTriggerSkipReason = (
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
): string | undefined => {
  if (getTriggerFiringMode(trigger) !== "state") {
    return undefined;
  }

  if (trigger.lastState !== "active" || trigger.lastFiredAt === undefined) {
    return undefined;
  }

  const repeatIntervalMs = getStatefulTriggerRepeatIntervalMs(trigger);

  if (event.receivedAt - trigger.lastFiredAt >= repeatIntervalMs) {
    return undefined;
  }

  return `Skipped while stateful trigger remains active; next repeat is allowed after ${repeatIntervalMs}ms.`;
};

const getTriggerCooldownSkipReason = (
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
): string | undefined => {
  if (
    trigger.cooldownMs === undefined ||
    trigger.lastFiredAt === undefined ||
    event.receivedAt - trigger.lastFiredAt >= trigger.cooldownMs
  ) {
    return undefined;
  }

  return `Skipped by trigger cooldown of ${trigger.cooldownMs}ms.`;
};

const getTriggerRateLimitSkipReason = (
  state: SmartSchedulerState,
  trigger: ScheduledEventTrigger,
  event: ScheduledTriggerEvent,
): string | undefined => {
  if (!trigger.maxEventsPerWindow) {
    return undefined;
  }

  const windowStartedAt = event.receivedAt - trigger.maxEventsPerWindow.windowMs;
  const firedEvents = state.events.reduce((count, candidate) => {
    if (
      candidate.receivedAt < windowStartedAt ||
      candidate.receivedAt > event.receivedAt
    ) {
      return count;
    }

    return (
      count +
      candidate.matches.filter(
        (match) =>
          match.triggerId === trigger.id &&
          match.matched &&
          match.deduplicated !== true,
      ).length
    );
  }, 0);

  if (firedEvents < trigger.maxEventsPerWindow.maxEvents) {
    return undefined;
  }

  return `Skipped by trigger rate limit of ${trigger.maxEventsPerWindow.maxEvents} event(s) per ${trigger.maxEventsPerWindow.windowMs}ms.`;
};

export class DurableSmartScheduler {
  private readonly statePath: string;
  private readonly executor: ScheduledTaskExecutor | undefined;
  private readonly clock: SchedulerClock;
  private readonly rng: () => number;
  private stateMutation: Promise<void> = Promise.resolve();
  private readonly activeRunControllers = new Map<string, AbortController>();

  constructor(options: DurableSmartSchedulerOptions) {
    this.statePath = options.statePath;
    this.executor = options.executor;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.rng = options.rng ?? Math.random;
  }

  private now(): number {
    return Math.trunc(this.clock.now());
  }

  private async mutateState<T>(
    mutator: (state: SmartSchedulerState) => T | Promise<T>,
  ): Promise<T> {
    const mutation = this.stateMutation.then(async () => {
      return withSchedulerStateLock(this.statePath, async () => {
        const state = await readSmartSchedulerState(this.statePath);
        const result = await mutator(state);

        state.updatedAt = this.now();
        pruneRunHistory(state);
        await writeSmartSchedulerStateUnlocked(this.statePath, state);

        return result;
      });
    });

    this.stateMutation = mutation.then(
      () => undefined,
      () => undefined,
    );

    return mutation;
  }

  async getState(): Promise<SmartSchedulerState> {
    return withSchedulerStateLock(this.statePath, () =>
      readSmartSchedulerState(this.statePath),
    );
  }

  async upsertJob(input: CreateScheduledJobInput): Promise<ScheduledJob> {
    return this.mutateState((state) => {
      const now = this.now();
      const dedupeKey = normalizeText(input.dedupeKey);
      const existingJob = dedupeKey
        ? state.jobs.find(
            (job) => job.dedupeKey === dedupeKey && job.status !== "deleted",
          )
        : undefined;
      const id = existingJob?.id ?? createJobId();
      const triggers = normalizeJobTriggers(input, now, existingJob);
      const schedule = getJobScheduleSummary(triggers);
      const target = normalizeTarget(input.target);
      const retry = normalizeRetryPolicy(input.retry);
      const queue = normalizeQueuePolicy(id, input.queue);
      const nextRunAt = getEarliestTriggerRunAt(triggers);
      const name =
        normalizeText(input.name) ??
        existingJob?.name ??
        normalizeTrimmedText(target.prompt.split(/\r?\n/u)[0]?.slice(0, 80)) ??
        "Scheduled job";
      const ttlMs = normalizeOptionalPositiveInteger(input.ttlMs);
      const maxDurationMs = normalizeOptionalPositiveInteger(input.maxDurationMs);
      const job: ScheduledJob = {
        id,
        name,
        status: "active",
        ...(schedule ? { schedule } : {}),
        triggers,
        target,
        missedRunPolicy: normalizeMissedRunPolicy(input.missedRunPolicy),
        missedRunGraceMs: normalizePositiveInteger(
          input.missedRunGraceMs,
          DEFAULT_MISSED_RUN_GRACE_MS,
        ),
        retry,
        queue,
        historyLimit: normalizePositiveInteger(
          input.historyLimit,
          DEFAULT_HISTORY_LIMIT,
        ),
        maxCatchUpRuns: normalizePositiveInteger(
          input.maxCatchUpRuns,
          DEFAULT_MAX_CATCH_UP_RUNS,
        ),
        createdAt: existingJob?.createdAt ?? now,
        updatedAt: now,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(dedupeKey ? { dedupeKey } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
        ...(existingJob?.lastEnqueuedAt !== undefined
          ? { lastEnqueuedAt: existingJob.lastEnqueuedAt }
          : {}),
        ...(existingJob?.lastStartedAt !== undefined
          ? { lastStartedAt: existingJob.lastStartedAt }
          : {}),
        ...(existingJob?.lastFinishedAt !== undefined
          ? { lastFinishedAt: existingJob.lastFinishedAt }
          : {}),
      };

      if (existingJob) {
        state.jobs = state.jobs.map((candidate) =>
          candidate.id === existingJob.id ? job : candidate,
        );
      } else {
        state.jobs.push(job);
      }

      return job;
    });
  }

  async updateJob(
    jobId: string,
    input: UpdateScheduledJobInput,
  ): Promise<ScheduledJob> {
    return this.mutateState((state) => {
      const now = this.now();
      const existingJob = state.jobs.find(
        (candidate) => candidate.id === jobId,
      );

      if (!existingJob || existingJob.status === "deleted") {
        throw new Error(`Scheduled job not found: ${jobId}`);
      }

      const targetInput: ScheduledJobTargetInput = {
        workspaceRoot:
          input.target?.workspaceRoot ?? existingJob.target.workspaceRoot,
        prompt: input.target?.prompt ?? existingJob.target.prompt,
        contextPaths:
          input.target?.contextPaths ?? existingJob.target.contextPaths,
        imagePaths: input.target?.imagePaths ?? existingJob.target.imagePaths,
        contextPacks:
          input.target?.contextPacks ?? existingJob.target.contextPacks,
        macros: input.target?.macros ?? existingJob.target.macros,
        ...(input.target?.mode ?? existingJob.target.mode
          ? { mode: input.target?.mode ?? existingJob.target.mode }
          : {}),
        ...(input.target?.profile ?? existingJob.target.profile
          ? { profile: input.target?.profile ?? existingJob.target.profile }
          : {}),
        ...(input.target?.provider ?? existingJob.target.provider
          ? { provider: input.target?.provider ?? existingJob.target.provider }
          : {}),
        ...(input.target?.model ?? existingJob.target.model
          ? { model: input.target?.model ?? existingJob.target.model }
          : {}),
        ...(input.target?.reasoning ?? existingJob.target.reasoning
          ? { reasoning: input.target?.reasoning ?? existingJob.target.reasoning }
          : {}),
      };
      const triggers =
        input.triggers !== undefined || input.schedule !== undefined
          ? normalizeJobTriggers(
              {
                ...(input.schedule ? { schedule: input.schedule } : {}),
                ...(input.triggers ? { triggers: input.triggers } : {}),
              },
              now,
              existingJob,
            )
          : existingJob.triggers;
      const schedule = getJobScheduleSummary(triggers);
      const target = normalizeTarget(targetInput);
      const nextRunAt = getEarliestTriggerRunAt(triggers);
      const dedupeKey = normalizeText(input.dedupeKey) ?? existingJob.dedupeKey;
      const ttlMs =
        input.ttlMs !== undefined
          ? normalizeOptionalPositiveInteger(input.ttlMs)
          : existingJob.ttlMs;
      const maxDurationMs =
        input.maxDurationMs !== undefined
          ? normalizeOptionalPositiveInteger(input.maxDurationMs)
          : existingJob.maxDurationMs;
      const updatedJob: ScheduledJob = {
        id: existingJob.id,
        name: normalizeText(input.name) ?? existingJob.name,
        status:
          existingJob.status === "completed" && triggers.length > 0
            ? "active"
            : existingJob.status,
        ...(schedule ? { schedule } : {}),
        triggers,
        target,
        missedRunPolicy:
          input.missedRunPolicy ?? existingJob.missedRunPolicy,
        missedRunGraceMs:
          input.missedRunGraceMs !== undefined
            ? normalizePositiveInteger(
                input.missedRunGraceMs,
                existingJob.missedRunGraceMs,
              )
            : existingJob.missedRunGraceMs,
        retry: input.retry
          ? normalizeRetryPolicy({ ...existingJob.retry, ...input.retry })
          : existingJob.retry,
        queue: input.queue
          ? normalizeQueuePolicy(existingJob.id, {
              ...existingJob.queue,
              ...input.queue,
            })
          : existingJob.queue,
        historyLimit:
          input.historyLimit !== undefined
            ? normalizePositiveInteger(input.historyLimit, existingJob.historyLimit)
            : existingJob.historyLimit,
        maxCatchUpRuns:
          input.maxCatchUpRuns !== undefined
            ? normalizePositiveInteger(
                input.maxCatchUpRuns,
                existingJob.maxCatchUpRuns,
              )
            : existingJob.maxCatchUpRuns,
        createdAt: existingJob.createdAt,
        updatedAt: now,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(dedupeKey ? { dedupeKey } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
        ...(existingJob.lastEnqueuedAt !== undefined
          ? { lastEnqueuedAt: existingJob.lastEnqueuedAt }
          : {}),
        ...(existingJob.lastStartedAt !== undefined
          ? { lastStartedAt: existingJob.lastStartedAt }
          : {}),
        ...(existingJob.lastFinishedAt !== undefined
          ? { lastFinishedAt: existingJob.lastFinishedAt }
          : {}),
      };

      state.jobs = state.jobs.map((candidate) =>
        candidate.id === existingJob.id ? updatedJob : candidate,
      );

      return updatedJob;
    });
  }

  async listJobs(): Promise<ScheduledJob[]> {
    const state = await this.getState();

    return state.jobs.filter((job) => job.status !== "deleted");
  }

  async getJob(jobId: string): Promise<ScheduledJob | undefined> {
    const state = await this.getState();

    return state.jobs.find((job) => job.id === jobId && job.status !== "deleted");
  }

  async pauseJob(jobId: string): Promise<ScheduledJob> {
    return this.setJobStatus(jobId, "paused");
  }

  async resumeJob(jobId: string): Promise<ScheduledJob> {
    return this.mutateState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);

      if (!job || job.status === "deleted") {
        throw new Error(`Scheduled job not found: ${jobId}`);
      }

      job.status = "active";
      job.updatedAt = this.now();
      const now = this.now();
      const nextRunAtCandidates: number[] = [];

      for (const trigger of job.triggers) {
        if (trigger.kind !== "time" || !trigger.enabled) {
          continue;
        }

        const nextRunAt = getNextRunAfter(trigger.schedule, now);

        if (nextRunAt !== undefined) {
          trigger.nextRunAt = nextRunAt;
          nextRunAtCandidates.push(nextRunAt);
        } else {
          delete trigger.nextRunAt;
        }
      }

      const nextRunAt = nextRunAtCandidates.sort((left, right) => left - right)[0];

      if (nextRunAt !== undefined) {
        job.nextRunAt = nextRunAt;
      } else {
        delete job.nextRunAt;
        const hasEventTrigger = job.triggers.some(
          (trigger) => trigger.kind !== "time" && trigger.enabled,
        );

        if (!hasEventTrigger) {
          job.status = "completed";
        }
      }

      return { ...job };
    });
  }

  async deleteJob(jobId: string): Promise<ScheduledJob> {
    return this.setJobStatus(jobId, "deleted");
  }

  private async setJobStatus(
    jobId: string,
    status: ScheduledJobStatus,
  ): Promise<ScheduledJob> {
    return this.mutateState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);

      if (!job || job.status === "deleted") {
        throw new Error(`Scheduled job not found: ${jobId}`);
      }

      job.status = status;
      job.updatedAt = this.now();

      return { ...job };
    });
  }

  async enqueueDueRuns(): Promise<ScheduledRunEnqueueResult[]> {
    return this.mutateState((state) => {
      const now = this.now();
      const enqueueResults: ScheduledRunEnqueueResult[] = [];

      for (const job of state.jobs) {
        if (job.status !== "active") {
          continue;
        }

        const { dueTimes, nextRunAt } = collectDueRunTimes(job, now);
        const scheduleSummary = getJobScheduleSummary(job.triggers);

        if (scheduleSummary) {
          job.schedule = scheduleSummary;
        } else {
          delete job.schedule;
        }

        if (nextRunAt !== undefined) {
          job.nextRunAt = nextRunAt;
        } else {
          delete job.nextRunAt;
        }

        if (dueTimes.length === 0) {
          continue;
        }

        const { enqueueTimes, skippedTimes } = splitDueTimesByMissedPolicy(
          job,
          dueTimes,
          now,
        );

        for (const skippedTime of skippedTimes) {
          const existingRun = hasExistingScheduledRun(
            state,
            job.id,
            skippedTime.triggerId,
            skippedTime.scheduledFor,
          );

          if (existingRun) {
            continue;
          }

          const skippedRun = createRun(
            job,
            "skipped",
            skippedTime.scheduledFor,
            now,
            "schedule",
            { triggerId: skippedTime.triggerId },
          );

          skippedRun.finishedAt = now;
          skippedRun.error = "Skipped by missed-run policy.";
          state.runs.push(skippedRun);
        }

        for (const enqueueTime of enqueueTimes) {
          const existingRun = hasExistingScheduledRun(
            state,
            job.id,
            enqueueTime.triggerId,
            enqueueTime.scheduledFor,
          );

          if (existingRun) {
            enqueueResults.push({
              handle: createRunHandle(existingRun),
              run: { ...existingRun },
              deduplicated: true,
            });
            continue;
          }

          const run = createRun(
            job,
            "queued",
            enqueueTime.scheduledFor,
            now,
            "schedule",
            { triggerId: enqueueTime.triggerId },
          );

          job.lastEnqueuedAt = now;
          enqueueResults.push({
            handle: createRunHandle(run),
            run: { ...run },
            deduplicated: false,
          });
          state.runs.push(run);
        }

        const hasEnabledRepeatingTimeTrigger = job.triggers.some(
          (trigger) =>
            trigger.kind === "time" &&
            trigger.enabled &&
            trigger.schedule.type !== "delay",
        );

        if (!hasEnabledRepeatingTimeTrigger && nextRunAt === undefined) {
          job.status = "completed";
          delete job.nextRunAt;
        } else if (nextRunAt !== undefined) {
          job.nextRunAt = nextRunAt;
        }

        job.updatedAt = now;
      }

      return enqueueResults;
    });
  }

  async triggerJobNow(jobId: string): Promise<ScheduledRunEnqueueResult> {
    return this.mutateState((state) => {
      const now = this.now();
      const job = state.jobs.find((candidate) => candidate.id === jobId);

      if (!job || job.status === "deleted") {
        throw new Error(`Scheduled job not found: ${jobId}`);
      }

      const run = createRun(job, "queued", now, now, "manual");

      job.lastEnqueuedAt = now;
      job.updatedAt = now;
      state.runs.push(run);

      return {
        handle: createRunHandle(run),
        run: { ...run },
        deduplicated: false,
      };
    });
  }

  async recordEventAndEnqueueRuns(
    input: ScheduledTriggerEventInput,
  ): Promise<ScheduledTriggerEventResult> {
    return this.mutateState((state) => {
      const now = this.now();
      const event = normalizeTriggerEventInput(input, now);
      const enqueued: ScheduledRunEnqueueResult[] = [];
      const existingEvent =
        event.dedupeKey !== undefined
          ? state.events.find(
              (candidate) =>
                candidate.type === event.type &&
                candidate.source === event.source &&
                candidate.dedupeKey === event.dedupeKey,
            )
          : undefined;

      if (existingEvent) {
        return {
          event: { ...existingEvent },
          enqueued,
        };
      }

      for (const job of state.jobs) {
        if (job.status !== "active") {
          continue;
        }

        if (
          event.workspaceRoot &&
          job.target.workspaceRoot !== event.workspaceRoot
        ) {
          continue;
        }

        for (const trigger of job.triggers) {
          if (trigger.kind === "time" || !trigger.enabled) {
            continue;
          }

          if (!eventTypeMatches(trigger, event)) {
            continue;
          }

          const match: ScheduledTriggerEventMatch = {
            jobId: job.id,
            triggerId: trigger.id,
            matched: false,
          };

          const activationMatched = eventFiltersMatch(trigger, event);

          const isStatefulTrigger = getTriggerFiringMode(trigger) === "state";
          const wasStateActive = trigger.lastState === "active";

          if (
            isStatefulTrigger &&
            wasStateActive &&
            getTriggerRecoveryMatched(trigger, event, activationMatched)
          ) {
            trigger.lastState = "idle";
            trigger.lastStateChangedAt = now;
            trigger.lastSkippedAt = now;
            match.skippedReason = "Stateful trigger recovered.";
            event.matches.push(match);
            continue;
          }

          if (!activationMatched) {
            trigger.lastSkippedAt = now;
            match.skippedReason = "Event did not match trigger filters.";
            event.matches.push(match);
            continue;
          }

          if (isStatefulTrigger && !wasStateActive) {
            trigger.lastState = "active";
            trigger.lastStateChangedAt = now;
          }

          const statefulSkipReason = wasStateActive
            ? getStatefulTriggerSkipReason(trigger, event)
            : undefined;

          if (statefulSkipReason) {
            trigger.lastMatchedAt = now;
            trigger.lastSkippedAt = now;
            match.skippedReason = statefulSkipReason;
            event.matches.push(match);
            continue;
          }

          const cooldownSkipReason = getTriggerCooldownSkipReason(
            trigger,
            event,
          );

          if (cooldownSkipReason) {
            trigger.lastSkippedAt = now;
            match.skippedReason = cooldownSkipReason;
            event.matches.push(match);
            continue;
          }

          const rateLimitSkipReason = getTriggerRateLimitSkipReason(
            state,
            trigger,
            event,
          );

          if (rateLimitSkipReason) {
            trigger.lastMatchedAt = now;
            trigger.lastSkippedAt = now;
            match.skippedReason = rateLimitSkipReason;
            event.matches.push(match);
            continue;
          }

          const dedupeSuffix = createEventRunDedupeSuffix(job, trigger, event);
          const dedupeKey = createRunDedupeKey(
            job,
            event.occurredAt,
            dedupeSuffix,
          );
          const existingRun = findExistingRunByDedupeKey(state, dedupeKey);

          trigger.lastMatchedAt = now;

          if (existingRun) {
            match.matched = true;
            match.queuedRunId = existingRun.id;
            match.deduplicated = true;
            event.matches.push(match);
            enqueued.push({
              handle: createRunHandle(existingRun),
              run: { ...existingRun },
              deduplicated: true,
            });
            continue;
          }

          const run = createRun(
            job,
            "queued",
            event.occurredAt,
            now,
            "event",
            {
              triggerId: trigger.id,
              eventId: event.id,
              dedupeSuffix,
            },
          );

          trigger.lastFiredAt = now;
          job.lastEnqueuedAt = now;
          job.updatedAt = now;
          state.runs.push(run);
          match.matched = true;
          match.queuedRunId = run.id;
          match.deduplicated = false;
          event.matches.push(match);
          enqueued.push({
            handle: createRunHandle(run),
            run: { ...run },
            deduplicated: false,
          });
        }
      }

      state.events.push(event);

      return {
        event: { ...event },
        enqueued,
      };
    });
  }

  async listEvents(): Promise<ScheduledTriggerEvent[]> {
    const state = await this.getState();

    return [...state.events].sort(
      (left, right) => right.receivedAt - left.receivedAt,
    );
  }

  async runDueJobs(
    options: RunQueuedScheduledJobsOptions = {},
  ): Promise<RunQueuedScheduledJobsResult> {
    const queued = await this.enqueueDueRuns();
    const runs = await this.runQueuedRuns(options);

    return {
      runs,
      queued: queued.map((result) => result.run),
    };
  }

  async runQueuedRuns(
    options: RunQueuedScheduledJobsOptions = {},
  ): Promise<ScheduledJobRun[]> {
    if (!this.executor) {
      throw new Error("Cannot run scheduled jobs without a scheduler executor.");
    }

    const selectedRuns = await this.claimQueuedRuns(options.maxRuns);

    const finishedRuns = await Promise.all(
      selectedRuns.map((run) => this.executeClaimedRun(run.id)),
    );

    return finishedRuns;
  }

  private async claimQueuedRuns(maxRuns: number | undefined): Promise<ScheduledJobRun[]> {
    return this.mutateState((state) => {
      const now = this.now();
      const runningCounts = countRunningRunsByQueue(state);
      const selectedRuns: ScheduledJobRun[] = [];
      const maxSelected =
        maxRuns === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxRuns);

      for (const run of state.runs) {
        if (
          run.status === "queued" &&
          run.expiresAt !== undefined &&
          run.expiresAt <= now
        ) {
          run.status = "expired";
          run.finishedAt = now;
          run.updatedAt = now;
          run.error = "Expired before it could be dequeued.";
        }
      }

      const queuedRuns = state.runs
        .filter((run) => {
          if (run.status !== "queued") {
            return false;
          }

          const readyAt = run.nextAttemptAt ?? run.enqueuedAt;

          return readyAt <= now;
        })
        .sort(
          (left, right) =>
            (left.nextAttemptAt ?? left.enqueuedAt) -
              (right.nextAttemptAt ?? right.enqueuedAt) ||
            left.enqueuedAt - right.enqueuedAt,
        );

      for (const run of queuedRuns) {
        if (selectedRuns.length >= maxSelected) {
          break;
        }

        const job = state.jobs.find((candidate) => candidate.id === run.jobId);

        if (!job || job.status === "deleted" || job.status === "paused") {
          continue;
        }

        const runningCount = runningCounts.get(run.queueKey) ?? 0;

        if (runningCount >= run.concurrencyLimit) {
          continue;
        }

        runningCounts.set(run.queueKey, runningCount + 1);
        run.status = "running";
        run.startedAt = now;
        run.updatedAt = now;
        run.attempt += 1;
        delete run.nextAttemptAt;
        job.lastStartedAt = now;
        job.updatedAt = now;
        selectedRuns.push({ ...run });
      }

      return selectedRuns;
    });
  }

  private async executeClaimedRun(runId: string): Promise<ScheduledJobRun> {
    if (!this.executor) {
      throw new Error("Cannot run scheduled jobs without a scheduler executor.");
    }

    const controller = new AbortController();
    this.activeRunControllers.set(runId, controller);
    let cleanupMaxDurationTimer = (): void => undefined;

    try {
      const { job, run, event } = await this.getRunnableSnapshot(runId);
      const request = this.createExecutionRequest(job, run, event);
      cleanupMaxDurationTimer = attachMaxDurationTimer(
        controller,
        job.maxDurationMs,
      );
      const result = await this.executor.execute(request, {
        signal: controller.signal,
        ...(job.maxDurationMs ? { maxDurationMs: job.maxDurationMs } : {}),
      });

      return await this.finishRunWithResult(runId, result);
    } catch (error: unknown) {
      return await this.finishRunWithError(runId, error);
    } finally {
      cleanupMaxDurationTimer();
      this.activeRunControllers.delete(runId);
    }
  }

  private async getRunnableSnapshot(
    runId: string,
  ): Promise<{ job: ScheduledJob; run: ScheduledJobRun; event?: ScheduledTriggerEvent }> {
    const state = await this.getState();
    const run = state.runs.find((candidate) => candidate.id === runId);

    if (!run || run.status !== "running") {
      throw new Error(`Scheduled run is no longer runnable: ${runId}`);
    }

    const job = state.jobs.find((candidate) => candidate.id === run.jobId);

    if (!job) {
      throw new Error(`Scheduled job not found for run: ${runId}`);
    }

    const event = run.eventId
      ? state.events.find((candidate) => candidate.id === run.eventId)
      : undefined;

    return { job, run, ...(event ? { event } : {}) };
  }

  private createExecutionRequest(
    job: ScheduledJob,
    run: ScheduledJobRun,
    event: ScheduledTriggerEvent | undefined,
  ): ScheduledTaskExecutionRequest {
    return {
      job,
      run,
      ...(event ? { event } : {}),
      targetType: job.target.type ?? "prompt",
      task: createScheduledJobTaskText(job),
      workspaceRoot: job.target.workspaceRoot,
      contextPaths: getScheduledJobContextPaths(job),
      imagePaths: job.target.imagePaths,
      ...(job.target.ralphFlow ? { ralphFlow: job.target.ralphFlow } : {}),
      ...(job.target.mode ? { mode: job.target.mode } : {}),
      ...(job.target.profile ? { profile: job.target.profile } : {}),
      ...(job.target.provider ? { provider: job.target.provider } : {}),
      ...(job.target.model ? { model: job.target.model } : {}),
      ...(job.target.reasoning ? { reasoning: job.target.reasoning } : {}),
    };
  }

  private async finishRunWithResult(
    runId: string,
    result: TaskExecutionResult,
  ): Promise<ScheduledJobRun> {
    const controller = this.activeRunControllers.get(runId);

    if (isTimeoutReason(controller?.signal.reason)) {
      return this.finishRunAttempt(runId, {
        status: "timed_out",
        result,
        error: String(controller?.signal.reason),
      });
    }

    if (controller?.signal.aborted) {
      return this.finishRunAttempt(runId, {
        status: "cancelled",
        result,
        error: controller.signal.reason
          ? String(controller.signal.reason)
          : "Scheduled run cancelled.",
      });
    }

    if (taskResultCancelled(result)) {
      return this.finishRunAttempt(runId, {
        status: "cancelled",
        result,
        error: result.reason ?? result.summary,
      });
    }

    if (taskResultSucceeded(result)) {
      return this.finishRunAttempt(runId, {
        status: "succeeded",
        result,
      });
    }

    return this.finishRunAttempt(runId, {
      status: "failed",
      result,
      error: result.reason ?? result.summary,
    });
  }

  private async finishRunWithError(
    runId: string,
    error: unknown,
  ): Promise<ScheduledJobRun> {
    const controller = this.activeRunControllers.get(runId);
    const message =
      controller?.signal.aborted && controller.signal.reason
        ? String(controller.signal.reason)
        : errorToMessage(error);

    return this.finishRunAttempt(runId, {
      status: isTimeoutReason(controller?.signal.reason)
        ? "timed_out"
        : controller?.signal.aborted
          ? "cancelled"
          : "failed",
      error: message,
    });
  }

  private async finishRunAttempt(
    runId: string,
    outcome: {
      status: "succeeded" | "failed" | "cancelled" | "timed_out";
      result?: TaskExecutionResult;
      error?: string;
    },
  ): Promise<ScheduledJobRun> {
    return this.mutateState((state) => {
      const now = this.now();
      const run = state.runs.find((candidate) => candidate.id === runId);

      if (!run) {
        throw new Error(`Scheduled run not found: ${runId}`);
      }

      const job = state.jobs.find((candidate) => candidate.id === run.jobId);
      const attemptStartedAt = run.startedAt ?? now;
      const finalStatus =
        run.cancelRequestedAt !== undefined ? "cancelled" : outcome.status;
      const finalError =
        run.cancelRequestedAt !== undefined
          ? run.cancelReason ?? outcome.error
          : outcome.error;
      const shouldRetry =
        finalStatus === "failed" && run.attempt < run.maxAttempts;
      const nextRetryAt = shouldRetry
        ? now +
          getRetryDelayMs(
            job?.retry ?? DEFAULT_RETRY_POLICY,
            run.attempt,
            this.rng,
          )
        : undefined;
      const attempt: ScheduledRunAttempt = {
        attempt: run.attempt,
        startedAt: attemptStartedAt,
        finishedAt: now,
        status: finalStatus,
        ...(outcome.result?.summary ? { summary: outcome.result.summary } : {}),
        ...(outcome.result?.status ? { resultStatus: outcome.result.status } : {}),
        ...(finalError ? { error: finalError } : {}),
        ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
      };

      run.attemptHistory.push(attempt);
      run.updatedAt = now;

      if (outcome.result) {
        run.result = outcome.result;
      }

      if (finalError) {
        run.error = finalError;
      }

      if (shouldRetry && nextRetryAt !== undefined) {
        run.status = "queued";
        run.nextAttemptAt = nextRetryAt;
        delete run.startedAt;
        delete run.finishedAt;
      } else {
        run.status = finalStatus;
        run.finishedAt = now;
      }

      if (job) {
        job.updatedAt = now;
        job.lastFinishedAt = now;
      }

      return { ...run };
    });
  }

  async getRun(
    handleOrRunId: ScheduledRunHandle | string,
  ): Promise<ScheduledJobRun | undefined> {
    const state = await this.getState();
    const runId = resolveRunId(handleOrRunId);

    return state.runs.find((run) => run.id === runId);
  }

  async listRuns(jobId?: string): Promise<ScheduledJobRun[]> {
    const state = await this.getState();

    return state.runs
      .filter((run) => !jobId || run.jobId === jobId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async cancelRun(
    handleOrRunId: ScheduledRunHandle | string,
    reason = "Scheduled run cancelled.",
  ): Promise<ScheduledJobRun> {
    const runId = resolveRunId(handleOrRunId);
    const controller = this.activeRunControllers.get(runId);

    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
    }

    return this.mutateState((state) => {
      const now = this.now();
      const run = state.runs.find((candidate) => candidate.id === runId);

      if (!run) {
        throw new Error(`Scheduled run not found: ${runId}`);
      }

      if (run.status === "queued") {
        run.status = "cancelled";
        run.cancelRequestedAt = now;
        run.cancelReason = reason;
        run.finishedAt = now;
        run.updatedAt = now;
        run.error = reason;
      } else if (run.status === "running") {
        run.cancelRequestedAt = now;
        run.cancelReason = reason;
        run.updatedAt = now;
      }

      return { ...run };
    });
  }

  async retryRun(
    handleOrRunId: ScheduledRunHandle | string,
  ): Promise<ScheduledRunHandle> {
    const runId = resolveRunId(handleOrRunId);

    return this.mutateState((state) => {
      const now = this.now();
      const parentRun = state.runs.find((candidate) => candidate.id === runId);

      if (!parentRun) {
        throw new Error(`Scheduled run not found: ${runId}`);
      }

      if (!isTerminalRunStatus(parentRun.status)) {
        throw new Error(`Scheduled run is not retryable yet: ${runId}`);
      }

      const job = state.jobs.find((candidate) => candidate.id === parentRun.jobId);

      if (!job || job.status === "deleted") {
        throw new Error(`Scheduled job not found for run: ${runId}`);
      }

      const retryRun = createRun(
        job,
        "queued",
        parentRun.scheduledFor,
        now,
        "manual-retry",
        {
          parentRunId: parentRun.id,
          ...(parentRun.triggerId ? { triggerId: parentRun.triggerId } : {}),
          ...(parentRun.eventId ? { eventId: parentRun.eventId } : {}),
        },
      );

      state.runs.push(retryRun);

      return {
        jobId: job.id,
        runId: retryRun.id,
      };
    });
  }
}
