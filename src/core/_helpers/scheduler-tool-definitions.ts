import {
  DurableSmartScheduler,
  getWorkspaceSchedulerStatePath,
  type CreateScheduledJobInput,
  type ScheduledContextPackSnapshot,
  type ScheduledEventTriggerKind,
  type ScheduledJob,
  type ScheduledJobRun,
  type ScheduledJobSchedule,
  type ScheduledJobScheduleInput,
  type ScheduledJobTrigger,
  type ScheduledJobTriggerInput,
  type ScheduledJobStatus,
  type ScheduledMacroReference,
  type ScheduledMissedRunPolicy,
  type ScheduledRetryPolicy,
  type UpdateScheduledJobInput,
} from "../scheduler.js";
import type {
  ModelProvider,
  RunMode,
} from "../runtime-contract.generated.js";
import {
  coerceInteger,
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
  type AgentToolExecutionResult,
} from "./agent-tools-shared.js";
import { limitText } from "./runtime-text.js";

const MAX_SCHEDULER_JOBS = 100;
const MAX_SCHEDULER_RUNS = 100;
const MAX_SCHEDULER_EVENTS = 100;
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const SCHEDULE_TYPES = ["cron", "interval", "delay"] as const;
const TRIGGER_KINDS = [
  "time",
  "manual",
  "app",
  "workspace-file",
  "git",
  "job-event",
  "webhook",
  "poll",
  "system",
  "calendar",
  "clipboard",
  "integration",
] as const;
const JOB_STATUSES = ["active", "paused", "completed", "deleted"] as const;
const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
  "skipped",
] as const;
const TRIGGER_FIRING_MODES = ["event", "state"] as const;
const EVENT_TRIGGER_KINDS = TRIGGER_KINDS.filter(
  (kind): kind is ScheduledEventTriggerKind => kind !== "time",
);
const MISSED_RUN_POLICIES = [
  "skip",
  "enqueue-latest",
  "enqueue-all",
] as const;
const RUN_MODES = ["ask", "machdoch"] as const;
const MODEL_PROVIDERS = ["openai", "anthropic", "google"] as const;
const FILTER_OPERATORS = [
  ">",
  ">=",
  "<",
  "<=",
  "!=",
  "=",
  "==",
  "contains",
  "endswith",
  "eq",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
  "matches",
  "neq",
  "not",
  "pattern",
  "prefix",
  "startswith",
  "suffix",
] as const;

const schedulerScalarValueSchema = {
  anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
} as const;

const schedulerKeyValueEntrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description:
        "Field path to set, for example path, mtime, usedPercent, or nested.detail.",
    },
    value: {
      ...schedulerScalarValueSchema,
      description: "String, number, or boolean value for this field.",
    },
    jsonValue: {
      type: "string",
      description:
        "JSON-encoded value for arrays, objects, or null when value is not expressive enough.",
    },
  },
  required: ["path"],
} as const;

const schedulerFilterEntrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description:
        "Event field path such as payload.path, payload.branch, source, or workspaceRoot.",
    },
    value: {
      ...schedulerScalarValueSchema,
      description:
        "Expected value. Strings support * wildcards when no operator is set.",
    },
    jsonValue: {
      type: "string",
      description:
        "JSON-encoded expected value for arrays, objects, or null when value is not expressive enough.",
    },
    op: {
      type: "string",
      enum: FILTER_OPERATORS,
      description:
        "Optional comparison operator such as >=, <=, contains, matches, exists, or eq.",
    },
    min: {
      type: "number",
      description: "Optional lower numeric bound.",
    },
    max: {
      type: "number",
      description: "Optional upper numeric bound.",
    },
  },
  required: ["path"],
} as const;

const scheduleInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: SCHEDULE_TYPES,
      description:
        "Use cron for recurring calendar schedules, interval for fixed millisecond cadence, or delay for one-shot runs.",
    },
    expression: {
      type: "string",
      description:
        "Five-field cron expression. Convert phrases like 'every Monday' yourself, for example Monday 09:00 is '0 9 * * 1'.",
    },
    timezone: {
      type: "string",
      description:
        "IANA timezone for cron schedules. Prefer the user's local timezone when the request implies local time.",
    },
    intervalMs: {
      type: "integer",
      minimum: 1,
      description: "Fixed interval in milliseconds.",
    },
    delayMs: {
      type: "integer",
      minimum: 1,
      description: "One-shot delay in milliseconds from now.",
    },
    runAtEpochMs: {
      type: "integer",
      minimum: 1,
      description: "One-shot absolute run time as Unix epoch milliseconds.",
    },
  },
  required: ["type"],
} as const;

const triggerInputSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "Existing trigger id when updating a trigger.",
      },
      kind: {
        type: "string",
        enum: TRIGGER_KINDS,
        description:
          "Use time for cron/interval/delay. Use event categories such as workspace-file, git, webhook, app, poll, system, or integration for event-only jobs.",
      },
      enabled: { type: "boolean" },
      name: { type: "string" },
      eventType: {
        type: "string",
        description:
          "Event type for non-time triggers, for example workspace-file.created, git.branch-changed, webhook.github.workflow_run, or app.workspace-opened. Supports * wildcards.",
      },
      schedule: scheduleInputSchema,
      filters: {
        type: "array",
        items: schedulerFilterEntrySchema,
        description:
          "Optional activation filters over event fields. Example: [{\"path\":\"payload.path\",\"value\":\"invoices/*.pdf\"}] or [{\"path\":\"payload.usedPercent\",\"op\":\">=\",\"value\":90}].",
      },
      recoveryFilters: {
        type: "array",
        items: schedulerFilterEntrySchema,
        description:
          "Optional recovery filters for stateful threshold triggers. Example: [{\"path\":\"payload.usedPercent\",\"op\":\"<=\",\"value\":80}].",
      },
      firingMode: {
        type: "string",
        enum: TRIGGER_FIRING_MODES,
        description:
          "Use event for edge events. Use state for threshold/condition triggers that should fire once, then repeat only after repeatIntervalMs/cooldownMs until recoveryFilters match.",
      },
      cooldownMs: {
        type: "integer",
        minimum: 1,
        description: "Minimum time between runs fired by this trigger.",
      },
      repeatIntervalMs: {
        type: "integer",
        minimum: 1,
        description:
          "For stateful triggers, how often to repeat while the condition remains active. Defaults to a safe scheduler interval if omitted.",
      },
      debounceMs: {
        type: "integer",
        minimum: 1,
        description:
          "Debounce window for bursty event sources. Watcher implementations may use this when emitting events.",
      },
      dedupeKeyTemplate: {
        type: "string",
        description:
          "Template for event run dedupe such as invoice:{payload.path}:{payload.mtime}.",
      },
      maxEventsPerWindow: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxEvents: {
            type: "integer",
            minimum: 1,
          },
          windowMs: {
            type: "integer",
            minimum: 1,
          },
        },
        description:
          "Burst cap for noisy triggers, for example {\"maxEvents\":2,\"windowMs\":60000}.",
      },
    },
    required: ["kind"],
  },
} as const;

const schedulerEventInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      description:
        "Normalized event type, for example workspace-file.created, git.branch-changed, webhook.github.workflow_run, or app.workspace-opened.",
    },
    kind: {
      type: "string",
      enum: EVENT_TRIGGER_KINDS,
      description:
        "Optional trigger category. If omitted it is inferred from the event type prefix.",
    },
    source: {
      type: "string",
      description: "Event source such as ui, cli, ai, watcher, github, or test.",
    },
    workspaceRoot: {
      type: "string",
      description:
        "Workspace root the event belongs to. Defaults to the active workspace.",
    },
    payload: {
      type: "array",
      items: schedulerKeyValueEntrySchema,
      description:
        "Event payload entries. Example: [{\"path\":\"path\",\"value\":\"invoices/june.pdf\"},{\"path\":\"mtime\",\"value\":\"123\"}]. Trigger filters can match fields like payload.path or payload.branch.",
    },
    dedupeKey: {
      type: "string",
      description: "Stable source event id used to dedupe repeated deliveries.",
    },
    occurredAtEpochMs: {
      type: "integer",
      minimum: 1,
      description: "When the event occurred as Unix epoch milliseconds.",
    },
  },
  required: ["type"],
} as const;

const schedulerPolicySchema = {
  missedRunPolicy: {
    type: "string",
    enum: MISSED_RUN_POLICIES,
    description:
      "How to handle runs missed while the app was offline. Use enqueue-latest unless the user asks to catch up every missed run.",
  },
  missedRunGraceMs: {
    type: "integer",
    minimum: 1,
    description: "Grace window for missed-run handling in milliseconds.",
  },
  retryAttempts: {
    type: "integer",
    minimum: 1,
    description: "Maximum attempts for each scheduled run.",
  },
  retryMinMs: {
    type: "integer",
    minimum: 1,
    description: "Initial retry backoff in milliseconds.",
  },
  retryMaxMs: {
    type: "integer",
    minimum: 1,
    description: "Maximum retry backoff in milliseconds.",
  },
  retryFactor: {
    type: "number",
    minimum: 1,
    description: "Retry backoff multiplier.",
  },
  retryRandomize: {
    type: "boolean",
    description: "Whether retry backoff should include jitter.",
  },
  dedupeKey: {
    type: "string",
    description:
      "Stable identifier for this schedule. Use a durable slug when creating a user-facing recurring automation.",
  },
  ttlMs: {
    type: "integer",
    minimum: 1,
    description: "Expire queued runs that do not start within this duration.",
  },
  maxDurationMs: {
    type: "integer",
    minimum: 1,
    description: "Abort an executing scheduled run after this duration.",
  },
  concurrencyKey: {
    type: "string",
    description:
      "Queue key shared by jobs that should be concurrency-limited together.",
  },
  concurrencyLimit: {
    type: "integer",
    minimum: 1,
    description: "Maximum concurrently running jobs for the queue key.",
  },
  historyLimit: {
    type: "integer",
    minimum: 1,
    description: "Number of historical runs to retain for this job.",
  },
  maxCatchUpRuns: {
    type: "integer",
    minimum: 1,
    description: "Maximum missed runs to consider when catching up.",
  },
} as const;

const schedulerTargetSchema = {
  prompt: {
    type: "string",
    description:
      "The enriched scheduled task prompt. Do not store the user's vague wording verbatim. Write a clear, durable instruction set with objective, workspace/platform assumptions, safety constraints, and verification expectations.",
  },
  contextPaths: {
    type: "array",
    items: { type: "string" },
    description: "Workspace-relative files or folders to attach as context.",
  },
  imagePaths: {
    type: "array",
    items: { type: "string" },
    description: "Workspace-relative image paths to attach.",
  },
  contextPacks: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        instructions: { type: "string" },
        prompt: { type: "string" },
        contextPaths: {
          type: "array",
          items: { type: "string" },
        },
        variableValues: {
          type: "array",
          items: schedulerKeyValueEntrySchema,
          description:
            "Optional context-pack variables as key/value entries, for example [{\"path\":\"scope\",\"value\":\"repo\"}].",
        },
      },
      required: ["name"],
    },
    description: "Optional snapshots of saved context packs for this job.",
  },
  macroInvocations: {
    type: "array",
    items: { type: "string" },
    description:
      "Saved macro names or prompt invocations such as '/triage --scope backend'.",
  },
  mode: {
    type: "string",
    enum: RUN_MODES,
    description: "Optional runtime mode override for scheduled executions.",
  },
  profile: {
    type: "string",
    description: "Optional runtime profile override.",
  },
  provider: {
    type: "string",
    enum: MODEL_PROVIDERS,
    description: "Optional model provider override.",
  },
  model: {
    type: "string",
    description: "Optional model override.",
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const coerceStringArray = (
  record: Record<string, unknown>,
  field: string,
): string[] | undefined => {
  const value = record[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return Array.from(
    new Set(
      value.flatMap((entry) =>
        typeof entry === "string" && entry.trim().length > 0
          ? [entry.trim()]
          : [],
      ),
    ),
  );
};

const coercePositiveInteger = (
  record: Record<string, unknown>,
  field: string,
): number | undefined => {
  const value = coerceInteger(record, field);

  return value !== undefined && value > 0 ? value : undefined;
};

const coercePositiveNumber = (
  record: Record<string, unknown>,
  field: string,
): number | undefined => {
  const value = record[field];

  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
};

const normalizeEnum = <T extends string>(
  value: string | undefined,
  allowedValues: readonly T[],
): T | undefined => {
  return allowedValues.includes(value as T) ? (value as T) : undefined;
};

type ParsedEntryValue =
  | {
      hasValue: true;
      value: unknown;
    }
  | {
      hasValue: false;
    };

const hasOwnRecordKey = (
  record: Record<string, unknown>,
  key: string,
): boolean => {
  return Object.prototype.hasOwnProperty.call(record, key);
};

const parseJsonEntryValue = (value: unknown): ParsedEntryValue => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { hasValue: false };
  }

  try {
    return {
      hasValue: true,
      value: JSON.parse(value) as unknown,
    };
  } catch {
    return { hasValue: false };
  }
};

const coerceEntryPath = (
  entry: Record<string, unknown>,
): string | undefined => {
  return (
    coerceString(entry, "path") ??
    coerceString(entry, "key") ??
    coerceString(entry, "name")
  );
};

const coerceEntryValue = (
  entry: Record<string, unknown>,
): ParsedEntryValue => {
  if (
    hasOwnRecordKey(entry, "value") &&
    entry.value !== undefined &&
    entry.value !== null
  ) {
    return {
      hasValue: true,
      value: entry.value,
    };
  }

  return parseJsonEntryValue(entry.jsonValue);
};

const coerceDirectEntryValue = (
  entry: Record<string, unknown>,
  field: string,
): ParsedEntryValue => {
  const value = entry[field];

  return value !== undefined && value !== null
    ? { hasValue: true, value }
    : { hasValue: false };
};

const setNestedRecordValue = (
  record: Record<string, unknown>,
  path: string,
  value: unknown,
): void => {
  const parts = path
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const lastPart = parts.at(-1);

  if (!lastPart) {
    return;
  }

  let current = record;

  for (const part of parts.slice(0, -1)) {
    const existing = current[part];

    if (isRecord(existing)) {
      current = existing;
      continue;
    }

    const next: Record<string, unknown> = {};
    current[part] = next;
    current = next;
  }

  current[lastPart] = value;
};

const parseEntryRecord = (
  value: unknown,
  options: { nestedPaths: boolean },
): Record<string, unknown> | undefined => {
  if (isRecord(value)) {
    return { ...value };
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const record: Record<string, unknown> = {};

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const path = coerceEntryPath(entry);
    const parsedValue = coerceEntryValue(entry);

    if (!path || !parsedValue.hasValue) {
      continue;
    }

    if (options.nestedPaths) {
      setNestedRecordValue(record, path, parsedValue.value);
      continue;
    }

    record[path] = parsedValue.value;
  }

  return Object.keys(record).length > 0 ? record : undefined;
};

const parseStringEntryRecord = (
  value: unknown,
): Record<string, string> | undefined => {
  const record = parseEntryRecord(value, { nestedPaths: false });

  if (!record) {
    return undefined;
  }

  const stringRecord = Object.fromEntries(
    Object.entries(record).filter(
      (candidate): candidate is [string, string] =>
        typeof candidate[1] === "string",
    ),
  );

  return Object.keys(stringRecord).length > 0 ? stringRecord : undefined;
};

const parseFilterRecord = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (isRecord(value)) {
    return { ...value };
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const filters: Record<string, unknown> = {};

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const path = coerceEntryPath(entry);

    if (!path) {
      continue;
    }

    const parsedValue = coerceEntryValue(entry);
    const op = coerceString(entry, "op") ?? coerceString(entry, "operator");
    const min = coerceDirectEntryValue(entry, "min");
    const max = coerceDirectEntryValue(entry, "max");
    const usesExpression = Boolean(op) || min.hasValue || max.hasValue;

    if (!usesExpression) {
      if (parsedValue.hasValue) {
        filters[path] = parsedValue.value;
      }

      continue;
    }

    const expression: Record<string, unknown> = {};

    if (op) {
      expression.op = op;
    }

    if (parsedValue.hasValue) {
      expression.value = parsedValue.value;
    }

    if (min.hasValue) {
      expression.min = min.value;
    }

    if (max.hasValue) {
      expression.max = max.value;
    }

    filters[path] = expression;
  }

  return Object.keys(filters).length > 0 ? filters : undefined;
};

const createScheduler = (workspaceRoot: string): DurableSmartScheduler => {
  return new DurableSmartScheduler({
    statePath: getWorkspaceSchedulerStatePath(workspaceRoot),
  });
};

const parseScheduleInput = (
  value: unknown,
): ScheduledJobScheduleInput | string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return "Expected `schedule` to be an object.";
  }

  const type = normalizeEnum(coerceString(value, "type"), SCHEDULE_TYPES);

  if (!type) {
    return "Expected `schedule.type` to be cron, interval, or delay.";
  }

  switch (type) {
    case "cron": {
      const expression = coerceString(value, "expression");
      const timezone = coerceString(value, "timezone") ?? DEFAULT_TIMEZONE;

      if (!expression) {
        return "Expected cron schedules to include `schedule.expression`.";
      }

      return {
        type: "cron",
        expression,
        timezone,
      };
    }
    case "interval": {
      const intervalMs = coercePositiveInteger(value, "intervalMs");

      if (intervalMs === undefined) {
        return "Expected interval schedules to include positive `schedule.intervalMs`.";
      }

      return {
        type: "interval",
        intervalMs,
      };
    }
    case "delay": {
      const delayMs = coercePositiveInteger(value, "delayMs");
      const runAt = coercePositiveInteger(value, "runAtEpochMs");

      if (delayMs === undefined && runAt === undefined) {
        return "Expected delay schedules to include `schedule.delayMs` or `schedule.runAtEpochMs`.";
      }

      return {
        type: "delay",
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(runAt !== undefined ? { runAt } : {}),
      };
    }
  }
};

const parseTriggerInput = (
  value: unknown,
): ScheduledJobTriggerInput | string | undefined => {
  if (!isRecord(value)) {
    return "Expected each trigger to be an object.";
  }

  const kind = normalizeEnum(coerceString(value, "kind"), TRIGGER_KINDS);

  if (!kind) {
    return "Expected trigger.kind to be a supported scheduler trigger kind.";
  }

  const id = coerceString(value, "id");
  const name = coerceString(value, "name");
  const enabled =
    typeof value.enabled === "boolean" ? value.enabled : undefined;
  const filters = parseFilterRecord(value.filters);
  const recoveryFilters = parseFilterRecord(value.recoveryFilters);
  const firingMode = normalizeEnum(
    coerceString(value, "firingMode"),
    TRIGGER_FIRING_MODES,
  );
  const cooldownMs = coercePositiveInteger(value, "cooldownMs");
  const repeatIntervalMs = coercePositiveInteger(value, "repeatIntervalMs");
  const debounceMs = coercePositiveInteger(value, "debounceMs");
  const dedupeKeyTemplate = coerceString(value, "dedupeKeyTemplate");
  const maxEventsPerWindow = isRecord(value.maxEventsPerWindow)
    ? {
        maxEvents: coercePositiveInteger(
          value.maxEventsPerWindow,
          "maxEvents",
        ),
        windowMs: coercePositiveInteger(value.maxEventsPerWindow, "windowMs"),
      }
    : undefined;
  const normalizedMaxEventsPerWindow =
    maxEventsPerWindow?.maxEvents !== undefined &&
    maxEventsPerWindow.windowMs !== undefined
      ? {
          maxEvents: maxEventsPerWindow.maxEvents,
          windowMs: maxEventsPerWindow.windowMs,
        }
      : undefined;

  if (kind === "time") {
    const schedule = parseScheduleInput(value.schedule);

    if (!schedule || typeof schedule === "string") {
      return schedule || "Expected time triggers to include a schedule.";
    }

    return {
      kind: "time",
      schedule,
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(filters ? { filters } : {}),
      ...(recoveryFilters ? { recoveryFilters } : {}),
      ...(firingMode ? { firingMode } : {}),
      ...(cooldownMs !== undefined ? { cooldownMs } : {}),
      ...(repeatIntervalMs !== undefined ? { repeatIntervalMs } : {}),
      ...(debounceMs !== undefined ? { debounceMs } : {}),
      ...(dedupeKeyTemplate ? { dedupeKeyTemplate } : {}),
      ...(normalizedMaxEventsPerWindow
        ? { maxEventsPerWindow: normalizedMaxEventsPerWindow }
        : {}),
    };
  }

  const eventType = coerceString(value, "eventType") ?? kind;

  return {
    kind: kind as ScheduledEventTriggerKind,
    eventType,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(filters ? { filters } : {}),
    ...(recoveryFilters ? { recoveryFilters } : {}),
    ...(firingMode ? { firingMode } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    ...(repeatIntervalMs !== undefined ? { repeatIntervalMs } : {}),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(dedupeKeyTemplate ? { dedupeKeyTemplate } : {}),
    ...(normalizedMaxEventsPerWindow
      ? { maxEventsPerWindow: normalizedMaxEventsPerWindow }
      : {}),
  };
};

const parseTriggerInputs = (
  value: unknown,
): ScheduledJobTriggerInput[] | string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return "Expected `triggers` to be an array.";
  }

  const triggers: ScheduledJobTriggerInput[] = [];

  for (const entry of value) {
    const trigger = parseTriggerInput(entry);

    if (!trigger || typeof trigger === "string") {
      return trigger || "Expected each trigger to be valid.";
    }

    triggers.push(trigger);
  }

  return triggers;
};

const parseContextPacks = (
  record: Record<string, unknown>,
): ScheduledContextPackSnapshot[] | undefined => {
  const value = record.contextPacks;

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = coerceString(entry, "name");

    if (!name) {
      return [];
    }

    const instructions = coerceString(entry, "instructions");
    const prompt = coerceString(entry, "prompt");
    const variableValues = parseStringEntryRecord(entry.variableValues);
    const contextPaths = coerceStringArray(entry, "contextPaths");

    return [
      {
        name,
        ...(instructions ? { instructions } : {}),
        ...(prompt ? { prompt } : {}),
        ...(contextPaths ? { contextPaths } : {}),
        ...(variableValues && Object.keys(variableValues).length > 0
          ? { variableValues }
          : {}),
      },
    ];
  });
};

const parseMacroReferences = (
  values: string[] | undefined,
): ScheduledMacroReference[] | undefined => {
  if (!values) {
    return undefined;
  }

  return values.map((value) => {
    if (value.startsWith("/")) {
      return {
        name: value.slice(1).split(/\s+/u)[0] ?? "macro",
        promptInvocation: value,
      };
    }

    return {
      name: value,
    };
  });
};

const parseRetryPolicy = (
  record: Record<string, unknown>,
): Partial<ScheduledRetryPolicy> | undefined => {
  const retry: Partial<ScheduledRetryPolicy> = {};
  const maxAttempts = coercePositiveInteger(record, "retryAttempts");
  const minTimeoutMs = coercePositiveInteger(record, "retryMinMs");
  const maxTimeoutMs = coercePositiveInteger(record, "retryMaxMs");
  const factor = coercePositiveNumber(record, "retryFactor");

  if (maxAttempts !== undefined) {
    retry.maxAttempts = maxAttempts;
  }

  if (minTimeoutMs !== undefined) {
    retry.minTimeoutMs = minTimeoutMs;
  }

  if (maxTimeoutMs !== undefined) {
    retry.maxTimeoutMs = maxTimeoutMs;
  }

  if (factor !== undefined) {
    retry.factor = factor;
  }

  if (typeof record.retryRandomize === "boolean") {
    retry.randomize = record.retryRandomize;
  }

  return Object.keys(retry).length > 0 ? retry : undefined;
};

const parseQueuePolicy = (
  record: Record<string, unknown>,
):
  | NonNullable<CreateScheduledJobInput["queue"]>
  | NonNullable<UpdateScheduledJobInput["queue"]>
  | undefined => {
  const queue: NonNullable<CreateScheduledJobInput["queue"]> = {};
  const concurrencyKey = coerceString(record, "concurrencyKey");
  const concurrencyLimit = coercePositiveInteger(record, "concurrencyLimit");

  if (concurrencyKey) {
    queue.concurrencyKey = concurrencyKey;
  }

  if (concurrencyLimit !== undefined) {
    queue.concurrencyLimit = concurrencyLimit;
  }

  return Object.keys(queue).length > 0 ? queue : undefined;
};

const parseMissedRunPolicy = (
  record: Record<string, unknown>,
): ScheduledMissedRunPolicy | undefined => {
  return normalizeEnum(coerceString(record, "missedRunPolicy"), MISSED_RUN_POLICIES);
};

const parseRunMode = (record: Record<string, unknown>): RunMode | undefined => {
  return normalizeEnum(coerceString(record, "mode"), RUN_MODES);
};

const parseProvider = (
  record: Record<string, unknown>,
): Exclude<ModelProvider, "unconfigured"> | undefined => {
  return normalizeEnum(coerceString(record, "provider"), MODEL_PROVIDERS);
};

const createTargetInput = (
  record: Record<string, unknown>,
  workspaceRoot: string,
  options: { requirePrompt: boolean },
): CreateScheduledJobInput["target"] | string => {
  const prompt = coerceString(record, "prompt");

  if (options.requirePrompt && !prompt) {
    return "Expected `prompt` to be an enriched scheduled task prompt.";
  }

  const contextPaths = coerceStringArray(record, "contextPaths");
  const imagePaths = coerceStringArray(record, "imagePaths");
  const contextPacks = parseContextPacks(record);
  const macros = parseMacroReferences(
    coerceStringArray(record, "macroInvocations"),
  );
  const mode = parseRunMode(record);
  const provider = parseProvider(record);
  const profile = coerceString(record, "profile");
  const model = coerceString(record, "model");

  return {
    workspaceRoot,
    prompt: prompt ?? "",
    contextPaths: contextPaths ?? [],
    imagePaths: imagePaths ?? [],
    contextPacks: contextPacks ?? [],
    macros: macros ?? [],
    ...(mode ? { mode } : {}),
    ...(profile ? { profile } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
};

const createUpdateTargetInput = (
  record: Record<string, unknown>,
): UpdateScheduledJobInput["target"] | undefined => {
  const target: UpdateScheduledJobInput["target"] = {};
  const prompt = coerceString(record, "prompt");
  const contextPaths = coerceStringArray(record, "contextPaths");
  const imagePaths = coerceStringArray(record, "imagePaths");
  const contextPacks = parseContextPacks(record);
  const macros = parseMacroReferences(
    coerceStringArray(record, "macroInvocations"),
  );
  const mode = parseRunMode(record);
  const provider = parseProvider(record);
  const profile = coerceString(record, "profile");
  const model = coerceString(record, "model");

  if (prompt !== undefined) {
    target.prompt = prompt;
  }

  if (contextPaths !== undefined) {
    target.contextPaths = contextPaths;
  }

  if (imagePaths !== undefined) {
    target.imagePaths = imagePaths;
  }

  if (contextPacks !== undefined) {
    target.contextPacks = contextPacks;
  }

  if (macros !== undefined) {
    target.macros = macros;
  }

  if (mode !== undefined) {
    target.mode = mode;
  }

  if (provider !== undefined) {
    target.provider = provider;
  }

  if (profile !== undefined) {
    target.profile = profile;
  }

  if (model !== undefined) {
    target.model = model;
  }

  return Object.keys(target).length > 0 ? target : undefined;
};

const createJobInput = (
  args: Record<string, unknown>,
  workspaceRoot: string,
): CreateScheduledJobInput | string => {
  const schedule = parseScheduleInput(args.schedule);
  const triggers = parseTriggerInputs(args.triggers);

  if (!schedule || typeof schedule === "string") {
    if (typeof schedule === "string") {
      return schedule;
    }
  }

  if (typeof triggers === "string") {
    return triggers;
  }

  if (!schedule && (!triggers || triggers.length === 0)) {
    return "Expected `schedule` or `triggers` before creating a scheduled job.";
  }

  const target = createTargetInput(args, workspaceRoot, {
    requirePrompt: true,
  });

  if (typeof target === "string") {
    return target;
  }

  const missedRunPolicy = parseMissedRunPolicy(args);
  const retry = parseRetryPolicy(args);
  const queue = parseQueuePolicy(args);
  const name = coerceString(args, "name");
  const missedRunGraceMs = coercePositiveInteger(args, "missedRunGraceMs");
  const historyLimit = coercePositiveInteger(args, "historyLimit");
  const maxCatchUpRuns = coercePositiveInteger(args, "maxCatchUpRuns");
  const dedupeKey = coerceString(args, "dedupeKey");
  const ttlMs = coercePositiveInteger(args, "ttlMs");
  const maxDurationMs = coercePositiveInteger(args, "maxDurationMs");

  return {
    ...(name ? { name } : {}),
    ...(schedule ? { schedule } : {}),
    ...(triggers ? { triggers } : {}),
    target,
    ...(missedRunPolicy ? { missedRunPolicy } : {}),
    ...(missedRunGraceMs !== undefined ? { missedRunGraceMs } : {}),
    ...(retry ? { retry } : {}),
    ...(queue ? { queue } : {}),
    ...(historyLimit !== undefined ? { historyLimit } : {}),
    ...(maxCatchUpRuns !== undefined ? { maxCatchUpRuns } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
  };
};

const createUpdateInput = (
  args: Record<string, unknown>,
): UpdateScheduledJobInput | string => {
  const schedule = parseScheduleInput(args.schedule);
  const triggers = parseTriggerInputs(args.triggers);

  if (typeof schedule === "string") {
    return schedule;
  }

  if (typeof triggers === "string") {
    return triggers;
  }

  const target = createUpdateTargetInput(args);
  const missedRunPolicy = parseMissedRunPolicy(args);
  const retry = parseRetryPolicy(args);
  const queue = parseQueuePolicy(args);
  const name = coerceString(args, "name");
  const missedRunGraceMs = coercePositiveInteger(args, "missedRunGraceMs");
  const historyLimit = coercePositiveInteger(args, "historyLimit");
  const maxCatchUpRuns = coercePositiveInteger(args, "maxCatchUpRuns");
  const dedupeKey = coerceString(args, "dedupeKey");
  const ttlMs = coercePositiveInteger(args, "ttlMs");
  const maxDurationMs = coercePositiveInteger(args, "maxDurationMs");
  const input: UpdateScheduledJobInput = {
    ...(name ? { name } : {}),
    ...(schedule ? { schedule } : {}),
    ...(triggers ? { triggers } : {}),
    ...(target ? { target } : {}),
    ...(missedRunPolicy ? { missedRunPolicy } : {}),
    ...(missedRunGraceMs !== undefined ? { missedRunGraceMs } : {}),
    ...(retry ? { retry } : {}),
    ...(queue ? { queue } : {}),
    ...(historyLimit !== undefined ? { historyLimit } : {}),
    ...(maxCatchUpRuns !== undefined ? { maxCatchUpRuns } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
  };

  if (Object.keys(input).length === 0) {
    return "Expected at least one field to update.";
  }

  return input;
};

const formatTimestamp = (timestamp: number | undefined): string => {
  return timestamp ? new Date(timestamp).toISOString() : "none";
};

const formatSchedule = (schedule: ScheduledJobSchedule): string => {
  switch (schedule.type) {
    case "cron":
      return `cron ${schedule.expression} (${schedule.timezone})`;
    case "interval":
      return `interval ${schedule.intervalMs}ms`;
    case "delay":
      return `delay until ${formatTimestamp(schedule.runAt)}`;
  }
};

const formatTrigger = (trigger: ScheduledJobTrigger): string => {
  if (trigger.kind === "time") {
    return formatSchedule(trigger.schedule);
  }

  return `${trigger.kind}:${trigger.eventType}`;
};

const formatJobTriggers = (job: ScheduledJob): string => {
  return job.triggers.length > 0
    ? job.triggers.map(formatTrigger).join(", ")
    : "no triggers";
};

const summarizeJob = (job: ScheduledJob): Record<string, unknown> => ({
  id: job.id,
  name: job.name,
  status: job.status,
  schedule: job.schedule ?? null,
  triggers: job.triggers,
  triggerLabel: formatJobTriggers(job),
  scheduleLabel: job.schedule ? formatSchedule(job.schedule) : "Event triggered",
  nextRunAt: job.nextRunAt ?? null,
  prompt: job.target.prompt,
  contextPaths: job.target.contextPaths,
  imagePaths: job.target.imagePaths,
  contextPacks: job.target.contextPacks,
  macros: job.target.macros,
  missedRunPolicy: job.missedRunPolicy,
  retry: job.retry,
  queue: job.queue,
  dedupeKey: job.dedupeKey ?? null,
  ttlMs: job.ttlMs ?? null,
  maxDurationMs: job.maxDurationMs ?? null,
  lastStartedAt: job.lastStartedAt ?? null,
  lastFinishedAt: job.lastFinishedAt ?? null,
});

const summarizeRun = (run: ScheduledJobRun): Record<string, unknown> => ({
  id: run.id,
  jobId: run.jobId,
  source: run.source,
  status: run.status,
  scheduledFor: run.scheduledFor,
  enqueuedAt: run.enqueuedAt,
  updatedAt: run.updatedAt,
  attempt: run.attempt,
  maxAttempts: run.maxAttempts,
  queueKey: run.queueKey,
  expiresAt: run.expiresAt ?? null,
  nextAttemptAt: run.nextAttemptAt ?? null,
  startedAt: run.startedAt ?? null,
  finishedAt: run.finishedAt ?? null,
  error: run.error ?? null,
  summary: run.result?.summary ?? null,
});

const createSchedulerResult = (
  toolName: string,
  value: unknown,
  sections: AgentToolExecutionResult["sections"],
  trace: string,
): AgentToolExecutionResult => {
  return {
    toolResult: {
      callId: crypto.randomUUID(),
      name: toolName,
      output: JSON.stringify(value, null, 2),
    },
    sections,
    traceLines: [trace],
  };
};

const createJobSections = (
  title: string,
  job: ScheduledJob,
): AgentToolExecutionResult["sections"] => {
  return [
    {
      title,
      lines: [
        `id: ${job.id}`,
        `name: ${job.name}`,
        `status: ${job.status}`,
        `triggers: ${formatJobTriggers(job)}`,
        `next run: ${formatTimestamp(job.nextRunAt)}`,
      ],
    },
    {
      title: "Scheduled Prompt",
      lines: [limitText(job.target.prompt, 1_000)],
    },
  ];
};

const normalizeJobStatus = (
  value: string | undefined,
): ScheduledJobStatus | "all" | undefined => {
  if (value === "all") {
    return "all";
  }

  return normalizeEnum(value, JOB_STATUSES);
};

const filterJobs = (
  jobs: ScheduledJob[],
  args: Record<string, unknown>,
): ScheduledJob[] => {
  const status = normalizeJobStatus(coerceString(args, "status"));
  const query = coerceString(args, "query")?.toLowerCase();
  const queryTokens = query
    ?.split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const maxJobs = Math.min(
    MAX_SCHEDULER_JOBS,
    coercePositiveInteger(args, "maxJobs") ?? 25,
  );

  return jobs
    .filter((job) => {
      if (status && status !== "all" && job.status !== status) {
        return false;
      }

      if (!queryTokens || queryTokens.length === 0) {
        return true;
      }

      const haystack = [
        job.id,
        job.name,
        job.dedupeKey,
        job.target.prompt,
        formatJobTriggers(job),
      ]
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .toLowerCase();

      return queryTokens.some((token) => haystack.includes(token));
    })
    .slice(0, maxJobs);
};

const filterRuns = (
  runs: ScheduledJobRun[],
  args: Record<string, unknown>,
): ScheduledJobRun[] => {
  const status = normalizeEnum(coerceString(args, "status"), RUN_STATUSES);
  const maxRuns = Math.min(
    MAX_SCHEDULER_RUNS,
    coercePositiveInteger(args, "maxRuns") ?? 25,
  );

  return runs
    .filter((run) => (status ? run.status === status : true))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, maxRuns);
};

type SchedulerEventList = Awaited<
  ReturnType<DurableSmartScheduler["listEvents"]>
>;

const summarizeEvent = (event: SchedulerEventList[number]): Record<string, unknown> => ({
  id: event.id,
  type: event.type,
  kind: event.kind,
  source: event.source,
  workspaceRoot: event.workspaceRoot ?? null,
  payload: event.payload,
  dedupeKey: event.dedupeKey ?? null,
  occurredAt: event.occurredAt,
  receivedAt: event.receivedAt,
  matches: event.matches,
});

const filterEvents = (
  events: SchedulerEventList,
  args: Record<string, unknown>,
): SchedulerEventList => {
  const query = coerceString(args, "query")?.toLowerCase();
  const maxEvents = Math.min(
    MAX_SCHEDULER_EVENTS,
    coercePositiveInteger(args, "maxEvents") ?? 25,
  );

  return events
    .filter((event) => {
      if (!query) {
        return true;
      }

      const haystack = [
        event.id,
        event.type,
        event.kind,
        event.source,
        event.workspaceRoot,
        event.dedupeKey,
        JSON.stringify(event.payload),
      ]
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    })
    .slice(0, maxEvents);
};

const createEventInput = (
  args: Record<string, unknown>,
  workspaceRoot: string,
):
  | Parameters<DurableSmartScheduler["recordEventAndEnqueueRuns"]>[0]
  | string => {
  const type = coerceString(args, "type");
  const kind = normalizeEnum(coerceString(args, "kind"), EVENT_TRIGGER_KINDS);
  const source = coerceString(args, "source") ?? "ai";
  const eventWorkspaceRoot =
    coerceString(args, "workspaceRoot") ?? workspaceRoot;
  const payload = parseEntryRecord(args.payload, { nestedPaths: true });
  const dedupeKey = coerceString(args, "dedupeKey");
  const occurredAt = coercePositiveInteger(args, "occurredAtEpochMs");

  if (!type) {
    return "Expected scheduler event `type`.";
  }

  return {
    type,
    ...(kind ? { kind } : {}),
    source,
    workspaceRoot: eventWorkspaceRoot,
    ...(payload ? { payload } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
};

export const createSchedulerToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
      spec: {
        name: "list_scheduled_jobs",
        description:
          "Read durable Smart Scheduler jobs in the current workspace. Use this before updating an existing schedule from a vague reference like 'the trash cleanup job'. Search by query, inspect the returned id, then call update_scheduled_job with that id.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description:
                "Optional case-insensitive search across id, name, dedupe key, schedule, and prompt.",
            },
            status: {
              type: "string",
              enum: ["all", ...JOB_STATUSES],
              description: "Optional job status filter.",
            },
            maxJobs: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SCHEDULER_JOBS,
            },
          },
        },
      },
      backingTool: "scheduler",
      riskLevel: "low",
      effect: "read",
      execute: async (args, context) => {
        const jobs = filterJobs(
          await createScheduler(context.workspaceRoot).listJobs(),
          args,
        );

        return createSchedulerResult(
          "list_scheduled_jobs",
          { jobs: jobs.map(summarizeJob) },
          [
            {
              title: "Scheduled Jobs",
              lines:
                jobs.length > 0
                  ? jobs.map(
                      (job) =>
                        `${job.id} | ${job.name} | ${job.status} | ${formatJobTriggers(job)}`,
                    )
                  : ["No scheduled jobs matched."],
            },
          ],
          `list_scheduled_jobs -> ${jobs.length} job(s)`,
        );
      },
    },
    {
      spec: {
        name: "list_scheduled_runs",
        description:
          "Read Smart Scheduler run history. Use this to answer status/history questions before retrying or changing a job.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: {
              type: "string",
              description: "Optional scheduled job id to filter run history.",
            },
            status: {
              type: "string",
              enum: RUN_STATUSES,
              description: "Optional run status filter.",
            },
            maxRuns: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SCHEDULER_RUNS,
            },
          },
        },
      },
      backingTool: "scheduler",
      riskLevel: "low",
      effect: "read",
      execute: async (args, context) => {
        const runs = filterRuns(
          await createScheduler(context.workspaceRoot).listRuns(
            coerceString(args, "jobId"),
          ),
          args,
        );

        return createSchedulerResult(
          "list_scheduled_runs",
          { runs: runs.map(summarizeRun) },
          [
            {
              title: "Scheduled Runs",
              lines:
                runs.length > 0
                  ? runs.map(
                      (run) =>
                        `${run.id} | job=${run.jobId} | ${run.status} | attempts=${run.attempt}/${run.maxAttempts}`,
                    )
                  : ["No scheduled runs matched."],
            },
          ],
          `list_scheduled_runs -> ${runs.length} run(s)`,
        );
      },
    },
    {
      spec: {
        name: "list_scheduler_events",
        description:
          "Read durable Smart Scheduler trigger events and match decisions. Use this to explain why an event-triggered job did or did not run.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description:
                "Optional case-insensitive search across event id, type, kind, source, workspace, dedupe key, and payload.",
            },
            maxEvents: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SCHEDULER_EVENTS,
            },
          },
        },
      },
      backingTool: "scheduler",
      riskLevel: "low",
      effect: "read",
      execute: async (args, context) => {
        const events = filterEvents(
          await createScheduler(context.workspaceRoot).listEvents(),
          args,
        );

        return createSchedulerResult(
          "list_scheduler_events",
          { events: events.map(summarizeEvent) },
          [
            {
              title: "Scheduler Events",
              lines:
                events.length > 0
                  ? events.map(
                      (event) =>
                        `${event.id} | ${event.kind} | ${event.type} | matches=${event.matches.length}`,
                    )
                  : ["No scheduler events matched."],
            },
          ],
          `list_scheduler_events -> ${events.length} event(s)`,
        );
      },
    },
    {
      spec: {
        name: "emit_scheduler_event",
        description:
          "Emit a normalized Smart Scheduler event to test or drive event-only jobs. Use this for user requests like 'run jobs for this file-created event' or to validate a trigger. Native watchers/webhooks should emit the same event shape.",
        inputSchema: schedulerEventInputSchema,
      },
      backingTool: "scheduler",
      riskLevel: "medium",
      effect: "write",
      execute: async (args, context) => {
        const input = createEventInput(args, context.workspaceRoot);

        if (typeof input === "string") {
          return createToolErrorResult(
            crypto.randomUUID(),
            "emit_scheduler_event",
            input,
          );
        }

        const result = await createScheduler(
          context.workspaceRoot,
        ).recordEventAndEnqueueRuns(input);

        return createSchedulerResult(
          "emit_scheduler_event",
          {
            event: summarizeEvent(result.event),
            enqueued: result.enqueued.map((entry) => ({
              handle: entry.handle,
              run: summarizeRun(entry.run),
              deduplicated: entry.deduplicated,
            })),
          },
          [
            {
              title: "Scheduler Event",
              lines: [
                `id: ${result.event.id}`,
                `type: ${result.event.type}`,
                `matches: ${result.event.matches.length}`,
                `enqueued: ${result.enqueued.length}`,
              ],
            },
          ],
          `emit_scheduler_event(${result.event.id}) -> ${result.enqueued.length} run(s)`,
        );
      },
    },
    {
      spec: {
        name: "create_scheduled_job",
        description:
          "Create a durable Smart Scheduler job from a natural-language request. Use `schedule` for cron/interval/delay jobs or `triggers` for event-only/hybrid jobs such as workspace-file.created, git.branch-changed, webhook.github.workflow_run, app.workspace-opened, system.disk-threshold, poll.http-status, or integration.*. Use firingMode=state with activation filters, recoveryFilters, repeatIntervalMs/cooldownMs, and maxEventsPerWindow for threshold monitors so they do not spam while a condition remains true. You must enrich the user's request into a reusable scheduled prompt: include the exact objective, trigger assumptions, workspace/platform assumptions, safety constraints, what tools/actions the scheduled AI should use, and how it should verify completion.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: {
              type: "string",
              description: "Human-readable schedule name.",
            },
            schedule: scheduleInputSchema,
            triggers: triggerInputSchema,
            ...schedulerTargetSchema,
            ...schedulerPolicySchema,
          },
          required: ["prompt"],
        },
      },
      backingTool: "scheduler",
      riskLevel: "medium",
      effect: "write",
      execute: async (args, context) => {
        const input = createJobInput(args, context.workspaceRoot);

        if (typeof input === "string") {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_scheduled_job",
            input,
          );
        }

        const job = await createScheduler(context.workspaceRoot).upsertJob(input);

        return createSchedulerResult(
          "create_scheduled_job",
          { job: summarizeJob(job) },
          createJobSections("Created Scheduled Job", job),
          `create_scheduled_job(${job.id}) -> ${job.name}`,
        );
      },
    },
    {
      spec: {
        name: "update_scheduled_job",
        description:
          "Update an existing durable Smart Scheduler job. First call list_scheduled_jobs when the user refers to a job by description instead of id. When changing the task, replace `prompt` with a newly enriched durable scheduled prompt, not the user's shorthand. When changing cadence or event behavior, supply a full updated schedule or triggers array, including stateful trigger recovery/repeat/rate-limit settings for threshold monitors.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: {
              type: "string",
              description: "Scheduled job id from list_scheduled_jobs.",
            },
            name: {
              type: "string",
              description: "Updated human-readable schedule name.",
            },
            schedule: scheduleInputSchema,
            triggers: triggerInputSchema,
            ...schedulerTargetSchema,
            ...schedulerPolicySchema,
          },
          required: ["jobId"],
        },
      },
      backingTool: "scheduler",
      riskLevel: "medium",
      effect: "write",
      execute: async (args, context) => {
        const jobId = coerceString(args, "jobId");

        if (!jobId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "update_scheduled_job",
            "Expected `jobId`.",
          );
        }

        const input = createUpdateInput(args);

        if (typeof input === "string") {
          return createToolErrorResult(
            crypto.randomUUID(),
            "update_scheduled_job",
            input,
          );
        }

        const job = await createScheduler(context.workspaceRoot).updateJob(
          jobId,
          input,
        );

        return createSchedulerResult(
          "update_scheduled_job",
          { job: summarizeJob(job) },
          createJobSections("Updated Scheduled Job", job),
          `update_scheduled_job(${job.id}) -> ${job.name}`,
        );
      },
    },
    {
      spec: {
        name: "pause_scheduled_job",
        description:
          "Pause an active Smart Scheduler job without deleting its definition or history.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: { type: "string" },
          },
          required: ["jobId"],
        },
      },
      backingTool: "scheduler",
      riskLevel: "medium",
      effect: "write",
      execute: async (args, context) => {
        const jobId = coerceString(args, "jobId");

        if (!jobId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "pause_scheduled_job",
            "Expected `jobId`.",
          );
        }

        const job = await createScheduler(context.workspaceRoot).pauseJob(jobId);

        return createSchedulerResult(
          "pause_scheduled_job",
          { job: summarizeJob(job) },
          createJobSections("Paused Scheduled Job", job),
          `pause_scheduled_job(${job.id})`,
        );
      },
    },
    {
      spec: {
        name: "resume_scheduled_job",
        description:
          "Resume a paused Smart Scheduler job and recalculate its next run.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: { type: "string" },
          },
          required: ["jobId"],
        },
      },
      backingTool: "scheduler",
      riskLevel: "medium",
      effect: "write",
      execute: async (args, context) => {
        const jobId = coerceString(args, "jobId");

        if (!jobId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "resume_scheduled_job",
            "Expected `jobId`.",
          );
        }

        const job = await createScheduler(context.workspaceRoot).resumeJob(jobId);

        return createSchedulerResult(
          "resume_scheduled_job",
          { job: summarizeJob(job) },
          createJobSections("Resumed Scheduled Job", job),
          `resume_scheduled_job(${job.id})`,
        );
      },
    },
    {
      spec: {
        name: "delete_scheduled_job",
        description:
          "Delete a Smart Scheduler job. Use pause_scheduled_job when the user wants to disable it temporarily.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobId: { type: "string" },
          },
          required: ["jobId"],
        },
      },
      backingTool: "scheduler",
      riskLevel: "medium",
      effect: "write",
      execute: async (args, context) => {
        const jobId = coerceString(args, "jobId");

        if (!jobId) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "delete_scheduled_job",
            "Expected `jobId`.",
          );
        }

        const job = await createScheduler(context.workspaceRoot).deleteJob(jobId);

        return createSchedulerResult(
          "delete_scheduled_job",
          { job: summarizeJob(job) },
          createJobSections("Deleted Scheduled Job", job),
          `delete_scheduled_job(${job.id})`,
        );
      },
    },
  ];
};
