import { normalizeSchedulerText } from "./normalize-scheduler-value.helper.js";

const DEFAULT_STATEFUL_TRIGGER_REPEAT_MS = 60 * 60_000;

export type SchedulerEventTriggerFiringMode = "event" | "state";
export type SchedulerEventTriggerState = "idle" | "active";
export type SchedulerEventTriggerKind =
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

export interface SchedulerEventTriggerRateLimitPolicy {
  maxEvents: number;
  windowMs: number;
}

export interface SchedulerEventTrigger {
  id: string;
  kind: string;
  eventType: string;
  filters?: Record<string, unknown>;
  recoveryFilters?: Record<string, unknown>;
  firingMode?: SchedulerEventTriggerFiringMode;
  cooldownMs?: number;
  repeatIntervalMs?: number;
  dedupeKeyTemplate?: string;
  maxEventsPerWindow?: SchedulerEventTriggerRateLimitPolicy;
  lastFiredAt?: number;
  lastState?: SchedulerEventTriggerState;
  lastStateChangedAt?: number;
}

export interface SchedulerTriggerEventMatch {
  triggerId: string;
  matched: boolean;
  deduplicated?: boolean;
}

export interface SchedulerTriggerEvent {
  id: string;
  type: string;
  kind: string;
  source: string;
  workspaceRoot?: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  receivedAt: number;
  matches: SchedulerTriggerEventMatch[];
}

export interface SchedulerEventTriggerJob {
  id: string;
}

export interface SchedulerEventTriggerStateSnapshot {
  events: SchedulerTriggerEvent[];
}

export const normalizeSchedulerEventPayload = (
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  return payload ? { ...payload } : {};
};

const isRecordValue = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const isSchedulerEventTriggerKind = (
  value: string | undefined,
): value is SchedulerEventTriggerKind => {
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

export const isSchedulerEventTriggerFiringMode = (
  value: string | undefined,
): value is SchedulerEventTriggerFiringMode => {
  return value === "event" || value === "state";
};

export const isSchedulerEventTriggerState = (
  value: string | undefined,
): value is SchedulerEventTriggerState => {
  return value === "idle" || value === "active";
};

export const inferSchedulerEventTriggerKind = (
  eventType: string,
): SchedulerEventTriggerKind => {
  const prefix = eventType.split(".")[0];

  return isSchedulerEventTriggerKind(prefix) ? prefix : "manual";
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

export const schedulerEventTypeMatches = (
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
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
  const operator = normalizeSchedulerText(
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
  event: SchedulerTriggerEvent,
): Record<string, unknown> => ({
  type: event.type,
  kind: event.kind,
  source: event.source,
  workspaceRoot: event.workspaceRoot,
  payload: event.payload,
});

const eventFilterRecordMatches = (
  filters: Record<string, unknown> | undefined,
  event: SchedulerTriggerEvent,
): boolean => {
  if (!filters || Object.keys(filters).length === 0) {
    return true;
  }

  const eventRecord = createEventFilterRecord(event);

  return Object.entries(filters).every(([path, expected]) => {
    return filterValueMatches(getPathValue(eventRecord, path), expected);
  });
};

export const schedulerEventFiltersMatch = (
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
): boolean => eventFilterRecordMatches(trigger.filters, event);

const renderDedupeTemplate = (
  template: string,
  job: SchedulerEventTriggerJob,
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
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

export const createSchedulerEventRunDedupeSuffix = (
  job: SchedulerEventTriggerJob,
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
): string => {
  const baseSuffix = trigger.dedupeKeyTemplate
    ? renderDedupeTemplate(trigger.dedupeKeyTemplate, job, trigger, event)
    : `${trigger.id}:${event.dedupeKey ?? event.id}`;

  if (getSchedulerEventTriggerFiringMode(trigger) !== "state") {
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

export const getSchedulerEventTriggerFiringMode = (
  trigger: SchedulerEventTrigger,
): SchedulerEventTriggerFiringMode => trigger.firingMode ?? "event";

const getStatefulTriggerRepeatIntervalMs = (
  trigger: SchedulerEventTrigger,
): number =>
  trigger.repeatIntervalMs ??
  trigger.cooldownMs ??
  DEFAULT_STATEFUL_TRIGGER_REPEAT_MS;

export const getSchedulerEventTriggerRecoveryMatched = (
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
  activationMatched: boolean,
): boolean => {
  if (trigger.recoveryFilters) {
    return eventFilterRecordMatches(trigger.recoveryFilters, event);
  }

  return !activationMatched;
};

export const getSchedulerStatefulTriggerSkipReason = (
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
): string | undefined => {
  if (getSchedulerEventTriggerFiringMode(trigger) !== "state") {
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

export const getSchedulerTriggerCooldownSkipReason = (
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
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

export const getSchedulerTriggerRateLimitSkipReason = (
  state: SchedulerEventTriggerStateSnapshot,
  trigger: SchedulerEventTrigger,
  event: SchedulerTriggerEvent,
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
