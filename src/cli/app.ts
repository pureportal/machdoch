import { readFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import { normalizeOptionalString } from "../common/_helpers/normalize-optional-string.js";
import {
  loadRuntimeConfig,
  saveWorkspaceDefaultModel,
} from "../core/config.js";
import { discoverCustomizations } from "../core/customizations.js";
import {
  loadUserMemorySettings,
  saveUserApiKey,
  saveUserGlobalMemoryEnabled,
  type UserApiProvider,
} from "../core/env.js";
import { createTaskExecutionController } from "../core/execution.js";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../core/memory.js";
import { resolveToolPolicies } from "../core/policy.js";
import { previewTaskRun } from "../core/task-runner.js";
import { getToolRegistry } from "../core/tools.js";
import type {
  ConversationHistoryEntry,
  ConversationMemoryEntry,
  ModelProvider,
  RunMode,
  TaskConversationContext,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskRunPreview,
} from "../core/types.js";
import {
  createBodyPreviewLines,
  createDiscoveryOptions,
  formatExecutionProgressLines,
  formatProfileLine,
} from "./_helpers/cli-output.js";

export type CommandName =
  | "run"
  | "chat"
  | "set-api"
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
  model?: string;
  defaultModel?: string;
  sessionMemoryEnabled?: boolean;
  globalMemoryEnabled?: boolean;
  setGlobalMemoryEnabled?: boolean;
  conversationContextFile?: string;
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
}

const VALID_MODES: ReadonlySet<RunMode> = new Set(["safe", "ask", "auto"]);
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
    | "model"
    | "defaultModel"
    | "sessionMemoryEnabled"
    | "globalMemoryEnabled"
    | "setGlobalMemoryEnabled"
    | "conversationContextFile"
  >,
  options?: {
    mode?: RunMode;
    profile?: string;
    provider?: UserApiProvider;
    runtimeProvider?: Exclude<ModelProvider, "unconfigured">;
    key?: string;
    model?: string;
    defaultModel?: string;
    sessionMemoryEnabled?: boolean;
    globalMemoryEnabled?: boolean;
    setGlobalMemoryEnabled?: boolean;
    conversationContextFile?: string;
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
    ...(options?.conversationContextFile
      ? { conversationContextFile: options.conversationContextFile }
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
  conversationContextFile?: string;
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
    ...(options.conversationContextFile
      ? { conversationContextFile: options.conversationContextFile }
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
  machdoch <task>
  machdoch run <task>
  machdoch --quick --task <task> [--mode <safe|ask|auto>]
  machdoch --set-api --provider <openai|anthropic|google> --key <value>
  machdoch --set-global-memory <on|off>
  machdoch --runtime-provider <openai|anthropic|google>
  machdoch --task <task> [--mode <safe|ask|auto>] [--quick] [--model <name>]
  machdoch --model <name>
  machdoch --default-model <name>
  machdoch inspect [--json]
  machdoch config [--json]
  machdoch tools [--json]
  machdoch profiles [--json]

Options:
  --mode <safe|ask|auto>  Override the runtime mode for this command.
  --quick                 Force a one-shot task run that exits at a terminal state. Use --mode to choose safe, ask, or auto.
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
  --profile <name>        Use a named profile from .machdoch/config.json.
  --cwd <path>            Use a different workspace root.
  --json                  Print machine-readable JSON.
  --verbose, -v           Print execution-state progress during \`machdoch run\`.
  -h, --help              Show help.

During \`machdoch run\`, press Ctrl+C to request cancellation after the current execution step.
Interactive chat mode starts when no task is provided but runtime options such as --model are set.
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
        "conversation-context-file"?: string;
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
        "conversation-context-file": { type: "string" },
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
    normalizeOptionalString(values?.cwd) ?? currentWorkingDirectory;

  if (workspaceRoot.trim().length === 0) {
    fail("Expected --cwd to be followed by a path.");
  }

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
  const rawSetGlobalMemory = normalizeOptionalString(
    values?.["set-global-memory"],
  );
  const rawConversationContextFile = normalizeOptionalString(
    values?.["conversation-context-file"],
  );
  const rawProfile = normalizeOptionalString(values?.profile);

  if (values?.mode !== undefined && !rawMode) {
    fail("Expected --mode to be followed by safe, ask, or auto.");
  }

  if (rawMode && !VALID_MODES.has(rawMode as RunMode)) {
    fail("Expected --mode to be followed by safe, ask, or auto.");
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

  if (rawTask && positionals.length > 0) {
    fail("Use either positional task text or --task, not both.");
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
      rawConversationContextFile
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
    ...(rawConversationContextFile
      ? { conversationContextFile: rawConversationContextFile }
      : {}),
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
      rawConversationContextFile
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
          command: "run",
        },
        { task: rawTask },
      );
    }

    if (quickRunRequested) {
      fail(
        "--quick can only be used with a task provided via --task or positional task text.",
      );
    }

    if (
      rawModel ||
      resolvedMode ||
      rawProfile ||
      rawRuntimeProvider ||
      sessionMemoryEnabled !== undefined ||
      rawGlobalMemory
    ) {
      return createParsedArgs({
        ...sharedOptions,
        command: "chat",
      });
    }

    return createParsedArgs({
      ...sharedOptions,
      command: "help",
    });
  }

  const [first, ...rest] = positionals;

  if (
    first === "inspect" ||
    first === "config" ||
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
      command: "run",
    },
    { task },
  );
};

export { formatExecutionProgressLines } from "./_helpers/cli-output.js";

const createVerboseProgressReporter = (
  writeLine: (line: string) => void,
): TaskExecutionProgressHandler => {
  let previousSnapshotKey = "";

  return (progress): void => {
    const snapshotKey = [
      progress.state,
      progress.message,
      progress.reason ?? "",
      progress.executedTools.join(","),
    ].join("|");

    if (snapshotKey === previousSnapshotKey) {
      return;
    }

    previousSnapshotKey = snapshotKey;

    for (const line of formatExecutionProgressLines(progress)) {
      writeLine(`machdoch: ${line}`);
    }
  };
};


const writeStdoutLine = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const writeStderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const attachCancellationHandlers = (
  controller: { cancel(reason?: string): void },
  options: { json: boolean },
): (() => void) => {
  let cancellationRequested = false;

  const requestCancellation = (signalName: NodeJS.Signals): void => {
    if (cancellationRequested) {
      process.exitCode = 130;
      return;
    }

    cancellationRequested = true;
    controller.cancel(`${signalName} received. Execution cancelled by user.`);

    if (!options.json) {
      writeStderrLine(
        "machdoch: cancellation requested; stopping after the current execution step.",
      );
    }
  };

  const handleSigint = (): void => {
    requestCancellation("SIGINT");
  };
  const handleSigterm = (): void => {
    requestCancellation("SIGTERM");
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  return (): void => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };
};

/**
 * Prints a task execution result in the CLI's human-readable summary format.
 */
const printExecutionSummary = (execution: TaskExecutionResult): void => {
  writeStdoutLine(`task: ${execution.task}`);
  writeStdoutLine(`mode: ${execution.mode}`);
  writeStdoutLine(`execution status: ${execution.status}`);
  writeStdoutLine(`summary: ${execution.summary}`);
  writeStdoutLine(
    `executed tools: ${execution.executedTools.length > 0 ? execution.executedTools.join(", ") : "none"}`,
  );

  if (execution.reason) {
    writeStdoutLine(`reason: ${execution.reason}`);
  }

  if (execution.autopilot) {
    writeStdoutLine(
      `autopilot: executor iterations=${execution.autopilot.executorIterations}, validator passes=${execution.autopilot.validatorPasses}, continuation requests=${execution.autopilot.continuationCount}`,
    );
  }

  for (const section of execution.outputSections) {
    writeStdoutLine(`${section.title.toLowerCase()}:`);
    for (const line of section.lines) {
      writeStdoutLine(`  - ${line}`);
    }
  }
};

/**
 * Prints the resolved runtime configuration.
 */
const printConfigSummary = async (args: ParsedCliArgs): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const memorySettings = await loadUserMemorySettings();

  if (args.json) {
    writeStdoutLine(JSON.stringify(config, null, 2));
    return;
  }

  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`provider: ${config.provider}`);
  writeStdoutLine(`model: ${config.model}`);
  writeStdoutLine(`offline: ${config.offline ? "true" : "false"}`);
  writeStdoutLine(`enabled tools: ${config.enabledTools.join(", ")}`);
  writeStdoutLine(`web search provider: ${config.webSearch.activeProvider}`);
  writeStdoutLine(
    `web search status: ${activeWebSearchConfigured ? "available" : "hidden"}`,
  );
  writeStdoutLine(
    `global memory: ${memorySettings.globalEnabled ? "enabled" : "disabled"} (${memorySettings.entries.length} saved fact${memorySettings.entries.length === 1 ? "" : "s"})`,
  );
  if (config.availableProfiles.length > 0) {
    writeStdoutLine("profiles:");
    for (const profile of config.availableProfiles) {
      writeStdoutLine(formatProfileLine(profile, config.activeProfile));
    }
  }
  writeStdoutLine("provider availability:");

  for (const entry of config.providerAvailability) {
    writeStdoutLine(
      `  - ${entry.provider}: ${entry.configured ? "configured" : "not configured"}`,
    );
  }
};

/**
 * Prints discovered instruction, prompt, and skill customizations.
 */
const printCustomizationSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const customizations = await discoverCustomizations(
    args.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );

  if (args.json) {
    writeStdoutLine(JSON.stringify(customizations, null, 2));
    return;
  }

  writeStdoutLine(`workspace: ${customizations.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(
    `github compatibility: ${config.compatibility.discoverGithubCustomizations ? "enabled" : "disabled"}`,
  );
  writeStdoutLine(`instructions: ${customizations.instructions.length}`);
  for (const entry of customizations.instructions) {
    writeStdoutLine(`  - [${entry.kind}] ${entry.path}`);
  }
  writeStdoutLine(`prompts: ${customizations.prompts.length}`);
  for (const entry of customizations.prompts) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
  writeStdoutLine(`skills: ${customizations.skills.length}`);
  for (const entry of customizations.skills) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
};

/**
 * Prints tool registration and the resolved policy for each available tool.
 */
const printToolSummary = async (args: ParsedCliArgs): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const toolPolicies = resolveToolPolicies(config);

  if (args.json) {
    writeStdoutLine(JSON.stringify(toolPolicies, null, 2));
    return;
  }

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`registered tools: ${getToolRegistry().length}`);

  for (const policy of toolPolicies) {
    writeStdoutLine(
      `- ${policy.tool.name} [${policy.tool.riskLevel}] -> ${policy.decision}`,
    );
    writeStdoutLine(`  ${policy.tool.description}`);
    writeStdoutLine(`  ${policy.reason}`);
  }
};

/**
 * Prints the active profile and the list of discovered named profiles.
 */
const printProfileSummary = async (args: ParsedCliArgs): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: config.workspaceRoot,
          activeProfile: config.activeProfile ?? null,
          availableProfiles: config.availableProfiles,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`active profile: ${config.activeProfile ?? "none"}`);

  if (config.availableProfiles.length === 0) {
    writeStdoutLine("profiles: none configured");
    return;
  }

  writeStdoutLine("profiles:");
  for (const profile of config.availableProfiles) {
    writeStdoutLine(formatProfileLine(profile, config.activeProfile));
  }
};

/**
 * Executes a supported task directly when possible or prints the staged preview
 * fallback when live execution is unavailable.
 */
const loadConversationContextFromFile = async (
  filePath: string,
): Promise<TaskConversationContext> => {
  const raw = await readFile(filePath, "utf8");

  return JSON.parse(raw) as TaskConversationContext;
};

const resolveConversationContext = async (
  args: ParsedCliArgs,
  explicitContext?: TaskConversationContext,
): Promise<TaskConversationContext | undefined> => {
  const baseContext =
    explicitContext ??
    (args.conversationContextFile
      ? await loadConversationContextFromFile(args.conversationContextFile)
      : undefined);

  if (
    !baseContext &&
    args.sessionMemoryEnabled === undefined &&
    args.globalMemoryEnabled === undefined
  ) {
    return undefined;
  }

  return {
    history: baseContext?.history ?? [],
    ...(baseContext?.sessionMemory !== undefined
      ? { sessionMemory: baseContext.sessionMemory }
      : {}),
    ...(baseContext?.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: baseContext.sessionMemoryEnabled }
      : {}),
    ...(baseContext?.globalMemory !== undefined
      ? { globalMemory: baseContext.globalMemory }
      : {}),
    ...(baseContext?.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: baseContext.globalMemoryEnabled }
      : {}),
    ...(args.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: args.sessionMemoryEnabled }
      : {}),
    ...(args.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: args.globalMemoryEnabled }
      : {}),
  };
};

const printTaskPreview = async (
  args: ParsedCliArgs,
  options?: {
    conversationContext?: TaskConversationContext;
  },
): Promise<{
  execution: TaskExecutionResult;
  preview?: TaskRunPreview;
}> => {
  const task = args.task ?? fail("No task was provided.");
  const conversationContext = await resolveConversationContext(
    args,
    options?.conversationContext,
  );

  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const customizations = await discoverCustomizations(
    args.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );
  const controller = createTaskExecutionController(
    task,
    config,
    customizations,
    {
      ...(args.verbose
        ? {
            onStateChange: createVerboseProgressReporter(writeStderrLine),
          }
        : {}),
      ...(conversationContext ? { conversationContext } : {}),
    },
  );
  const detachCancellationHandlers = attachCancellationHandlers(controller, {
    json: args.json,
  });

  let execution: TaskExecutionResult;

  try {
    execution = await controller.execute();
  } finally {
    detachCancellationHandlers();
  }

  if (execution.status === "cancelled") {
    process.exitCode = 130;
  }

  if (execution.status === "executed" || execution.status === "cancelled") {
    if (args.json) {
      writeStdoutLine(JSON.stringify({ execution }, null, 2));
      return { execution };
    }

    writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
    printExecutionSummary(execution);
    return { execution };
  }

  const preview = previewTaskRun(task, config, customizations);

  if (args.json) {
    writeStdoutLine(JSON.stringify({ execution, preview }, null, 2));
    return { execution, preview };
  }

  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  printExecutionSummary(execution);
  writeStdoutLine();

  writeStdoutLine(`task: ${preview.task}`);
  writeStdoutLine(`mode: ${preview.mode}`);
  writeStdoutLine(`summary: ${preview.summary}`);
  writeStdoutLine(`suggested tools: ${preview.suggestedTools.join(", ")}`);
  writeStdoutLine(
    `blocked tools: ${preview.blockedTools.length > 0 ? preview.blockedTools.join(", ") : "none"}`,
  );
  writeStdoutLine(
    `customizations: ${preview.customizationCounts.instructions} instruction(s), ${preview.customizationCounts.prompts} prompt(s), ${preview.customizationCounts.skills} skill(s)`,
  );
  writeStdoutLine("tool policy:");
  for (const policy of preview.toolPolicies) {
    writeStdoutLine(
      `  - ${policy.tool.name} [${policy.tool.riskLevel}] -> ${policy.decision}`,
    );
  }

  if (preview.invokedPrompt) {
    writeStdoutLine("invoked prompt:");
    writeStdoutLine(
      `  - ${preview.invokedPrompt.name} (${preview.invokedPrompt.path})`,
    );

    if (preview.invokedPrompt.description) {
      writeStdoutLine(`    ${preview.invokedPrompt.description}`);
    }

    writeStdoutLine(
      `    arguments: ${preview.invokedPrompt.arguments.length > 0 ? preview.invokedPrompt.arguments : "none"}`,
    );

    if (preview.invokedPrompt.agent) {
      writeStdoutLine(`    agent: ${preview.invokedPrompt.agent}`);
    }

    if (preview.invokedPrompt.model) {
      writeStdoutLine(`    model: ${preview.invokedPrompt.model}`);
    }

    if (preview.invokedPrompt.tools.length > 0) {
      writeStdoutLine(`    tools: ${preview.invokedPrompt.tools.join(", ")}`);
    }

    if (preview.invokedPrompt.expectedInputs.length > 0) {
      writeStdoutLine(
        `    inputs: ${preview.invokedPrompt.expectedInputs.join(", ")}`,
      );
    }

    const resolvedInputEntries = Object.entries(
      preview.invokedPrompt.inputValues,
    );

    if (resolvedInputEntries.length > 0) {
      writeStdoutLine("    resolved inputs:");

      for (const [name, value] of resolvedInputEntries) {
        writeStdoutLine(`      ${name}=${value}`);
      }
    }

    if (preview.invokedPrompt.missingInputs.length > 0) {
      writeStdoutLine(
        `    missing inputs: ${preview.invokedPrompt.missingInputs.join(", ")}`,
      );
    }

    const promptBodyPreviewLines = createBodyPreviewLines(
      preview.invokedPrompt.resolvedBody,
    );

    if (promptBodyPreviewLines.length > 0) {
      writeStdoutLine("    resolved body preview:");

      for (const line of promptBodyPreviewLines) {
        writeStdoutLine(`      ${line}`);
      }
    }
  }

  if (preview.applicableInstructions.length > 0) {
    writeStdoutLine("applicable instructions:");
    for (const instruction of preview.applicableInstructions) {
      const prioritySuffix =
        instruction.priority !== 0 ? ` [priority ${instruction.priority}]` : "";

      writeStdoutLine(
        `  - ${instruction.name} (${instruction.path})${prioritySuffix}`,
      );
      writeStdoutLine(`    ${instruction.reason}`);

      const instructionBodyPreviewLines = createBodyPreviewLines(
        instruction.body,
        4,
      );

      if (instructionBodyPreviewLines.length > 0) {
        writeStdoutLine("    body preview:");

        for (const line of instructionBodyPreviewLines) {
          writeStdoutLine(`      ${line}`);
        }
      }
    }
  }

  if (preview.suggestedPrompts.length > 0) {
    writeStdoutLine("suggested prompts:");
    for (const prompt of preview.suggestedPrompts) {
      writeStdoutLine(`  - ${prompt.name} (${prompt.path})`);
      writeStdoutLine(`    ${prompt.reason}`);
    }
  }

  if (preview.suggestedSkills.length > 0) {
    writeStdoutLine("suggested skills:");
    for (const skill of preview.suggestedSkills) {
      writeStdoutLine(`  - ${skill.name} (${skill.path})`);
      writeStdoutLine(`    ${skill.reason}`);
    }
  }

  if (preview.warnings.length > 0) {
    writeStdoutLine("warnings:");
    for (const warning of preview.warnings) {
      writeStdoutLine(`  - ${warning}`);
    }
  }

  if (preview.notes.length > 0) {
    writeStdoutLine("notes:");
    for (const note of preview.notes) {
      writeStdoutLine(`  - ${note}`);
    }
  }

  writeStdoutLine("plan:");
  preview.steps.forEach((step, index) => {
    writeStdoutLine(`  ${index + 1}. ${step.title}`);
    writeStdoutLine(`     ${step.description}`);
  });

  return { execution, preview };
};

const printDefaultModelSummary = async (args: ParsedCliArgs): Promise<void> => {
  const model = args.defaultModel ?? fail("No default model was provided.");
  const configPath = await saveWorkspaceDefaultModel(args.workspaceRoot, model);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: args.workspaceRoot,
          configPath,
          model,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`workspace: ${args.workspaceRoot}`);
  writeStdoutLine(`updated config: ${configPath}`);
  writeStdoutLine(`default model: ${model}`);
};

const printSetApiSummary = async (args: ParsedCliArgs): Promise<void> => {
  const provider = args.provider ?? fail("No provider was provided.");
  const key = args.key ?? fail("No API key was provided.");
  const configPath = await saveUserApiKey(provider, key);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          provider,
          configured: true,
          configPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`provider: ${provider}`);
  writeStdoutLine(`updated user config: ${configPath}`);
  writeStdoutLine("status: configured");
};

const printSetGlobalMemorySummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const enabled =
    args.setGlobalMemoryEnabled ??
    fail("No global-memory setting was provided.");
  const configPath = await saveUserGlobalMemoryEnabled(enabled);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          globalMemoryEnabled: enabled,
          configPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`updated user config: ${configPath}`);
  writeStdoutLine(`global memory: ${enabled ? "enabled" : "disabled"}`);
};

const printInteractiveChatHelp = (): void => {
  writeStdoutLine("interactive commands:");
  writeStdoutLine("  /help  Show this help");
  writeStdoutLine("  /exit  Leave interactive mode");
  writeStdoutLine("  /quit  Leave interactive mode");
};

const runInteractiveChat = async (args: ParsedCliArgs): Promise<void> => {
  if (args.json) {
    fail("Interactive chat mode does not support --json.");
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Interactive chat mode requires an interactive terminal.");
  }

  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const memorySettings = await loadUserMemorySettings();
  const sessionState: {
    history: ConversationHistoryEntry[];
    sessionMemory: ConversationMemoryEntry[];
    sessionMemoryEnabled: boolean;
    globalMemoryEnabled?: boolean;
  } = {
    history: [],
    sessionMemory: [],
    sessionMemoryEnabled: args.sessionMemoryEnabled ?? true,
    ...(args.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: args.globalMemoryEnabled }
      : {}),
  };
  const effectiveGlobalMemoryEnabled =
    sessionState.globalMemoryEnabled ?? memorySettings.globalEnabled;

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`model: ${config.model}`);
  writeStdoutLine(
    `session memory: ${sessionState.sessionMemoryEnabled ? "enabled" : "disabled"}`,
  );
  writeStdoutLine(
    `global memory: ${effectiveGlobalMemoryEnabled ? "enabled" : "disabled"}`,
  );
  writeStdoutLine("Type a task and press Enter. Use /exit to quit.");
  printInteractiveChatHelp();
  writeStdoutLine();

  const interfaceHandle = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const nextTask = (await interfaceHandle.question("machdoch> ")).trim();

      if (nextTask.length === 0) {
        continue;
      }

      if (
        nextTask === "/exit" ||
        nextTask === "exit" ||
        nextTask === "/quit" ||
        nextTask === "quit"
      ) {
        break;
      }

      if (nextTask === "/help") {
        printInteractiveChatHelp();
        writeStdoutLine();
        continue;
      }

      const { execution } = await printTaskPreview(
        {
          ...args,
          command: "run",
          task: nextTask,
        },
        {
          conversationContext: {
            history: sessionState.history,
            sessionMemory: sessionState.sessionMemory,
            sessionMemoryEnabled: sessionState.sessionMemoryEnabled,
            ...(sessionState.globalMemoryEnabled !== undefined
              ? { globalMemoryEnabled: sessionState.globalMemoryEnabled }
              : {}),
          },
        },
      );

      const assistantContent =
        execution.response?.markdown.trim() || execution.summary.trim();

      sessionState.history = [
        ...sessionState.history,
        {
          role: "user" as const,
          content: nextTask,
          createdAt: Date.now(),
        },
        {
          role: "assistant" as const,
          content: assistantContent,
          createdAt: Date.now(),
        },
      ].slice(-60);

      const sessionMemoryUpdates =
        execution.memoryUpdates
          ?.filter((update) => update.scope === "session")
          .map((update) => update.entry) ?? [];

      if (sessionMemoryUpdates.length > 0) {
        sessionState.sessionMemory = mergeConversationMemoryEntries(
          sessionState.sessionMemory,
          sessionMemoryUpdates,
          MAX_SESSION_MEMORY_ENTRIES,
        );
      }

      writeStdoutLine();
    }
  } finally {
    interfaceHandle.close();
  }
};

/**
 * Dispatches the requested CLI command.
 */
export const runCli = async (argv: string[]): Promise<void> => {
  const args = parseCliArgs(argv);

  switch (args.command) {
    case "help": {
      writeStdoutLine(getHelpText());
      return;
    }
    case "set-api": {
      await printSetApiSummary(args);
      return;
    }
    case "set-global-memory": {
      await printSetGlobalMemorySummary(args);
      return;
    }
    case "set-default-model": {
      await printDefaultModelSummary(args);
      return;
    }
    case "config": {
      await printConfigSummary(args);
      return;
    }
    case "chat": {
      await runInteractiveChat(args);
      return;
    }
    case "inspect": {
      await printCustomizationSummary(args);
      return;
    }
    case "tools": {
      await printToolSummary(args);
      return;
    }
    case "profiles": {
      await printProfileSummary(args);
      return;
    }
    case "run": {
      await printTaskPreview(args);
      return;
    }
  }
};
