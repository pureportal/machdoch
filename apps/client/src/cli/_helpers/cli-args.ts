import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import { validateTaskDeterministicAction } from "../../core/_helpers/deterministic-action-validation.js";
import type { TaskDeterministicAction } from "../../core/types.js";
import type {
  AgentCliProvider,
  ModelProvider,
  ReasoningMode,
  RuntimeAgentLimitOverrides,
  RunMode,
  UserApiProvider,
} from "../../core/runtime-contract.generated.js";
import {
  INSTRUCTION_ACTIONS,
  FLEET_ACTIONS,
  MCP_ACTIONS,
  MCP_ACTIONS_REQUIRING_SERVER,
  MCP_ACTIONS_REQUIRING_TARGET,
  PROVIDER_SYNC_ACTIONS,
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
  VALID_PROVIDER_DESCRIPTION,
  VALID_PROVIDERS,
  VALID_REASONING_MODE_DESCRIPTION,
  VALID_REASONING_MODES,
  VALID_RUNTIME_PROVIDER_DESCRIPTION,
  VALID_RUNTIME_PROVIDERS,
} from "./cli-args-constants.js";
import {
  createParsedArgs,
  createSharedParsedOptions,
} from "./create-parsed-cli-args.helper.js";
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
  ConfigCliAction,
  ConfigCliOptions,
  CommandName,
  InstructionCliAction,
  FleetCliAction,
  FleetCliOptions,
  InstructionCliGroup,
  InstructionCliOptions,
  McpCliAction,
  ProviderSyncCliAction,
  ProviderSyncCliOptions,
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
  TaskInterviewCliOptions,
} from "./cli-args-types.js";
import type {
  FleetCliAction,
  FleetCliOptions,
  InstructionCliAction,
  InstructionCliGroup,
  McpCliAction,
  ProviderSyncCliAction,
  ParsedCliArgs,
  RalphCliAction,
  RalphCliGenerationMode,
  RalphCliGenerationTarget,
  RalphCliScope,
  RalphWatchCliAction,
  SchedulerCliAction,
  TaskInterviewCliOptions,
} from "./cli-args-types.js";

export { getHelpText };

const assertInstructionOptionAllowed = (
  provided: boolean,
  option: string,
  action: InstructionCliAction,
  allowedActions: readonly InstructionCliAction[],
): void => {
  if (!provided || allowedActions.includes(action)) return;
  fail(
    `${option} is not valid for \`machdoch instructions ${action.replace("-", " ")}\`.`,
  );
};

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
        "deterministic-action-json"?: string;
        "skip-file-change-detection"?: boolean;
        context?: string[];
        image?: string[];
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
        "scheduled-ralph-profile"?: string;
        "scheduled-ralph-resume-policy"?: string;
        "scheduled-ralph-allowed-root"?: string[];
        "scheduled-ralph-allow-commands"?: string;
        "scheduled-ralph-allow-writes"?: string;
        "scheduled-ralph-allow-network"?: string;
        "scheduled-ralph-allow-mcp-tools"?: string;
        "flow-json"?: string;
        "flow-json-file"?: string;
        "expected-fingerprint"?: string;
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
        "retry-current"?: boolean;
        "max-rounds"?: string;
        "max-transitions"?: string;
        "instruction-boundary-policy"?: string;
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
        "request-id"?: string;
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
        "ralph-flow"?: string;
        "flow-scope"?: string;
        description?: string;
        profile?: string[];
        "expected-revision"?: string;
        "expected-digest"?: string;
        surface?: string;
        "include-content"?: boolean;
        "include-workspaces"?: boolean;
        "decisions-file"?: string;
        "confirm-assignment-removal"?: boolean;
        "metadata-json"?: string;
        "manager-url"?: string;
        "enrollment-key"?: string;
        "display-name"?: string;
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
        "deterministic-action-json": { type: "string" },
        "skip-file-change-detection": { type: "boolean" },
        context: { type: "string", multiple: true },
        image: { type: "string", multiple: true },
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
        "scheduled-ralph-profile": { type: "string" },
        "scheduled-ralph-resume-policy": { type: "string" },
        "scheduled-ralph-allowed-root": { type: "string", multiple: true },
        "scheduled-ralph-allow-commands": { type: "string" },
        "scheduled-ralph-allow-writes": { type: "string" },
        "scheduled-ralph-allow-network": { type: "string" },
        "scheduled-ralph-allow-mcp-tools": { type: "string" },
        "flow-json": { type: "string" },
        "flow-json-file": { type: "string" },
        "expected-fingerprint": { type: "string" },
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
        "retry-current": { type: "boolean" },
        "max-rounds": { type: "string" },
        "max-transitions": { type: "string" },
        "instruction-boundary-policy": { type: "string" },
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
        "request-id": { type: "string" },
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
        "ralph-flow": { type: "string" },
        "flow-scope": { type: "string" },
        description: { type: "string" },
        profile: { type: "string", multiple: true },
        "expected-revision": { type: "string" },
        "expected-digest": { type: "string" },
        surface: { type: "string" },
        "include-content": { type: "boolean" },
        "include-workspaces": { type: "boolean" },
        "decisions-file": { type: "string" },
        "confirm-assignment-removal": { type: "boolean" },
        "metadata-json": { type: "string" },
        "manager-url": { type: "string" },
        "enrollment-key": { type: "string" },
        "display-name": { type: "string" },
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
  const isProviderSyncCommand = positionals[0] === "provider-sync";
  const isFleetCommand = positionals[0] === "fleet";
  const rawRuntimeProvider = normalizeOptionalString(
    values?.["runtime-provider"],
  );
  const rawFleetManagerUrl = normalizeOptionalString(values?.["manager-url"]);
  const rawFleetEnrollmentKey = normalizeOptionalString(
    values?.["enrollment-key"],
  );
  const rawFleetDisplayName = normalizeOptionalString(values?.["display-name"]);
  if (
    !isFleetCommand &&
    (values?.["manager-url"] !== undefined ||
      values?.["enrollment-key"] !== undefined ||
      values?.["display-name"] !== undefined)
  ) {
    fail("Fleet enrollment options require `machdoch fleet enroll`.");
  }
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
  const skipFileChangeDetection =
    values?.["skip-file-change-detection"] === true;
  const rawDeterministicActionJson = normalizeOptionalString(
    values?.["deterministic-action-json"],
  );
  const rawContextPaths = normalizeContextPaths(values?.context);
  const rawImagePaths = normalizeImagePaths(values?.image);
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
  const rawSchedulerIntervalMs = normalizeOptionalString(
    values?.["interval-ms"],
  );
  const rawSchedulerDelayMs = normalizeOptionalString(values?.["delay-ms"]);
  const rawSchedulerRunAt = normalizeOptionalString(values?.["run-at"]);
  const rawSchedulerTimezone = normalizeOptionalString(values?.timezone);
  const rawSchedulerTarget = normalizeOptionalString(
    values?.["scheduler-target"],
  );
  const rawSchedulerPrompt = normalizeOptionalString(values?.prompt);
  const rawSchedulerPromptFile = normalizeOptionalString(
    values?.["prompt-file"],
  );
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
  const rawScheduledRalphProfile = normalizeOptionalString(
    values?.["scheduled-ralph-profile"],
  );
  const rawScheduledRalphResumePolicy = normalizeOptionalString(
    values?.["scheduled-ralph-resume-policy"],
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
  const rawRalphFlowJsonFile = normalizeOptionalString(
    values?.["flow-json-file"],
  );
  const rawRalphExpectedFingerprint = normalizeOptionalString(
    values?.["expected-fingerprint"],
  );
  const rawRalphWatchJson = normalizeOptionalString(values?.["watch-json"]);
  const rawRalphWatchJsonFile = normalizeOptionalString(
    values?.["watch-json-file"],
  );
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
  const rawRalphInputJsonFile = normalizeOptionalString(
    values?.["input-json-file"],
  );
  const rawRalphRetryCurrent = values?.["retry-current"] === true;
  const rawRalphMaxRounds = normalizeOptionalString(values?.["max-rounds"]);
  const rawRalphMaxTransitions = normalizeOptionalString(
    values?.["max-transitions"],
  );
  const rawRalphInstructionBoundaryPolicy = normalizeOptionalString(
    values?.["instruction-boundary-policy"],
  );
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
  const rawSchedulerRetryMinMs = normalizeOptionalString(
    values?.["retry-min-ms"],
  );
  const rawSchedulerRetryMaxMs = normalizeOptionalString(
    values?.["retry-max-ms"],
  );
  const rawSchedulerRetryFactor = normalizeOptionalString(
    values?.["retry-factor"],
  );
  const rawSchedulerRetryRandomize = normalizeOptionalString(
    values?.["retry-randomize"],
  );
  const rawSchedulerDedupeKey = normalizeOptionalString(values?.["dedupe-key"]);
  const rawSchedulerRequestId = normalizeOptionalString(values?.["request-id"]);
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
  const rawMcpArgumentsJson = normalizeOptionalString(
    values?.["arguments-json"],
  );
  const includeDisabledMcp = values?.["include-disabled"] === true;
  const rawMcpAgent = normalizeOptionalString(values?.agent);
  const rawMcpPhase = normalizeOptionalString(values?.phase);
  const rawMcpUnusedDays = normalizeOptionalString(values?.["unused-days"]);
  const rawMcpNeverUsedDays = normalizeOptionalString(
    values?.["never-used-days"],
  );
  const applyMcpCleanup = values?.apply === true;
  const rawMcpScope =
    positionals[0] === "mcp"
      ? normalizeOptionalString(values?.scope)
      : undefined;
  const rawRalphScope = normalizeOptionalString(values?.scope);
  const rawInstructionPath = normalizeOptionalString(values?.path);
  const rawInstructionRalphFlow = normalizeOptionalString(
    values?.["ralph-flow"],
  );
  const rawInstructionRalphFlowScope = normalizeOptionalString(
    values?.["flow-scope"],
  );
  const rawInstructionDescription =
    typeof values?.description === "string" ? values.description : undefined;
  const rawInstructionProfileIds = values?.profile
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawInstructionExpectedRevision = normalizeOptionalString(
    values?.["expected-revision"],
  );
  const rawInstructionExpectedDigest = normalizeOptionalString(
    values?.["expected-digest"],
  );
  const rawInstructionSurface = normalizeOptionalString(values?.surface);
  const rawInstructionDecisionsFile = normalizeOptionalString(
    values?.["decisions-file"],
  );
  const rawInstructionMetadataJson = normalizeOptionalString(
    values?.["metadata-json"],
  );

  if (values?.mode !== undefined && !rawMode) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  if (rawMode && !VALID_MODES.has(rawMode as RunMode)) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  if (values?.["ralph-flow"] !== undefined && !rawInstructionRalphFlow) {
    fail("Expected --ralph-flow to be followed by a Ralph flow id or alias.");
  }

  if (values?.["flow-scope"] !== undefined && !rawInstructionRalphFlowScope) {
    fail("Expected --flow-scope to be followed by user or workspace.");
  }

  if (
    rawInstructionRalphFlowScope &&
    !RALPH_SCOPES.has(rawInstructionRalphFlowScope as RalphCliScope)
  ) {
    fail("Expected --flow-scope to be followed by user or workspace.");
  }

  if (values?.provider !== undefined && !rawProvider) {
    fail(
      `Expected --provider to be followed by ${VALID_PROVIDER_DESCRIPTION}.`,
    );
  }

  if (values?.["runtime-provider"] !== undefined && !rawRuntimeProvider) {
    fail(
      `Expected --runtime-provider to be followed by ${VALID_RUNTIME_PROVIDER_DESCRIPTION}.`,
    );
  }

  if (
    rawProvider &&
    !VALID_PROVIDERS.has(rawProvider as UserApiProvider) &&
    !(
      isProviderSyncCommand &&
      ["codex-cli", "claude-cli", "copilot-cli"].includes(rawProvider)
    )
  ) {
    fail(
      `Expected --provider to be followed by ${VALID_PROVIDER_DESCRIPTION}.`,
    );
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

  if (
    values?.["deterministic-action-json"] !== undefined &&
    !rawDeterministicActionJson
  ) {
    fail(
      "Expected --deterministic-action-json to be followed by a JSON object.",
    );
  }

  let deterministicAction: TaskDeterministicAction | undefined;
  if (rawDeterministicActionJson) {
    let parsedAction: unknown;
    try {
      parsedAction = JSON.parse(rawDeterministicActionJson);
    } catch {
      fail("--deterministic-action-json must contain valid JSON.");
    }

    const validation = validateTaskDeterministicAction(parsedAction);
    if (validation.state === "invalid") {
      fail(`Invalid --deterministic-action-json: ${validation.reason}`);
    } else {
      deterministicAction = validation.action;
    }
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

  if (
    deterministicAction &&
    !(
      (quickRunRequested && rawTask) ||
      (positionals[0] === "run" && positionals.length > 1)
    )
  ) {
    fail(
      "--deterministic-action-json is only valid for a one-shot task execution.",
    );
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
    fail(
      "--default-model cannot be combined with runtime loop limit overrides.",
    );
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
    ...(deterministicAction ? { deterministicAction } : {}),
    ...(skipFileChangeDetection ? { skipFileChangeDetection: true } : {}),
  });

  if (setGlobalMemoryEnabled !== undefined) {
    if (
      rawTask ||
      positionals.length > 0 ||
      rawModel ||
      rawDefaultModel ||
      rawReasoning ||
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

    const helpPositionals =
      positionals[0] === "help" ? positionals.slice(1) : positionals;

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "help",
      },
      helpPositionals[0] ? { helpTopic: helpPositionals[0] } : undefined,
    );
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

  if (first !== "mcp" && applyMcpCleanup) {
    fail("--apply is only valid for `machdoch mcp cleanup`.");
  }

  if (
    first !== "instructions" &&
    (rawInstructionRalphFlow || rawInstructionRalphFlowScope)
  ) {
    fail(
      "--ralph-flow and --flow-scope are only valid for `machdoch instructions`.",
    );
  }

  if (first === "interview") {
    if (quickRunRequested || rawTask) {
      fail("`machdoch interview` cannot be combined with --quick or --task.");
    }

    assertNoAdditionalPositionals(first, rest);

    if (!rawSchedulerPrompt && !rawSchedulerPromptFile) {
      fail("`machdoch interview` expects --prompt or --prompt-file.");
    }

    if (rawSchedulerPrompt && rawSchedulerPromptFile) {
      fail(
        "Use either --prompt or --prompt-file for `machdoch interview`, not both.",
      );
    }

    if (rawRalphInputJson && rawRalphInputJsonFile) {
      fail(
        "Use either --input-json or --input-json-file for `machdoch interview`, not both.",
      );
    }

    const interviewMaxRounds = parseOptionalPositiveInteger(
      rawRalphMaxRounds,
      "--max-rounds",
    );
    const interview: TaskInterviewCliOptions = {
      ...(rawSchedulerPrompt ? { prompt: rawSchedulerPrompt } : {}),
      ...(rawSchedulerPromptFile ? { promptFile: rawSchedulerPromptFile } : {}),
      ...(rawRalphInputJson ? { inputJson: rawRalphInputJson } : {}),
      ...(rawRalphInputJsonFile
        ? { inputJsonFile: rawRalphInputJsonFile }
        : {}),
      ...(interviewMaxRounds !== undefined
        ? { maxRounds: interviewMaxRounds }
        : {}),
    };

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "interview",
      },
      {
        interview,
      },
    );
  }

  if (first === "provider-sync") {
    if (quickRunRequested || rawTask) {
      fail(
        "`machdoch provider-sync` cannot be combined with --quick or --task.",
      );
    }
    const [rawAction, ...extraPositionals] = rest;
    const actionText = normalizeOptionalString(rawAction) ?? "status";
    if (!PROVIDER_SYNC_ACTIONS.has(actionText as ProviderSyncCliAction)) {
      fail(
        `Expected \`machdoch provider-sync\` action to be one of ${Array.from(
          PROVIDER_SYNC_ACTIONS,
        ).join(", ")}.`,
      );
    }
    if (extraPositionals.length > 0) {
      fail(
        `Command \`provider-sync ${actionText}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
      );
    }
    if (
      rawModel ||
      rawDefaultModel ||
      rawReasoning ||
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
        "`machdoch provider-sync` cannot be combined with runtime override options.",
      );
    }
    return createParsedArgs(
      {
        json,
        verbose,
        workspaceRoot,
        command: "provider-sync",
      },
      {
        providerSync: {
          action: actionText as ProviderSyncCliAction,
          ...(rawProvider ? { provider: rawProvider as AgentCliProvider } : {}),
        },
      },
    );
  }

  if (first === "fleet") {
    if (quickRunRequested || rawTask) {
      fail("`machdoch fleet` cannot be combined with --quick or --task.");
    }
    const [rawAction, ...extraPositionals] = rest;
    const actionText = normalizeOptionalString(rawAction) ?? "status";
    if (!FLEET_ACTIONS.has(actionText as FleetCliAction)) {
      fail(
        `Expected \`machdoch fleet\` action to be one of ${Array.from(
          FLEET_ACTIONS,
        ).join(", ")}.`,
      );
    }
    if (extraPositionals.length > 0) {
      fail(
        `Command \`fleet ${actionText}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
      );
    }
    if (
      rawModel ||
      rawDefaultModel ||
      rawReasoning ||
      rawRuntimeProvider ||
      rawProvider ||
      rawKey ||
      rawMode ||
      sessionMemoryEnabled !== undefined ||
      globalMemoryEnabled !== undefined ||
      agentLimits ||
      rawConversationContextFile ||
      deterministicAction ||
      skipFileChangeDetection ||
      rawContextPaths ||
      rawImagePaths
    ) {
      fail(
        "`machdoch fleet` cannot be combined with runtime override options.",
      );
    }

    const action = actionText as FleetCliAction;
    if (action === "enroll") {
      if (!rawFleetManagerUrl) {
        fail("Expected --manager-url for `machdoch fleet enroll`.");
      }
      if (!rawFleetEnrollmentKey) {
        fail("Expected --enrollment-key for `machdoch fleet enroll`.");
      }
      if (!rawFleetDisplayName) {
        fail("Expected --display-name for `machdoch fleet enroll`.");
      }
    } else if (
      values?.["manager-url"] !== undefined ||
      values?.["enrollment-key"] !== undefined ||
      values?.["display-name"] !== undefined
    ) {
      fail(
        `Fleet enrollment options are only valid for \`machdoch fleet enroll\`.`,
      );
    }

    const fleet: FleetCliOptions = {
      action,
      ...(rawFleetManagerUrl ? { managerUrl: rawFleetManagerUrl } : {}),
      ...(rawFleetEnrollmentKey
        ? { enrollmentKey: rawFleetEnrollmentKey }
        : {}),
      ...(rawFleetDisplayName ? { displayName: rawFleetDisplayName } : {}),
    };
    return createParsedArgs(
      { json, verbose, workspaceRoot, command: "fleet" },
      { fleet },
    );
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
      fail(
        `Expected a target after \`machdoch mcp ${action} ${serverId ?? ""}\`.`,
      );
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
      fail(
        "--arguments-json is only valid for `machdoch mcp call-tool` or `machdoch mcp get-prompt`.",
      );
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

    if (action === "lifecycle-hook" && !rawMcpPhase) {
      fail("--phase is required for `machdoch mcp lifecycle-hook`.");
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

    const acceptsMcpScope =
      action === "proxy" ||
      action === "oauth-authorize" ||
      action === "oauth-start" ||
      action === "oauth-finish";
    if (rawMcpScope && !acceptsMcpScope) {
      fail(
        "--scope is only valid for `machdoch mcp proxy` and MCP OAuth commands.",
      );
    }

    if (rawMcpScope && rawMcpScope !== "user") {
      fail("Expected `machdoch mcp --scope` to be followed by user.");
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
          ...(rawMcpScope === "user" ? { scope: rawMcpScope } : {}),
          ...(serverId ? { serverId } : {}),
          ...(target ? { target } : {}),
          ...(rawMcpArgumentsJson
            ? { argumentsJson: rawMcpArgumentsJson }
            : {}),
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
    const isJsonValidationCommand = action === "validate-json";

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
        ]
          .filter(Boolean)
          .join(" ")}`,
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

    if (isJsonValidationCommand && normalizeOptionalString(rawSubject)) {
      fail("`machdoch ralph validate-json` does not accept a flow id.");
    }

    const isGenerationCommand = action === "create" || action === "interview";

    if (isGenerationCommand && !rawSchedulerPrompt && !rawSchedulerPromptFile) {
      fail(`\`machdoch ralph ${action}\` expects --prompt or --prompt-file.`);
    }

    if (
      !isGenerationCommand &&
      (rawSchedulerPrompt || rawSchedulerPromptFile)
    ) {
      fail(
        "--prompt and --prompt-file are only valid for `machdoch ralph create` or `machdoch ralph interview`.",
      );
    }

    if (
      (action === "save" || isJsonValidationCommand) &&
      !rawRalphFlowJson &&
      !rawRalphFlowJsonFile
    ) {
      fail(
        `\`machdoch ralph ${action}\` expects --flow-json. Use --flow-json-file for large payloads.`,
      );
    }

    if (
      (action === "save" || isJsonValidationCommand) &&
      rawRalphFlowJson &&
      rawRalphFlowJsonFile
    ) {
      fail(
        `Use either --flow-json or --flow-json-file for \`machdoch ralph ${action}\`, not both.`,
      );
    }

    if (action !== "save" && !isJsonValidationCommand && rawRalphFlowJson) {
      fail(
        "--flow-json is only valid for `machdoch ralph save` or `machdoch ralph validate-json`.",
      );
    }

    if (action !== "save" && !isJsonValidationCommand && rawRalphFlowJsonFile) {
      fail(
        "--flow-json-file is only valid for `machdoch ralph save` or `machdoch ralph validate-json`.",
      );
    }

    if (
      action !== "save" &&
      action !== "delete" &&
      rawRalphExpectedFingerprint
    ) {
      fail(
        "--expected-fingerprint is only valid for `machdoch ralph save` or `machdoch ralph delete`.",
      );
    }

    if (action !== "watches" && rawRalphWatchJson) {
      fail("--watch-json is only valid for `machdoch ralph watches create`.");
    }

    if (action !== "watches" && rawRalphWatchJsonFile) {
      fail(
        "--watch-json-file is only valid for `machdoch ralph watches create`.",
      );
    }

    if (
      isGenerationCommand &&
      rawRalphExistingFlowJson &&
      rawRalphExistingFlowJsonFile
    ) {
      fail(
        `Use either --existing-flow-json or --existing-flow-json-file for \`machdoch ralph ${action}\`, not both.`,
      );
    }

    if (
      !isGenerationCommand &&
      (rawRalphExistingFlowJson || rawRalphExistingFlowJsonFile)
    ) {
      if (rawRalphExistingFlowJson) {
        fail(
          "--existing-flow-json is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
        );
      }

      fail(
        "--existing-flow-json-file is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
      );
    }

    if (action === "restore" && !rawRalphRevision) {
      fail("`machdoch ralph restore` expects --revision.");
    }

    if (action !== "restore" && rawRalphRevision) {
      fail("--revision is only valid for `machdoch ralph restore`.");
    }

    if (!isGenerationCommand && rawRalphFlowTarget) {
      fail(
        "--flow-target is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
      );
    }

    if (
      rawRalphFlowTarget &&
      !RALPH_GENERATION_TARGETS.has(
        rawRalphFlowTarget as RalphCliGenerationTarget,
      )
    ) {
      fail(
        "Expected --flow-target to be followed by flow, prompt-block, or refactor.",
      );
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

    if (
      action === "resume" &&
      !rawRalphRetryCurrent &&
      !rawRalphInputJson &&
      !rawRalphInputJsonFile
    ) {
      fail(
        "`machdoch ralph resume` expects --input-json, --input-json-file, or --retry-current.",
      );
    }

    if (
      action === "resume" &&
      rawRalphRetryCurrent &&
      (rawRalphInputJson || rawRalphInputJsonFile)
    ) {
      fail(
        "Use either --retry-current or an input response for `machdoch ralph resume`, not both.",
      );
    }

    if (
      (action === "resume" || action === "interview") &&
      rawRalphInputJson &&
      rawRalphInputJsonFile
    ) {
      fail(
        `Use either --input-json or --input-json-file for \`machdoch ralph ${action}\`, not both.`,
      );
    }

    if (action !== "resume" && rawRalphRetryCurrent) {
      fail("--retry-current is only valid for `machdoch ralph resume`.");
    }

    if (action !== "resume" && action !== "interview" && rawRalphInputJson) {
      fail(
        "--input-json is only valid for `machdoch ralph resume` or `machdoch ralph interview`.",
      );
    }

    if (
      action !== "resume" &&
      action !== "interview" &&
      rawRalphInputJsonFile
    ) {
      fail(
        "--input-json-file is only valid for `machdoch ralph resume` or `machdoch ralph interview`.",
      );
    }

    if (!isGenerationCommand && rawRalphMaxRounds) {
      fail(
        "--max-rounds is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
      );
    }

    if (action !== "run" && action !== "resume" && rawRalphMaxTransitions) {
      fail(
        "--max-transitions is only valid for `machdoch ralph run` or `machdoch ralph resume`.",
      );
    }

    if (
      rawRalphInstructionBoundaryPolicy &&
      !["require-match", "original-boundary", "new-boundary"].includes(
        rawRalphInstructionBoundaryPolicy,
      )
    ) {
      fail(
        "--instruction-boundary-policy must be require-match, original-boundary, or new-boundary.",
      );
    }

    if (action !== "resume" && rawRalphInstructionBoundaryPolicy) {
      fail(
        "--instruction-boundary-policy is only valid for `machdoch ralph resume`.",
      );
    }

    if (action !== "log" && rawRalphTrace) {
      fail("--trace is only valid for `machdoch ralph log`.");
    }

    if (rawRalphScope && !RALPH_SCOPES.has(rawRalphScope as RalphCliScope)) {
      fail("Expected Ralph --scope to be followed by user or workspace.");
    }

    const watchActionText = isWatchCommand
      ? (normalizeOptionalString(rawSubject) ?? "list")
      : undefined;

    if (
      watchActionText &&
      !RALPH_WATCH_ACTIONS.has(watchActionText as RalphWatchCliAction)
    ) {
      fail(
        "Expected `machdoch ralph watches` action to be one of list, create, delete, sync, or run.",
      );
    }

    if (
      isWatchCommand &&
      watchActionText === "create" &&
      !rawRalphWatchJson &&
      !rawRalphWatchJsonFile
    ) {
      fail(
        "`machdoch ralph watches create` expects --watch-json or --watch-json-file.",
      );
    }

    if (
      isWatchCommand &&
      watchActionText !== "create" &&
      (rawRalphWatchJson || rawRalphWatchJsonFile)
    ) {
      fail(
        "--watch-json and --watch-json-file are only valid for `machdoch ralph watches create`.",
      );
    }

    if (isWatchCommand && rawRalphWatchJson && rawRalphWatchJsonFile) {
      fail(
        "Use either --watch-json or --watch-json-file for `machdoch ralph watches create`, not both.",
      );
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
          ...(rawRalphScope ? { scope: rawRalphScope as RalphCliScope } : {}),
          ...(rawSchedulerName ? { name: rawSchedulerName } : {}),
          ...(rawSchedulerPrompt ? { prompt: rawSchedulerPrompt } : {}),
          ...(rawSchedulerPromptFile
            ? { promptFile: rawSchedulerPromptFile }
            : {}),
          ...(rawRalphFlowJson ? { flowJson: rawRalphFlowJson } : {}),
          ...(rawRalphFlowJsonFile
            ? { flowJsonFile: rawRalphFlowJsonFile }
            : {}),
          ...(rawRalphExpectedFingerprint
            ? { expectedFingerprint: rawRalphExpectedFingerprint }
            : {}),
          ...(rawRalphWatchJson ? { watchJson: rawRalphWatchJson } : {}),
          ...(rawRalphWatchJsonFile
            ? { watchJsonFile: rawRalphWatchJsonFile }
            : {}),
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
            ? {
                generationMode:
                  rawRalphGenerationMode as RalphCliGenerationMode,
              }
            : {}),
          ...(rawRalphParams && rawRalphParams.length > 0
            ? { params: rawRalphParams }
            : {}),
          ...(rawRalphParamsFile ? { paramsFile: rawRalphParamsFile } : {}),
          ...(rawRalphInputJson ? { inputJson: rawRalphInputJson } : {}),
          ...(rawRalphInputJsonFile
            ? { inputJsonFile: rawRalphInputJsonFile }
            : {}),
          ...(rawRalphRetryCurrent ? { retryCurrent: true } : {}),
          ...(ralphMaxRounds !== undefined
            ? { maxRounds: ralphMaxRounds }
            : {}),
          ...(ralphMaxTransitions !== undefined
            ? { maxTransitions: ralphMaxTransitions }
            : {}),
          ...(rawRalphInstructionBoundaryPolicy
            ? {
                instructionBoundaryPolicy: rawRalphInstructionBoundaryPolicy as
                  | "require-match"
                  | "original-boundary"
                  | "new-boundary",
              }
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
      fail(
        "`machdoch instructions` cannot be combined with --quick or --task.",
      );
    }

    const instructionGroups = new Set<InstructionCliGroup>([
      "profiles",
      "assignments",
      "workspaces",
      "transfer",
      "recovery",
    ]);
    const [rawFirst, rawSecond, rawThird, rawFourth, ...extraPositionals] =
      rest;
    const firstInstructionWord =
      normalizeOptionalString(rawFirst) ?? "profiles";
    const group = instructionGroups.has(
      firstInstructionWord as InstructionCliGroup,
    )
      ? (firstInstructionWord as InstructionCliGroup)
      : undefined;
    if (
      group === undefined &&
      firstInstructionWord !== "resolve" &&
      firstInstructionWord !== "validate"
    ) {
      fail(
        `Unknown instruction command \`${firstInstructionWord}\`. Use profiles, assignments, workspaces, transfer, recovery, resolve, or validate.`,
      );
    }
    const groupAction = normalizeOptionalString(rawSecond);
    const instructionGroupPrefix: Record<InstructionCliGroup, string> = {
      profiles: "profile",
      assignments: "assignment",
      workspaces: "workspace",
      transfer: "transfer",
      recovery: "recovery",
    };
    const actionText = group
      ? `${instructionGroupPrefix[group]}-${
          groupAction ?? (group === "recovery" ? "status" : "list")
        }`
      : firstInstructionWord;
    const action = actionText as InstructionCliAction;
    if (!INSTRUCTION_ACTIONS.has(action)) {
      fail(
        `Unknown instruction command \`${[firstInstructionWord, groupAction]
          .filter(Boolean)
          .join(
            " ",
          )}\`. Use profiles, assignments, workspaces, transfer, recovery, resolve, or validate.`,
      );
    }
    const instructionOptionNames = new Set([
      "json",
      "verbose",
      "help",
      "cwd",
      "runtime-provider",
      "model",
      "reasoning",
      "name",
      "description",
      "profile",
      "expected-revision",
      "expected-digest",
      "surface",
      "include-content",
      "include-workspaces",
      "decisions-file",
      "confirm-assignment-removal",
      "metadata-json",
      "prompt",
      "prompt-file",
      "path",
      "ralph-flow",
      "flow-scope",
    ]);
    const unsupportedInstructionOption = Object.keys(values ?? {}).find(
      (name) => !instructionOptionNames.has(name),
    );
    if (unsupportedInstructionOption) {
      fail(
        `--${unsupportedInstructionOption} is not valid for \`machdoch instructions\`.`,
      );
    }
    const rawSubject = group ? rawThird : rawSecond;
    const rawSecondarySubject = group ? rawFourth : rawThird;
    const unexpected = [
      ...(group ? [] : rawFourth ? [rawFourth] : []),
      ...extraPositionals,
    ].filter((entry): entry is string => typeof entry === "string");
    if (unexpected.length > 0) {
      fail(
        `Command \`instructions ${firstInstructionWord}\` has unexpected positional arguments: ${unexpected.join(" ")}`,
      );
    }
    if (
      rawInstructionSurface &&
      rawInstructionSurface !== "api" &&
      rawInstructionSurface !== "cli"
    ) {
      fail("Expected --surface to be followed by api or cli.");
    }
    if (values?.prompt !== undefined && values?.["prompt-file"] !== undefined) {
      fail("Use either --prompt or --prompt-file, not both.");
    }
    if (values?.name !== undefined && !rawSchedulerName) {
      fail("Expected --name to contain a non-empty name.");
    }
    if (values?.["prompt-file"] !== undefined && !rawSchedulerPromptFile) {
      fail("Expected --prompt-file to contain a file path.");
    }
    if (values?.path !== undefined && !rawInstructionPath) {
      fail("Expected --path to contain a path.");
    }
    if (
      values?.["expected-revision"] !== undefined &&
      !rawInstructionExpectedRevision
    ) {
      fail("Expected --expected-revision to contain a revision number.");
    }
    if (
      values?.["expected-digest"] !== undefined &&
      !rawInstructionExpectedDigest
    ) {
      fail("Expected --expected-digest to contain a SHA-256 digest.");
    }
    if (
      rawInstructionExpectedDigest &&
      !/^[0-9a-f]{64}$/iu.test(rawInstructionExpectedDigest)
    ) {
      fail("--expected-digest must be a 64-character SHA-256 digest.");
    }
    if (values?.surface !== undefined && !rawInstructionSurface) {
      fail("Expected --surface to be followed by api or cli.");
    }
    if (
      values?.["decisions-file"] !== undefined &&
      !rawInstructionDecisionsFile
    ) {
      fail("Expected --decisions-file to contain a file path.");
    }
    if (
      values?.["metadata-json"] !== undefined &&
      !rawInstructionMetadataJson
    ) {
      fail("Expected --metadata-json to contain a JSON object.");
    }
    if (
      values?.profile !== undefined &&
      (rawInstructionProfileIds?.length ?? 0) === 0
    ) {
      fail("Expected --profile to contain a profile UUID.");
    }

    assertInstructionOptionAllowed(
      values?.name !== undefined,
      "--name",
      action,
      [
        "profile-create",
        "profile-edit",
        "profile-duplicate",
        "workspace-configure",
      ],
    );
    assertInstructionOptionAllowed(
      values?.description !== undefined,
      "--description",
      action,
      ["profile-create", "profile-edit"],
    );
    assertInstructionOptionAllowed(
      values?.profile !== undefined,
      "--profile",
      action,
      ["assignment-set"],
    );
    assertInstructionOptionAllowed(
      values?.["expected-revision"] !== undefined,
      "--expected-revision",
      action,
      [
        "profile-create",
        "profile-edit",
        "profile-duplicate",
        "profile-delete",
        "assignment-set",
        "assignment-relink",
        "assignment-remove",
        "workspace-configure",
        "workspace-relink",
        "workspace-remove",
        "transfer-import",
      ],
    );
    assertInstructionOptionAllowed(
      values?.["expected-digest"] !== undefined,
      "--expected-digest",
      action,
      ["recovery-restore", "recovery-export", "recovery-reset"],
    );
    assertInstructionOptionAllowed(
      values?.surface !== undefined,
      "--surface",
      action,
      ["resolve"],
    );
    assertInstructionOptionAllowed(
      values?.["include-content"] === true,
      "--include-content",
      action,
      ["profile-list", "resolve", "recovery-export"],
    );
    assertInstructionOptionAllowed(
      values?.["include-workspaces"] === true,
      "--include-workspaces",
      action,
      ["transfer-export", "transfer-import"],
    );
    assertInstructionOptionAllowed(
      values?.["decisions-file"] !== undefined,
      "--decisions-file",
      action,
      ["transfer-import"],
    );
    assertInstructionOptionAllowed(
      values?.["confirm-assignment-removal"] === true,
      "--confirm-assignment-removal",
      action,
      ["workspace-remove"],
    );
    assertInstructionOptionAllowed(
      values?.["ralph-flow"] !== undefined,
      "--ralph-flow",
      action,
      ["resolve"],
    );
    assertInstructionOptionAllowed(
      values?.["flow-scope"] !== undefined,
      "--flow-scope",
      action,
      ["resolve"],
    );
    assertInstructionOptionAllowed(
      values?.prompt !== undefined,
      "--prompt",
      action,
      ["profile-create", "profile-edit"],
    );
    assertInstructionOptionAllowed(
      values?.["prompt-file"] !== undefined,
      "--prompt-file",
      action,
      ["profile-create", "profile-edit", "transfer-import"],
    );
    assertInstructionOptionAllowed(
      values?.path !== undefined,
      "--path",
      action,
      [
        "resolve",
        "assignment-set",
        "assignment-relink",
        "assignment-remove",
        "workspace-relink",
      ],
    );
    assertInstructionOptionAllowed(
      values?.["metadata-json"] !== undefined,
      "--metadata-json",
      action,
      ["profile-create", "profile-edit", "workspace-configure"],
    );
    for (const [provided, option] of [
      [values?.["runtime-provider"] !== undefined, "--runtime-provider"],
      [values?.model !== undefined, "--model"],
      [values?.reasoning !== undefined, "--reasoning"],
    ] as const) {
      if (provided && action !== "resolve" && action !== "validate") {
        fail(
          `${option} is only valid for \`machdoch instructions resolve\` or \`machdoch instructions validate\`.`,
        );
      }
    }
    const instructionSubject = normalizeOptionalString(rawSubject);
    const instructionSecondarySubject =
      normalizeOptionalString(rawSecondarySubject);
    const actionsWithoutSubjects = new Set<InstructionCliAction>([
      "profile-list",
      "assignment-list",
      "workspace-list",
      "transfer-export",
      "transfer-import",
      "recovery-status",
      "recovery-restore",
      "recovery-export",
      "recovery-reset",
      "resolve",
      "validate",
    ]);
    if (
      actionsWithoutSubjects.has(action) &&
      (instructionSubject || instructionSecondarySubject)
    ) {
      fail(
        `\`machdoch instructions ${group ? `${firstInstructionWord} ${groupAction ?? ""}`.trim() : action}\` does not accept positional arguments.`,
      );
    }
    if (instructionSecondarySubject && action !== "assignment-relink") {
      fail(
        `\`machdoch instructions ${firstInstructionWord} ${groupAction ?? ""}\` has an unexpected positional argument: ${instructionSecondarySubject}`,
      );
    }
    const actionsRequiringSubject = new Set<InstructionCliAction>([
      "profile-show",
      "profile-edit",
      "profile-duplicate",
      "profile-delete",
      "assignment-set",
      "assignment-relink",
      "assignment-remove",
      "workspace-relink",
      "workspace-remove",
    ]);
    if (actionsRequiringSubject.has(action) && !instructionSubject) {
      fail(
        `\`machdoch instructions ${action.replace("-", " ")}\` requires a subject.`,
      );
    }
    if (action === "assignment-relink" && !instructionSecondarySubject) {
      fail("Assignment relink requires the current relative folder.");
    }
    if (
      [
        "assignment-set",
        "assignment-relink",
        "assignment-remove",
        "workspace-relink",
      ].includes(action) &&
      !rawInstructionPath
    ) {
      fail(
        `\`machdoch instructions ${action.replace("-", " ")}\` requires --path.`,
      );
    }
    if (action === "profile-create" && instructionSubject && rawSchedulerName) {
      fail("Use either a positional profile name or --name, not both.");
    }
    const instructionExpectedRevision = parseOptionalInteger(
      rawInstructionExpectedRevision,
      "--expected-revision",
    );
    if (
      instructionExpectedRevision !== undefined &&
      instructionExpectedRevision < 0
    ) {
      fail("--expected-revision must be zero or greater.");
    }

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "instructions",
      },
      {
        instructions: {
          action,
          ...(group ? { group } : {}),
          ...(instructionSubject ? { subject: instructionSubject } : {}),
          ...(instructionSecondarySubject
            ? { secondarySubject: instructionSecondarySubject }
            : {}),
          ...(rawSchedulerName ? { name: rawSchedulerName } : {}),
          ...(rawInstructionDescription !== undefined
            ? { description: rawInstructionDescription }
            : {}),
          ...(rawInstructionProfileIds && rawInstructionProfileIds.length > 0
            ? { profileIds: rawInstructionProfileIds }
            : {}),
          ...(instructionExpectedRevision === undefined
            ? {}
            : { expectedRevision: instructionExpectedRevision }),
          ...(rawInstructionExpectedDigest
            ? { expectedDigest: rawInstructionExpectedDigest }
            : {}),
          ...(rawInstructionSurface
            ? { surface: rawInstructionSurface as "api" | "cli" }
            : {}),
          ...(values?.["include-content"] === true
            ? { includeContent: true }
            : {}),
          ...(values?.["include-workspaces"] === true
            ? { includeWorkspaces: true }
            : {}),
          ...(rawInstructionDecisionsFile
            ? { decisionsFile: rawInstructionDecisionsFile }
            : {}),
          ...(values?.["confirm-assignment-removal"] === true
            ? { confirmAssignmentRemoval: true }
            : {}),
          ...(rawInstructionRalphFlow
            ? { ralphFlow: rawInstructionRalphFlow }
            : {}),
          ...(rawInstructionRalphFlowScope
            ? { ralphFlowScope: rawInstructionRalphFlowScope as RalphCliScope }
            : {}),
          ...(typeof values?.prompt === "string"
            ? { prompt: values.prompt }
            : {}),
          ...(rawSchedulerPromptFile
            ? { promptFile: rawSchedulerPromptFile }
            : {}),
          ...(rawInstructionPath ? { path: rawInstructionPath } : {}),
          ...(rawInstructionMetadataJson
            ? { metadataJson: rawInstructionMetadataJson }
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
        }),
      },
    );
  }

  if (first === "help") {
    if (quickRunRequested) {
      fail(
        "--quick can only be used with a task provided via --task or positional task text.",
      );
    }

    if (rest.length > 1) {
      fail("Usage: machdoch help [command]");
    }

    return createParsedArgs(
      {
        ...sharedOptions,
        command: "help",
      },
      rest[0] ? { helpTopic: rest[0] } : undefined,
    );
  }

  if (first === "memory") {
    if (quickRunRequested || rawTask) {
      fail("`machdoch memory` cannot be combined with --quick or --task.");
    }

    const [rawAction, ...extraPositionals] = rest;
    const action = normalizeOptionalString(rawAction) ?? "list";
    if (action !== "list") {
      fail("Unknown memory command. Expected `machdoch memory list`.");
    }
    if (extraPositionals.length > 0) {
      fail("Usage: machdoch memory [list] [--json]");
    }
    if (
      rawModel ||
      rawDefaultModel ||
      rawReasoning ||
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
        "`machdoch memory` cannot be combined with runtime override options.",
      );
    }

    return createParsedArgs({
      json,
      verbose,
      workspaceRoot,
      command: "memory",
    });
  }

  if (first === "inspect" || first === "tools") {
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

    const [rawSubcommand, setting, ...valueParts] = rest;
    const subcommand = rawSubcommand ?? "show";
    const configAction = subcommand === "interactive" ? "edit" : subcommand;

    if (
      !["show", "list", "get", "set", "unset", "edit"].includes(configAction)
    ) {
      fail(
        `Unknown config command \`${subcommand}\`. Expected show, list, get, set, unset, or edit.`,
      );
    }

    if (
      (configAction === "show" ||
        configAction === "list" ||
        configAction === "edit") &&
      (setting || valueParts.length > 0)
    ) {
      fail(`Usage: machdoch config ${configAction}`);
    }

    const configSetting =
      configAction === "get" ||
      configAction === "set" ||
      configAction === "unset"
        ? (normalizeOptionalString(setting) ??
          fail(
            `Expected \`machdoch config ${configAction} <setting>${configAction === "set" ? " <value>" : ""}\`.`,
          ))
        : undefined;
    const configValue =
      configAction === "set"
        ? (normalizeOptionalString(valueParts.join(" ")) ??
          fail("Expected `machdoch config set <setting> <value>`."))
        : undefined;

    if (
      (configAction === "get" || configAction === "unset") &&
      valueParts.length > 0
    ) {
      fail(`Usage: machdoch config ${configAction} <setting>`);
    }

    if (
      configAction !== "show" &&
      (rawModel ||
        rawDefaultModel ||
        rawReasoning ||
        rawRuntimeProvider ||
        rawMode ||
        sessionMemoryEnabled !== undefined ||
        globalMemoryEnabled !== undefined ||
        agentLimits ||
        rawConversationContextFile ||
        rawContextPaths ||
        rawImagePaths)
    ) {
      fail(
        `\`machdoch config ${configAction}\` cannot be combined with runtime override options.`,
      );
    }

    return createParsedArgs(
      {
        ...(configAction === "show"
          ? sharedOptions
          : { json, verbose, workspaceRoot }),
        command: "config",
      },
      {
        config: {
          action: configAction as
            | "show"
            | "list"
            | "get"
            | "set"
            | "unset"
            | "edit",
          ...(configSetting ? { setting: configSetting } : {}),
          ...(configValue ? { value: configValue } : {}),
        },
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
