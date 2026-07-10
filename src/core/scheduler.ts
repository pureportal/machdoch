import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  createRalphFlowFingerprint,
  readRalphFlow,
  type RalphFlow,
  type RalphFlowVariable,
} from "./ralph.js";
import { discoverRalphFlowVariables } from "./_helpers/ralph-placeholders.helper.js";
import { validateRalphFlow } from "./_helpers/validate-ralph-flow.helper.js";
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
import {
  normalizeSchedulerMultilineText,
  normalizeSchedulerOptionalPositiveInteger,
  normalizeSchedulerPositiveInteger,
  normalizeSchedulerPositiveNumber,
  normalizeSchedulerText,
  normalizeSchedulerTrimmedText,
} from "./_helpers/normalize-scheduler-value.helper.js";
import {
  createScheduledJobTaskText,
} from "./_helpers/create-scheduled-job-task-text.helper.js";
import {
  getScheduledJobContextPaths,
} from "./_helpers/get-scheduled-job-context-paths.helper.js";
import {
  getSchedulerFrontmatterBoolean,
} from "./_helpers/get-scheduler-frontmatter-boolean.helper.js";
import {
  getSchedulerFrontmatterNumber,
} from "./_helpers/get-scheduler-frontmatter-number.helper.js";
import {
  getSchedulerFrontmatterString,
} from "./_helpers/get-scheduler-frontmatter-string.helper.js";
import {
  getSchedulerFrontmatterStringList,
} from "./_helpers/get-scheduler-frontmatter-string-list.helper.js";
import {
  createSchedulerEventRunDedupeSuffix,
  getSchedulerEventTriggerFiringMode,
  getSchedulerEventTriggerRecoveryMatched,
  getSchedulerStatefulTriggerSkipReason,
  getSchedulerTriggerCooldownSkipReason,
  getSchedulerTriggerRateLimitSkipReason,
  inferSchedulerEventTriggerKind,
  isSchedulerEventTriggerFiringMode,
  isSchedulerEventTriggerState,
  normalizeSchedulerEventPayload,
  schedulerEventFiltersMatch,
  schedulerEventTypeMatches,
} from "./_helpers/scheduler-event-trigger-matching.helper.js";
import { normalizeStringList } from "../helpers/normalize-string-list.helper.js";
export {
  createScheduledJobTaskText,
} from "./_helpers/create-scheduled-job-task-text.helper.js";
export {
  getScheduledJobContextPaths,
} from "./_helpers/get-scheduled-job-context-paths.helper.js";
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
export const SMART_SCHEDULER_WORKSPACE_REGISTRY_FILE_NAME =
  "scheduler-workspaces.json";

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_MISSED_RUN_POLICY: ScheduledMissedRunPolicy = "enqueue-latest";
const DEFAULT_MISSED_RUN_GRACE_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_EVENT_HISTORY_LIMIT = 1_000;
const DEFAULT_MUTATION_RECEIPT_LIMIT = 1_000;
const DEFAULT_MAX_CATCH_UP_RUNS = 100;
const DEFAULT_CONCURRENCY_LIMIT = 1;
const DEFAULT_SCHEDULER_SERVICE_POLL_INTERVAL_MS = 30_000;
const DEFAULT_SCHEDULER_SERVICE_IDLE_SHUTDOWN_MS = 0;
const DEFAULT_SCHEDULER_SERVICE_MAX_CHAIN_DEPTH = 25;
const DEFAULT_SCHEDULER_RUNNING_HEARTBEAT_MS = 30_000;
const DEFAULT_SCHEDULER_ABANDONED_RUN_STALE_MS = 5 * 60_000;
const DEFAULT_RETRY_POLICY: ScheduledRetryPolicy = {
  maxAttempts: 1,
  factor: 2,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  randomize: true,
};
const DEFAULT_UNATTENDED_RALPH_RETRY_POLICY: ScheduledRetryPolicy = {
  ...DEFAULT_RETRY_POLICY,
  maxAttempts: 3,
};
const SCHEDULER_STATE_LOCK_RETRY_MS = 25;
const SCHEDULER_STATE_LOCK_STALE_MS = 5 * 60_000;
const SCHEDULER_STATE_LOCK_TRANSIENT_ACCESS_MS = 2_000;
const SCHEDULER_STATE_REPLACE_RETRY_DELAYS_MS = [
  0,
  10,
  25,
  50,
  100,
  250,
] as const;
const SCHEDULER_TIMEOUT_REASON_PREFIX = "Scheduled run exceeded max duration";
const SCHEDULER_HEARTBEAT_FAILURE_PREFIX =
  "Scheduled run heartbeat persistence failed";

class StaleScheduledRunClaimError extends Error {
  constructor(runId: string) {
    super(`Scheduled run claim is no longer current: ${runId}`);
    this.name = "StaleScheduledRunClaimError";
  }
}

const isStaleScheduledRunClaimError = (
  error: unknown,
): error is StaleScheduledRunClaimError => {
  return error instanceof StaleScheduledRunClaimError;
};

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
export type ScheduledRalphExecutionProfile = "unattended";
export type ScheduledRalphResumePolicy = "never" | "recoverable";

export interface ScheduledRalphFlowPermissions {
  allowedRoots: string[];
  allowCommands: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  allowMcpTools: boolean;
}

export interface ScheduledRalphFlowTarget {
  scope: ScheduledRalphFlowScope;
  id: string;
  params: Record<string, string>;
  maxTransitions?: number;
  runLogScope?: ScheduledRalphFlowScope;
  executionProfile?: ScheduledRalphExecutionProfile;
  resumePolicy?: ScheduledRalphResumePolicy;
  permissions?: ScheduledRalphFlowPermissions;
  /** Immutable flow revision captured when the job was created or updated. */
  flowSnapshot?: RalphFlow;
  flowFingerprint?: string;
  flowSnapshotAt?: number;
  flowSnapshotRefreshError?: string;
  flowSnapshotRefreshFailedAt?: number;
}

export interface ScheduledRalphVariableReadiness {
  name: string;
  type: RalphFlowVariable["type"];
  required: boolean;
  default?: string;
  value?: string;
  source: "parameter" | "default" | "missing";
}

export interface ScheduledRalphTargetReadiness {
  ready: boolean;
  flowId: string;
  flowName?: string;
  flowFingerprint?: string;
  variables: ScheduledRalphVariableReadiness[];
  autoResolvedHumanBlockIds: string[];
  blockingHumanBlockIds: string[];
  errors: string[];
  warnings: string[];
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
  /** Durable fence token that owned this attempt. */
  claimToken?: string;
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
  /** Durable fence token for the currently running attempt. */
  claimToken?: string;
  /** Immutable execution target captured at enqueue time. */
  targetSnapshot?: ScheduledJobTarget;
  maxDurationMsSnapshot?: number;
  dedupeKey?: string;
  parentRunId?: string;
  idempotencyKey?: string;
  expiresAt?: number;
  nextAttemptAt?: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequestedAt?: number;
  cancelReason?: string;
  result?: TaskExecutionResult;
  error?: string;
}

export type SchedulerMutationOperation =
  | "upsert-job"
  | "update-job"
  | "pause-job"
  | "resume-job"
  | "delete-job"
  | "trigger-job"
  | "retry-run"
  | "cancel-run";

export interface SchedulerMutationReceipt {
  key: string;
  operation: SchedulerMutationOperation;
  target: string;
  payloadHash: string;
  completedAt: number;
  result: unknown;
}

export interface SmartSchedulerState {
  schema: typeof SMART_SCHEDULER_SCHEMA;
  schemaVersion: typeof SMART_SCHEDULER_SCHEMA_VERSION;
  createdAt: number;
  updatedAt: number;
  jobs: ScheduledJob[];
  runs: ScheduledJobRun[];
  events: ScheduledTriggerEvent[];
  mutationReceipts: SchedulerMutationReceipt[];
}

export interface ScheduledTriggerEventInput {
  type: string;
  kind?: ScheduledEventTriggerKind;
  source?: string;
  workspaceRoot?: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  parentRunId?: string;
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
  parentRunId?: string;
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
  deduplicated?: boolean;
  status?: ScheduledRunStatus;
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
  workspaceRoot?: string;
  executor?: ScheduledTaskExecutor;
  clock?: SchedulerClock;
  rng?: () => number;
  runningHeartbeatMs?: number;
  heartbeatRun?: (runId: string, claimToken: string) => Promise<void>;
}

export interface RunQueuedScheduledJobsOptions {
  maxRuns?: number;
  recoverAbandoned?: boolean;
  signal?: AbortSignal;
}

export interface RunQueuedScheduledJobsResult {
  runs: ScheduledJobRun[];
  queued: ScheduledJobRun[];
}

export interface SchedulerRecoveredRun {
  runId: string;
  jobId: string;
  previousStatus: ScheduledRunStatus;
  status: ScheduledRunStatus;
}

export interface SchedulerServiceIterationResult {
  recovered: SchedulerRecoveredRun[];
  queued: ScheduledJobRun[];
  runs: ScheduledJobRun[];
}

export interface SchedulerServiceOptions {
  pollIntervalMs?: number;
  idleShutdownMs?: number;
  abandonedRunStaleMs?: number;
  maxIterations?: number;
  maxRunsPerTick?: number;
  signal?: AbortSignal;
  onIteration?: (result: SchedulerServiceIterationResult) => void | Promise<void>;
}

export interface SchedulerServiceResult {
  iterations: number;
  recoveredRuns: number;
  queuedRuns: number;
  finishedRuns: number;
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
  mutationReceipts: [],
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

const sleepWithSignal = async (
  durationMs: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (durationMs <= 0 || signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    function onAbort(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onTimeout(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }

    const timeout = setTimeout(onTimeout, durationMs);
    signal?.addEventListener("abort", onAbort, { once: true });
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

const isSchedulerStateLockContentionError = (
  error: unknown,
  lockPath: string,
): boolean => {
  if (isErrorWithCode(error, "EEXIST")) {
    return true;
  }

  return (
    (isErrorWithCode(error, "EACCES") || isErrorWithCode(error, "EPERM")) &&
    existsSync(lockPath)
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
  const startedAt = Date.now();

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
      if (
        (isErrorWithCode(error, "EACCES") || isErrorWithCode(error, "EPERM")) &&
        !existsSync(lockPath) &&
        Date.now() - startedAt <= SCHEDULER_STATE_LOCK_TRANSIENT_ACCESS_MS
      ) {
        await sleep(SCHEDULER_STATE_LOCK_RETRY_MS);
        continue;
      }

      if (!isSchedulerStateLockContentionError(error, lockPath)) {
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

const isSchedulerMutationOperation = (
  value: unknown,
): value is SchedulerMutationOperation => {
  return (
    value === "upsert-job" ||
    value === "update-job" ||
    value === "pause-job" ||
    value === "resume-job" ||
    value === "delete-job" ||
    value === "trigger-job" ||
    value === "retry-run" ||
    value === "cancel-run"
  );
};

const normalizeMutationReceipts = (
  value: unknown,
): SchedulerMutationReceipt[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((candidate): candidate is SchedulerMutationReceipt => {
      return (
        isRecordValue(candidate) &&
        typeof candidate.key === "string" &&
        candidate.key.length > 0 &&
        isSchedulerMutationOperation(candidate.operation) &&
        typeof candidate.target === "string" &&
        candidate.target.length > 0 &&
        typeof candidate.payloadHash === "string" &&
        candidate.payloadHash.length > 0 &&
        typeof candidate.completedAt === "number" &&
        Number.isFinite(candidate.completedAt) &&
        Object.prototype.hasOwnProperty.call(candidate, "result")
      );
    })
    .slice(-DEFAULT_MUTATION_RECEIPT_LIMIT);
};

const serializeMutationPayload = (value: unknown): string => {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeMutationPayload(entry)).join(",")}]`;
  }

  if (isRecordValue(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeMutationPayload(value[key])}`,
      )
      .join(",")}}`;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }

  if (
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  return "null";
};

const createMutationPayloadHash = (payload: unknown): string => {
  return createHash("sha256")
    .update(serializeMutationPayload(payload))
    .digest("hex");
};

interface SchedulerMutationRequest {
  key: string | undefined;
  operation: SchedulerMutationOperation;
  target: string;
  payload: unknown;
}

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
    mutationReceipts: normalizeMutationReceipts(parsed.mutationReceipts),
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

const writeSchedulerFileDurably = async (
  tempPath: string,
  targetPath: string,
  content: string,
): Promise<void> => {
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await replaceSmartSchedulerStateFile(tempPath, targetPath);

  if (process.platform !== "win32") {
    const directoryHandle = await open(dirname(targetPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
};

const writeSmartSchedulerStateUnlocked = async (
  statePath: string,
  state: SmartSchedulerState,
): Promise<void> => {
  await mkdir(dirname(statePath), { recursive: true });

  const tempPath = `${statePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

  try {
    await writeSchedulerFileDurably(
      tempPath,
      statePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
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

const createRunClaimToken = (attempt: number): string =>
  `claim_${attempt}_${randomUUID()}`;

const createEventId = (): string => `event_${randomUUID()}`;

const normalizeTimeZone = (value: string | undefined): string => {
  const timezone = normalizeSchedulerText(value) ?? DEFAULT_TIMEZONE;

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
      const expression = normalizeSchedulerText(input.expression);

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
      const intervalMs = normalizeSchedulerOptionalPositiveInteger(input.intervalMs);

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
          : timestamp + normalizeSchedulerPositiveInteger(input.delayMs, 0);

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
  const kind = normalizeSchedulerText(guard.kind);

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

  const maxEvents = normalizeSchedulerOptionalPositiveInteger(value.maxEvents);
  const windowMs = normalizeSchedulerOptionalPositiveInteger(value.windowMs);

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
  const name = normalizeSchedulerText(input.name);
  const debounceMs = normalizeSchedulerOptionalPositiveInteger(input.debounceMs);
  const cooldownMs = normalizeSchedulerOptionalPositiveInteger(input.cooldownMs);
  const repeatIntervalMs = normalizeSchedulerOptionalPositiveInteger(
    input.repeatIntervalMs,
  );
  const dedupeKeyTemplate = normalizeSchedulerText(input.dedupeKeyTemplate);
  const filters = cloneRecord(input.filters);
  const recoveryFilters = cloneRecord(input.recoveryFilters);
  const guards = normalizeTriggerGuards(input.guards);
  const firingMode = isSchedulerEventTriggerFiringMode(input.firingMode)
    ? input.firingMode
    : isSchedulerEventTriggerFiringMode(existingTrigger?.firingMode)
      ? existingTrigger.firingMode
      : recoveryFilters || repeatIntervalMs !== undefined
        ? "state"
        : undefined;
  const maxEventsPerWindow = normalizeRateLimitPolicy(input.maxEventsPerWindow);

  return {
    id: normalizeSchedulerText(input.id) ?? existingTrigger?.id ?? createTriggerId(),
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
    ...(isSchedulerEventTriggerState(existingTrigger?.lastState)
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

  const eventType = normalizeSchedulerText(input.eventType) ?? input.kind;

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
  const name = normalizeSchedulerText(pack.name);

  if (!name) {
    return undefined;
  }

  const instructions = normalizeSchedulerMultilineText(pack.instructions);
  const prompt = normalizeSchedulerMultilineText(pack.prompt);
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
  const name = normalizeSchedulerText(macro.name);

  if (!name) {
    return undefined;
  }

  const promptInvocation = normalizeSchedulerText(macro.promptInvocation);

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
  workspaceRoot: string,
): ScheduledRalphFlowTarget | undefined => {
  if (target.type !== "ralph-flow" && !target.ralphFlow) {
    return undefined;
  }

  const flowId = normalizeSchedulerTrimmedText(target.ralphFlow?.id);

  if (!flowId) {
    throw new Error("Expected scheduled Ralph target to include a flow id.");
  }

  const maxTransitions = target.ralphFlow?.maxTransitions;
  const executionProfile =
    target.ralphFlow?.executionProfile === "unattended"
      ? target.ralphFlow.executionProfile
      : undefined;
  const resumePolicy =
    target.ralphFlow?.resumePolicy === "never" ||
    target.ralphFlow?.resumePolicy === "recoverable"
      ? target.ralphFlow.resumePolicy
      : executionProfile === "unattended"
        ? "recoverable"
        : undefined;
  const configuredPermissions = target.ralphFlow?.permissions;
  const unattended = executionProfile === "unattended";
  const configuredAllowedRoots = normalizeStringList(
    configuredPermissions?.allowedRoots,
  );
  const permissions =
    configuredPermissions || unattended
      ? {
          allowedRoots:
            configuredAllowedRoots.length > 0
              ? configuredAllowedRoots
              : unattended
                ? [workspaceRoot]
                : [],
          allowCommands: unattended || configuredPermissions?.allowCommands === true,
          allowWrites: unattended || configuredPermissions?.allowWrites === true,
          allowNetwork: unattended || configuredPermissions?.allowNetwork === true,
          allowMcpTools: unattended || configuredPermissions?.allowMcpTools === true,
        }
      : undefined;

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
    ...(executionProfile ? { executionProfile } : {}),
    ...(resumePolicy ? { resumePolicy } : {}),
    ...(permissions ? { permissions } : {}),
  };
};

export const getUserSchedulerWorkspaceRegistryPath = (): string => {
  return join(
    dirname(getUserConfigPath()),
    SMART_SCHEDULER_WORKSPACE_REGISTRY_FILE_NAME,
  );
};

interface SchedulerWorkspaceRegistry {
  schema: "machdoch.schedulerWorkspaces";
  schemaVersion: 1;
  updatedAt: number;
  workspaceRoots: string[];
}

const readSchedulerWorkspaceRegistryUnlocked = async (
  registryPath: string,
): Promise<SchedulerWorkspaceRegistry> => {
  if (!existsSync(registryPath)) {
    return {
      schema: "machdoch.schedulerWorkspaces",
      schemaVersion: 1,
      updatedAt: Date.now(),
      workspaceRoots: [],
    };
  }

  const value = JSON.parse(await readFile(registryPath, "utf8")) as Partial<SchedulerWorkspaceRegistry>;

  if (
    value.schema !== "machdoch.schedulerWorkspaces" ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.workspaceRoots)
  ) {
    throw new Error(`Unsupported scheduler workspace registry: ${registryPath}`);
  }

  return {
    schema: "machdoch.schedulerWorkspaces",
    schemaVersion: 1,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    workspaceRoots: value.workspaceRoots.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    ),
  };
};

const writeSchedulerWorkspaceRegistryUnlocked = async (
  registryPath: string,
  registry: SchedulerWorkspaceRegistry,
): Promise<void> => {
  await mkdir(dirname(registryPath), { recursive: true });
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

  try {
    await writeSchedulerFileDurably(
      tempPath,
      registryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
    );
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
};

export const registerSchedulerWorkspace = async (
  workspaceRoot: string,
): Promise<string> => {
  const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
  const registryPath = getUserSchedulerWorkspaceRegistryPath();

  await withSchedulerStateLock(registryPath, async () => {
    const registry = await readSchedulerWorkspaceRegistryUnlocked(registryPath);
    const queueKey = createCanonicalWorkspaceQueueKey(canonicalRoot);
    const rootsByKey = new Map(
      registry.workspaceRoots.map((root) => [createCanonicalWorkspaceQueueKey(root), root]),
    );
    rootsByKey.set(queueKey, canonicalRoot);
    registry.workspaceRoots = [...rootsByKey.values()].sort((left, right) =>
      left.localeCompare(right),
    );
    registry.updatedAt = Date.now();
    await writeSchedulerWorkspaceRegistryUnlocked(registryPath, registry);
  });

  return canonicalRoot;
};

export const listRegisteredSchedulerWorkspaces = async (): Promise<string[]> => {
  const registryPath = getUserSchedulerWorkspaceRegistryPath();

  return withSchedulerStateLock(registryPath, async () => {
    const registry = await readSchedulerWorkspaceRegistryUnlocked(registryPath);
    const validity = await Promise.all(
      registry.workspaceRoots.map(async (workspaceRoot) => {
        try {
          return (await stat(workspaceRoot)).isDirectory();
        } catch {
          return false;
        }
      }),
    );
    const workspaceRoots = registry.workspaceRoots.filter(
      (_workspaceRoot, index) => validity[index],
    );

    if (workspaceRoots.length !== registry.workspaceRoots.length) {
      registry.workspaceRoots = workspaceRoots;
      registry.updatedAt = Date.now();
      await writeSchedulerWorkspaceRegistryUnlocked(registryPath, registry);
    }

    return workspaceRoots;
  });
};

const cloneScheduledValue = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value)) as T;
};

export const createScheduledRalphExecutionSnapshot = (
  flow: RalphFlow,
): RalphFlow => {
  const snapshot = cloneScheduledValue(flow);
  delete snapshot.createdAt;
  delete snapshot.updatedAt;

  if (snapshot.source) {
    snapshot.source = {
      kind: snapshot.source.kind,
      id: snapshot.source.id,
      version: snapshot.source.version,
      ...(snapshot.source.importedAt
        ? { importedAt: snapshot.source.importedAt }
        : {}),
      ...(snapshot.source.templateFingerprint
        ? { templateFingerprint: snapshot.source.templateFingerprint }
        : {}),
    };
  }

  return snapshot;
};

const canonicalizeWorkspaceRoot = async (workspaceRoot: string): Promise<string> => {
  const absoluteRoot = resolve(workspaceRoot);

  try {
    return await realpath(absoluteRoot);
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }

    return absoluteRoot;
  }
};

const createCanonicalWorkspaceQueueKey = (workspaceRoot: string): string => {
  const normalized = resolve(workspaceRoot).replaceAll("\\", "/");
  const canonical = process.platform === "win32" ? normalized.toLowerCase() : normalized;

  return `ralph-workspace:${canonical}`;
};

const hasScheduledValue = (value: unknown): boolean => {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
};

export const inspectScheduledRalphTarget = async (
  workspaceRoot: string,
  target: ScheduledRalphFlowTarget,
  options: { flow?: RalphFlow; params?: Record<string, string> } = {},
): Promise<ScheduledRalphTargetReadiness> => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const autoResolvedHumanBlockIds: string[] = [];
  const blockingHumanBlockIds: string[] = [];
  let flow: RalphFlow;

  try {
    flow = options.flow ?? target.flowSnapshot ?? await readRalphFlow(
      workspaceRoot,
      target.id,
      { scope: target.scope },
    );
  } catch (error) {
    return {
      ready: false,
      flowId: target.id,
      variables: [],
      autoResolvedHumanBlockIds,
      blockingHumanBlockIds,
      errors: [errorToMessage(error)],
      warnings,
    };
  }

  const params = options.params ?? target.params;
  const declaredVariables = discoverRalphFlowVariables(flow);
  const declaredVariableNames = new Set(declaredVariables.map((variable) => variable.name));
  const resolvedVariables = Object.fromEntries(
    declaredVariables.flatMap((variable) => {
      if (Object.hasOwn(params, variable.name)) {
        return [[variable.name, params[variable.name] ?? ""]] as const;
      }
      if (variable.default !== undefined) {
        return [[variable.name, variable.default]] as const;
      }
      return [];
    }),
  );
  const variables: ScheduledRalphVariableReadiness[] = declaredVariables.map(
    (variable) => {
      const hasParam = Object.hasOwn(params, variable.name);
      const value = hasParam ? params[variable.name] : variable.default;
      const source = hasParam
        ? "parameter" as const
        : variable.default !== undefined
          ? "default" as const
          : "missing" as const;

      if (variable.required && !hasScheduledValue(value)) {
        errors.push(`Missing required Ralph parameter \`${variable.name}\`.`);
      }

      return {
        name: variable.name,
        type: variable.type,
        required: variable.required,
        ...(variable.default !== undefined ? { default: variable.default } : {}),
        ...(value !== undefined ? { value } : {}),
        source,
      };
    },
  );

  for (const name of Object.keys(params)) {
    if (!declaredVariableNames.has(name)) {
      errors.push(`Ralph parameter \`${name}\` is not declared by this flow.`);
    }
  }

  const validation = validateRalphFlow(flow, { variableValues: resolvedVariables });
  errors.push(...validation.errors.filter((message) => !message.startsWith("missing required Ralph variable")));
  warnings.push(...validation.warnings);

  for (const block of flow.blocks) {
    if (block.type === "ASK_USER") {
      if (target.executionProfile === "unattended") {
        autoResolvedHumanBlockIds.push(block.id);
        warnings.push(
          `ASK_USER block \`${block.id}\` will synthesize bounded unattended values.`,
        );
        continue;
      }

      const canAutoResolve =
        (block.mode ?? "missingOnly") === "missingOnly" &&
        block.fields.every((field) => {
          if (!field.required || field.skippable) {
            return true;
          }

          const variableName = field.variableName?.trim() || field.id;
          return hasScheduledValue(resolvedVariables[variableName]) ||
            hasScheduledValue(field.defaultValue);
        });

      if (canAutoResolve) {
        autoResolvedHumanBlockIds.push(block.id);
        warnings.push(`ASK_USER block \`${block.id}\` will use scheduled/default values.`);
      } else {
        blockingHumanBlockIds.push(block.id);
        errors.push(`Scheduled Ralph flow cannot pause at ASK_USER block \`${block.id}\`.`);
      }
      continue;
    }

    if (block.type === "INTERVIEW") {
      if (target.executionProfile === "unattended") {
        autoResolvedHumanBlockIds.push(block.id);
        warnings.push(
          `INTERVIEW block \`${block.id}\` will be skipped by the unattended runtime.`,
        );
        continue;
      }

      const interviewEnabled = resolvedVariables.enableInterview;

      if (interviewEnabled === "false" || interviewEnabled === "0") {
        autoResolvedHumanBlockIds.push(block.id);
        warnings.push(`INTERVIEW block \`${block.id}\` is disabled for unattended execution.`);
      } else {
        blockingHumanBlockIds.push(block.id);
        errors.push(
          `Scheduled Ralph flow cannot pause at INTERVIEW block \`${block.id}\`; set enableInterview=false or remove the block.`,
        );
      }
    }
  }

  return {
    ready: errors.length === 0,
    flowId: flow.id,
    flowName: flow.name,
    flowFingerprint: createRalphFlowFingerprint(flow),
    variables,
    autoResolvedHumanBlockIds,
    blockingHumanBlockIds,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings)),
  };
};

const pinScheduledRalphTarget = async (
  workspaceRoot: string,
  target: ScheduledRalphFlowTarget,
  timestamp: number,
): Promise<ScheduledRalphFlowTarget> => {
  const flow = await readRalphFlow(workspaceRoot, target.id, { scope: target.scope });
  const readiness = await inspectScheduledRalphTarget(workspaceRoot, target, { flow });

  if (!readiness.ready) {
    throw new Error(`Scheduled Ralph target is not unattended-ready: ${readiness.errors.join(" ")}`);
  }

  return {
    ...target,
    id: flow.id,
    flowSnapshot: createScheduledRalphExecutionSnapshot(flow),
    flowFingerprint: createRalphFlowFingerprint(flow),
    flowSnapshotAt: timestamp,
  };
};

const refreshScheduledRalphTarget = async (
  workspaceRoot: string,
  target: ScheduledRalphFlowTarget,
  timestamp: number,
): Promise<{
  target: ScheduledRalphFlowTarget;
  usable: boolean;
  error?: string;
}> => {
  try {
    const refreshed = await pinScheduledRalphTarget(
      workspaceRoot,
      target,
      timestamp,
    );
    delete refreshed.flowSnapshotRefreshError;
    delete refreshed.flowSnapshotRefreshFailedAt;
    return { target: refreshed, usable: true };
  } catch (error) {
    const message = errorToMessage(error);
    const fallback = {
      ...target,
      flowSnapshotRefreshError: message,
      flowSnapshotRefreshFailedAt: timestamp,
    };

    return {
      target: fallback,
      usable: Boolean(target.flowSnapshot && target.flowFingerprint),
      error: message,
    };
  }
};

const normalizeRalphTargetForStorage = async (
  workspaceRoot: string,
  target: ScheduledRalphFlowTarget,
  previousTarget: ScheduledRalphFlowTarget | undefined,
  timestamp: number,
): Promise<ScheduledRalphFlowTarget> => {
  try {
    return await pinScheduledRalphTarget(workspaceRoot, target, timestamp);
  } catch (error) {
    const message = errorToMessage(error);

    if (!/^Ralph flow `.+` was not found\.$/u.test(message)) {
      throw error;
    }

    // Watches, imported scheduler state, and external automation may refer to
    // a flow before it is installed. Persist that reference for CRUD/sync, but
    // retain any last valid pin and mark the target degraded. Enqueue paths
    // must refresh successfully or have that immutable fallback before running.
    return {
      ...target,
      ...(previousTarget?.flowSnapshot
        ? { flowSnapshot: cloneScheduledValue(previousTarget.flowSnapshot) }
        : {}),
      ...(previousTarget?.flowFingerprint
        ? { flowFingerprint: previousTarget.flowFingerprint }
        : {}),
      ...(previousTarget?.flowSnapshotAt !== undefined
        ? { flowSnapshotAt: previousTarget.flowSnapshotAt }
        : {}),
      flowSnapshotRefreshError: message,
      flowSnapshotRefreshFailedAt: timestamp,
    };
  }
};

const normalizeTarget = async (
  target: ScheduledJobTargetInput,
  timestamp: number,
  previousTarget?: ScheduledJobTarget,
): Promise<ScheduledJobTarget> => {
  const configuredWorkspaceRoot = normalizeSchedulerTrimmedText(target.workspaceRoot);

  if (!configuredWorkspaceRoot) {
    throw new Error("Expected scheduled job target to include a workspace root.");
  }

  const workspaceRoot = await canonicalizeWorkspaceRoot(configuredWorkspaceRoot);

  const normalizedRalphFlow = normalizeRalphFlowTarget(target, workspaceRoot);
  const existingRalphFlow = previousTarget?.ralphFlow;
  const previousRalphTarget =
    previousTarget?.workspaceRoot === workspaceRoot &&
    existingRalphFlow !== undefined &&
    normalizedRalphFlow !== undefined &&
    existingRalphFlow.id === normalizedRalphFlow.id &&
    existingRalphFlow.scope === normalizedRalphFlow.scope
      ? existingRalphFlow
      : undefined;
  const ralphFlow = normalizedRalphFlow
    ? await normalizeRalphTargetForStorage(
        workspaceRoot,
        normalizedRalphFlow,
        previousRalphTarget,
        timestamp,
      )
    : undefined;
  const targetType: ScheduledJobTargetType = ralphFlow ? "ralph-flow" : "prompt";
  const prompt = normalizeSchedulerMultilineText(target.prompt);
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
    ...(target.provider ? { provider: target.provider } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.reasoning ? { reasoning: target.reasoning } : {}),
  };
};

const normalizeRetryPolicy = (
  retry: Partial<ScheduledRetryPolicy> | undefined,
  defaults: ScheduledRetryPolicy = DEFAULT_RETRY_POLICY,
): ScheduledRetryPolicy => {
  const minTimeoutMs = normalizeSchedulerPositiveInteger(
    retry?.minTimeoutMs,
    defaults.minTimeoutMs,
  );
  const maxTimeoutMs = Math.max(
    minTimeoutMs,
    normalizeSchedulerPositiveInteger(
      retry?.maxTimeoutMs,
      defaults.maxTimeoutMs,
    ),
  );

  return {
    maxAttempts: normalizeSchedulerPositiveInteger(
      retry?.maxAttempts,
      defaults.maxAttempts,
    ),
    factor: normalizeSchedulerPositiveNumber(retry?.factor, defaults.factor),
    minTimeoutMs,
    maxTimeoutMs,
    randomize: retry?.randomize ?? defaults.randomize,
  };
};

const getDefaultRetryPolicy = (
  target: ScheduledJobTarget,
): ScheduledRetryPolicy => {
  return target.ralphFlow?.executionProfile === "unattended"
    ? DEFAULT_UNATTENDED_RALPH_RETRY_POLICY
    : DEFAULT_RETRY_POLICY;
};

const normalizeQueuePolicy = (
  jobId: string,
  queue: Partial<ScheduledQueuePolicy> | undefined,
  target?: ScheduledJobTarget,
): ScheduledQueuePolicy => {
  const defaultConcurrencyKey =
    target?.ralphFlow?.executionProfile === "unattended"
      ? createCanonicalWorkspaceQueueKey(target.workspaceRoot)
      : jobId;

  return {
    concurrencyKey:
      normalizeSchedulerText(queue?.concurrencyKey) ?? defaultConcurrencyKey,
    concurrencyLimit: normalizeSchedulerPositiveInteger(
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
  const configuredName = getSchedulerFrontmatterString(attributes, "name");

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
    getSchedulerFrontmatterString(attributes, "schedule-cron") ??
    (typeof scheduleValue === "string" && scheduleValue.trim().includes(" ")
      ? scheduleValue.trim()
      : undefined);
  const timezone = getSchedulerFrontmatterString(attributes, "schedule-timezone");

  if (cron) {
    return {
      type: "cron",
      expression: cron,
      ...(timezone ? { timezone } : {}),
    };
  }

  const intervalMs = getSchedulerFrontmatterNumber(attributes, "schedule-interval-ms");
  const anchorAt = getSchedulerFrontmatterNumber(attributes, "schedule-anchor-at");

  if (intervalMs !== undefined) {
    return {
      type: "interval",
      intervalMs,
      ...(anchorAt !== undefined ? { anchorAt } : {}),
    };
  }

  const delayMs = getSchedulerFrontmatterNumber(attributes, "schedule-delay-ms");
  const runAt = getSchedulerFrontmatterNumber(attributes, "schedule-run-at");

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
    getSchedulerFrontmatterBoolean(document.attributes, "schedule-enabled") ??
    getSchedulerFrontmatterBoolean(document.attributes, "schedule") ??
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

  const modeText = getSchedulerFrontmatterString(document.attributes, "schedule-mode");
  const providerText = getSchedulerFrontmatterString(
    document.attributes,
    "schedule-provider",
  );
  const missedRunPolicyText = getSchedulerFrontmatterString(
    document.attributes,
    "schedule-missed-run-policy",
  );
  const scheduleArguments =
    getSchedulerFrontmatterString(document.attributes, "schedule-arguments") ?? "";
  const promptInvocation = `/${promptName}${scheduleArguments ? ` ${scheduleArguments}` : ""}`;
  const missedRunPolicy = isMissedRunPolicyValue(missedRunPolicyText)
    ? missedRunPolicyText
    : undefined;
  const model = getSchedulerFrontmatterString(document.attributes, "schedule-model");
  const missedRunGraceMs = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-missed-run-grace-ms",
  );
  const retryAttempts = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-retry-attempts",
  );
  const retryMinMs = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-retry-min-ms",
  );
  const retryMaxMs = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-retry-max-ms",
  );
  const retryFactor = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-retry-factor",
  );
  const retryRandomize = getSchedulerFrontmatterBoolean(
    document.attributes,
    "schedule-retry-randomize",
  );
  const concurrencyKey = getSchedulerFrontmatterString(
    document.attributes,
    "schedule-queue-key",
  );
  const concurrencyLimit = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-concurrency-limit",
  );
  const ttlMs = getSchedulerFrontmatterNumber(document.attributes, "schedule-ttl-ms");
  const maxDurationMs = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-max-duration-ms",
  );
  const historyLimit = getSchedulerFrontmatterNumber(
    document.attributes,
    "schedule-history-limit",
  );
  const maxCatchUpRuns = getSchedulerFrontmatterNumber(
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
      getSchedulerFrontmatterString(document.attributes, "schedule-name") ??
      `Prompt: ${promptName}`,
    schedule,
    target: {
      workspaceRoot,
      prompt: promptInvocation,
      contextPaths: getSchedulerFrontmatterStringList(
        document.attributes,
        "schedule-context",
      ),
      imagePaths: getSchedulerFrontmatterStringList(
        document.attributes,
        "schedule-image",
      ),
      ...(isRunModeValue(modeText) ? { mode: modeText } : {}),
      ...(isConfiguredProviderValue(providerText)
        ? { provider: providerText }
        : {}),
      ...(model ? { model } : {}),
    },
    dedupeKey:
      getSchedulerFrontmatterString(document.attributes, "schedule-dedupe-key") ??
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
    targetSnapshot?: ScheduledJobTarget;
    maxDurationMsSnapshot?: number;
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
    targetSnapshot: cloneScheduledValue(options.targetSnapshot ?? job.target),
    ...((options.maxDurationMsSnapshot ?? job.maxDurationMs) !== undefined
      ? { maxDurationMsSnapshot: options.maxDurationMsSnapshot ?? job.maxDurationMs }
      : {}),
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

const getRunChain = (
  state: SmartSchedulerState,
  parentRunId: string | undefined,
): ScheduledJobRun[] => {
  const chain: ScheduledJobRun[] = [];
  const visitedRunIds = new Set<string>();
  let cursor = parentRunId;

  while (cursor && !visitedRunIds.has(cursor)) {
    visitedRunIds.add(cursor);
    const run = state.runs.find((candidate) => candidate.id === cursor);

    if (!run) {
      break;
    }

    chain.push(run);
    cursor = run.parentRunId;

    if (chain.length > DEFAULT_SCHEDULER_SERVICE_MAX_CHAIN_DEPTH) {
      break;
    }
  }

  return chain;
};

const getJobEventChainSkipReason = (
  state: SmartSchedulerState,
  event: ScheduledTriggerEvent,
  targetJobId: string,
): string | undefined => {
  if (event.kind !== "job-event" || !event.parentRunId) {
    return undefined;
  }

  const chain = getRunChain(state, event.parentRunId);

  if (chain.length >= DEFAULT_SCHEDULER_SERVICE_MAX_CHAIN_DEPTH) {
    return `Skipped to avoid exceeding chained scheduler depth ${DEFAULT_SCHEDULER_SERVICE_MAX_CHAIN_DEPTH}.`;
  }

  if (chain.some((run) => run.jobId === targetJobId)) {
    return "Skipped to avoid a chained scheduler cycle.";
  }

  return undefined;
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
  state.mutationReceipts = state.mutationReceipts.slice(
    -DEFAULT_MUTATION_RECEIPT_LIMIT,
  );
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

const getRecordEntry = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const entry = value[key];

  return isRecordValue(entry) ? entry : undefined;
};

const getStringEntry = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const entry = value[key];

  return typeof entry === "string" && entry.trim() ? entry : undefined;
};

const getRalphCompletionMetadata = (
  result: TaskExecutionResult | undefined,
): Record<string, unknown> | undefined => {
  if (!result?.metadata) {
    return undefined;
  }

  return getRecordEntry(result.metadata, "ralphFlow");
};

const createRunCompletionPayload = (
  job: ScheduledJob,
  run: ScheduledJobRun,
): Record<string, unknown> => {
  return {
    jobId: job.id,
    jobName: job.name,
    runId: run.id,
    status: run.status,
    resultStatus: run.result?.status,
    targetType: job.target.type,
    source: run.source,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    scheduledFor: run.scheduledFor,
    enqueuedAt: run.enqueuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    queueKey: run.queueKey,
    triggerId: run.triggerId,
    eventId: run.eventId,
    parentRunId: run.parentRunId,
    summary: run.result?.summary,
    error: run.error,
  };
};

const createRalphCompletionPayload = (
  job: ScheduledJob,
  run: ScheduledJobRun,
  ralph: Record<string, unknown>,
): Record<string, unknown> => {
  return {
    ...createRunCompletionPayload(job, run),
    ralph: {
      scope: getStringEntry(ralph, "scope"),
      flowId: getStringEntry(ralph, "flowId"),
      flowName: getStringEntry(ralph, "flowName"),
      runId: getStringEntry(ralph, "runId"),
      status: getStringEntry(ralph, "status"),
      runLogScope: getStringEntry(ralph, "runLogScope"),
    },
  };
};

const createRunCompletionEventInputs = (
  job: ScheduledJob,
  run: ScheduledJobRun,
): ScheduledTriggerEventInput[] => {
  if (!isTerminalRunStatus(run.status)) {
    return [];
  }

  const baseEvent = {
    kind: "job-event" as const,
    source: "scheduler",
    workspaceRoot: job.target.workspaceRoot,
    parentRunId: run.id,
    occurredAt: run.finishedAt ?? run.updatedAt,
  };
  const genericPayload = createRunCompletionPayload(job, run);
  const events: ScheduledTriggerEventInput[] = [
    {
      ...baseEvent,
      type: "job-event.finished",
      payload: genericPayload,
      dedupeKey: `run:${run.id}:job-event.finished`,
    },
    {
      ...baseEvent,
      type: `job-event.${run.status}`,
      payload: genericPayload,
      dedupeKey: `run:${run.id}:job-event.${run.status}`,
    },
  ];
  const ralph = getRalphCompletionMetadata(run.result);
  const ralphStatus = ralph ? getStringEntry(ralph, "status") : undefined;

  if (ralph && ralphStatus) {
    const payload = createRalphCompletionPayload(job, run, ralph);

    events.push(
      {
        ...baseEvent,
        type: "job-event.ralph-flow.finished",
        payload,
        dedupeKey: `run:${run.id}:job-event.ralph-flow.finished`,
      },
      {
        ...baseEvent,
        type: `job-event.ralph-flow.${ralphStatus}`,
        payload,
        dedupeKey: `run:${run.id}:job-event.ralph-flow.${ralphStatus}`,
      },
    );
  }

  return events;
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

const normalizeTriggerEventInput = (
  input: ScheduledTriggerEventInput,
  timestamp: number,
): ScheduledTriggerEvent => {
  const type = normalizeSchedulerText(input.type);

  if (!type) {
    throw new Error("Expected scheduler event to include a type.");
  }

  const source = normalizeSchedulerText(input.source) ?? "manual";
  const workspaceRoot = normalizeSchedulerTrimmedText(input.workspaceRoot);
  const dedupeKey = normalizeSchedulerText(input.dedupeKey);
  const parentRunId = normalizeSchedulerText(input.parentRunId);
  const occurredAt =
    typeof input.occurredAt === "number" && Number.isFinite(input.occurredAt)
      ? Math.trunc(input.occurredAt)
      : timestamp;
  const kind = input.kind ?? inferSchedulerEventTriggerKind(type);

  return {
    id: createEventId(),
    type,
    kind,
    source,
    payload: normalizeSchedulerEventPayload(input.payload),
    occurredAt,
    receivedAt: timestamp,
    matches: [],
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(parentRunId ? { parentRunId } : {}),
  };
};

export class DurableSmartScheduler {
  private readonly statePath: string;
  private readonly workspaceRoot: string | undefined;
  private readonly executor: ScheduledTaskExecutor | undefined;
  private readonly clock: SchedulerClock;
  private readonly rng: () => number;
  private readonly runningHeartbeatMs: number;
  private readonly heartbeatRun:
    | ((runId: string, claimToken: string) => Promise<void>)
    | undefined;
  private stateMutation: Promise<void> = Promise.resolve();
  private readonly activeRunControllers = new Map<
    string,
    { claimToken: string; controller: AbortController }
  >();
  private workspaceRegistration: Promise<void> | undefined;

  constructor(options: DurableSmartSchedulerOptions) {
    this.statePath = options.statePath;
    this.workspaceRoot = options.workspaceRoot;
    this.executor = options.executor;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.rng = options.rng ?? Math.random;
    this.runningHeartbeatMs = Math.max(
      1,
      Math.trunc(options.runningHeartbeatMs ?? DEFAULT_SCHEDULER_RUNNING_HEARTBEAT_MS),
    );
    this.heartbeatRun = options.heartbeatRun;
  }

  private now(): number {
    return Math.trunc(this.clock.now());
  }

  private async ensureWorkspaceRegistered(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    this.workspaceRegistration ??= registerSchedulerWorkspace(this.workspaceRoot).then(
      () => undefined,
    );

    try {
      await this.workspaceRegistration;
    } catch (error) {
      this.workspaceRegistration = undefined;
      throw error;
    }
  }

  private async mutateState<T>(
    mutator: (state: SmartSchedulerState) => T | Promise<T>,
    request?: SchedulerMutationRequest,
  ): Promise<T> {
    await this.ensureWorkspaceRegistered();
    const mutation = this.stateMutation.then(async () => {
      return withSchedulerStateLock(this.statePath, async () => {
        const state = await readSmartSchedulerState(this.statePath);
        const requestKey = normalizeSchedulerText(request?.key);
        const payloadHash = requestKey && request
          ? createMutationPayloadHash(request.payload)
          : undefined;
        const existingReceipt = requestKey
          ? [...state.mutationReceipts]
              .reverse()
              .find((receipt) => receipt.key === requestKey)
          : undefined;

        if (existingReceipt && request && payloadHash) {
          if (
            existingReceipt.operation !== request.operation ||
            existingReceipt.target !== request.target ||
            existingReceipt.payloadHash !== payloadHash
          ) {
            throw new Error(
              `Scheduler mutation idempotency conflict for key \`${requestKey}\`.`,
            );
          }

          return structuredClone(existingReceipt.result) as T;
        }

        const result = await mutator(state);

        state.updatedAt = this.now();
        pruneRunHistory(state);
        if (requestKey && request && payloadHash) {
          state.mutationReceipts.push({
            key: requestKey,
            operation: request.operation,
            target: request.target,
            payloadHash,
            completedAt: state.updatedAt,
            result: structuredClone(result),
          });
          state.mutationReceipts = state.mutationReceipts.slice(
            -DEFAULT_MUTATION_RECEIPT_LIMIT,
          );
        }
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
    await this.ensureWorkspaceRegistered();
    return withSchedulerStateLock(this.statePath, () =>
      readSmartSchedulerState(this.statePath),
    );
  }

  async upsertJob(
    input: CreateScheduledJobInput,
    requestId?: string,
  ): Promise<ScheduledJob> {
    return this.mutateState(async (state) => {
      const now = this.now();
      const dedupeKey = normalizeSchedulerText(input.dedupeKey);
      const existingJob = dedupeKey
        ? state.jobs.find(
            (job) => job.dedupeKey === dedupeKey && job.status !== "deleted",
          )
        : undefined;
      const id = existingJob?.id ?? createJobId();
      const triggers = normalizeJobTriggers(input, now, existingJob);
      const schedule = getJobScheduleSummary(triggers);
      const target = await normalizeTarget(input.target, now, existingJob?.target);
      const retry = normalizeRetryPolicy(input.retry, getDefaultRetryPolicy(target));
      const queue = normalizeQueuePolicy(id, input.queue, target);
      const nextRunAt = getEarliestTriggerRunAt(triggers);
      const name =
        normalizeSchedulerText(input.name) ??
        existingJob?.name ??
        normalizeSchedulerTrimmedText(target.prompt.split(/\r?\n/u)[0]?.slice(0, 80)) ??
        "Scheduled job";
      const ttlMs = normalizeSchedulerOptionalPositiveInteger(input.ttlMs);
      const maxDurationMs = normalizeSchedulerOptionalPositiveInteger(input.maxDurationMs);
      const job: ScheduledJob = {
        id,
        name,
        status: "active",
        ...(schedule ? { schedule } : {}),
        triggers,
        target,
        missedRunPolicy: normalizeMissedRunPolicy(input.missedRunPolicy),
        missedRunGraceMs: normalizeSchedulerPositiveInteger(
          input.missedRunGraceMs,
          DEFAULT_MISSED_RUN_GRACE_MS,
        ),
        retry,
        queue,
        historyLimit: normalizeSchedulerPositiveInteger(
          input.historyLimit,
          DEFAULT_HISTORY_LIMIT,
        ),
        maxCatchUpRuns: normalizeSchedulerPositiveInteger(
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
    }, {
      key: requestId,
      operation: "upsert-job",
      target: normalizeSchedulerText(input.dedupeKey) ?? "new-job",
      payload: input,
    });
  }

  async updateJob(
    jobId: string,
    input: UpdateScheduledJobInput,
    requestId?: string,
  ): Promise<ScheduledJob> {
    return this.mutateState(async (state) => {
      const now = this.now();
      const existingJob = state.jobs.find(
        (candidate) => candidate.id === jobId,
      );

      if (!existingJob || existingJob.status === "deleted") {
        throw new Error(`Scheduled job not found: ${jobId}`);
      }

      const targetType = input.target?.type ?? existingJob.target.type;
      const targetInput: ScheduledJobTargetInput = {
        type: targetType,
        workspaceRoot:
          input.target?.workspaceRoot ?? existingJob.target.workspaceRoot,
        prompt: input.target?.prompt ?? existingJob.target.prompt,
        contextPaths:
          input.target?.contextPaths ?? existingJob.target.contextPaths,
        imagePaths: input.target?.imagePaths ?? existingJob.target.imagePaths,
        contextPacks:
          input.target?.contextPacks ?? existingJob.target.contextPacks,
        macros: input.target?.macros ?? existingJob.target.macros,
        ...(targetType === "ralph-flow"
          ? {
              ralphFlow:
                input.target?.ralphFlow ?? existingJob.target.ralphFlow ??
                (() => {
                  throw new Error("Expected updated Ralph target to include a flow id.");
                })(),
            }
          : {}),
        ...(input.target?.mode ?? existingJob.target.mode
          ? { mode: input.target?.mode ?? existingJob.target.mode }
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
      const target = await normalizeTarget(targetInput, now, existingJob.target);
      const enteredUnattendedRalphProfile =
        target.ralphFlow?.executionProfile === "unattended" &&
        existingJob.target.ralphFlow?.executionProfile !== "unattended";
      const workspaceChanged =
        target.workspaceRoot !== existingJob.target.workspaceRoot;
      const existingQueueWasWorkspaceDefault =
        existingJob.queue.concurrencyKey ===
        createCanonicalWorkspaceQueueKey(existingJob.target.workspaceRoot);
      const refreshDefaultQueue =
        enteredUnattendedRalphProfile ||
        (workspaceChanged && existingQueueWasWorkspaceDefault);
      const nextRunAt = getEarliestTriggerRunAt(triggers);
      const dedupeKey = normalizeSchedulerText(input.dedupeKey) ?? existingJob.dedupeKey;
      const ttlMs =
        input.ttlMs !== undefined
          ? normalizeSchedulerOptionalPositiveInteger(input.ttlMs)
          : existingJob.ttlMs;
      const maxDurationMs =
        input.maxDurationMs !== undefined
          ? normalizeSchedulerOptionalPositiveInteger(input.maxDurationMs)
          : existingJob.maxDurationMs;
      const updatedJob: ScheduledJob = {
        id: existingJob.id,
        name: normalizeSchedulerText(input.name) ?? existingJob.name,
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
            ? normalizeSchedulerPositiveInteger(
                input.missedRunGraceMs,
                existingJob.missedRunGraceMs,
              )
            : existingJob.missedRunGraceMs,
        retry: input.retry
          ? normalizeRetryPolicy(
              { ...existingJob.retry, ...input.retry },
              getDefaultRetryPolicy(target),
            )
          : enteredUnattendedRalphProfile
            ? normalizeRetryPolicy(undefined, getDefaultRetryPolicy(target))
            : existingJob.retry,
        queue: input.queue
          ? normalizeQueuePolicy(
              existingJob.id,
              {
                ...(refreshDefaultQueue ? {} : existingJob.queue),
                ...input.queue,
              },
              target,
            )
          : refreshDefaultQueue
            ? normalizeQueuePolicy(existingJob.id, undefined, target)
            : existingJob.queue,
        historyLimit:
          input.historyLimit !== undefined
            ? normalizeSchedulerPositiveInteger(input.historyLimit, existingJob.historyLimit)
            : existingJob.historyLimit,
        maxCatchUpRuns:
          input.maxCatchUpRuns !== undefined
            ? normalizeSchedulerPositiveInteger(
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
    }, {
      key: requestId,
      operation: "update-job",
      target: jobId,
      payload: input,
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

  async pauseJob(jobId: string, requestId?: string): Promise<ScheduledJob> {
    return this.setJobStatus(jobId, "paused", requestId);
  }

  async resumeJob(jobId: string, requestId?: string): Promise<ScheduledJob> {
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
    }, {
      key: requestId,
      operation: "resume-job",
      target: jobId,
      payload: {},
    });
  }

  async deleteJob(jobId: string, requestId?: string): Promise<ScheduledJob> {
    return this.setJobStatus(jobId, "deleted", requestId);
  }

  private async setJobStatus(
    jobId: string,
    status: ScheduledJobStatus,
    requestId?: string,
  ): Promise<ScheduledJob> {
    return this.mutateState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);

      if (!job || job.status === "deleted") {
        throw new Error(`Scheduled job not found: ${jobId}`);
      }

      job.status = status;
      job.updatedAt = this.now();

      return { ...job };
    }, {
      key: requestId,
      operation: status === "paused" ? "pause-job" : "delete-job",
      target: jobId,
      payload: {},
    });
  }

  async enqueueDueRuns(): Promise<ScheduledRunEnqueueResult[]> {
    return this.mutateState(async (state) => {
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

        let ralphTargetUsable = true;
        let ralphRefreshError: string | undefined;

        if (enqueueTimes.length > 0 && job.target.ralphFlow) {
          const refresh = await refreshScheduledRalphTarget(
            job.target.workspaceRoot,
            job.target.ralphFlow,
            now,
          );
          job.target = {
            ...job.target,
            ralphFlow: refresh.target,
          };
          ralphTargetUsable = refresh.usable;
          ralphRefreshError = refresh.error;
        }

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
            ralphTargetUsable ? "queued" : "failed",
            enqueueTime.scheduledFor,
            now,
            "schedule",
            { triggerId: enqueueTime.triggerId },
          );

          if (!ralphTargetUsable) {
            run.finishedAt = now;
            run.updatedAt = now;
            run.error =
              `Scheduled Ralph flow revision could not be refreshed and no pinned fallback exists: ${ralphRefreshError ?? "unknown error"}`;
            state.runs.push(run);
            continue;
          }

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

  async triggerJobNow(
    jobId: string,
    idempotencyKey?: string,
  ): Promise<ScheduledRunEnqueueResult> {
    const normalizedIdempotencyKey = normalizeSchedulerText(idempotencyKey);

    return this.mutateState(async (state) => {
      const now = this.now();
      const job = state.jobs.find((candidate) => candidate.id === jobId);

      if (!job || job.status === "deleted") {
        throw new Error(`Scheduled job not found: ${jobId}`);
      }

      if (job.target.ralphFlow) {
        const refresh = await refreshScheduledRalphTarget(
          job.target.workspaceRoot,
          job.target.ralphFlow,
          now,
        );
        if (!refresh.usable) {
          throw new Error(
            `Scheduled Ralph flow revision could not be refreshed: ${refresh.error ?? "unknown error"}`,
          );
        }
        job.target = {
          ...job.target,
          ralphFlow: refresh.target,
        };
      }

      const run = createRun(job, "queued", now, now, "manual");

      if (normalizedIdempotencyKey) {
        run.idempotencyKey = normalizedIdempotencyKey;
      }

      job.lastEnqueuedAt = now;
      job.updatedAt = now;
      state.runs.push(run);

      return {
        handle: createRunHandle(run),
        run: { ...run },
        deduplicated: false,
      };
    }, {
      key: normalizedIdempotencyKey,
      operation: "trigger-job",
      target: jobId,
      payload: {},
    });
  }

  async recordEventAndEnqueueRuns(
    input: ScheduledTriggerEventInput,
  ): Promise<ScheduledTriggerEventResult> {
    return this.mutateState(async (state) => {
      const now = this.now();
      const event = normalizeTriggerEventInput(input, now);
      const enqueued: ScheduledRunEnqueueResult[] = [];
      const refreshedRalphJobIds = new Set<string>();
      const unusableRalphJobs = new Map<string, string>();
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

          if (!schedulerEventTypeMatches(trigger, event)) {
            continue;
          }

          const match: ScheduledTriggerEventMatch = {
            jobId: job.id,
            triggerId: trigger.id,
            matched: false,
          };

          const activationMatched = schedulerEventFiltersMatch(trigger, event);

          const isStatefulTrigger =
            getSchedulerEventTriggerFiringMode(trigger) === "state";
          const wasStateActive = trigger.lastState === "active";

          if (
            isStatefulTrigger &&
            wasStateActive &&
            getSchedulerEventTriggerRecoveryMatched(
              trigger,
              event,
              activationMatched,
            )
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
            ? getSchedulerStatefulTriggerSkipReason(trigger, event)
            : undefined;

          if (statefulSkipReason) {
            trigger.lastMatchedAt = now;
            trigger.lastSkippedAt = now;
            match.skippedReason = statefulSkipReason;
            event.matches.push(match);
            continue;
          }

          const cooldownSkipReason = getSchedulerTriggerCooldownSkipReason(
            trigger,
            event,
          );

          if (cooldownSkipReason) {
            trigger.lastSkippedAt = now;
            match.skippedReason = cooldownSkipReason;
            event.matches.push(match);
            continue;
          }

          const rateLimitSkipReason = getSchedulerTriggerRateLimitSkipReason(
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

          const chainSkipReason = getJobEventChainSkipReason(state, event, job.id);

          if (chainSkipReason) {
            trigger.lastMatchedAt = now;
            trigger.lastSkippedAt = now;
            match.skippedReason = chainSkipReason;
            event.matches.push(match);
            continue;
          }

          const dedupeSuffix = createSchedulerEventRunDedupeSuffix(
            job,
            trigger,
            event,
          );
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

          if (job.target.ralphFlow && !refreshedRalphJobIds.has(job.id)) {
            const refresh = await refreshScheduledRalphTarget(
              job.target.workspaceRoot,
              job.target.ralphFlow,
              now,
            );
            job.target = {
              ...job.target,
              ralphFlow: refresh.target,
            };
            refreshedRalphJobIds.add(job.id);
            if (!refresh.usable) {
              unusableRalphJobs.set(
                job.id,
                refresh.error ?? "unknown Ralph flow refresh error",
              );
            }
          }

          const refreshError = unusableRalphJobs.get(job.id);
          if (refreshError) {
            trigger.lastSkippedAt = now;
            match.skippedReason =
              `Scheduled Ralph flow revision could not be refreshed: ${refreshError}`;
            event.matches.push(match);
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
              ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
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

  async recoverAbandonedRuns(
    reason = "Scheduler service recovered an abandoned running run.",
    staleAfterMs = DEFAULT_SCHEDULER_ABANDONED_RUN_STALE_MS,
  ): Promise<SchedulerRecoveredRun[]> {
    const state = await this.getState();
    const now = this.now();
    const abandonedRuns = state.runs.filter((run) => {
      const activeClaim = this.activeRunControllers.get(run.id);

      return (
        run.status === "running" &&
        (!activeClaim || activeClaim.claimToken !== run.claimToken) &&
        now - run.updatedAt >= staleAfterMs
      );
    });
    const recovered: SchedulerRecoveredRun[] = [];

    for (const run of abandonedRuns) {
      let finishedRun: ScheduledJobRun;

      try {
        finishedRun = await this.finishRunAttempt(run.id, run.claimToken, {
          status: "failed",
          error: reason,
        });
      } catch (error) {
        if (isStaleScheduledRunClaimError(error)) {
          continue;
        }

        throw error;
      }

      recovered.push({
        runId: finishedRun.id,
        jobId: finishedRun.jobId,
        previousStatus: "running",
        status: finishedRun.status,
      });
    }

    return recovered;
  }

  async runDueJobs(
    options: RunQueuedScheduledJobsOptions = {},
  ): Promise<RunQueuedScheduledJobsResult> {
    if (options.recoverAbandoned !== false) {
      await this.recoverAbandonedRuns(
        "Scheduler runner recovered an abandoned running run.",
      );
    }
    const queued = await this.enqueueDueRuns();
    const runs = await this.runQueuedRuns(options);

    return {
      runs,
      queued: queued.map((result) => result.run),
    };
  }

  async runService(
    options: SchedulerServiceOptions = {},
  ): Promise<SchedulerServiceResult> {
    const pollIntervalMs = Math.max(
      1,
      Math.trunc(options.pollIntervalMs ?? DEFAULT_SCHEDULER_SERVICE_POLL_INTERVAL_MS),
    );
    const idleShutdownMs = Math.max(
      0,
      Math.trunc(options.idleShutdownMs ?? DEFAULT_SCHEDULER_SERVICE_IDLE_SHUTDOWN_MS),
    );
    const abandonedRunStaleMs = Math.max(
      DEFAULT_SCHEDULER_RUNNING_HEARTBEAT_MS,
      Math.trunc(options.abandonedRunStaleMs ?? DEFAULT_SCHEDULER_ABANDONED_RUN_STALE_MS),
    );
    const maxIterations =
      options.maxIterations !== undefined
        ? Math.max(1, Math.trunc(options.maxIterations))
        : undefined;
    const result: SchedulerServiceResult = {
      iterations: 0,
      recoveredRuns: 0,
      queuedRuns: 0,
      finishedRuns: 0,
    };
    let idleSince: number | undefined;

    while (!options.signal?.aborted) {
      const recovered = await this.recoverAbandonedRuns(
        "Scheduler service recovered an abandoned running run.",
        abandonedRunStaleMs,
      );
      const due = await this.runDueJobs(
        options.maxRunsPerTick !== undefined
          ? {
              maxRuns: options.maxRunsPerTick,
              recoverAbandoned: false,
              ...(options.signal ? { signal: options.signal } : {}),
            }
          : {
              recoverAbandoned: false,
              ...(options.signal ? { signal: options.signal } : {}),
            },
      );
      const iteration: SchedulerServiceIterationResult = {
        recovered,
        queued: due.queued,
        runs: due.runs,
      };

      result.iterations += 1;
      result.recoveredRuns += recovered.length;
      result.queuedRuns += due.queued.length;
      result.finishedRuns += due.runs.length;

      await options.onIteration?.(iteration);

      const didFinishOrRecover = recovered.length > 0 || due.runs.length > 0;

      if (didFinishOrRecover) {
        idleSince = undefined;
      } else {
        idleSince ??= this.now();
      }

      if (maxIterations !== undefined && result.iterations >= maxIterations) {
        break;
      }

      if (
        idleShutdownMs > 0 &&
        idleSince !== undefined &&
        this.now() - idleSince >= idleShutdownMs
      ) {
        break;
      }

      await sleepWithSignal(didFinishOrRecover ? 1 : pollIntervalMs, options.signal);
    }

    return result;
  }

  async runQueuedRuns(
    options: RunQueuedScheduledJobsOptions = {},
  ): Promise<ScheduledJobRun[]> {
    if (!this.executor) {
      throw new Error("Cannot run scheduled jobs without a scheduler executor.");
    }

    if (options.signal?.aborted) {
      return [];
    }

    const selectedRuns = await this.claimQueuedRuns(
      options.maxRuns,
      options.signal,
    );

    const finishedRuns = await Promise.all(
      selectedRuns.map((run) => {
        if (!run.claimToken) {
          throw new Error(`Scheduled run claim token was not persisted: ${run.id}`);
        }

        return this.executeClaimedRun(run.id, run.claimToken, options.signal);
      }),
    );

    return finishedRuns;
  }

  private async claimQueuedRuns(
    maxRuns: number | undefined,
    signal?: AbortSignal,
  ): Promise<ScheduledJobRun[]> {
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
        if (signal?.aborted || selectedRuns.length >= maxSelected) {
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
        run.claimToken = createRunClaimToken(run.attempt);
        delete run.nextAttemptAt;
        job.lastStartedAt = now;
        job.updatedAt = now;
        selectedRuns.push({ ...run });
      }

      return selectedRuns;
    });
  }

  private async executeClaimedRun(
    runId: string,
    claimToken: string,
    signal?: AbortSignal,
  ): Promise<ScheduledJobRun> {
    if (!this.executor) {
      throw new Error("Cannot run scheduled jobs without a scheduler executor.");
    }

    const controller = new AbortController();
    const forwardAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(signal?.reason ?? "Scheduler service stopped.");
      }
    };
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) {
      forwardAbort();
    }
    this.activeRunControllers.set(runId, { claimToken, controller });
    let cleanupMaxDurationTimer = (): void => undefined;
    const cleanupHeartbeat = this.startRunningRunHeartbeat(
      runId,
      claimToken,
      controller,
    );

    try {
      const { job, run, event } = await this.getRunnableSnapshot(
        runId,
        claimToken,
      );
      const request = this.createExecutionRequest(job, run, event);
      cleanupMaxDurationTimer = attachMaxDurationTimer(
        controller,
        run.maxDurationMsSnapshot ?? job.maxDurationMs,
      );
      const result = await this.executor.execute(request, {
        signal: controller.signal,
        ...((run.maxDurationMsSnapshot ?? job.maxDurationMs)
          ? { maxDurationMs: run.maxDurationMsSnapshot ?? job.maxDurationMs }
          : {}),
      });

      if (signal?.aborted) {
        return await this.finishRunAttempt(runId, claimToken, {
          status: "failed",
          result,
          error: signal.reason
            ? `Scheduler worker stopped: ${String(signal.reason)}`
            : "Scheduler worker stopped.",
          infrastructureAbort: true,
        });
      }

      return await this.finishRunWithResult(runId, claimToken, controller, result);
    } catch (error: unknown) {
      if (isStaleScheduledRunClaimError(error)) {
        throw error;
      }

      if (signal?.aborted) {
        return await this.finishRunAttempt(runId, claimToken, {
          status: "failed",
          error: signal.reason
            ? `Scheduler worker stopped: ${String(signal.reason)}`
            : errorToMessage(error),
          infrastructureAbort: true,
        });
      }

      return await this.finishRunWithError(runId, claimToken, controller, error);
    } finally {
      cleanupMaxDurationTimer();
      cleanupHeartbeat();
      if (this.activeRunControllers.get(runId)?.claimToken === claimToken) {
        this.activeRunControllers.delete(runId);
      }
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private startRunningRunHeartbeat(
    runId: string,
    claimToken: string,
    controller: AbortController,
  ): () => void {
    const timer = setInterval(() => {
      void (
        this.heartbeatRun?.(runId, claimToken) ??
        this.touchRunningRun(runId, claimToken)
      ).catch((error) => {
        if (!controller.signal.aborted) {
          controller.abort(
            `${SCHEDULER_HEARTBEAT_FAILURE_PREFIX}: ${errorToMessage(error)}`,
          );
        }
      });
    }, this.runningHeartbeatMs);

    return () => clearInterval(timer);
  }

  private async touchRunningRun(
    runId: string,
    claimToken: string,
  ): Promise<void> {
    await this.mutateState((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);

      if (
        !run ||
        run.status !== "running" ||
        run.claimToken !== claimToken
      ) {
        throw new StaleScheduledRunClaimError(runId);
      }

      run.updatedAt = this.now();
    });
  }

  private async getRunnableSnapshot(
    runId: string,
    claimToken: string,
  ): Promise<{ job: ScheduledJob; run: ScheduledJobRun; event?: ScheduledTriggerEvent }> {
    const state = await this.getState();
    const run = state.runs.find((candidate) => candidate.id === runId);

    if (
      !run ||
      run.status !== "running" ||
      run.claimToken !== claimToken
    ) {
      throw new StaleScheduledRunClaimError(runId);
    }

    const job = state.jobs.find((candidate) => candidate.id === run.jobId);

    if (!job) {
      throw new Error(`Scheduled job not found for run: ${runId}`);
    }

    const event = run.eventId
      ? state.events.find((candidate) => candidate.id === run.eventId)
      : undefined;

    const snapshotJob = run.targetSnapshot
      ? { ...job, target: cloneScheduledValue(run.targetSnapshot) }
      : job;

    return { job: snapshotJob, run, ...(event ? { event } : {}) };
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
      ...(job.target.provider ? { provider: job.target.provider } : {}),
      ...(job.target.model ? { model: job.target.model } : {}),
      ...(job.target.reasoning ? { reasoning: job.target.reasoning } : {}),
    };
  }

  private async finishRunWithResult(
    runId: string,
    claimToken: string,
    controller: AbortController,
    result: TaskExecutionResult,
  ): Promise<ScheduledJobRun> {
    if (
      typeof controller.signal.reason === "string" &&
      controller.signal.reason.startsWith(SCHEDULER_HEARTBEAT_FAILURE_PREFIX)
    ) {
      return this.finishRunAttempt(runId, claimToken, {
        status: "failed",
        result,
        error: controller.signal.reason,
      });
    }

    if (isTimeoutReason(controller.signal.reason)) {
      return this.finishRunAttempt(runId, claimToken, {
        status: "timed_out",
        result,
        error: String(controller?.signal.reason),
      });
    }

    if (controller.signal.aborted) {
      return this.finishRunAttempt(runId, claimToken, {
        status: "cancelled",
        result,
        error: controller.signal.reason
          ? String(controller.signal.reason)
          : "Scheduled run cancelled.",
      });
    }

    if (taskResultCancelled(result)) {
      return this.finishRunAttempt(runId, claimToken, {
        status: "cancelled",
        result,
        error: result.reason ?? result.summary,
      });
    }

    if (taskResultSucceeded(result)) {
      return this.finishRunAttempt(runId, claimToken, {
        status: "succeeded",
        result,
      });
    }

    return this.finishRunAttempt(runId, claimToken, {
      status: "failed",
      result,
      error: result.reason ?? result.summary,
    });
  }

  private async finishRunWithError(
    runId: string,
    claimToken: string,
    controller: AbortController,
    error: unknown,
  ): Promise<ScheduledJobRun> {
    const message =
      controller.signal.aborted && controller.signal.reason
        ? String(controller.signal.reason)
        : errorToMessage(error);

    if (message.startsWith(SCHEDULER_HEARTBEAT_FAILURE_PREFIX)) {
      return this.finishRunAttempt(runId, claimToken, {
        status: "failed",
        error: message,
      });
    }

    return this.finishRunAttempt(runId, claimToken, {
      status: isTimeoutReason(controller.signal.reason)
        ? "timed_out"
        : controller.signal.aborted
          ? "cancelled"
          : "failed",
      error: message,
    });
  }

  private async finishRunAttempt(
    runId: string,
    claimToken: string | undefined,
    outcome: {
      status: "succeeded" | "failed" | "cancelled" | "timed_out";
      result?: TaskExecutionResult;
      error?: string;
      infrastructureAbort?: boolean;
    },
  ): Promise<ScheduledJobRun> {
    const finished = await this.mutateState((state) => {
      const now = this.now();
      const run = state.runs.find((candidate) => candidate.id === runId);

      if (
        !run ||
        run.status !== "running" ||
        run.claimToken !== claimToken
      ) {
        throw new StaleScheduledRunClaimError(runId);
      }

      const job = state.jobs.find((candidate) => candidate.id === run.jobId);
      const attemptStartedAt = run.startedAt ?? now;
      const infrastructureRetry =
        outcome.infrastructureAbort === true &&
        run.cancelRequestedAt === undefined;
      if (infrastructureRetry) {
        // A service lifecycle must not consume the job's configured execution
        // attempts. The next claim uses the same run and immutable snapshot,
        // while Ralph can resume the durable checkpoint from this failed attempt.
        run.maxAttempts = Math.max(run.maxAttempts, run.attempt + 1);
      }
      const finalStatus =
        run.cancelRequestedAt !== undefined
          ? "cancelled"
          : infrastructureRetry
            ? "failed"
            : outcome.status;
      const finalError =
        run.cancelRequestedAt !== undefined
          ? run.cancelReason ?? outcome.error
          : outcome.error;
      const shouldRetry =
        infrastructureRetry ||
        ((finalStatus === "failed" || finalStatus === "timed_out") &&
          run.attempt < run.maxAttempts);
      const nextRetryAt = shouldRetry
        ? infrastructureRetry
          ? now
          : now +
            getRetryDelayMs(
              job?.retry ?? DEFAULT_RETRY_POLICY,
              run.attempt,
              this.rng,
            )
        : undefined;
      const attempt: ScheduledRunAttempt = {
        attempt: run.attempt,
        ...(claimToken ? { claimToken } : {}),
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
      delete run.claimToken;

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

      return {
        run: { ...run },
        ...(job ? { job: { ...job } } : {}),
        emitCompletionEvents: !shouldRetry && isTerminalRunStatus(run.status),
      };
    });

    if (finished.emitCompletionEvents && finished.job) {
      await this.recordRunCompletionEvents(finished.job, finished.run);
    }

    return finished.run;
  }

  private async recordRunCompletionEvents(
    job: ScheduledJob,
    run: ScheduledJobRun,
  ): Promise<void> {
    const events = createRunCompletionEventInputs(job, run);

    for (const event of events) {
      await this.recordEventAndEnqueueRuns(event);
    }
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
    idempotencyKey?: string,
  ): Promise<ScheduledJobRun> {
    const runId = resolveRunId(handleOrRunId);
    const run = await this.mutateState<ScheduledJobRun>((state) => {
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
    }, {
      key: idempotencyKey,
      operation: "cancel-run",
      target: runId,
      payload: { reason },
    });

    const activeClaim = this.activeRunControllers.get(runId);
    if (
      run.status === "running" &&
      run.claimToken !== undefined &&
      activeClaim?.claimToken === run.claimToken &&
      !activeClaim.controller.signal.aborted
    ) {
      activeClaim.controller.abort(reason);
    }

    return run;
  }

  async retryRun(
    handleOrRunId: ScheduledRunHandle | string,
    idempotencyKey?: string,
  ): Promise<ScheduledRunHandle> {
    const runId = resolveRunId(handleOrRunId);
    const normalizedIdempotencyKey = normalizeSchedulerText(idempotencyKey);

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
          ...(parentRun.targetSnapshot
            ? { targetSnapshot: parentRun.targetSnapshot }
            : {}),
          ...(parentRun.maxDurationMsSnapshot !== undefined
            ? { maxDurationMsSnapshot: parentRun.maxDurationMsSnapshot }
            : {}),
          ...(parentRun.triggerId ? { triggerId: parentRun.triggerId } : {}),
          ...(parentRun.eventId ? { eventId: parentRun.eventId } : {}),
        },
      );

      if (normalizedIdempotencyKey) {
        retryRun.idempotencyKey = normalizedIdempotencyKey;
      }

      state.runs.push(retryRun);

      return {
        jobId: job.id,
        runId: retryRun.id,
        status: retryRun.status,
      };
    }, {
      key: normalizedIdempotencyKey,
      operation: "retry-run",
      target: runId,
      payload: {},
    });
  }
}
