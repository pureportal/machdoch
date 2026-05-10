import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";
import { normalizeOptionalString } from "../../common/_helpers/normalize-optional-string.js";
import type { UserApiProvider } from "../../core/env.js";
import type {
  ModelProvider,
  RuntimeAgentLimitOverrides,
  RunMode,
} from "../../core/types.js";

export type CommandName =
  | "run"
  | "chat"
  | "set-api"
  | "set-config"
  | "set-global-memory"
  | "inspect"
  | "config"
  | "tools"
  | "profiles"
  | "set-default-model"
  | "help";

export interface ParsedCliArgs {
  command: CommandName;
  task?: string;
  mode?: RunMode;
  profile?: string;
  provider?: UserApiProvider;
  runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
  key?: string;
  configSetting?: string;
  configValue?: string;
  model?: string;
  defaultModel?: string;
  sessionMemoryEnabled?: boolean;
  globalMemoryEnabled?: boolean;
  setGlobalMemoryEnabled?: boolean;
  agentLimits?: RuntimeAgentLimitOverrides;
  conversationContextFile?: string;
  contextPaths?: string[];
  imagePaths?: string[];
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
}

const VALID_MODES: ReadonlySet<RunMode> = new Set([
  "plan",
  "safe",
  "ask",
  "auto",
]);
const VALID_MODE_DESCRIPTION = "plan, safe, ask, or auto";
const VALID_PROVIDERS: ReadonlySet<UserApiProvider> = new Set([
  "openai",
  "anthropic",
  "google",
]);
const VALID_RUNTIME_PROVIDERS: ReadonlySet<
  Exclude<ModelProvider, "unconfigured">
> = new Set(["openai", "anthropic", "google"]);
const VALID_BOOLEAN_TOGGLE_VALUES: ReadonlySet<string> = new Set(["on", "off"]);
const VALID_MEMORY_OVERRIDE_VALUES: ReadonlySet<string> = new Set([
  "inherit",
  "on",
  "off",
]);
const COMMANDS_WITHOUT_POSITIONALS: ReadonlySet<CommandName> = new Set([
  "inspect",
  "config",
  "tools",
  "profiles",
  "help",
]);

const fail = (message: string): never => {
  throw new Error(message);
};

const createParsedArgs = (
  base: Omit<
    ParsedCliArgs,
    | "mode"
    | "profile"
    | "task"
    | "provider"
    | "runtimeProvider"
    | "key"
    | "configSetting"
    | "configValue"
    | "model"
    | "defaultModel"
    | "sessionMemoryEnabled"
    | "globalMemoryEnabled"
    | "setGlobalMemoryEnabled"
    | "agentLimits"
    | "conversationContextFile"
    | "contextPaths"
    | "imagePaths"
  >,
  options?: {
    mode?: RunMode;
    profile?: string;
    provider?: UserApiProvider;
    runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
    key?: string;
    configSetting?: string;
    configValue?: string;
    model?: string;
    defaultModel?: string;
    sessionMemoryEnabled?: boolean;
    globalMemoryEnabled?: boolean;
    setGlobalMemoryEnabled?: boolean;
    agentLimits?: RuntimeAgentLimitOverrides;
    conversationContextFile?: string;
    contextPaths?: string[];
    imagePaths?: string[];
    task?: string;
  },
): ParsedCliArgs => {
  return {
    ...base,
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(options?.profile ? { profile: options.profile } : {}),
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(options?.runtimeProvider
      ? { runtimeProvider: options.runtimeProvider }
      : {}),
    ...(options?.key ? { key: options.key } : {}),
    ...(options?.configSetting ? { configSetting: options.configSetting } : {}),
    ...(options?.configValue ? { configValue: options.configValue } : {}),
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options?.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: options.sessionMemoryEnabled }
      : {}),
    ...(options?.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: options.globalMemoryEnabled }
      : {}),
    ...(options?.setGlobalMemoryEnabled !== undefined
      ? { setGlobalMemoryEnabled: options.setGlobalMemoryEnabled }
      : {}),
    ...(options?.agentLimits ? { agentLimits: options.agentLimits } : {}),
    ...(options?.conversationContextFile
      ? { conversationContextFile: options.conversationContextFile }
      : {}),
    ...(options?.contextPaths && options.contextPaths.length > 0
      ? { contextPaths: options.contextPaths }
      : {}),
    ...(options?.imagePaths && options.imagePaths.length > 0
      ? { imagePaths: options.imagePaths }
      : {}),
    ...(options?.task ? { task: options.task } : {}),
  };
};

const createSharedParsedOptions = (options: {
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
  mode?: RunMode;
  profile?: string;
  runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
  model?: string;
  defaultModel?: string;
  sessionMemoryEnabled?: boolean;
  globalMemoryEnabled?: boolean;
  agentLimits?: RuntimeAgentLimitOverrides;
  conversationContextFile?: string;
  contextPaths?: string[];
  imagePaths?: string[];
}): Omit<ParsedCliArgs, "command" | "task"> => {
  return {
    json: options.json,
    verbose: options.verbose,
    workspaceRoot: options.workspaceRoot,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.runtimeProvider
      ? { runtimeProvider: options.runtimeProvider }
      : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: options.sessionMemoryEnabled }
      : {}),
    ...(options.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: options.globalMemoryEnabled }
      : {}),
    ...(options.agentLimits ? { agentLimits: options.agentLimits } : {}),
    ...(options.conversationContextFile
      ? { conversationContextFile: options.conversationContextFile }
      : {}),
    ...(options.contextPaths && options.contextPaths.length > 0
      ? { contextPaths: options.contextPaths }
      : {}),
    ...(options.imagePaths && options.imagePaths.length > 0
      ? { imagePaths: options.imagePaths }
      : {}),
  };
};

const parseBooleanToggle = (value: string, flagName: string): boolean => {
  if (!VALID_BOOLEAN_TOGGLE_VALUES.has(value)) {
    fail(`Expected ${flagName} to be followed by on or off.`);
  }

  return value === "on";
};

const parseMemoryOverride = (
  value: string,
  flagName: string,
): boolean | undefined => {
  if (!VALID_MEMORY_OVERRIDE_VALUES.has(value)) {
    fail(`Expected ${flagName} to be followed by inherit, on, or off.`);
  }

  if (value === "inherit") {
    return undefined;
  }

  return value === "on";
};

const parsePositiveInteger = (value: string, flagName: string): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    fail(`Expected ${flagName} to be followed by a positive integer.`);
  }

  return parsed;
};

const normalizeContextPaths = (
  values: string[] | undefined,
): string[] | undefined => {
  if (values === undefined) {
    return undefined;
  }

  const normalizedPaths = values.flatMap((value) => {
    const normalized = normalizeOptionalString(value);

    return normalized ? [normalized] : [];
  });

  if (normalizedPaths.length === 0) {
    fail("Expected --context to be followed by a file or folder path.");
  }

  return Array.from(new Set(normalizedPaths));
};

const normalizeImagePaths = (
  values: string[] | undefined,
): string[] | undefined => {
  if (values === undefined) {
    return undefined;
  }

  const normalizedPaths = values.flatMap((value) => {
    const normalized = normalizeOptionalString(value);

    return normalized ? [normalized] : [];
  });

  if (normalizedPaths.length === 0) {
    fail("Expected --image to be followed by an image file path.");
  }

  return Array.from(new Set(normalizedPaths));
};

const assertNoAdditionalPositionals = (
  command: CommandName,
  positionals: string[],
): void => {
  if (positionals.length === 0 || !COMMANDS_WITHOUT_POSITIONALS.has(command)) {
    return;
  }

  fail(
    `Command \`${command}\` does not accept positional arguments: ${positionals.join(" ")}`,
  );
};

export const getHelpText = (): string => {
  return `machdoch

Usage:
  machdoch [--mode <plan|safe|ask|auto>]
  machdoch <task>
  machdoch --task <task> [--mode <plan|safe|ask|auto>]
  machdoch run <task>
  machdoch --quick --task <task> [--mode <plan|safe|ask|auto>]
  machdoch --set-api --provider <openai|anthropic|google> --key <value>
  machdoch --set-global-memory <on|off>
  machdoch --runtime-provider <openai|anthropic|google>
  machdoch --model <name>
  machdoch --default-model <name>
  machdoch inspect [--json]
  machdoch config [--json]
  machdoch config set <setting> <value> [--json]
  machdoch tools [--json]
  machdoch profiles [--json]

Options:
  --mode <plan|safe|ask|auto>
                          Override the runtime mode for this command or chat session.
  --quick                 Force a one-shot task run that exits at a terminal state. Use --mode to choose plan, safe, ask, or auto.
  --set-api               Save a provider API key into the user-scoped Machdoch config file.
  --provider <name>       Provider name for --set-api (openai, anthropic, google).
  --runtime-provider <name>
                          Override the runtime provider for this command or chat session.
  --key <value>           API key value for --set-api.
  --task <text>           Provide the task text explicitly instead of positionals.
  --model <name>          Override the active model for this run or chat session.
  --default-model <name>  Persist the workspace default model to .machdoch/config.json.
  --set-global-memory <on|off>
                          Persist whether cross-session global memory is enabled.
  --session-memory <on|off>
                          Enable or disable per-session memory for this run or chat session.
  --global-memory <inherit|on|off>
                          Override cross-session global memory for this run or chat session.
  --executor-turns <count>
                          Override the per-executor model turn limit.
  --autopilot-iterations <count>
                          Override the Autopilot continuation limit.
  --infinite              Disable executor turn and Autopilot iteration limits. The wall-clock safety timeout still applies.
  --conversation-context-file <path>
                          Load conversation history and memory context from a JSON file.
  --context <path>        Add a file or folder path as task context. Repeat for multiple paths.
  --image <path>          Attach an image for a vision-capable model to read. Repeat for multiple images.
  --profile <name>        Use a named profile from .machdoch/config.json.
  --cwd <path>            Use a different workspace root.
  --json                  Print machine-readable JSON.
  --verbose, -v           Print compact progress updates during \`machdoch run\`.
  -h, --help              Show help.

Config settings accepted by \`machdoch config set\`:
  api.<openai|anthropic|google>.key
  web-search.provider
  web-search.<perplexity|tavily|serper>.key
  voice.provider
  speech-to-text.<provider|input-device>
  desktop.<setting>
  memory.global
  agent-limits.<infinite|executor-turns|autopilot-iterations>
  workspace.<model|provider|mode|offline>

Default CLI mode is interactive and keeps running until /exit, /quit, or Ctrl+C.
\`machdoch <task>\` and \`machdoch --task <text>\` start interactive chat with an initial task.
Use \`/paste\` in interactive chat to submit multiline task text; finish with a line containing only \`/end\`.
Use \`machdoch run <task>\` or \`machdoch --quick --task <text>\` for one-shot execution that exits.
During a task run, press Ctrl+C to request cancellation after the current execution step.
`;
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

  if (values?.mode !== undefined && !rawMode) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  if (rawMode && !VALID_MODES.has(rawMode as RunMode)) {
    fail(`Expected --mode to be followed by ${VALID_MODE_DESCRIPTION}.`);
  }

  if (values?.profile !== undefined && !rawProfile) {
    fail("Expected --profile to be followed by a profile name.");
  }

  if (values?.provider !== undefined && !rawProvider) {
    fail("Expected --provider to be followed by openai, anthropic, or google.");
  }

  if (values?.["runtime-provider"] !== undefined && !rawRuntimeProvider) {
    fail(
      "Expected --runtime-provider to be followed by openai, anthropic, or google.",
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
      "Expected --runtime-provider to be followed by openai, anthropic, or google.",
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
