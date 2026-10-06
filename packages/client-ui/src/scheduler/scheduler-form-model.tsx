import type {
  SchedulerCreateJobInput,
  SchedulerCreateTriggerInput,
  SchedulerMissedRunPolicy,
  SchedulerRunStatus,
  SchedulerRalphVariableReadinessSummary,
} from "@machdoch/fleet-protocol/scheduler-contract";
import type { SchedulerRuntime } from "./scheduler-runtime";

type ReasoningMode = NonNullable<SchedulerCreateJobInput["reasoning"]>;

export type ScheduleType = "cron" | "interval" | "delay" | "event";
export type SchedulerPanelTab = "jobs" | "runs";
export type SchedulerReasoningFormValue = "" | ReasoningMode;
export type SchedulerTriggerKind =
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
export type SchedulerRalphVariable = SchedulerRalphVariableReadinessSummary;

export interface SchedulerRalphReadinessView {
  ready: boolean;
  loading: boolean;
  errors: string[];
  warnings: string[];
}
export type SchedulerRalphFlowOption = Awaited<
  ReturnType<SchedulerRuntime["listRalphFlows"]>
>["flows"][number];

export const SCHEDULER_PANEL_REFRESH_INTERVAL_MS = 10_000;

export interface SchedulerFormState {
  name: string;
  targetType: "prompt" | "ralph-flow";
  prompt: string;
  ralphFlowId: string;
  ralphFlowScope: "workspace" | "user";
  ralphParams: string;
  ralphRunLogScope: "workspace" | "user";
  ralphMaxTransitions: string;
  ralphAllowedRoots: string;
  ralphUnattended: boolean;
  ralphAllowCommands: boolean;
  ralphAllowWrites: boolean;
  ralphAllowNetwork: boolean;
  ralphAllowMcpTools: boolean;
  scheduleType: ScheduleType;
  cron: string;
  timezone: string;
  intervalMs: string;
  delayMs: string;
  runAtLocal: string;
  triggerEnabled: boolean;
  triggerKind: SchedulerTriggerKind;
  triggerEventType: string;
  triggerFiringMode: "event" | "state";
  triggerFilters: string;
  triggerRecoveryFilters: string;
  triggerCooldownMs: string;
  triggerRepeatMs: string;
  triggerMaxEvents: string;
  triggerWindowMs: string;
  triggerDedupeKeyTemplate: string;
  contextPaths: string;
  imagePaths: string;
  contextPackJson: string;
  macros: string;
  missedRunPolicy: SchedulerMissedRunPolicy;
  retryAttempts: string;
  retryMinMs: string;
  retryMaxMs: string;
  retryFactor: string;
  retryRandomize: boolean;
  ttlMs: string;
  maxDurationMs: string;
  dedupeKey: string;
  concurrencyKey: string;
  concurrencyLimit: string;
  historyLimit: string;
  maxCatchUpRuns: string;
  mode: "" | "ask" | "machdoch";
  reasoning: SchedulerReasoningFormValue;
  provider: "" | "openai" | "anthropic" | "google";
  model: string;
}

export const createDefaultFormState = (): SchedulerFormState => ({
  name: "",
  targetType: "prompt",
  prompt: "",
  ralphFlowId: "",
  ralphFlowScope: "workspace",
  ralphParams: "",
  ralphRunLogScope: "workspace",
  ralphMaxTransitions: "",
  ralphAllowedRoots: "",
  ralphUnattended: true,
  ralphAllowCommands: true,
  ralphAllowWrites: true,
  ralphAllowNetwork: true,
  ralphAllowMcpTools: true,
  scheduleType: "cron",
  cron: "0 9 * * *",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  intervalMs: "3600000",
  delayMs: "60000",
  runAtLocal: "",
  triggerEnabled: false,
  triggerKind: "workspace-file",
  triggerEventType: "workspace-file.created",
  triggerFiringMode: "event",
  triggerFilters: "",
  triggerRecoveryFilters: "",
  triggerCooldownMs: "",
  triggerRepeatMs: "",
  triggerMaxEvents: "",
  triggerWindowMs: "",
  triggerDedupeKeyTemplate: "",
  contextPaths: "",
  imagePaths: "",
  contextPackJson: "",
  macros: "",
  missedRunPolicy: "enqueue-latest",
  retryAttempts: "3",
  retryMinMs: "1000",
  retryMaxMs: "60000",
  retryFactor: "2",
  retryRandomize: true,
  ttlMs: "",
  maxDurationMs: "",
  dedupeKey: "",
  concurrencyKey: "",
  concurrencyLimit: "1",
  historyLimit: "100",
  maxCatchUpRuns: "100",
  mode: "",
  reasoning: "",
  provider: "",
  model: "",
});

export const triggerKindOptions: Array<{
  value: SchedulerTriggerKind;
  label: string;
}> = [
  { value: "workspace-file", label: "Workspace File" },
  { value: "system", label: "System" },
  { value: "git", label: "Git" },
  { value: "webhook", label: "Webhook" },
  { value: "poll", label: "Polling" },
  { value: "app", label: "App Event" },
  { value: "integration", label: "Integration" },
  { value: "calendar", label: "Calendar" },
  { value: "clipboard", label: "Clipboard" },
  { value: "job-event", label: "Job Event" },
  { value: "manual", label: "Manual Event" },
];

export const defaultEventTypeByKind: Record<SchedulerTriggerKind, string> = {
  manual: "manual.triggered",
  app: "app.workspace-opened",
  "workspace-file": "workspace-file.created",
  git: "git.branch-changed",
  "job-event": "job-event.completed",
  webhook: "webhook.received",
  poll: "poll.http-status",
  system: "system.disk-threshold",
  calendar: "calendar.event-starting",
  clipboard: "clipboard.changed",
  integration: "integration.event",
};

export const terminalRunStatuses = new Set<SchedulerRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
  "skipped",
]);

export const splitLines = (value: string): string[] => {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
};

export const parseRalphParams = (value: string): Record<string, string> => {
  const params: Record<string, string> = {};

  for (const entry of splitLines(value)) {
    const separatorIndex = entry.indexOf("=");

    if (separatorIndex <= 0) {
      throw new Error("Ralph params must use name=value lines.");
    }

    const key = entry.slice(0, separatorIndex).trim();
    const paramValue = entry.slice(separatorIndex + 1);

    if (!key) {
      throw new Error("Ralph params must include a non-empty name.");
    }

    params[key] = paramValue;
  }

  return params;
};

export const serializeRalphParams = (
  params: Record<string, string>,
): string => {
  return Object.entries(params)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
};

export const setSchedulerRalphParam = (
  serializedParams: string,
  name: string,
  value: string,
): string => {
  let params: Record<string, string> = {};

  try {
    params = parseRalphParams(serializedParams);
  } catch {}

  if (value === "") {
    delete params[name];
  } else {
    params[name] = value;
  }

  return serializeRalphParams(params);
};

export const getSchedulerRalphParamEditorValue = (
  serializedParams: string,
  name: string,
): string => {
  try {
    return parseRalphParams(serializedParams)[name] ?? "";
  } catch {
    return "";
  }
};

export const parseOptionalPositiveInteger = (
  value: string,
  label: string,
): number | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
};

export const parseOptionalPositiveNumber = (
  value: string,
  label: string,
): number | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return parsed;
};

export const parseTriggerFilterValue = (value: string): unknown => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null") {
    return null;
  }

  const parsed = Number(value);

  if (value.length > 0 && Number.isFinite(parsed)) {
    return parsed;
  }

  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    return JSON.parse(value) as unknown;
  }

  return value;
};

export const parseTriggerFilters = (
  value: string,
  label: string,
): Record<string, unknown> | undefined => {
  const filters = splitLines(value);

  if (filters.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    filters.map((entry) => {
      const match = /^(.*?)\s*(>=|<=|!=|=|>|<)\s*(.*?)$/u.exec(entry);

      if (!match || !match[1]?.trim()) {
        throw new Error(`${label} must use path=value or path>=value.`);
      }

      const path = match[1].trim();
      const operator = match[2];
      const filterValue = parseTriggerFilterValue(match[3]?.trim() ?? "");

      return [
        path,
        operator === "=" ? filterValue : { op: operator, value: filterValue },
      ];
    }),
  );
};

export const parseContextPacks = (
  value: string,
): NonNullable<SchedulerCreateJobInput["contextPacks"]> => {
  const normalized = value.trim();

  if (!normalized) {
    return [];
  }

  const parsed = JSON.parse(normalized) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];

  return entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("name" in entry) ||
      typeof entry.name !== "string"
    ) {
      throw new Error("Context pack JSON must include a name.");
    }

    const candidate = entry as {
      name: string;
      instructions?: unknown;
      prompt?: unknown;
      contextPaths?: unknown;
      variableValues?: unknown;
    };

    return {
      name: candidate.name,
      ...(typeof candidate.instructions === "string"
        ? { instructions: candidate.instructions }
        : {}),
      ...(typeof candidate.prompt === "string"
        ? { prompt: candidate.prompt }
        : {}),
      ...(Array.isArray(candidate.contextPaths)
        ? {
            contextPaths: candidate.contextPaths.filter(
              (path): path is string => typeof path === "string",
            ),
          }
        : {}),
      ...(candidate.variableValues &&
      typeof candidate.variableValues === "object" &&
      !Array.isArray(candidate.variableValues)
        ? {
            variableValues: Object.fromEntries(
              Object.entries(candidate.variableValues).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            ),
          }
        : {}),
    };
  });
};

export const buildSchedulerCreateInput = (
  form: SchedulerFormState,
  reasoningValue: SchedulerReasoningFormValue,
  activeWorkspace: string | null,
): SchedulerCreateJobInput => {
  const prompt = form.prompt.trim();
  const ralphFlowId = form.ralphFlowId.trim();

  if (form.targetType === "prompt" && !prompt) {
    throw new Error("Prompt is required.");
  }

  if (form.targetType === "ralph-flow" && !ralphFlowId) {
    throw new Error("Ralph flow id is required.");
  }

  const intervalMs = parseOptionalPositiveInteger(form.intervalMs, "Interval");
  const delayMs = parseOptionalPositiveInteger(form.delayMs, "Delay");
  const hasRunAtLocal = form.runAtLocal.trim().length > 0;
  const runAt = hasRunAtLocal ? new Date(form.runAtLocal).getTime() : undefined;

  if (
    form.scheduleType === "delay" &&
    hasRunAtLocal &&
    !Number.isFinite(runAt)
  ) {
    throw new Error("Run at must be a valid local date and time.");
  }

  if (
    form.scheduleType === "delay" &&
    delayMs === undefined &&
    runAt === undefined
  ) {
    throw new Error("Delay or run at is required.");
  }

  const schedule =
    form.scheduleType === "event"
      ? undefined
      : form.scheduleType === "cron"
        ? {
            type: "cron" as const,
            expression: form.cron.trim(),
            ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
          }
        : form.scheduleType === "interval"
          ? {
              type: "interval" as const,
              intervalMs:
                intervalMs ??
                (() => {
                  throw new Error("Interval is required.");
                })(),
            }
          : {
              type: "delay" as const,
              ...(delayMs ? { delayMs } : {}),
              ...(runAt ? { runAt } : {}),
            };
  const triggerEnabled = form.triggerEnabled || form.scheduleType === "event";
  const triggerCooldownMs = parseOptionalPositiveInteger(
    form.triggerCooldownMs,
    "Trigger cooldown",
  );
  const triggerRepeatMs = parseOptionalPositiveInteger(
    form.triggerRepeatMs,
    "Trigger repeat",
  );
  const triggerMaxEvents = parseOptionalPositiveInteger(
    form.triggerMaxEvents,
    "Trigger max events",
  );
  const triggerWindowMs = parseOptionalPositiveInteger(
    form.triggerWindowMs,
    "Trigger window",
  );

  if ((triggerMaxEvents === undefined) !== (triggerWindowMs === undefined)) {
    throw new Error(
      "Trigger max events and trigger window must be set together.",
    );
  }

  const triggers: SchedulerCreateTriggerInput[] = [];

  if (triggerEnabled) {
    const eventType = form.triggerEventType.trim();

    if (!eventType) {
      throw new Error("Trigger event type is required.");
    }

    const triggerFilters = parseTriggerFilters(
      form.triggerFilters,
      "Activation filters",
    );
    const triggerRecoveryFilters = parseTriggerFilters(
      form.triggerRecoveryFilters,
      "Recovery filters",
    );

    triggers.push({
      kind: form.triggerKind,
      eventType,
      firingMode: form.triggerFiringMode,
      ...(triggerFilters ? { filters: triggerFilters } : {}),
      ...(triggerRecoveryFilters
        ? { recoveryFilters: triggerRecoveryFilters }
        : {}),
      ...(triggerCooldownMs ? { cooldownMs: triggerCooldownMs } : {}),
      ...(triggerRepeatMs ? { repeatIntervalMs: triggerRepeatMs } : {}),
      ...(form.triggerDedupeKeyTemplate.trim()
        ? { dedupeKeyTemplate: form.triggerDedupeKeyTemplate.trim() }
        : {}),
      ...(triggerMaxEvents && triggerWindowMs
        ? {
            maxEventsPerWindow: {
              maxEvents: triggerMaxEvents,
              windowMs: triggerWindowMs,
            },
          }
        : {}),
    });
  }

  const sharedInput = {
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(schedule ? { schedule } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    missedRunPolicy: form.missedRunPolicy,
    retryAttempts: parseOptionalPositiveInteger(
      form.retryAttempts,
      "Retry attempts",
    ),
    retryMinMs: parseOptionalPositiveInteger(form.retryMinMs, "Retry minimum"),
    retryMaxMs: parseOptionalPositiveInteger(form.retryMaxMs, "Retry maximum"),
    retryFactor: parseOptionalPositiveNumber(form.retryFactor, "Retry factor"),
    retryRandomize: form.retryRandomize,
    ttlMs: parseOptionalPositiveInteger(form.ttlMs, "TTL"),
    maxDurationMs: parseOptionalPositiveInteger(
      form.maxDurationMs,
      "Max duration",
    ),
    ...(form.dedupeKey.trim() ? { dedupeKey: form.dedupeKey.trim() } : {}),
    ...(form.concurrencyKey.trim()
      ? { concurrencyKey: form.concurrencyKey.trim() }
      : {}),
    concurrencyLimit: parseOptionalPositiveInteger(
      form.concurrencyLimit,
      "Concurrency limit",
    ),
    historyLimit: parseOptionalPositiveInteger(
      form.historyLimit,
      "History limit",
    ),
    maxCatchUpRuns: parseOptionalPositiveInteger(
      form.maxCatchUpRuns,
      "Catch-up limit",
    ),
  };

  if (form.targetType === "ralph-flow") {
    return {
      ...sharedInput,
      targetType: "ralph-flow",
      ralphFlow: {
        id: ralphFlowId,
        scope: form.ralphFlowScope,
        params: parseRalphParams(form.ralphParams),
        runLogScope: form.ralphRunLogScope,
        ...(form.ralphUnattended
          ? {
              executionProfile: "unattended" as const,
              resumePolicy: "recoverable" as const,
            }
          : {}),
        maxTransitions: parseOptionalPositiveInteger(
          form.ralphMaxTransitions,
          "Ralph max transitions",
        ),
        permissions: {
          allowedRoots:
            splitLines(form.ralphAllowedRoots).length > 0
              ? splitLines(form.ralphAllowedRoots)
              : activeWorkspace
                ? [activeWorkspace]
                : [],
          allowCommands: form.ralphAllowCommands,
          allowWrites: form.ralphAllowWrites,
          allowNetwork: form.ralphAllowNetwork,
          allowMcpTools: form.ralphAllowMcpTools,
        },
      },
    };
  }

  return {
    ...sharedInput,
    targetType: "prompt",
    prompt,
    contextPaths: splitLines(form.contextPaths),
    imagePaths: splitLines(form.imagePaths),
    contextPacks: parseContextPacks(form.contextPackJson),
    macros: splitLines(form.macros),
    ...(form.mode ? { mode: form.mode } : {}),
    ...(reasoningValue ? { reasoning: reasoningValue } : {}),
    ...(form.provider ? { provider: form.provider } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
  };
};
