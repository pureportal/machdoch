import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parseMarkdownDocument } from "./frontmatter.js";
import type {
  FrontmatterValue,
  ModelProvider,
  RunMode,
  TaskExecutionOptions,
  TaskExecutionResult,
} from "./types.js";

export const SMART_SCHEDULER_SCHEMA = "machdoch.smartScheduler" as const;
export const SMART_SCHEDULER_SCHEMA_VERSION = 1 as const;
export const SMART_SCHEDULER_FILE_NAME = "scheduler.json";

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_MISSED_RUN_POLICY: ScheduledMissedRunPolicy = "enqueue-latest";
const DEFAULT_MISSED_RUN_GRACE_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_MAX_CATCH_UP_RUNS = 100;
const DEFAULT_CONCURRENCY_LIMIT = 1;
const DEFAULT_RETRY_POLICY: ScheduledRetryPolicy = {
  maxAttempts: 1,
  factor: 2,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  randomize: true,
};
const MINUTE_MS = 60_000;
const CRON_LOOKAHEAD_MS = 366 * 24 * 60 * MINUTE_MS;
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

export type ScheduledRunSource = "schedule" | "manual" | "manual-retry";

export type ScheduledMissedRunPolicy = "skip" | "enqueue-latest" | "enqueue-all";

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

export interface ScheduledJobTarget {
  workspaceRoot: string;
  prompt: string;
  contextPaths: string[];
  imagePaths: string[];
  contextPacks: ScheduledContextPackSnapshot[];
  macros: ScheduledMacroReference[];
  mode?: RunMode;
  profile?: string;
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
}

export interface ScheduledJobTargetInput {
  workspaceRoot: string;
  prompt?: string;
  contextPaths?: string[];
  imagePaths?: string[];
  contextPacks?: ScheduledContextPackSnapshot[];
  macros?: ScheduledMacroReference[];
  mode?: RunMode;
  profile?: string;
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
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
  schedule: ScheduledJobSchedule;
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
  schedule: ScheduledJobScheduleInput;
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
  task: string;
  workspaceRoot: string;
  contextPaths: string[];
  imagePaths: string[];
  mode?: RunMode;
  profile?: string;
  provider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
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

export interface CronField {
  any: boolean;
  values: ReadonlySet<number>;
  lastDayOfMonth: boolean;
  lastWeekdays: ReadonlySet<number>;
}

export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export interface TimeZoneDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const createEmptySchedulerState = (timestamp: number): SmartSchedulerState => ({
  schema: SMART_SCHEDULER_SCHEMA,
  schemaVersion: SMART_SCHEDULER_SCHEMA_VERSION,
  createdAt: timestamp,
  updatedAt: timestamp,
  jobs: [],
  runs: [],
});

export const getWorkspaceSchedulerStatePath = (workspaceRoot: string): string => {
  return join(workspaceRoot, ".machdoch", SMART_SCHEDULER_FILE_NAME);
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
    jobs: parsed.jobs,
    runs: parsed.runs,
  };
};

export const writeSmartSchedulerState = async (
  statePath: string,
  state: SmartSchedulerState,
): Promise<void> => {
  await mkdir(dirname(statePath), { recursive: true });

  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
};

const createJobId = (): string => `sched_${randomUUID()}`;

const createRunId = (): string => `run_${randomUUID()}`;

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

const normalizeTarget = (target: ScheduledJobTargetInput): ScheduledJobTarget => {
  const workspaceRoot = normalizeTrimmedText(target.workspaceRoot);

  if (!workspaceRoot) {
    throw new Error("Expected scheduled job target to include a workspace root.");
  }

  const prompt = normalizeMultilineText(target.prompt);
  const contextPacks = (target.contextPacks ?? []).flatMap((pack) => {
    const normalized = normalizeContextPack(pack);

    return normalized ? [normalized] : [];
  });
  const macros = (target.macros ?? []).flatMap((macro) => {
    const normalized = normalizeMacroReference(macro);

    return normalized ? [normalized] : [];
  });

  if (!prompt && contextPacks.length === 0 && macros.length === 0) {
    throw new Error(
      "Expected scheduled job target to include a prompt, context pack, or macro.",
    );
  }

  return {
    workspaceRoot,
    prompt,
    contextPaths: normalizeStringList(target.contextPaths),
    imagePaths: normalizeStringList(target.imagePaths),
    contextPacks,
    macros,
    ...(target.mode ? { mode: target.mode } : {}),
    ...(target.profile ? { profile: target.profile } : {}),
    ...(target.provider ? { provider: target.provider } : {}),
    ...(target.model ? { model: target.model } : {}),
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
): string | undefined => {
  return job.dedupeKey ? `${job.dedupeKey}:${scheduledFor}` : undefined;
};

const createRun = (
  job: ScheduledJob,
  status: ScheduledRunStatus,
  scheduledFor: number,
  enqueuedAt: number,
  source: ScheduledRunSource,
  parentRunId?: string,
): ScheduledJobRun => {
  const dedupeKey = createRunDedupeKey(job, scheduledFor);
  const expiresAt = job.ttlMs ? enqueuedAt + job.ttlMs : undefined;

  return {
    id: createRunId(),
    jobId: job.id,
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
    ...(parentRunId ? { parentRunId } : {}),
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
  scheduledFor: number,
): ScheduledJobRun | undefined => {
  return state.runs.find(
    (run) =>
      run.jobId === jobId &&
      run.source === "schedule" &&
      run.scheduledFor === scheduledFor,
  );
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

const getDaysInMonth = (year: number, month: number): number => {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const createRange = (min: number, max: number): number[] => {
  return Array.from({ length: max - min + 1 }, (_value, index) => min + index);
};

const parseCronNumber = (
  value: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>>,
  normalize?: (value: number) => number,
): number => {
  const raw = value.trim().toLowerCase();
  const named = names[raw];
  const parsed = named ?? Number(raw);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron field value: ${value}`);
  }

  const normalized = normalize?.(parsed) ?? parsed;

  if (normalized < min || normalized > max) {
    throw new Error(`Cron field value out of range: ${value}`);
  }

  return normalized;
};

const parseCronField = (
  field: string,
  min: number,
  max: number,
  names: Readonly<Record<string, number>> = {},
  options?: {
    allowLastDayOfMonth?: boolean;
    allowLastWeekday?: boolean;
    normalize?: (value: number) => number;
  },
): CronField => {
  const values = new Set<number>();
  const lastWeekdays = new Set<number>();
  let any = false;
  let lastDayOfMonth = false;

  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();

    if (!part) {
      throw new Error(`Invalid cron field: ${field}`);
    }

    if (part === "*") {
      any = true;
      for (const value of createRange(min, max)) {
        values.add(value);
      }
      continue;
    }

    if (part === "L" && options?.allowLastDayOfMonth) {
      lastDayOfMonth = true;
      continue;
    }

    if (part.endsWith("L") && options?.allowLastWeekday) {
      const weekday = parseCronNumber(
        part.slice(0, -1),
        min,
        max,
        names,
        options.normalize,
      );
      lastWeekdays.add(weekday);
      continue;
    }

    const [base, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;

    if (!base || !Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${part}`);
    }

    const range =
      base === "*"
        ? [min, max]
        : base.includes("-")
          ? base
              .split("-")
              .map((value) =>
                parseCronNumber(value, min, max, names, options?.normalize),
              )
          : [
              parseCronNumber(base, min, max, names, options?.normalize),
              parseCronNumber(base, min, max, names, options?.normalize),
            ];
    const [start, end] = range;

    if (start === undefined || end === undefined || start > end) {
      throw new Error(`Invalid cron range: ${part}`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return {
    any,
    values,
    lastDayOfMonth,
    lastWeekdays,
  };
};

export const parseCronExpression = (expression: string): ParsedCronExpression => {
  const fields = expression.trim().split(/\s+/u);

  if (fields.length !== 5) {
    throw new Error("Cron schedules must use five fields; seconds are not supported.");
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, {}, {
      allowLastDayOfMonth: true,
    }),
    month: parseCronField(month, 1, 12, MONTH_NAMES),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6, WEEKDAY_NAMES, {
      allowLastWeekday: true,
      normalize: (value) => (value === 7 ? 0 : value),
    }),
  };
};

const getTimeZoneDateParts = (
  timestamp: number,
  timezone: string,
): TimeZoneDateParts => {
  const formatter = new Intl.DateTimeFormat("en-US-u-hc-h23", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = new Map(
    formatter.formatToParts(new Date(timestamp)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  const weekday = parts.get("weekday")?.toLowerCase().slice(0, 3);
  const dayOfWeek = weekday ? WEEKDAY_NAMES[weekday] : undefined;

  if (dayOfWeek === undefined) {
    throw new Error(`Unable to resolve weekday in timezone ${timezone}.`);
  }

  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    dayOfWeek,
  };
};

const cronFieldMatches = (
  field: CronField,
  value: number,
  parts: TimeZoneDateParts,
  kind: "dayOfMonth" | "dayOfWeek" | "other",
): boolean => {
  if (field.values.has(value)) {
    return true;
  }

  if (
    kind === "dayOfMonth" &&
    field.lastDayOfMonth &&
    parts.day === getDaysInMonth(parts.year, parts.month)
  ) {
    return true;
  }

  if (
    kind === "dayOfWeek" &&
    field.lastWeekdays.has(value) &&
    parts.day + 7 > getDaysInMonth(parts.year, parts.month)
  ) {
    return true;
  }

  return false;
};

const cronDayMatches = (
  parsed: ParsedCronExpression,
  parts: TimeZoneDateParts,
): boolean => {
  const dayOfMonthMatches = cronFieldMatches(
    parsed.dayOfMonth,
    parts.day,
    parts,
    "dayOfMonth",
  );
  const dayOfWeekMatches = cronFieldMatches(
    parsed.dayOfWeek,
    parts.dayOfWeek,
    parts,
    "dayOfWeek",
  );

  if (!parsed.dayOfMonth.any && !parsed.dayOfWeek.any) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }

  return dayOfMonthMatches && dayOfWeekMatches;
};

const cronExpressionMatches = (
  parsed: ParsedCronExpression,
  parts: TimeZoneDateParts,
): boolean => {
  return (
    cronFieldMatches(parsed.minute, parts.minute, parts, "other") &&
    cronFieldMatches(parsed.hour, parts.hour, parts, "other") &&
    cronFieldMatches(parsed.month, parts.month, parts, "other") &&
    cronDayMatches(parsed, parts)
  );
};

export const getNextCronRunAfter = (
  expression: string,
  timezone: string,
  afterTimestamp: number,
): number => {
  const parsed = parseCronExpression(expression);
  const endTimestamp = afterTimestamp + CRON_LOOKAHEAD_MS;
  let candidate =
    Math.floor(afterTimestamp / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  while (candidate <= endTimestamp) {
    if (
      cronExpressionMatches(
        parsed,
        getTimeZoneDateParts(candidate, timezone),
      )
    ) {
      return candidate;
    }

    candidate += MINUTE_MS;
  }

  throw new Error(`Unable to find next cron run within one year: ${expression}`);
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
  dueTimes: number[];
  nextRunAt?: number;
} => {
  const dueTimes: number[] = [];
  let nextRunAt = job.nextRunAt ?? getNextRunAfter(job.schedule, job.createdAt);

  while (
    nextRunAt !== undefined &&
    nextRunAt <= now &&
    dueTimes.length < job.maxCatchUpRuns
  ) {
    dueTimes.push(nextRunAt);
    nextRunAt = getNextRunAfter(job.schedule, nextRunAt);
  }

  return {
    dueTimes,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
  };
};

const splitDueTimesByMissedPolicy = (
  job: ScheduledJob,
  dueTimes: number[],
  now: number,
): {
  enqueueTimes: number[];
  skippedTimes: number[];
} => {
  if (dueTimes.length === 0) {
    return { enqueueTimes: [], skippedTimes: [] };
  }

  const latest = dueTimes.at(-1);

  if (latest === undefined) {
    return { enqueueTimes: [], skippedTimes: [] };
  }

  switch (job.missedRunPolicy) {
    case "enqueue-all":
      return {
        enqueueTimes: dueTimes,
        skippedTimes: [],
      };
    case "enqueue-latest":
      return {
        enqueueTimes: [latest],
        skippedTimes: dueTimes.slice(0, -1),
      };
    case "skip": {
      const enqueueLatest = now - latest <= job.missedRunGraceMs;

      return {
        enqueueTimes: enqueueLatest ? [latest] : [],
        skippedTimes: enqueueLatest ? dueTimes.slice(0, -1) : dueTimes,
      };
    }
  }
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
      const state = await readSmartSchedulerState(this.statePath);
      const result = await mutator(state);

      state.updatedAt = this.now();
      pruneRunHistory(state);
      await writeSmartSchedulerState(this.statePath, state);

      return result;
    });

    this.stateMutation = mutation.then(
      () => undefined,
      () => undefined,
    );

    return mutation;
  }

  async getState(): Promise<SmartSchedulerState> {
    return readSmartSchedulerState(this.statePath);
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
      const schedule = normalizeSchedule(input.schedule, now);
      const target = normalizeTarget(input.target);
      const retry = normalizeRetryPolicy(input.retry);
      const queue = normalizeQueuePolicy(id, input.queue);
      const nextRunAt = getNextRunAfter(schedule, now);
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
        schedule,
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
      };
      const schedule = input.schedule
        ? normalizeSchedule(input.schedule, now)
        : existingJob.schedule;
      const target = normalizeTarget(targetInput);
      const nextRunAt = getNextRunAfter(schedule, now);
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
          existingJob.status === "completed" && nextRunAt !== undefined
            ? "active"
            : existingJob.status,
        schedule,
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
      const nextRunAt = getNextRunAfter(job.schedule, this.now());

      if (nextRunAt !== undefined) {
        job.nextRunAt = nextRunAt;
      } else {
        delete job.nextRunAt;
        job.status = "completed";
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

        if (dueTimes.length === 0) {
          continue;
        }

        const { enqueueTimes, skippedTimes } = splitDueTimesByMissedPolicy(
          job,
          dueTimes,
          now,
        );

        for (const scheduledFor of skippedTimes) {
          const existingRun = hasExistingScheduledRun(
            state,
            job.id,
            scheduledFor,
          );

          if (existingRun) {
            continue;
          }

          const skippedRun = createRun(
            job,
            "skipped",
            scheduledFor,
            now,
            "schedule",
          );

          skippedRun.finishedAt = now;
          skippedRun.error = "Skipped by missed-run policy.";
          state.runs.push(skippedRun);
        }

        for (const scheduledFor of enqueueTimes) {
          const existingRun = hasExistingScheduledRun(
            state,
            job.id,
            scheduledFor,
          );

          if (existingRun) {
            enqueueResults.push({
              handle: createRunHandle(existingRun),
              run: { ...existingRun },
              deduplicated: true,
            });
            continue;
          }

          const run = createRun(job, "queued", scheduledFor, now, "schedule");

          job.lastEnqueuedAt = now;
          enqueueResults.push({
            handle: createRunHandle(run),
            run: { ...run },
            deduplicated: false,
          });
          state.runs.push(run);
        }

        if (job.schedule.type === "delay" && nextRunAt === undefined) {
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
      const { job, run } = await this.getRunnableSnapshot(runId);
      const request = this.createExecutionRequest(job, run);
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
  ): Promise<{ job: ScheduledJob; run: ScheduledJobRun }> {
    const state = await this.getState();
    const run = state.runs.find((candidate) => candidate.id === runId);

    if (!run || run.status !== "running") {
      throw new Error(`Scheduled run is no longer runnable: ${runId}`);
    }

    const job = state.jobs.find((candidate) => candidate.id === run.jobId);

    if (!job) {
      throw new Error(`Scheduled job not found for run: ${runId}`);
    }

    return { job, run };
  }

  private createExecutionRequest(
    job: ScheduledJob,
    run: ScheduledJobRun,
  ): ScheduledTaskExecutionRequest {
    return {
      job,
      run,
      task: createScheduledJobTaskText(job),
      workspaceRoot: job.target.workspaceRoot,
      contextPaths: getScheduledJobContextPaths(job),
      imagePaths: job.target.imagePaths,
      ...(job.target.mode ? { mode: job.target.mode } : {}),
      ...(job.target.profile ? { profile: job.target.profile } : {}),
      ...(job.target.provider ? { provider: job.target.provider } : {}),
      ...(job.target.model ? { model: job.target.model } : {}),
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
        parentRun.id,
      );

      state.runs.push(retryRun);

      return {
        jobId: job.id,
        runId: retryRun.id,
      };
    });
  }
}
