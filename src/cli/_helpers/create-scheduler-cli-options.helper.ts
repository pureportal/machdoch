import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import type {
  SchedulerCliAction,
  SchedulerCliOptions,
} from "./cli-args-types.js";
import {
  fail,
  parseBooleanToggle,
  parseOptionalPositiveInteger,
  parseOptionalPositiveNumber,
} from "./parse-cli-primitive.helper.js";

export interface RawSchedulerCliOptions {
  action: SchedulerCliAction;
  rawSubject?: string | undefined;
  rawSchedulerName?: string | undefined;
  rawSchedulerCron?: string | undefined;
  rawSchedulerTriggers?: string[] | undefined;
  rawSchedulerTriggerFilters?: string[] | undefined;
  rawSchedulerTriggerRecoveryFilters?: string[] | undefined;
  rawSchedulerTriggerFiringMode?: string | undefined;
  rawSchedulerTriggerCooldownMs?: string | undefined;
  rawSchedulerTriggerRepeatMs?: string | undefined;
  rawSchedulerTriggerDebounceMs?: string | undefined;
  rawSchedulerTriggerDedupeKeyTemplate?: string | undefined;
  rawSchedulerTriggerMaxEvents?: string | undefined;
  rawSchedulerTriggerWindowMs?: string | undefined;
  rawSchedulerIntervalMs?: string | undefined;
  rawSchedulerDelayMs?: string | undefined;
  rawSchedulerRunAt?: string | undefined;
  rawSchedulerTimezone?: string | undefined;
  rawSchedulerPrompt?: string | undefined;
  rawSchedulerPromptFile?: string | undefined;
  rawSchedulerContextPacks?: string[] | undefined;
  rawSchedulerMacros?: string[] | undefined;
  rawSchedulerMissedRunPolicy?: string | undefined;
  rawSchedulerMissedRunGraceMs?: string | undefined;
  rawSchedulerRetryAttempts?: string | undefined;
  rawSchedulerRetryMinMs?: string | undefined;
  rawSchedulerRetryMaxMs?: string | undefined;
  rawSchedulerRetryFactor?: string | undefined;
  rawSchedulerRetryRandomize?: string | undefined;
  rawSchedulerDedupeKey?: string | undefined;
  rawSchedulerTtlMs?: string | undefined;
  rawSchedulerMaxDurationMs?: string | undefined;
  rawSchedulerConcurrencyKey?: string | undefined;
  rawSchedulerConcurrencyLimit?: string | undefined;
  rawSchedulerHistoryLimit?: string | undefined;
  rawSchedulerMaxCatchUpRuns?: string | undefined;
  rawSchedulerEventType?: string | undefined;
  rawSchedulerEventKind?: string | undefined;
  rawSchedulerEventSource?: string | undefined;
  rawSchedulerEventPayloadJson?: string | undefined;
  rawSchedulerEventDedupeKey?: string | undefined;
  rawSchedulerEventOccurredAt?: string | undefined;
}

const assignPositiveInteger = (
  options: SchedulerCliOptions,
  key: keyof SchedulerCliOptions,
  value: string | undefined,
  flagName: string,
): void => {
  const parsed = parseOptionalPositiveInteger(value, flagName);

  if (parsed !== undefined) {
    Object.assign(options, { [key]: parsed });
  }
};

export const createSchedulerCliOptions = ({
  action,
  rawSubject,
  rawSchedulerName,
  rawSchedulerCron,
  rawSchedulerTriggers,
  rawSchedulerTriggerFilters,
  rawSchedulerTriggerRecoveryFilters,
  rawSchedulerTriggerFiringMode,
  rawSchedulerTriggerCooldownMs,
  rawSchedulerTriggerRepeatMs,
  rawSchedulerTriggerDebounceMs,
  rawSchedulerTriggerDedupeKeyTemplate,
  rawSchedulerTriggerMaxEvents,
  rawSchedulerTriggerWindowMs,
  rawSchedulerIntervalMs,
  rawSchedulerDelayMs,
  rawSchedulerRunAt,
  rawSchedulerTimezone,
  rawSchedulerPrompt,
  rawSchedulerPromptFile,
  rawSchedulerContextPacks,
  rawSchedulerMacros,
  rawSchedulerMissedRunPolicy,
  rawSchedulerMissedRunGraceMs,
  rawSchedulerRetryAttempts,
  rawSchedulerRetryMinMs,
  rawSchedulerRetryMaxMs,
  rawSchedulerRetryFactor,
  rawSchedulerRetryRandomize,
  rawSchedulerDedupeKey,
  rawSchedulerTtlMs,
  rawSchedulerMaxDurationMs,
  rawSchedulerConcurrencyKey,
  rawSchedulerConcurrencyLimit,
  rawSchedulerHistoryLimit,
  rawSchedulerMaxCatchUpRuns,
  rawSchedulerEventType,
  rawSchedulerEventKind,
  rawSchedulerEventSource,
  rawSchedulerEventPayloadJson,
  rawSchedulerEventDedupeKey,
  rawSchedulerEventOccurredAt,
}: RawSchedulerCliOptions): SchedulerCliOptions => {
  if (action === "create") {
    const scheduleCount = [
      rawSchedulerCron,
      rawSchedulerIntervalMs,
      rawSchedulerDelayMs ?? rawSchedulerRunAt,
    ].filter(Boolean).length;
    const triggerCount = rawSchedulerTriggers?.length ?? 0;

    if (scheduleCount > 1) {
      fail(
        "`machdoch scheduler create` expects at most one of --cron, --interval-ms, or --delay-ms/--run-at.",
      );
    }

    if (scheduleCount + triggerCount === 0) {
      fail(
        "`machdoch scheduler create` expects --cron, --interval-ms, --delay-ms/--run-at, or --trigger.",
      );
    }

    if (!rawSchedulerPrompt && !rawSchedulerPromptFile) {
      fail("`machdoch scheduler create` expects --prompt or --prompt-file.");
    }
  }

  if (action === "event" && !rawSchedulerEventType) {
    fail("`machdoch scheduler event` expects --event-type.");
  }

  const options: SchedulerCliOptions = { action };
  const subject = normalizeOptionalString(rawSubject);

  if (subject) {
    options.subject = subject;
  }

  if (rawSchedulerName) {
    options.name = rawSchedulerName;
  }

  if (rawSchedulerCron) {
    options.cron = rawSchedulerCron;
  }

  if (rawSchedulerTriggers && rawSchedulerTriggers.length > 0) {
    options.triggers = rawSchedulerTriggers;
  }

  if (rawSchedulerTriggerFilters && rawSchedulerTriggerFilters.length > 0) {
    options.triggerFilters = rawSchedulerTriggerFilters;
  }

  if (
    rawSchedulerTriggerRecoveryFilters &&
    rawSchedulerTriggerRecoveryFilters.length > 0
  ) {
    options.triggerRecoveryFilters = rawSchedulerTriggerRecoveryFilters;
  }

  if (rawSchedulerTriggerFiringMode) {
    options.triggerFiringMode = rawSchedulerTriggerFiringMode;
  }

  assignPositiveInteger(
    options,
    "triggerCooldownMs",
    rawSchedulerTriggerCooldownMs,
    "--trigger-cooldown-ms",
  );
  assignPositiveInteger(
    options,
    "triggerRepeatMs",
    rawSchedulerTriggerRepeatMs,
    "--trigger-repeat-ms",
  );
  assignPositiveInteger(
    options,
    "triggerDebounceMs",
    rawSchedulerTriggerDebounceMs,
    "--trigger-debounce-ms",
  );

  if (rawSchedulerTriggerDedupeKeyTemplate) {
    options.triggerDedupeKeyTemplate = rawSchedulerTriggerDedupeKeyTemplate;
  }

  assignPositiveInteger(
    options,
    "triggerMaxEvents",
    rawSchedulerTriggerMaxEvents,
    "--trigger-max-events",
  );
  assignPositiveInteger(
    options,
    "triggerWindowMs",
    rawSchedulerTriggerWindowMs,
    "--trigger-window-ms",
  );
  assignPositiveInteger(
    options,
    "intervalMs",
    rawSchedulerIntervalMs,
    "--interval-ms",
  );
  assignPositiveInteger(options, "delayMs", rawSchedulerDelayMs, "--delay-ms");
  assignPositiveInteger(options, "runAt", rawSchedulerRunAt, "--run-at");

  if (rawSchedulerTimezone) {
    options.timezone = rawSchedulerTimezone;
  }

  if (rawSchedulerPrompt) {
    options.prompt = rawSchedulerPrompt;
  }

  if (rawSchedulerPromptFile) {
    options.promptFile = rawSchedulerPromptFile;
  }

  if (rawSchedulerContextPacks && rawSchedulerContextPacks.length > 0) {
    options.contextPacks = rawSchedulerContextPacks;
  }

  if (rawSchedulerMacros && rawSchedulerMacros.length > 0) {
    options.macros = rawSchedulerMacros;
  }

  if (rawSchedulerMissedRunPolicy) {
    options.missedRunPolicy = rawSchedulerMissedRunPolicy;
  }

  assignPositiveInteger(
    options,
    "missedRunGraceMs",
    rawSchedulerMissedRunGraceMs,
    "--missed-run-grace-ms",
  );
  assignPositiveInteger(
    options,
    "retryAttempts",
    rawSchedulerRetryAttempts,
    "--retry-attempts",
  );
  assignPositiveInteger(
    options,
    "retryMinMs",
    rawSchedulerRetryMinMs,
    "--retry-min-ms",
  );
  assignPositiveInteger(
    options,
    "retryMaxMs",
    rawSchedulerRetryMaxMs,
    "--retry-max-ms",
  );

  const retryFactor = parseOptionalPositiveNumber(
    rawSchedulerRetryFactor,
    "--retry-factor",
  );

  if (retryFactor !== undefined) {
    options.retryFactor = retryFactor;
  }

  if (rawSchedulerRetryRandomize) {
    options.retryRandomize = parseBooleanToggle(
      rawSchedulerRetryRandomize,
      "--retry-randomize",
    );
  }

  if (rawSchedulerDedupeKey) {
    options.dedupeKey = rawSchedulerDedupeKey;
  }

  assignPositiveInteger(options, "ttlMs", rawSchedulerTtlMs, "--ttl-ms");
  assignPositiveInteger(
    options,
    "maxDurationMs",
    rawSchedulerMaxDurationMs,
    "--max-duration-ms",
  );

  if (rawSchedulerConcurrencyKey) {
    options.concurrencyKey = rawSchedulerConcurrencyKey;
  }

  assignPositiveInteger(
    options,
    "concurrencyLimit",
    rawSchedulerConcurrencyLimit,
    "--concurrency-limit",
  );
  assignPositiveInteger(
    options,
    "historyLimit",
    rawSchedulerHistoryLimit,
    "--history-limit",
  );
  assignPositiveInteger(
    options,
    "maxCatchUpRuns",
    rawSchedulerMaxCatchUpRuns,
    "--max-catch-up-runs",
  );

  if (rawSchedulerEventType) {
    options.eventType = rawSchedulerEventType;
  }

  if (rawSchedulerEventKind) {
    options.eventKind = rawSchedulerEventKind;
  }

  if (rawSchedulerEventSource) {
    options.eventSource = rawSchedulerEventSource;
  }

  if (rawSchedulerEventPayloadJson) {
    options.eventPayloadJson = rawSchedulerEventPayloadJson;
  }

  if (rawSchedulerEventDedupeKey) {
    options.eventDedupeKey = rawSchedulerEventDedupeKey;
  }

  assignPositiveInteger(
    options,
    "eventOccurredAt",
    rawSchedulerEventOccurredAt,
    "--event-occurred-at",
  );

  return options;
};
