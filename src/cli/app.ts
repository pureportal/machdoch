import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  loadRuntimeConfig,
  saveWorkspaceDefaultModel,
} from "../core/config.js";
import { discoverCustomizations } from "../core/customizations.js";
import { saveUserApiKey } from "../core/env.js";
import { createTaskExecutionController } from "../core/execution.js";
import { resolveToolPolicies } from "../core/policy.js";
import { previewTaskRun } from "../core/task-runner.js";
import { getToolRegistry } from "../core/tools.js";
import type {
  ProviderAvailability,
  RunMode,
  RuntimeProfileSummary,
  TaskExecutionProgress,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionState,
} from "../core/types.js";

export type CommandName =
  | "run"
  | "chat"
  | "set-api"
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
  provider?: ProviderAvailability["provider"];
  key?: string;
  model?: string;
  defaultModel?: string;
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
}

const VALID_MODES: ReadonlySet<RunMode> = new Set(["safe", "ask", "auto"]);
const VALID_PROVIDERS: ReadonlySet<ProviderAvailability["provider"]> = new Set([
  "openai",
  "anthropic",
  "google",
]);
const COMMANDS_WITHOUT_POSITIONALS: ReadonlySet<CommandName> = new Set([
  "inspect",
  "config",
  "tools",
  "profiles",
  "help",
]);
const TERMINAL_PROGRESS_STATES: ReadonlySet<TaskExecutionState> = new Set([
  "completed",
  "approval-required",
  "blocked",
  "unsupported",
  "cancelled",
]);

const fail = (message: string): never => {
  throw new Error(message);
};

const createParsedArgs = (
  base: Omit<
    ParsedCliArgs,
    "mode" | "profile" | "task" | "provider" | "key" | "model" | "defaultModel"
  >,
  options?: {
    mode?: RunMode;
    profile?: string;
    provider?: ProviderAvailability["provider"];
    key?: string;
    model?: string;
    defaultModel?: string;
    task?: string;
  },
): ParsedCliArgs => {
  return {
    ...base,
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(options?.profile ? { profile: options.profile } : {}),
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(options?.key ? { key: options.key } : {}),
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options?.task ? { task: options.task } : {}),
  };
};

const normalizeOptionalString = (
  value: string | boolean | undefined,
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
};

const createSharedParsedOptions = (options: {
  json: boolean;
  verbose: boolean;
  workspaceRoot: string;
  mode?: RunMode;
  profile?: string;
  model?: string;
  defaultModel?: string;
}): Omit<ParsedCliArgs, "command" | "task"> => {
  return {
    json: options.json,
    verbose: options.verbose,
    workspaceRoot: options.workspaceRoot,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
  };
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
  machdoch --set-api --provider <openai|anthropic|google> --key <value>
  machdoch --task <task> [--quick] [--model <name>]
  machdoch --model <name>
  machdoch --default-model <name>
  machdoch inspect [--json]
  machdoch config [--json]
  machdoch tools [--json]
  machdoch profiles [--json]

Options:
  --mode <safe|ask|auto>  Override the runtime mode for this command.
  --quick                 Shortcut for --mode auto.
  --set-api               Save a provider API key into the user-scoped Machdoch config file.
  --provider <name>       Provider name for --set-api (openai, anthropic, google).
  --key <value>           API key value for --set-api.
  --task <text>           Provide the task text explicitly instead of positionals.
  --model <name>          Override the active model for this run or chat session.
  --default-model <name>  Persist the workspace default model to .machdoch/config.json.
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
        mode?: string;
        provider?: string;
        key?: string;
        task?: string;
        model?: string;
        "default-model"?: string;
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
        mode: { type: "string" },
        provider: { type: "string" },
        key: { type: "string" },
        task: { type: "string" },
        model: { type: "string" },
        "default-model": { type: "string" },
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
  const workspaceRoot =
    normalizeOptionalString(values?.cwd) ?? currentWorkingDirectory;

  if (workspaceRoot.trim().length === 0) {
    fail("Expected --cwd to be followed by a path.");
  }

  const rawMode = normalizeOptionalString(values?.mode);
  const rawProvider = normalizeOptionalString(values?.provider);
  const rawKey = normalizeOptionalString(values?.key);
  const rawTask = normalizeOptionalString(values?.task);
  const rawModel = normalizeOptionalString(values?.model);
  const rawDefaultModel = normalizeOptionalString(values?.["default-model"]);
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

  if (
    rawProvider &&
    !VALID_PROVIDERS.has(rawProvider as ProviderAvailability["provider"])
  ) {
    fail("Expected --provider to be followed by openai, anthropic, or google.");
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

  if (rawTask && positionals.length > 0) {
    fail("Use either positional task text or --task, not both.");
  }

  if (values?.quick === true && rawMode !== undefined && rawMode !== "auto") {
    fail("--quick cannot be combined with a non-auto --mode value.");
  }

  if (rawDefaultModel && (rawTask || positionals.length > 0)) {
    fail("--default-model cannot be combined with a task.");
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
      rawMode ||
      values?.quick === true
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
        provider: rawProvider as ProviderAvailability["provider"],
        key: rawKey ?? fail("--set-api requires --key."),
      },
    );
  }

  const resolvedMode = rawMode ?? (values?.quick === true ? "auto" : undefined);

  const sharedOptions = createSharedParsedOptions({
    json,
    verbose,
    workspaceRoot,
    ...(resolvedMode ? { mode: resolvedMode as RunMode } : {}),
    ...(rawProfile ? { profile: rawProfile } : {}),
    ...(rawModel ? { model: rawModel } : {}),
    ...(rawDefaultModel ? { defaultModel: rawDefaultModel } : {}),
  });

  if (values?.help === true) {
    return createParsedArgs({
      ...sharedOptions,
      command: "help",
    });
  }

  if (rawDefaultModel) {
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

    if (rawModel || resolvedMode || rawProfile) {
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

/**
 * Formats execution-state progress for the CLI's verbose stderr stream.
 */
export const formatExecutionProgressLines = (
  progress: TaskExecutionProgress,
): string[] => {
  const lines = [`[${progress.state}] ${progress.message}`];

  if (progress.reason) {
    lines.push(`reason: ${progress.reason}`);
  }

  if (
    progress.executedTools.length > 0 &&
    TERMINAL_PROGRESS_STATES.has(progress.state)
  ) {
    lines.push(`tools: ${progress.executedTools.join(", ")}`);
  }

  return lines;
};

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

/**
 * Formats a single profile line for human-readable console output.
 */
const formatProfileLine = (
  profile: RuntimeProfileSummary,
  activeProfile: string | undefined,
): string => {
  const activeMarker = activeProfile === profile.name ? " (active)" : "";

  return `  - ${profile.name}${activeMarker}${profile.description ? `: ${profile.description}` : ""}`;
};

/**
 * Creates the optional discovery flags object only when GitHub compatibility is
 * enabled.
 */
const createDiscoveryOptions = (
  discoverGithubCustomizations: boolean | undefined,
): { discoverGithubCustomizations: true } | undefined => {
  return discoverGithubCustomizations
    ? { discoverGithubCustomizations: true }
    : undefined;
};

const DEFAULT_BODY_PREVIEW_LINES = 8;

/**
 * Produces a truncated preview of Markdown body content for CLI display.
 */
const createBodyPreviewLines = (
  body: string,
  maxPreviewLines = DEFAULT_BODY_PREVIEW_LINES,
): string[] => {
  const normalizedBody = body
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (normalizedBody.length === 0) {
    return [];
  }

  const bodyLines = normalizedBody.split("\n");
  const previewLines = bodyLines.slice(0, maxPreviewLines);

  if (bodyLines.length > maxPreviewLines) {
    previewLines.push(
      `… truncated after ${maxPreviewLines} of ${bodyLines.length} lines`,
    );
  }

  return previewLines;
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
  );

  if (args.json) {
    writeStdoutLine(JSON.stringify(config, null, 2));
    return;
  }

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`provider: ${config.provider}`);
  writeStdoutLine(`model: ${config.model}`);
  writeStdoutLine(`offline: ${config.offline ? "true" : "false"}`);
  writeStdoutLine(`enabled tools: ${config.enabledTools.join(", ")}`);
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
const printTaskPreview = async (args: ParsedCliArgs): Promise<void> => {
  const task = args.task ?? fail("No task was provided.");

  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
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
      ...(args.verbose && !args.json
        ? {
            onStateChange: createVerboseProgressReporter(writeStderrLine),
          }
        : {}),
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
      return;
    }

    writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
    printExecutionSummary(execution);
    return;
  }

  const preview = previewTaskRun(task, config, customizations);

  if (args.json) {
    writeStdoutLine(JSON.stringify({ execution, preview }, null, 2));
    return;
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
  );

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`model: ${config.model}`);
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

      await printTaskPreview({
        ...args,
        command: "run",
        task: nextTask,
      });
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
