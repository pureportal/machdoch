import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import type { InstructionAudience, InstructionMode } from "../../core/types.js";
import type { ModelProvider, ReasoningMode, RuntimeAgentLimitOverrides, RunMode, UserApiProvider } from "../../core/runtime-contract.generated.js";
import {
  INSTRUCTION_ACTIONS,
  INSTRUCTION_ACTIONS_REQUIRING_SUBJECT,
  INSTRUCTION_AUDIENCES,
  INSTRUCTION_MODES,
  INSTRUCTION_SCOPES,
  MCP_ACTIONS,
  MCP_ACTIONS_REQUIRING_SERVER,
  MCP_ACTIONS_REQUIRING_TARGET,
  RALPH_ACTIONS,
  RALPH_ACTIONS_REQUIRING_SUBJECT,
  RALPH_GENERATION_MODES,
  RALPH_GENERATION_TARGETS,
  RALPH_SCOPES,
  RALPH_WATCH_ACTIONS,
  SCHEDULER_ACTIONS,
  SCHEDULER_ACTIONS_REQUIRING_SUBJECT,
  VALID_MODE_DESCRIPTION,
  VALID_MODES,
  VALID_PROVIDERS,
  VALID_REASONING_MODE_DESCRIPTION,
  VALID_REASONING_MODES,
  VALID_RUNTIME_PROVIDER_DESCRIPTION,
  VALID_RUNTIME_PROVIDERS,
} from "./cli-args-constants.js";
import { createParsedArgs, createSharedParsedOptions } from "./create-parsed-cli-args.helper.js";
import { createSchedulerCliOptions } from "./create-scheduler-cli-options.helper.js";
import { getHelpText } from "./cli-help-text.js";
import {
  assertNoAdditionalPositionals,
  fail,
  normalizeContextPaths,
  normalizeImagePaths,
  parseBooleanToggle,
  parseMemoryOverride,
  parseOptionalInteger,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
} from "./parse-cli-primitive.helper.js";
export type {
  CommandName,
  InstructionCliAction,
  InstructionCliOptions,
  InstructionCliScope,
  McpCliAction,
  McpCliOptions,
  ParsedCliArgs,
  RalphCliAction,
  RalphCliGenerationMode,
  RalphCliGenerationTarget,
  RalphCliOptions,
  RalphCliScope,
  RalphWatchCliAction,
  SchedulerCliAction,
  SchedulerCliOptions,
} from "./cli-args-types.js";
import type {
  InstructionCliAction,
  InstructionCliScope,
  McpCliAction,
  ParsedCliArgs,
  RalphCliAction,
  RalphCliGenerationMode,
  RalphCliGenerationTarget,
  RalphCliScope,
  RalphWatchCliAction,
  SchedulerCliAction,
} from "./cli-args-types.js";

export { getHelpText };

export const parseCliArgs = (
  argv: string[],
  options?: {
    currentWorkingDirectory?: string;
  },
): ParsedCliArgs => {
  const currentWorkingDirectory =
    options?.currentWorkingDirectory ?? process.cwd();

  let values:
    | {
        json?: boolean;
        verbose?: boolean;
        help?: boolean;
        quick?: boolean;
        "set-api"?: boolean;
        "set-global-memory"?: string;
        mode?: string;
        provider?: string;
        "runtime-provider"?: string;
        key?: string;
        task?: string;
        model?: string;
        reasoning?: string;
        "default-model"?: string;
        "session-memory"?: string;
        "global-memory"?: string;
        "executor-turns"?: string;
        "autopilot-iterations"?: string;
        infinite?: boolean;
        "conversation-context-file"?: string;
        context?: string[];
        image?: string[];
        profile?: string;
        cwd?: string;
        name?: string;
        cron?: string;
        trigger?: string[];
        "trigger-filter"?: string[];
        "trigger-recovery-filter"?: string[];
        "trigger-firing-mode"?: string;
        "trigger-cooldown-ms"?: string;
        "trigger-repeat-ms"?: string;
        "trigger-debounce-ms"?: string;
        "trigger-dedupe-key-template"?: string;
        "trigger-max-events"?: string;
        "trigger-window-ms"?: string;
        "interval-ms"?: string;
        "delay-ms"?: string;
        "run-at"?: string;
        timezone?: string;
        "scheduler-target"?: string;
        prompt?: string;
        "prompt-file"?: string;
        "scheduled-ralph-flow"?: string;
        "scheduled-ralph-flow-scope"?: string;
        "scheduled-ralph-param"?: string[];
        "scheduled-ralph-run-log-scope"?: string;
        "scheduled-ralph-max-transitions"?: string;
        "scheduled-ralph-allowed-root"?: string[];
        "scheduled-ralph-allow-commands"?: string;
        "scheduled-ralph-allow-writes"?: string;
        "scheduled-ralph-allow-network"?: string;
        "scheduled-ralph-allow-mcp-tools"?: string;
        "flow-json"?: string;
        "flow-json-file"?: string;
        "watch-json"?: string;
        "watch-json-file"?: string;
        "existing-flow-json"?: string;
        "existing-flow-json-file"?: string;
        revision?: string;
        "flow-target"?: string;
        "generation-mode"?: string;
        param?: string[];
        "params-file"?: string;
        "input-json"?: string;
        "input-json-file"?: string;
        "max-rounds"?: string;
        "max-transitions"?: string;
        trace?: boolean;
        "context-pack"?: string[];
        macro?: string[];
        "missed-run-policy"?: string;
        "missed-run-grace-ms"?: string;
        "retry-attempts"?: string;
        "retry-min-ms"?: string;
        "retry-max-ms"?: string;
        "retry-factor"?: string;
        "retry-randomize"?: string;
        "dedupe-key"?: string;
        "ttl-ms"?: string;
        "max-duration-ms"?: string;
        "concurrency-key"?: string;
        "concurrency-limit"?: string;
        "history-limit"?: string;
        "max-catch-up-runs"?: string;
        "event-type"?: string;
        "event-kind"?: string;
        "event-source"?: string;
        "event-payload-json"?: string;
        "event-dedupe-key"?: string;
        "event-occurred-at"?: string;
        "service-poll-ms"?: string;
        "service-idle-shutdown-ms"?: string;
        "service-abandoned-run-stale-ms"?: string;
        "service-max-iterations"?: string;
        "service-max-runs-per-tick"?: string;
        "service-start-event-type"?: string;
        "service-start-event-kind"?: string;
        "service-start-event-dedupe-key"?: string;
        "arguments-json"?: string;
        "include-disabled"?: boolean;
        agent?: string;
        phase?: string;
        "unused-days"?: string;
        "never-used-days"?: string;
        apply?: boolean;
        scope?: string;
        path?: string;
        "apply-to"?: string[];
        exclude?: string[];
        keyword?: string[];
        "instruction-mode"?: string;
        audience?: string;
        priority?: string;
        "ralph-flow"?: string;
        "flow-scope"?: string;
      }
    | undefined;
  let positionals: string[] = [];

  try {
    const parsed = parseNodeArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        quick: { type: "boolean" },
        "set-api": { type: "boolean" },
        "set-global-memory": { type: "string" },
        mode: { type: "string" },
        provider: { type: "string" },
        "runtime-provider": { type: "string" },
        key: { type: "string" },
        task: { type: "string" },
        model: { type: "string" },
        reasoning: { type: "string" },
        "default-model": { type: "string" },
        "session-memory": { type: "string" },
        "global-memory": { type: "string" },
        "executor-turns": { type: "string" },
        "autopilot-iterations": { type: "string" },
        infinite: { type: "boolean" },
        "conversation-context-file": { type: "string" },
        context: { type: "string", multiple: true },
        image: { type: "string", multiple: true },
        profile: { type: "string" },
        cwd: { type: "string" },
        name: { type: "string" },
        cron: { type: "string" },
        trigger: { type: "string", multiple: true },
        "trigger-filter": { type: "string", multiple: true },
        "trigger-recovery-filter": { type: "string", multiple: true },
        "trigger-firing-mode": { type: "string" },
        "trigger-cooldown-ms": { type: "string" },
        "trigger-repeat-ms": { type: "string" },
        "trigger-debounce-ms": { type: "string" },
        "trigger-dedupe-key-template": { type: "string" },
        "trigger-max-events": { type: "string" },
        "trigger-window-ms": { type: "string" },
        "interval-ms": { type: "string" },
        "delay-ms": { type: "string" },
        "run-at": { type: "string" },
        timezone: { type: "string" },
        "scheduler-target": { type: "string" },
        prompt: { type: "string" },
        "prompt-file": { type: "string" },
        "scheduled-ralph-flow": { type: "string" },
        "scheduled-ralph-flow-scope": { type: "string" },
        "scheduled-ralph-param": { type: "string", multiple: true },
        "scheduled-ralph-run-log-scope": { type: "string" },
        "scheduled-ralph-max-transitions": { type: "string" },
        "scheduled-ralph-allowed-root": { type: "string", multiple: true },
        "scheduled-ralph-allow-commands": { type: "string" },
        "scheduled-ralph-allow-writes": { type: "string" },
        "scheduled-ralph-allow-network": { type: "string" },
        "scheduled-ralph-allow-mcp-tools": { type: "string" },
        "flow-json": { type: "string" },
        "flow-json-file": { type: "string" },
        "watch-json": { type: "string" },
        "watch-json-file": { type: "string" },
        "existing-flow-json": { type: "string" },
        "existing-flow-json-file": { type: "string" },
        revision: { type: "string" },
        "flow-target": { type: "string" },
        "generation-mode": { type: "string" },
        param: { type: "string", multiple: true },
        "params-file": { type: "string" },
        "input-json": { type: "string" },
        "input-json-file": { type: "string" },
        "max-rounds": { type: "string" },
        "max-transitions": { type: "string" },
        trace: { type: "boolean" },
        "context-pack": { type: "string", multiple: true },
        macro: { type: "string", multiple: true },
        "missed-run-policy": { type: "string" },
        "missed-run-grace-ms": { type: "string" },
        "retry-attempts": { type: "string" },
        "retry-min-ms": { type: "string" },
        "retry-max-ms": { type: "string" },
        "retry-factor": { type: "string" },
        "retry-randomize": { type: "string" },
        "dedupe-key": { type: "string" },
        "ttl-ms": { type: "string" },
        "max-duration-ms": { type: "string" },
        "concurrency-key": { type: "string" },
        "concurrency-limit": { type: "string" },
        "history-limit": { type: "string" },
        "max-catch-up-runs": { type: "string" },
        "event-type": { type: "string" },
        "event-kind": { type: "string" },
        "event-source": { type: "string" },
        "event-payload-json": { type: "string" },
        "event-dedupe-key": { type: "string" },
        "event-occurred-at": { type: "string" },
        "service-poll-ms": { type: "string" },
        "service-idle-shutdown-ms": { type: "string" },
        "service-abandoned-run-stale-ms": { type: "string" },
        "service-max-iterations": { type: "string" },
        "service-max-runs-per-tick": { type: "string" },
        "service-start-event-type": { type: "string" },
        "service-start-event-kind": { type: "string" },
        "service-start-event-dedupe-key": { type: "string" },
        "arguments-json": { type: "string" },
        "include-disabled": { type: "boolean" },
        agent: { type: "string" },
        phase: { type: "string" },
        "unused-days": { type: "string" },
        "never-used-days": { type: "string" },
        apply: { type: "boolean" },
        scope: { type: "string" },
        path: { type: "string" },
        "apply-to": { type: "string", multiple: true },
        exclude: { type: "string", multiple: true },
        keyword: { type: "string", multiple: true },
        "instruction-mode": { type: "string" },
        audience: { type: "string" },
        priority: { type: "string" },
        "ralph-flow": { type: "string" },
        "flow-scope": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });

    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const json = values?.json === true;
  const verbose = values?.verbose === true;
  const quickRunRequested = values?.quick === true;
  const workspaceRoot =
    normalizeOptionalString(values?.cwd) ??
    normalizeOptionalString(currentWorkingDirectory) ??
    fail("Expected --cwd to be followed by a path.");

  const rawMode = normalizeOptionalString(values?.mode);
  const rawProvider = normalizeOptionalString(values?.provider);
  const rawRuntimeProvider = normalizeOptionalString(
    values?.["runtime-provider"],
  );
  const rawKey = normalizeOptionalString(values?.key);
  const rawTask = normalizeOptionalString(values?.task);
  const rawModel = normalizeOptionalString(values?.model);
  const rawReasoning = normalizeOptionalString(values?.reasoning);
  const rawDefaultModel = normalizeOptionalString(values?.["default-model"]);
  const rawSessionMemory = normalizeOptionalString(values?.["session-memory"]);
  const rawGlobalMemory = normalizeOptionalString(values?.["global-memory"]);
  const rawExecutorTurns = normalizeOptionalString(values?.["executor-turns"]);
  const rawAutopilotIterations = normalizeOptionalString(
    values?.["autopilot-iterations"],
  );
  const rawSetGlobalMemory = normalizeOptionalString(
    values?.["set-global-memory"],
  );
  const rawConversationContextFile = normalizeOptionalString(
    values?.["conversation-context-file"],
  );
  const rawContextPaths = normalizeContextPaths(values?.context);
  const rawImagePaths = normalizeImagePaths(values?.image);
  const rawProfile = normalizeOptionalString(values?.profile);
  const rawSchedulerName = normalizeOptionalString(values?.name);
  const rawSchedulerCron = normalizeOptionalString(values?.cron);
  const rawSchedulerTriggers = values?.trigger
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawSchedulerTriggerFilters = values?.["trigger-filter"]
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawSchedulerTriggerRecoveryFilters = values?.["trigger-recovery-filter"]
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawSchedulerTriggerFiringMode = normalizeOptionalString(
    values?.["trigger-firing-mode"],
  );
  const rawSchedulerTriggerCooldownMs = normalizeOptionalString(
    values?.["trigger-cooldown-ms"],
  );
  const rawSchedulerTriggerRepeatMs = normalizeOptionalString(
    values?.["trigger-repeat-ms"],
  );
  const rawSchedulerTriggerDebounceMs = normalizeOptionalString(
    values?.["trigger-debounce-ms"],
  );
  const rawSchedulerTriggerDedupeKeyTemplate = normalizeOptionalString(
    values?.["trigger-dedupe-key-template"],
  );
  const rawSchedulerTriggerMaxEvents = normalizeOptionalString(
    values?.["trigger-max-events"],
  );
  const rawSchedulerTriggerWindowMs = normalizeOptionalString(
    values?.["trigger-window-ms"],
  );
  const rawSchedulerIntervalMs = normalizeOptionalString(values?.["interval-ms"]);
  const rawSchedulerDelayMs = normalizeOptionalString(values?.["delay-ms"]);
  const rawSchedulerRunAt = normalizeOptionalString(values?.["run-at"]);
  const rawSchedulerTimezone = normalizeOptionalString(values?.timezone);
  const rawSchedulerTarget = normalizeOptionalString(values?.["scheduler-target"]);
  const rawSchedulerPrompt = normalizeOptionalString(values?.prompt);
  const rawSchedulerPromptFile = normalizeOptionalString(values?.["prompt-file"]);
  const rawScheduledRalphFlow = normalizeOptionalString(
    values?.["scheduled-ralph-flow"],
  );
  const rawScheduledRalphFlowScope = normalizeOptionalString(
    values?.["scheduled-ralph-flow-scope"],
  );
  const rawScheduledRalphParams = values?.["scheduled-ralph-param"]
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawScheduledRalphRunLogScope = normalizeOptionalString(
    values?.["scheduled-ralph-run-log-scope"],
  );
  const rawScheduledRalphMaxTransitions = normalizeOptionalString(
    values?.["scheduled-ralph-max-transitions"],
  );
  const rawScheduledRalphAllowedRoots = values?.["scheduled-ralph-allowed-root"]
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawScheduledRalphAllowCommands = normalizeOptionalString(
    values?.["scheduled-ralph-allow-commands"],
  );
  const rawScheduledRalphAllowWrites = normalizeOptionalString(
    values?.["scheduled-ralph-allow-writes"],
  );
  const rawScheduledRalphAllowNetwork = normalizeOptionalString(
    values?.["scheduled-ralph-allow-network"],
  );
  const rawScheduledRalphAllowMcpTools = normalizeOptionalString(
    values?.["scheduled-ralph-allow-mcp-tools"],
  );
  const rawRalphFlowJson = normalizeOptionalString(values?.["flow-json"]);
  const rawRalphFlowJsonFile = normalizeOptionalString(values?.["flow-json-file"]);
  const rawRalphWatchJson = normalizeOptionalString(values?.["watch-json"]);
  const rawRalphWatchJsonFile = normalizeOptionalString(values?.["watch-json-file"]);
  const rawRalphExistingFlowJson = normalizeOptionalString(
    values?.["existing-flow-json"],
  );
  const rawRalphExistingFlowJsonFile = normalizeOptionalString(
    values?.["existing-flow-json-file"],
  );
  const rawRalphRevision = normalizeOptionalString(values?.revision);
  const rawRalphFlowTarget = normalizeOptionalString(values?.["flow-target"]);
  const rawRalphGenerationMode = normalizeOptionalString(
    values?.["generation-mode"],
  );
  const rawRalphParams = values?.param
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawRalphParamsFile = normalizeOptionalString(values?.["params-file"]);
  const rawRalphInputJson = normalizeOptionalString(values?.["input-json"]);
  const rawRalphInputJsonFile = normalizeOptionalString(values?.["input-json-file"]);
  const rawRalphMaxRounds = normalizeOptionalString(values?.["max-rounds"]);
  const rawRalphMaxTransitions = normalizeOptionalString(values?.["max-transitions"]);
  const rawRalphTrace = values?.trace === true;
  const rawSchedulerContextPacks = values?.["context-pack"]
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawSchedulerMacros = values?.macro
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawSchedulerMissedRunPolicy = normalizeOptionalString(
    values?.["missed-run-policy"],
  );
  const rawSchedulerMissedRunGraceMs = normalizeOptionalString(
    values?.["missed-run-grace-ms"],
  );
  const rawSchedulerRetryAttempts = normalizeOptionalString(
    values?.["retry-attempts"],
  );
  const rawSchedulerRetryMinMs = normalizeOptionalString(values?.["retry-min-ms"]);
  const rawSchedulerRetryMaxMs = normalizeOptionalString(values?.["retry-max-ms"]);
  const rawSchedulerRetryFactor = normalizeOptionalString(
    values?.["retry-factor"],
  );
  const rawSchedulerRetryRandomize = normalizeOptionalString(
    values?.["retry-randomize"],
  );
  const rawSchedulerDedupeKey = normalizeOptionalString(values?.["dedupe-key"]);
  const rawSchedulerTtlMs = normalizeOptionalString(values?.["ttl-ms"]);
  const rawSchedulerMaxDurationMs = normalizeOptionalString(
    values?.["max-duration-ms"],
  );
  const rawSchedulerConcurrencyKey = normalizeOptionalString(
    values?.["concurrency-key"],
  );
  const rawSchedulerConcurrencyLimit = normalizeOptionalString(
    values?.["concurrency-limit"],
  );
  const rawSchedulerHistoryLimit = normalizeOptionalString(
    values?.["history-limit"],
  );
  const rawSchedulerMaxCatchUpRuns = normalizeOptionalString(
    values?.["max-catch-up-runs"],
  );
  const rawSchedulerEventType = normalizeOptionalString(values?.["event-type"]);
  const rawSchedulerEventKind = normalizeOptionalString(values?.["event-kind"]);
  const rawSchedulerEventSource = normalizeOptionalString(
    values?.["event-source"],
  );
  const rawSchedulerEventPayloadJson = normalizeOptionalString(
    values?.["event-payload-json"],
  );
  const rawSchedulerEventDedupeKey = normalizeOptionalString(
    values?.["event-dedupe-key"],
  );
  const rawSchedulerEventOccurredAt = normalizeOptionalString(
    values?.["event-occurred-at"],
  );
  const rawSchedulerServicePollMs = normalizeOptionalString(
    values?.["service-poll-ms"],
  );
  const rawSchedulerServiceIdleShutdownMs = normalizeOptionalString(
    values?.["service-idle-shutdown-ms"],
  );
  const rawSchedulerServiceAbandonedRunStaleMs = normalizeOptionalString(
    values?.["service-abandoned-run-stale-ms"],
  );
  const rawSchedulerServiceMaxIterations = normalizeOptionalString(
    values?.["service-max-iterations"],
  );
  const rawSchedulerServiceMaxRunsPerTick = normalizeOptionalString(
    values?.["service-max-runs-per-tick"],
  );
  const rawSchedulerServiceStartEventType = normalizeOptionalString(
    values?.["service-start-event-type"],
  );
  const rawSchedulerServiceStartEventKind = normalizeOptionalString(
    values?.["service-start-event-kind"],
  );
  const rawSchedulerServiceStartEventDedupeKey = normalizeOptionalString(
    values?.["service-start-event-dedupe-key"],
  );
  const rawMcpArgumentsJson = normalizeOptionalString(values?.["arguments-json"]);
  const includeDisabledMcp = values?.["include-disabled"] === true;
  const rawMcpAgent = normalizeOptionalString(values?.agent);
  const rawMcpPhase = normalizeOptionalString(values?.phase);
  const rawMcpUnusedDays = normalizeOptionalString(values?.["unused-days"]);
  const rawMcpNeverUsedDays = normalizeOptionalString(values?.["never-used-days"]);
  const applyMcpCleanup = values?.apply === true;
  const rawInstructionScope = normalizeOptionalString(values?.scope);
  const rawInstructionPath = normalizeOptionalString(values?.path);
  const rawInstructionApplyTo = values?.["apply-to"]
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawInstructionExclude = values?.exclude
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawInstructionKeywords = values?.keyword
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawInstructionMode = normalizeOptionalString(
    values?.["instruction-mode"],
  );
  const rawInstructionAudience = normalizeOptionalString(values?.audience);
  const rawInstructionPriority = normalizeOptionalString(values?.priority);
  const rawInstructionRalphFlow = normalizeOptionalString(values?.["ralph-flow"]);
  const rawInstructionRalphFlowScope = normalizeOptionalString(
    values?.["flow-scope"],
  );

  if (values?.mode !== undefined && !rawMode) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  if (rawMode && !VALID_MODES.has(rawMode as RunMode)) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  if (values?.profile !== undefined && !rawProfile) {
    fail("Expected --profile to be followed by a profile name.");
  }

  if (values?.scope !== undefined && !rawInstructionScope) {
    fail("Expected --scope to be followed by user, workspace, compatibility, or ralph-flow.");
  }

  if (
    rawInstructionScope &&
    !INSTRUCTION_SCOPES.has(rawInstructionScope as InstructionCliScope)
  ) {
    fail("Expected --scope to be followed by user, workspace, compatibility, or ralph-flow.");
  }

  if (values?.["ralph-flow"] !== undefined && !rawInstructionRalphFlow) {
    fail("Expected --ralph-flow to be followed by a Ralph flow id or alias.");
  }

  if (
    values?.["flow-scope"] !== undefined &&
    !rawInstructionRalphFlowScope
  ) {
    fail("Expected --flow-scope to be followed by user or workspace.");
  }

  if (
    rawInstructionRalphFlowScope &&
    !RALPH_SCOPES.has(rawInstructionRalphFlowScope as RalphCliScope)
  ) {
    fail("Expected --flow-scope to be followed by user or workspace.");
  }

  if (values?.["instruction-mode"] !== undefined && !rawInstructionMode) {
    fail(
      "Expected --instruction-mode to be followed by always, auto, agent-requested, manual, or disabled.",
    );
  }

  if (
    rawInstructionMode &&
    !INSTRUCTION_MODES.has(rawInstructionMode as InstructionMode)
  ) {
    fail(
      "Expected --instruction-mode to be followed by always, auto, agent-requested, manual, or disabled.",
    );
  }

  if (values?.audience !== undefined && !rawInstructionAudience) {
    fail("Expected --audience to be followed by executor, validator, generator, or all.");
  }

  if (
    rawInstructionAudience &&
    !INSTRUCTION_AUDIENCES.has(rawInstructionAudience as InstructionAudience)
  ) {
    fail("Expected --audience to be followed by executor, validator, generator, or all.");
  }

  if (values?.provider !== undefined && !rawProvider) {
    fail("Expected --provider to be followed by openai, anthropic, or google.");
  }

  if (values?.["runtime-provider"] !== undefined && !rawRuntimeProvider) {
    fail(
      `Expected --runtime-provider to be followed by ${VALID_RUNTIME_PROVIDER_DESCRIPTION}.`,
    );
  }

  if (rawProvider && !VALID_PROVIDERS.has(rawProvider as UserApiProvider)) {
    fail("Expected --provider to be followed by openai, anthropic, or google.");
  }

  if (
    rawRuntimeProvider &&
    !VALID_RUNTIME_PROVIDERS.has(
      rawRuntimeProvider as Exclude<ModelProvider, "unconfigured">,
    )
  ) {
    fail(
      `Expected --runtime-provider to be followed by ${VALID_RUNTIME_PROVIDER_DESCRIPTION}.`,
    );
  }

  if (values?.key !== undefined && !rawKey) {
    fail("Expected --key to be followed by an API key value.");
  }

  if (values?.task !== undefined && !rawTask) {
    fail("Expected --task to be followed by task text.");
  }

  if (values?.model !== undefined && !rawModel) {
    fail("Expected --model to be followed by a model name.");
  }

  if (values?.reasoning !== undefined && !rawReasoning) {
    fail(
      `Expected --reasoning to be followed by ${VALID_REASONING_MODE_DESCRIPTION}.`,
    );
  }

  if (
    rawReasoning &&
    !VALID_REASONING_MODES.has(rawReasoning as ReasoningMode)
  ) {
    fail(
      `Expected --reasoning to be followed by ${VALID_REASONING_MODE_DESCRIPTION}.`,
    );
  }

  if (values?.["default-model"] !== undefined && !rawDefaultModel) {
    fail("Expected --default-model to be followed by a model name.");
  }

  if (values?.["session-memory"] !== undefined && !rawSessionMemory) {
    fail("Expected --session-memory to be followed by on or off.");
  }

  if (values?.["global-memory"] !== undefined && !rawGlobalMemory) {
    fail("Expected --global-memory to be followed by inherit, on, or off.");
  }

  if (values?.["executor-turns"] !== undefined && !rawExecutorTurns) {
    fail("Expected --executor-turns to be followed by a positive integer.");
  }

  if (
    values?.["autopilot-iterations"] !== undefined &&
    !rawAutopilotIterations
  ) {
    fail(
      "Expected --autopilot-iterations to be followed by a positive integer.",
    );
  }

  if (values?.["set-global-memory"] !== undefined && !rawSetGlobalMemory) {
    fail("Expected --set-global-memory to be followed by on or off.");
  }

  if (
    values?.["conversation-context-file"] !== undefined &&
    !rawConversationContextFile
  ) {
    fail("Expected --conversation-context-file to be followed by a file path.");
  }

  const sessionMemoryEnabled = rawSessionMemory
    ? parseBooleanToggle(rawSessionMemory, "--session-memory")
    : undefined;
  const globalMemoryEnabled = rawGlobalMemory
    ? parseMemoryOverride(rawGlobalMemory, "--global-memory")
    : undefined;
  const setGlobalMemoryEnabled = rawSetGlobalMemory
    ? parseBooleanToggle(rawSetGlobalMemory, "--set-global-memory")
    : undefined;
  const executorTurns = rawExecutorTurns
    ? parsePositiveInteger(rawExecutorTurns, "--executor-turns")
    : undefined;
  const autopilotExecutorIterations = rawAutopilotIterations
    ? parsePositiveInteger(rawAutopilotIterations, "--autopilot-iterations")
    : undefined;
  const infinite = values?.infinite === true;
  const instructionPriority = parseOptionalInteger(
    rawInstructionPriority,
    "--priority",
  );
  const agentLimits: RuntimeAgentLimitOverrides | undefined = infinite
    ? { infinite: true }
    : executorTurns !== undefined || autopilotExecutorIterations !== undefined
      ? {
          ...(executorTurns !== undefined ? { executorTurns } : {}),
          ...(autopilotExecutorIterations !== undefined
            ? { autopilotExecutorIterations }
            : {}),
        }
      : undefined;

  if (
    infinite &&
    (executorTurns !== undefined || autopilotExecutorIterations !== undefined)
  ) {
    fail("--infinite cannot be combined with finite loop limit overrides.");
  }

  if (rawTask && positionals.length > 0) {
    fail("Use either positional task text or --task, not both.");
  }

  if (rawDefaultModel && rawContextPaths) {
    fail("--default-model cannot be combined with --context.");
  }

  if (rawDefaultModel && rawImagePaths) {
    fail("--default-model cannot be combined with --image.");
  }

  if (rawDefaultModel && rawReasoning) {
    fail("--default-model cannot be combined with --reasoning.");
  }

  if (rawDefaultModel && agentLimits) {
    fail("--default-model cannot be combined with runtime loop limit overrides.");
  }

  if (rawDefaultModel && (rawTask || positionals.length > 0)) {
    fail("--default-model cannot be combined with a task.");
  }

  if (quickRunRequested && rawDefaultModel) {
    fail(
      "--quick can only be used with a task provided via --task or positional task text.",
    );
  }

  if (values?.["set-api"] === true) {
    if (!rawProvider) {
      fail("--set-api requires --provider.");
    }

    if (!rawKey) {
      fail("--set-api requires --key.");
    }

    if (
      rawTask ||
      positionals.length > 0 ||
      rawModel ||
      rawDefaultModel ||
      rawReasoning ||
      rawProfile ||
      rawRuntimeProvider ||
      rawMode ||
      quickRunRequested ||
      sessionMemoryEnabled !== undefined ||
      globalMemoryEnabled !== undefined ||
      agentLimits ||
      rawConversationContextFile ||
      rawContextPaths ||
      rawImagePaths
    ) {
      fail(
        "--set-api cannot be combined with tasks or runtime override options.",
      );
    }

    return createParsedArgs(
      {
        json,
        verbose,
        workspaceRoot,
        command: "set-api",
      },
      {
        provider: rawProvider as UserApiProvider,
        key: rawKey ?? fail("--set-api requires --key."),
      },
    );
  }

  const resolvedMode = rawMode;

  const sharedOptions = createSharedParsedOptions({
    json,
    verbose,
    workspaceRoot,
    ...(resolvedMode ? { mode: resolvedMode as RunMode } : {}),
    ...(rawProfile ? { profile: rawProfile } : {}),
    ...(rawRuntimeProvider
      ? {
          runtimeProvider: rawRuntimeProvider as Exclude<
            ModelProvider,
            "unconfigured"
          >,
        }
      : {}),
    ...(rawModel ? { model: rawModel } : {}),
    ...(rawDefaultModel ? { defaultModel: rawDefaultModel } : {}),
    ...(rawReasoning ? { reasoning: rawReasoning as ReasoningMode } : {}),
    ...(sessionMemoryEnabled !== undefined ? { sessionMemoryEnabled } : {}),
    ...(globalMemoryEnabled !== undefined ? { globalMemoryEnabled } : {}),
    ...(agentLimits ? { agentLimits } : {}),
    ...(rawConversationContextFile
      ? { conversationContextFile: rawConversationContextFile }
      : {}),
    ...(rawContextPaths ? { contextPaths: rawContextPaths } : {}),
    ...(rawImagePaths ? { imagePaths: rawImagePaths } : {}),
  });

  if (setGlobalMemoryEnabled !== undefined) {
    if (
      rawTask ||
      positionals.length > 0 ||
      rawModel ||
      rawDefaultModel ||
      rawReasoning ||
      rawProfile ||
      rawRuntimeProvider ||
      rawMode ||
      quickRunRequested ||
      sessionMemoryEnabled !== undefined ||
      globalMemoryEnabled !== undefined ||
      agentLimits ||
      rawConversationContextFile ||
      rawContextPaths ||
      rawImagePaths
    ) {
      fail(
        "--set-global-memory cannot be combined with tasks or runtime override options.",
      );
    }

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "set-global-memory",
      },
      { setGlobalMemoryEnabled },
    );
  }

  if (values?.help === true) {
    if (quickRunRequested) {
      fail(
        "--quick can only be used with a task provided via --task or positional task text.",
      );
    }

    return createParsedArgs({
      ...sharedOptions,
      command: "help",
    });
  }

  if (rawDefaultModel) {
    if (quickRunRequested) {
      fail(
        "--quick can only be used with a task provided via --task or positional task text.",
      );
    }

    return createParsedArgs({
      ...sharedOptions,
      command: "set-default-model",
    });
  }

  if (positionals.length === 0) {
    if (rawTask) {
      return createParsedArgs(
        {
          ...sharedOptions,
          command: quickRunRequested ? "run" : "chat",
        },
        { task: rawTask },
      );
    }

    if (quickRunRequested) {
      fail(
        "--quick can only be used with a task provided via --task or positional task text.",
      );
    }

    return createParsedArgs({
      ...sharedOptions,
      command: "chat",
    });
  }

  const [first, ...rest] = positionals;

  if (
    first !== "instructions" &&
    (rawInstructionRalphFlow || rawInstructionRalphFlowScope)
  ) {
    fail("--ralph-flow and --flow-scope are only valid for `machdoch instructions`.");
  }

  if (first === "mcp") {
    if (quickRunRequested || rawTask) {
      fail("`machdoch mcp` cannot be combined with --quick or --task.");
    }

    const [rawAction, rawServerId, rawTarget, ...extraPositionals] = rest;
    const actionText = normalizeOptionalString(rawAction) ?? "servers";

    if (!MCP_ACTIONS.has(actionText as McpCliAction)) {
      fail(
        `Expected \`machdoch mcp\` action to be one of ${Array.from(
          MCP_ACTIONS,
        ).join(", ")}.`,
      );
    }

    const action = actionText as McpCliAction;
    const serverId = normalizeOptionalString(rawServerId);
    const target = normalizeOptionalString(rawTarget);

    if (extraPositionals.length > 0) {
      fail(
        `Command \`mcp ${action}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
      );
    }

    if (MCP_ACTIONS_REQUIRING_SERVER.has(action) && !serverId) {
      fail(`Expected a server id after \`machdoch mcp ${action}\`.`);
    }

    if (MCP_ACTIONS_REQUIRING_TARGET.has(action) && !target) {
      fail(`Expected a target after \`machdoch mcp ${action} ${serverId ?? ""}\`.`);
    }

    if (!MCP_ACTIONS_REQUIRING_SERVER.has(action) && serverId) {
      fail(`Command \`mcp ${action}\` does not accept a server id.`);
    }

    if (!MCP_ACTIONS_REQUIRING_TARGET.has(action) && target) {
      fail(`Command \`mcp ${action}\` does not accept a target.`);
    }

    if (
      rawMcpArgumentsJson &&
      action !== "call-tool" &&
      action !== "get-prompt"
    ) {
      fail("--arguments-json is only valid for `machdoch mcp call-tool` or `machdoch mcp get-prompt`.");
    }

    if (includeDisabledMcp && action !== "servers") {
      fail("--include-disabled is only valid for `machdoch mcp servers`.");
    }

    if (rawMcpAgent && action !== "lifecycle-hook") {
      fail("--agent is only valid for `machdoch mcp lifecycle-hook`.");
    }

    if (rawMcpPhase && action !== "lifecycle-hook") {
      fail("--phase is only valid for `machdoch mcp lifecycle-hook`.");
    }

    if (rawMcpUnusedDays && action !== "cleanup") {
      fail("--unused-days is only valid for `machdoch mcp cleanup`.");
    }

    if (rawMcpNeverUsedDays && action !== "cleanup") {
      fail("--never-used-days is only valid for `machdoch mcp cleanup`.");
    }

    if (applyMcpCleanup && action !== "cleanup") {
      fail("--apply is only valid for `machdoch mcp cleanup`.");
    }

    const unusedDays =
      action === "cleanup"
        ? parseOptionalPositiveInteger(rawMcpUnusedDays, "--unused-days")
        : undefined;
    const neverUsedDays =
      action === "cleanup"
        ? parseOptionalPositiveInteger(rawMcpNeverUsedDays, "--never-used-days")
        : undefined;

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "mcp",
      },
      {
        mcp: {
          action,
          ...(serverId ? { serverId } : {}),
          ...(target ? { target } : {}),
          ...(rawMcpArgumentsJson ? { argumentsJson: rawMcpArgumentsJson } : {}),
          ...(includeDisabledMcp ? { includeDisabled: true } : {}),
          ...(rawMcpAgent ? { agent: rawMcpAgent } : {}),
          ...(rawMcpPhase ? { phase: rawMcpPhase } : {}),
          ...(unusedDays !== undefined ? { unusedDays } : {}),
          ...(neverUsedDays !== undefined ? { neverUsedDays } : {}),
          ...(applyMcpCleanup ? { apply: true } : {}),
        },
      },
    );
  }

  if (first === "ralph") {
    if (quickRunRequested || rawTask) {
      fail("`machdoch ralph` cannot be combined with --quick or --task.");
    }

    const [rawAction, rawSubject, ...extraPositionals] = rest;
    const actionText = normalizeOptionalString(rawAction) ?? "list";

    if (!RALPH_ACTIONS.has(actionText as RalphCliAction)) {
      fail(
        `Expected \`machdoch ralph\` action to be one of ${Array.from(
          RALPH_ACTIONS,
        ).join(", ")}.`,
      );
    }

    const action = actionText as RalphCliAction;
    const isWatchCommand = action === "watches";

    if (!isWatchCommand && extraPositionals.length > 0) {
      fail(
        `Command \`ralph ${action}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
      );
    }

    if (isWatchCommand && extraPositionals.length > 1) {
      fail(
        `Command \`ralph watches\` accepts at most a watch action and watch id: ${[
          rawSubject,
          ...extraPositionals,
        ].filter(Boolean).join(" ")}`,
      );
    }

    if (
      RALPH_ACTIONS_REQUIRING_SUBJECT.has(action) &&
      !normalizeOptionalString(rawSubject)
    ) {
      fail(
        action === "log" || action === "run-detail" || action === "resume"
          ? `Expected a run id after \`machdoch ralph ${action}\`.`
          : `Expected a flow id after \`machdoch ralph ${action}\`.`,
      );
    }

    const isGenerationCommand = action === "create" || action === "interview";

    if (isGenerationCommand && !rawSchedulerPrompt && !rawSchedulerPromptFile) {
      fail(`\`machdoch ralph ${action}\` expects --prompt or --prompt-file.`);
    }

    if (!isGenerationCommand && (rawSchedulerPrompt || rawSchedulerPromptFile)) {
      fail("--prompt and --prompt-file are only valid for `machdoch ralph create` or `machdoch ralph interview`.");
    }

    if (action === "save" && !rawRalphFlowJson && !rawRalphFlowJsonFile) {
      fail(
        "`machdoch ralph save` expects --flow-json. Use --flow-json-file for large payloads.",
      );
    }

    if (action === "save" && rawRalphFlowJson && rawRalphFlowJsonFile) {
      fail("Use either --flow-json or --flow-json-file for `machdoch ralph save`, not both.");
    }

    if (action !== "save" && rawRalphFlowJson) {
      fail("--flow-json is only valid for `machdoch ralph save`.");
    }

    if (action !== "save" && rawRalphFlowJsonFile) {
      fail("--flow-json-file is only valid for `machdoch ralph save`.");
    }

    if (action !== "watches" && rawRalphWatchJson) {
      fail("--watch-json is only valid for `machdoch ralph watches create`.");
    }

    if (action !== "watches" && rawRalphWatchJsonFile) {
      fail("--watch-json-file is only valid for `machdoch ralph watches create`.");
    }

    if (isGenerationCommand && rawRalphExistingFlowJson && rawRalphExistingFlowJsonFile) {
      fail(`Use either --existing-flow-json or --existing-flow-json-file for \`machdoch ralph ${action}\`, not both.`);
    }

    if (
      !isGenerationCommand &&
      (rawRalphExistingFlowJson || rawRalphExistingFlowJsonFile)
    ) {
      if (rawRalphExistingFlowJson) {
        fail("--existing-flow-json is only valid for `machdoch ralph create` or `machdoch ralph interview`.");
      }

      fail("--existing-flow-json-file is only valid for `machdoch ralph create` or `machdoch ralph interview`.");
    }

    if (action === "restore" && !rawRalphRevision) {
      fail("`machdoch ralph restore` expects --revision.");
    }

    if (action !== "restore" && rawRalphRevision) {
      fail("--revision is only valid for `machdoch ralph restore`.");
    }

    if (!isGenerationCommand && rawRalphFlowTarget) {
      fail("--flow-target is only valid for `machdoch ralph create` or `machdoch ralph interview`.");
    }

    if (
      rawRalphFlowTarget &&
      !RALPH_GENERATION_TARGETS.has(rawRalphFlowTarget as RalphCliGenerationTarget)
    ) {
      fail("Expected --flow-target to be followed by flow, prompt-block, or refactor.");
    }

    if (action !== "create" && rawRalphGenerationMode) {
      fail("--generation-mode is only valid for `machdoch ralph create`.");
    }

    if (
      rawRalphGenerationMode &&
      !RALPH_GENERATION_MODES.has(
        rawRalphGenerationMode as RalphCliGenerationMode,
      )
    ) {
      fail("Expected --generation-mode to be followed by do-it or interview.");
    }

    if (action !== "run" && rawRalphParams && rawRalphParams.length > 0) {
      fail("--param is only valid for `machdoch ralph run`.");
    }

    if (action !== "run" && rawRalphParamsFile) {
      fail("--params-file is only valid for `machdoch ralph run`.");
    }

    if (action === "resume" && !rawRalphInputJson && !rawRalphInputJsonFile) {
      fail("`machdoch ralph resume` expects --input-json or --input-json-file.");
    }

    if ((action === "resume" || action === "interview") && rawRalphInputJson && rawRalphInputJsonFile) {
      fail(`Use either --input-json or --input-json-file for \`machdoch ralph ${action}\`, not both.`);
    }

    if (action !== "resume" && action !== "interview" && rawRalphInputJson) {
      fail("--input-json is only valid for `machdoch ralph resume` or `machdoch ralph interview`.");
    }

    if (action !== "resume" && action !== "interview" && rawRalphInputJsonFile) {
      fail("--input-json-file is only valid for `machdoch ralph resume` or `machdoch ralph interview`.");
    }

    if (!isGenerationCommand && rawRalphMaxRounds) {
      fail("--max-rounds is only valid for `machdoch ralph create` or `machdoch ralph interview`.");
    }

    if (action !== "run" && action !== "resume" && rawRalphMaxTransitions) {
      fail("--max-transitions is only valid for `machdoch ralph run` or `machdoch ralph resume`.");
    }

    if (action !== "log" && rawRalphTrace) {
      fail("--trace is only valid for `machdoch ralph log`.");
    }

    if (rawInstructionScope && !RALPH_SCOPES.has(rawInstructionScope as RalphCliScope)) {
      fail("Expected Ralph --scope to be followed by user or workspace.");
    }

    const watchActionText = isWatchCommand
      ? normalizeOptionalString(rawSubject) ?? "list"
      : undefined;

    if (
      watchActionText &&
      !RALPH_WATCH_ACTIONS.has(watchActionText as RalphWatchCliAction)
    ) {
      fail("Expected `machdoch ralph watches` action to be one of list, create, delete, sync, or run.");
    }

    if (isWatchCommand && watchActionText === "create" && !rawRalphWatchJson && !rawRalphWatchJsonFile) {
      fail("`machdoch ralph watches create` expects --watch-json or --watch-json-file.");
    }

    if (isWatchCommand && watchActionText !== "create" && (rawRalphWatchJson || rawRalphWatchJsonFile)) {
      fail("--watch-json and --watch-json-file are only valid for `machdoch ralph watches create`.");
    }

    if (isWatchCommand && rawRalphWatchJson && rawRalphWatchJsonFile) {
      fail("Use either --watch-json or --watch-json-file for `machdoch ralph watches create`, not both.");
    }

    if (
      isWatchCommand &&
      watchActionText === "delete" &&
      !normalizeOptionalString(extraPositionals[0])
    ) {
      fail("Expected a watch id after `machdoch ralph watches delete`.");
    }

    const ralphSubject = normalizeOptionalString(rawSubject);
    const watchSubject = isWatchCommand
      ? normalizeOptionalString(extraPositionals[0])
      : undefined;
    const ralphMaxRounds = parseOptionalPositiveInteger(
      rawRalphMaxRounds,
      "--max-rounds",
    );
    const ralphMaxTransitions = parseOptionalPositiveInteger(
      rawRalphMaxTransitions,
      "--max-transitions",
    );

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "ralph",
      },
      {
        ralph: {
          action,
          ...(isWatchCommand
            ? watchSubject
              ? { subject: watchSubject }
              : {}
            : ralphSubject
              ? { subject: ralphSubject }
              : {}),
          ...(rawInstructionScope
            ? { scope: rawInstructionScope as RalphCliScope }
            : {}),
          ...(rawSchedulerName ? { name: rawSchedulerName } : {}),
          ...(rawSchedulerPrompt ? { prompt: rawSchedulerPrompt } : {}),
          ...(rawSchedulerPromptFile ? { promptFile: rawSchedulerPromptFile } : {}),
          ...(rawRalphFlowJson ? { flowJson: rawRalphFlowJson } : {}),
          ...(rawRalphFlowJsonFile ? { flowJsonFile: rawRalphFlowJsonFile } : {}),
          ...(rawRalphWatchJson ? { watchJson: rawRalphWatchJson } : {}),
          ...(rawRalphWatchJsonFile ? { watchJsonFile: rawRalphWatchJsonFile } : {}),
          ...(rawRalphExistingFlowJson
            ? { existingFlowJson: rawRalphExistingFlowJson }
            : {}),
          ...(rawRalphExistingFlowJsonFile
            ? { existingFlowJsonFile: rawRalphExistingFlowJsonFile }
            : {}),
          ...(rawRalphRevision ? { revision: rawRalphRevision } : {}),
          ...(rawRalphFlowTarget
            ? { target: rawRalphFlowTarget as RalphCliGenerationTarget }
            : {}),
          ...(rawRalphGenerationMode
            ? { generationMode: rawRalphGenerationMode as RalphCliGenerationMode }
            : {}),
          ...(rawRalphParams && rawRalphParams.length > 0
            ? { params: rawRalphParams }
            : {}),
          ...(rawRalphParamsFile ? { paramsFile: rawRalphParamsFile } : {}),
          ...(rawRalphInputJson ? { inputJson: rawRalphInputJson } : {}),
          ...(rawRalphInputJsonFile ? { inputJsonFile: rawRalphInputJsonFile } : {}),
          ...(ralphMaxRounds !== undefined ? { maxRounds: ralphMaxRounds } : {}),
          ...(ralphMaxTransitions !== undefined
            ? { maxTransitions: ralphMaxTransitions }
            : {}),
          ...(rawRalphTrace ? { trace: true } : {}),
          ...(watchActionText
            ? { watchAction: watchActionText as RalphWatchCliAction }
            : {}),
        },
      },
    );
  }

  if (first === "instructions") {
    if (quickRunRequested || rawTask) {
      fail("`machdoch instructions` cannot be combined with --quick or --task.");
    }

    const [rawAction, rawSubject, ...extraPositionals] = rest;
    const actionText = normalizeOptionalString(rawAction) ?? "list";

    if (!INSTRUCTION_ACTIONS.has(actionText as InstructionCliAction)) {
      fail(
        `Expected \`machdoch instructions\` action to be one of ${Array.from(
          INSTRUCTION_ACTIONS,
        ).join(", ")}.`,
      );
    }

    const action = actionText as InstructionCliAction;

    if (extraPositionals.length > 0) {
      fail(
        `Command \`instructions ${action}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
      );
    }

    if (
      INSTRUCTION_ACTIONS_REQUIRING_SUBJECT.has(action) &&
      !normalizeOptionalString(rawSubject)
    ) {
      fail(`Expected an instruction name or path after \`machdoch instructions ${action}\`.`);
    }

    if (
      (action === "create" || action === "save" || action === "generate") &&
      !normalizeOptionalString(rawSubject) &&
      !rawSchedulerName
    ) {
      fail(`\`machdoch instructions ${action}\` expects a name or --name.`);
    }

    if (
      (action === "create" || action === "save" || action === "generate") &&
      !rawSchedulerPrompt &&
      !rawSchedulerPromptFile
    ) {
      fail(`\`machdoch instructions ${action}\` expects --prompt or --prompt-file.`);
    }

    if (
      (action === "create" || action === "save" || action === "generate") &&
      rawSchedulerPrompt &&
      rawSchedulerPromptFile
    ) {
      fail(`Use either --prompt or --prompt-file for \`machdoch instructions ${action}\`, not both.`);
    }

    if (
      action !== "create" &&
      action !== "save" &&
      action !== "generate" &&
      (rawSchedulerPrompt || rawSchedulerPromptFile)
    ) {
      fail("--prompt and --prompt-file are only valid for `machdoch instructions create`, `machdoch instructions save`, or `machdoch instructions generate`.");
    }

    if (
      action !== "create" &&
      action !== "save" &&
      action !== "generate" &&
      rawInstructionPath
    ) {
      fail("--path is only valid for `machdoch instructions create`, `machdoch instructions save`, or `machdoch instructions generate`.");
    }

    if (action !== "generate" && rawRalphMaxRounds) {
      fail("--max-rounds is only valid for `machdoch instructions generate`.");
    }

    if (
      (action === "create" || action === "save" || action === "generate") &&
      rawInstructionScope === "compatibility"
    ) {
      fail("Compatibility instruction files are read-only; use user, workspace, or ralph-flow scope.");
    }

    if (rawInstructionScope === "ralph-flow" && !rawInstructionRalphFlow) {
      fail("Ralph flow instruction scope requires --ralph-flow.");
    }

    if (rawInstructionScope !== "ralph-flow" && rawInstructionRalphFlow) {
      fail("--ralph-flow requires --scope ralph-flow.");
    }

    if (rawInstructionScope !== "ralph-flow" && rawInstructionRalphFlowScope) {
      fail("--flow-scope requires --scope ralph-flow.");
    }

    const instructionSubject = normalizeOptionalString(rawSubject);
    const instructionMaxRounds = parseOptionalPositiveInteger(
      rawRalphMaxRounds,
      "--max-rounds",
    );

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "instructions",
      },
      {
        instructions: {
          action,
          ...(instructionSubject ? { subject: instructionSubject } : {}),
          ...(rawSchedulerName ? { name: rawSchedulerName } : {}),
          ...(rawInstructionScope
            ? { scope: rawInstructionScope as InstructionCliScope }
            : {}),
          ...(rawInstructionRalphFlow
            ? { ralphFlow: rawInstructionRalphFlow }
            : {}),
          ...(rawInstructionRalphFlowScope
            ? { ralphFlowScope: rawInstructionRalphFlowScope as RalphCliScope }
            : {}),
          ...(rawSchedulerPrompt ? { prompt: rawSchedulerPrompt } : {}),
          ...(rawSchedulerPromptFile ? { promptFile: rawSchedulerPromptFile } : {}),
          ...(rawInstructionPath ? { path: rawInstructionPath } : {}),
          ...(rawInstructionApplyTo && rawInstructionApplyTo.length > 0
            ? { applyTo: rawInstructionApplyTo }
            : {}),
          ...(rawInstructionExclude && rawInstructionExclude.length > 0
            ? { exclude: rawInstructionExclude }
            : {}),
          ...(rawInstructionKeywords && rawInstructionKeywords.length > 0
            ? { keywords: rawInstructionKeywords }
            : {}),
          ...(rawInstructionMode
            ? { mode: rawInstructionMode as InstructionMode }
            : {}),
          ...(rawInstructionAudience
            ? { audience: rawInstructionAudience as InstructionAudience }
            : {}),
          ...(instructionPriority !== undefined
            ? { priority: instructionPriority }
            : {}),
          ...(instructionMaxRounds !== undefined
            ? { maxRounds: instructionMaxRounds }
            : {}),
        },
      },
    );
  }

  if (first === "scheduler") {
    if (quickRunRequested || rawTask) {
      fail("`machdoch scheduler` cannot be combined with --quick or --task.");
    }

    const [rawAction, rawSubject, ...extraPositionals] = rest;
    const actionText = normalizeOptionalString(rawAction) ?? "list";

    if (!SCHEDULER_ACTIONS.has(actionText as SchedulerCliAction)) {
      fail(
        `Expected \`machdoch scheduler\` action to be one of ${Array.from(
          SCHEDULER_ACTIONS,
        ).join(", ")}.`,
      );
    }

    const action = actionText as SchedulerCliAction;

    if (extraPositionals.length > 0) {
      fail(
        `Command \`scheduler ${action}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
      );
    }

    if (
      SCHEDULER_ACTIONS_REQUIRING_SUBJECT.has(action) &&
      !normalizeOptionalString(rawSubject)
    ) {
      fail(`Expected an id after \`machdoch scheduler ${action}\`.`);
    }

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "scheduler",
      },
      {
        scheduler: createSchedulerCliOptions({
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
        }),
      },
    );
  }

  if (
    first === "inspect" ||
    first === "tools" ||
    first === "profiles" ||
    first === "help"
  ) {
    if (quickRunRequested) {
      fail(
        "--quick can only be used with a task provided via --task or positional task text.",
      );
    }

    assertNoAdditionalPositionals(first, rest);

    return createParsedArgs({
      ...sharedOptions,
      command: first,
    });
  }

  if (first === "config") {
    if (quickRunRequested) {
      fail(
        "--quick can only be used with a task provided via --task or positional task text.",
      );
    }

    if (rest.length === 0) {
      return createParsedArgs({
        ...sharedOptions,
        command: "config",
      });
    }

    const [subcommand, setting, ...valueParts] = rest;

    if (subcommand !== "set") {
      fail(
        `Command \`config\` does not accept positional arguments: ${rest.join(" ")}`,
      );
    }

    const configSetting =
      normalizeOptionalString(setting) ??
      fail("Expected `machdoch config set <setting> <value>`.");
    const configValue =
      normalizeOptionalString(valueParts.join(" ")) ??
      fail("Expected `machdoch config set <setting> <value>`.");

    if (
      rawModel ||
      rawDefaultModel ||
      rawReasoning ||
      rawProfile ||
      rawRuntimeProvider ||
      rawMode ||
      sessionMemoryEnabled !== undefined ||
      globalMemoryEnabled !== undefined ||
      agentLimits ||
      rawConversationContextFile ||
      rawContextPaths ||
      rawImagePaths
    ) {
      fail(
        "`machdoch config set` cannot be combined with runtime override options.",
      );
    }

    return createParsedArgs(
      {
        json,
        verbose,
        workspaceRoot,
        command: "set-config",
      },
      {
        configSetting,
        configValue,
      },
    );
  }

  if (first === "run") {
    const task = rest.join(" ").trim();

    if (task.length === 0) {
      if (rawTask) {
        return createParsedArgs(
          {
            ...sharedOptions,
            command: "run",
          },
          { task: rawTask },
        );
      }

      fail("Expected a task after `machdoch run`.");
    }

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "run",
      },
      { task },
    );
  }

  const task = positionals.join(" ").trim();

  return createParsedArgs(
    {
      ...sharedOptions,
      command: quickRunRequested ? "run" : "chat",
    },
    { task },
  );
};
