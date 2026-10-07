import {
  createInstructionCliOptions,
  validateInstructionFlowOptions,
  validateInstructionCommand,
} from "./create-instruction-cli-options.helper.js";
import { createRalphCliOptions } from "./create-ralph-cli-options.helper.js";
import {
  createMcpCliOptions,
  validateMcpCommand,
} from "./create-mcp-cli-options.helper.js";
import {
  createFleetCliOptions,
  validateFleetEnrollmentCommand,
} from "./create-fleet-cli-options.helper.js";
import { tokenizeCliArgs, type CliTokenValues } from "./cli-token-options.js";
import process from "node:process";
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
  PROVIDER_SYNC_ACTIONS,
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
  ProviderSyncCliAction,
  ParsedCliArgs,
  SchedulerCliAction,
  TaskInterviewCliOptions,
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

  let values: CliTokenValues | undefined;
  let positionals: string[] = [];

  try {
    const parsed = tokenizeCliArgs(argv);
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const json = values?.json === true;
  const verbose = values?.verbose === true;
  if (values?.check && positionals[0] !== "update")
    fail("--check is only valid for machdoch update.");
  const quickRunRequested = values?.quick === true;
  const workspaceRoot =
    normalizeOptionalString(values?.cwd) ??
    normalizeOptionalString(currentWorkingDirectory) ??
    fail("Expected --cwd to be followed by a path.");

  const rawMode = normalizeOptionalString(values?.mode);
  const rawProvider = normalizeOptionalString(values?.provider);
  const isProviderSyncCommand = positionals[0] === "provider-sync";
  const rawRuntimeProvider = normalizeOptionalString(
    values?.["runtime-provider"],
  );
  validateFleetEnrollmentCommand(positionals[0], values);
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
  const rawRalphInputJson = normalizeOptionalString(values?.["input-json"]);
  const rawRalphInputJsonFile = normalizeOptionalString(
    values?.["input-json-file"],
  );
  const rawRalphMaxRounds = normalizeOptionalString(values?.["max-rounds"]);
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

  if (values?.mode !== undefined && !rawMode) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  if (rawMode && !VALID_MODES.has(rawMode as RunMode)) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  validateInstructionFlowOptions(values);

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

  if (
    rawTask &&
    positionals.length > 0 &&
    !(positionals.length === 1 && ["run", "chat"].includes(positionals[0]!))
  ) {
    fail("Use either positional task text or --task, not both.");
  }

  if (
    deterministicAction &&
    !(
      (quickRunRequested && rawTask) ||
      (positionals[0] === "run" && (positionals.length > 1 || rawTask))
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

  validateMcpCommand(first!, values?.apply === true);

  validateInstructionCommand(first!, values);

  if (first === "media-flow-agent") {
    assertNoAdditionalPositionals(first, rest);
    if (
      quickRunRequested ||
      rawTask ||
      rawRalphInputJson ||
      !rawRalphInputJsonFile
    ) {
      fail("`machdoch media-flow-agent` expects --input-json-file.");
    }
    return {
      ...sharedOptions,
      command: "media-flow-agent",
      mediaFlowAgent: {
        inputJsonFile:
          rawRalphInputJsonFile ?? fail("Missing --input-json-file."),
      },
    };
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
    return createParsedArgs(
      { json, verbose, workspaceRoot, command: "fleet" },
      {
        fleet: createFleetCliOptions({
          rest,
          quickRunRequested,
          rawTask,
          values,
          runtimeOverridesProvided: Boolean(
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
            rawImagePaths,
          ),
        }),
      },
    );
  }

  if (first === "mcp") {
    return createParsedArgs(
      { ...sharedOptions, command: "mcp" },
      {
        mcp: createMcpCliOptions({ rest, quickRunRequested, rawTask, values }),
      },
    );
  }

  if (first === "ralph") {
    return createParsedArgs(
      { ...sharedOptions, command: "ralph" },
      {
        ralph: createRalphCliOptions({
          rest,
          quickRunRequested,
          rawTask,
          values,
        }),
      },
    );
  }

  if (first === "instructions") {
    return createParsedArgs(
      { ...sharedOptions, command: "instructions" },
      {
        instructions: createInstructionCliOptions({
          rest,
          quickRunRequested,
          rawTask,
          values,
          suppliedOptionNames: Object.keys(values ?? {}),
        }),
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

  if (first === "update") {
    if (rest.length || quickRunRequested || rawTask)
      fail("Usage: machdoch update [--check] [--json]");
    return {
      command: "update",
      workspaceRoot,
      json,
      verbose,
      update: { check: values?.check === true },
    };
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
    if (action !== "list" && action !== "forget") {
      fail(
        "Unknown memory command. Use `machdoch memory list` or `machdoch memory forget <workspace|global> <id>`.",
      );
    }
    if (action === "list" && extraPositionals.length > 0) {
      fail("Usage: machdoch memory [list] [--json]");
    }
    if (
      action === "forget" &&
      (extraPositionals.length !== 2 ||
        !["workspace", "global"].includes(extraPositionals[0] ?? "") ||
        !extraPositionals[1]?.trim())
    ) {
      fail("Usage: machdoch memory forget <workspace|global> <id>");
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

    return {
      json,
      verbose,
      workspaceRoot,
      command: "memory",
      ...(action === "forget"
        ? {
            memory: {
              action,
              scope: extraPositionals[0] as "workspace" | "global",
              id: extraPositionals[1]!,
            },
          }
        : {}),
    };
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

  if (first === "chat") {
    if (quickRunRequested)
      fail("Use `machdoch run <task>` for a one-shot task.");
    const task = rawTask ?? rest.join(" ").trim();
    return createParsedArgs(
      { ...sharedOptions, command: "chat" },
      task ? { task } : undefined,
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
