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
  rawSchedulerTarget?: string | undefined;
  rawSchedulerPrompt?: string | undefined;
  rawSchedulerPromptFile?: string | undefined;
  rawScheduledRalphFlow?: string | undefined;
  rawScheduledRalphFlowScope?: string | undefined;
  rawScheduledRalphParams?: string[] | undefined;
  rawScheduledRalphRunLogScope?: string | undefined;
  rawScheduledRalphMaxTransitions?: string | undefined;
  rawScheduledRalphProfile?: string | undefined;
  rawScheduledRalphResumePolicy?: string | undefined;
  rawScheduledRalphAllowedRoots?: string[] | undefined;
  rawScheduledRalphAllowCommands?: string | undefined;
  rawScheduledRalphAllowWrites?: string | undefined;
  rawScheduledRalphAllowNetwork?: string | undefined;
  rawScheduledRalphAllowMcpTools?: string | undefined;
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
  rawSchedulerRequestId?: string | undefined;
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
  rawSchedulerServicePollMs?: string | undefined;
  rawSchedulerServiceIdleShutdownMs?: string | undefined;
  rawSchedulerServiceAbandonedRunStaleMs?: string | undefined;
  rawSchedulerServiceMaxIterations?: string | undefined;
  rawSchedulerServiceMaxRunsPerTick?: string | undefined;
  rawSchedulerServiceStartEventType?: string | undefined;
  rawSchedulerServiceStartEventKind?: string | undefined;
  rawSchedulerServiceStartEventDedupeKey?: string | undefined;
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
  rawSchedulerTarget,
  rawSchedulerPrompt,
  rawSchedulerPromptFile,
  rawScheduledRalphFlow,
  rawScheduledRalphFlowScope,
  rawScheduledRalphParams,
  rawScheduledRalphRunLogScope,
  rawScheduledRalphMaxTransitions,
  rawScheduledRalphProfile,
  rawScheduledRalphResumePolicy,
  rawScheduledRalphAllowedRoots,
  rawScheduledRalphAllowCommands,
  rawScheduledRalphAllowWrites,
  rawScheduledRalphAllowNetwork,
  rawScheduledRalphAllowMcpTools,
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
  rawSchedulerRequestId,
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
  rawSchedulerServicePollMs,
  rawSchedulerServiceIdleShutdownMs,
  rawSchedulerServiceAbandonedRunStaleMs,
  rawSchedulerServiceMaxIterations,
  rawSchedulerServiceMaxRunsPerTick,
  rawSchedulerServiceStartEventType,
  rawSchedulerServiceStartEventKind,
  rawSchedulerServiceStartEventDedupeKey,
}: RawSchedulerCliOptions): SchedulerCliOptions => {
  const rawTarget = rawSchedulerTarget ?? (rawScheduledRalphFlow ? "ralph-flow" : "prompt");

  if (rawTarget !== "prompt" && rawTarget !== "ralph-flow") {
    fail("Expected --scheduler-target to be prompt or ralph-flow.");
  }

  const target: NonNullable<SchedulerCliOptions["schedulerTarget"]> =
    rawTarget === "ralph-flow" ? "ralph-flow" : "prompt";

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

    if (target === "prompt" && !rawSchedulerPrompt && !rawSchedulerPromptFile) {
      fail("`machdoch scheduler create` expects --prompt or --prompt-file.");
    }

    if (target === "ralph-flow" && !rawScheduledRalphFlow) {
      fail("`machdoch scheduler create --scheduler-target ralph-flow` expects --scheduled-ralph-flow.");
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

  if (rawSchedulerTarget || target === "ralph-flow") {
    options.schedulerTarget = target;
  }

  if (rawSchedulerPrompt) {
    options.prompt = rawSchedulerPrompt;
  }

  if (rawSchedulerPromptFile) {
    options.promptFile = rawSchedulerPromptFile;
  }

  if (rawScheduledRalphFlow) {
    options.scheduledRalphFlow = rawScheduledRalphFlow;
  }

  if (rawScheduledRalphFlowScope) {
    if (
      rawScheduledRalphFlowScope !== "workspace" &&
      rawScheduledRalphFlowScope !== "user"
    ) {
      fail("Expected --scheduled-ralph-flow-scope to be workspace or user.");
    }

    options.scheduledRalphFlowScope = rawScheduledRalphFlowScope as "workspace" | "user";
  }

  if (rawScheduledRalphParams && rawScheduledRalphParams.length > 0) {
    options.scheduledRalphParams = rawScheduledRalphParams;
  }

  if (rawScheduledRalphRunLogScope) {
    if (
      rawScheduledRalphRunLogScope !== "workspace" &&
      rawScheduledRalphRunLogScope !== "user"
    ) {
      fail("Expected --scheduled-ralph-run-log-scope to be workspace or user.");
    }

    options.scheduledRalphRunLogScope = rawScheduledRalphRunLogScope as "workspace" | "user";
  }

  assignPositiveInteger(
    options,
    "scheduledRalphMaxTransitions",
    rawScheduledRalphMaxTransitions,
    "--scheduled-ralph-max-transitions",
  );

  if (rawScheduledRalphProfile) {
    if (rawScheduledRalphProfile !== "unattended") {
      fail("Expected --scheduled-ralph-profile to be unattended.");
    }

    options.scheduledRalphProfile = "unattended";
  }

  if (rawScheduledRalphResumePolicy) {
    if (
      rawScheduledRalphResumePolicy !== "never" &&
      rawScheduledRalphResumePolicy !== "recoverable"
    ) {
      fail(
        "Expected --scheduled-ralph-resume-policy to be never or recoverable.",
      );
    }

    options.scheduledRalphResumePolicy =
      rawScheduledRalphResumePolicy === "never" ? "never" : "recoverable";
  }

  if (rawScheduledRalphAllowedRoots && rawScheduledRalphAllowedRoots.length > 0) {
    options.scheduledRalphAllowedRoots = rawScheduledRalphAllowedRoots;
  }

  if (rawScheduledRalphAllowCommands) {
    options.scheduledRalphAllowCommands = parseBooleanToggle(
      rawScheduledRalphAllowCommands,
      "--scheduled-ralph-allow-commands",
    );
  }

  if (rawScheduledRalphAllowWrites) {
    options.scheduledRalphAllowWrites = parseBooleanToggle(
      rawScheduledRalphAllowWrites,
      "--scheduled-ralph-allow-writes",
    );
  }

  if (rawScheduledRalphAllowNetwork) {
    options.scheduledRalphAllowNetwork = parseBooleanToggle(
      rawScheduledRalphAllowNetwork,
      "--scheduled-ralph-allow-network",
    );
  }

  if (rawScheduledRalphAllowMcpTools) {
    options.scheduledRalphAllowMcpTools = parseBooleanToggle(
      rawScheduledRalphAllowMcpTools,
      "--scheduled-ralph-allow-mcp-tools",
    );
  }

  if (rawSchedulerContextPacks && rawSchedulerContextPacks.length > 0) {
    options.contextPacks = rawSchedulerContextPacks;
  }

  if (rawSchedulerMacros && rawSchedulerMacros.length > 0) {
    options.macros = rawSchedulerMacros;
  }

  if (rawSchedulerRequestId) {
    options.requestId = rawSchedulerRequestId;
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

  assignPositiveInteger(
    options,
    "servicePollMs",
    rawSchedulerServicePollMs,
    "--service-poll-ms",
  );
  assignPositiveInteger(
    options,
    "serviceIdleShutdownMs",
    rawSchedulerServiceIdleShutdownMs,
    "--service-idle-shutdown-ms",
  );
  assignPositiveInteger(
    options,
    "serviceAbandonedRunStaleMs",
    rawSchedulerServiceAbandonedRunStaleMs,
    "--service-abandoned-run-stale-ms",
  );
  assignPositiveInteger(
    options,
    "serviceMaxIterations",
    rawSchedulerServiceMaxIterations,
    "--service-max-iterations",
  );
  assignPositiveInteger(
    options,
    "serviceMaxRunsPerTick",
    rawSchedulerServiceMaxRunsPerTick,
    "--service-max-runs-per-tick",
  );

  if (rawSchedulerServiceStartEventType) {
    options.serviceStartEventType = rawSchedulerServiceStartEventType;
  }

  if (rawSchedulerServiceStartEventKind) {
    options.serviceStartEventKind = rawSchedulerServiceStartEventKind;
  }

  if (rawSchedulerServiceStartEventDedupeKey) {
    options.serviceStartEventDedupeKey = rawSchedulerServiceStartEventDedupeKey;
  }

  return options;
};
