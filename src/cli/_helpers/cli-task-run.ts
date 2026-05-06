import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { loadUserMemorySettings } from "../../core/env.js";
import { createTaskExecutionController } from "../../core/execution.js";
import {
  createImageInputUnsupportedModelMessage,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
  providerSupportsImageInputMediaType,
} from "../../core/model-capabilities.js";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../../core/memory.js";
import { previewTaskRun } from "../../core/task-runner.js";
import type {
  ConversationHistoryEntry,
  AgentModelImageInput,
  ConversationMemoryEntry,
  RuntimeConfig,
  TaskConversationContext,
  TaskExecutionResult,
  TaskRunPreview,
} from "../../core/types.js";
import type { ParsedCliArgs } from "./cli-args.js";
import {
  attachCancellationHandlers,
  createVerboseProgressReporter,
  printExecutionSummary,
  writeStderrLine,
  writeStdoutLine,
} from "./cli-io.js";
import { createDiscoveryOptions } from "./cli-output.js";

const fail = (message: string): never => {
  throw new Error(message);
};

type CliContextPathKind = "file" | "folder" | "path";

interface CliContextPathEntry {
  path: string;
  kind: CliContextPathKind;
}

export interface InteractiveChatSessionState {
  history: ConversationHistoryEntry[];
  sessionMemory: ConversationMemoryEntry[];
  sessionMemoryEnabled: boolean;
  globalMemoryEnabled?: boolean;
  globalMemory?: ConversationMemoryEntry[];
  uiControlEnabled?: boolean;
  uiControl?: TaskConversationContext["uiControl"];
}

const loadConversationContextFromFile = async (
  filePath: string,
): Promise<TaskConversationContext> => {
  const raw = await readFile(filePath, "utf8");

  return JSON.parse(raw) as TaskConversationContext;
};

const classifyContextPath = async (
  contextPath: string,
  workspaceRoot: string,
): Promise<CliContextPathEntry> => {
  const normalizedPath = contextPath.trim();
  const resolvedPath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(workspaceRoot, normalizedPath);

  try {
    const metadata = await stat(resolvedPath);

    if (metadata.isDirectory()) {
      return { path: normalizedPath, kind: "folder" };
    }

    if (metadata.isFile()) {
      return { path: normalizedPath, kind: "file" };
    }
  } catch {
    // Keep unknown paths as explicit references instead of failing before the
    // executor can decide how to handle them.
  }

  return { path: normalizedPath, kind: "path" };
};

export const createContextPathsTaskBlock = async (
  contextPaths: string[] | undefined,
  workspaceRoot: string,
): Promise<string> => {
  const entries = await Promise.all(
    (contextPaths ?? [])
      .map((contextPath) => contextPath.trim())
      .filter((contextPath) => contextPath.length > 0)
      .map((contextPath) => classifyContextPath(contextPath, workspaceRoot)),
  );

  if (entries.length === 0) {
    return "";
  }

  if (entries.length === 1) {
    const [entry] = entries;

    if (!entry) {
      return "";
    }

    return `Use this ${entry.kind}: "${entry.path}"`;
  }

  return [
    "Use these paths:",
    ...entries.map((entry) => `- ${entry.kind}: "${entry.path}"`),
  ].join("\n");
};

export const applyContextPathsToTask = async (
  task: string,
  contextPaths: string[] | undefined,
  workspaceRoot: string,
): Promise<string> => {
  const normalizedTask = task.trim();
  const contextBlock = await createContextPathsTaskBlock(
    contextPaths,
    workspaceRoot,
  );

  if (!contextBlock) {
    return normalizedTask;
  }

  return `${normalizedTask}\n\n${contextBlock}`;
};

export const createImageInputsFromPaths = async (
  imagePaths: string[] | undefined,
  workspaceRoot: string,
  config: Pick<RuntimeConfig, "model" | "provider">,
): Promise<AgentModelImageInput[]> => {
  const normalizedPaths = (imagePaths ?? [])
    .map((imagePath) => imagePath.trim())
    .filter((imagePath) => imagePath.length > 0);

  if (normalizedPaths.length === 0) {
    return [];
  }

  if (!modelSupportsImageInput(config.provider, config.model)) {
    fail(createImageInputUnsupportedModelMessage(config.provider, config.model));
  }

  return await Promise.all(
    normalizedPaths.map(async (imagePath) => {
      const resolvedPath = isAbsolute(imagePath)
        ? imagePath
        : resolve(workspaceRoot, imagePath);
      const mediaType =
        getImageInputMediaTypeForPath(imagePath) ??
        getImageInputMediaTypeForPath(resolvedPath);

      const imageMediaType: AgentModelImageInput["mediaType"] =
        mediaType ??
        fail(
          `Unsupported image attachment format for \`${imagePath}\`. Supported extensions for provider \`${config.provider}\`: ${getSupportedImageInputExtensions(
            config.provider,
          ).join(", ")}.`,
        );

      if (
        !providerSupportsImageInputMediaType(config.provider, imageMediaType)
      ) {
        const supportedExtensions = getSupportedImageInputExtensions(
          config.provider,
        ).join(", ");

        fail(
          `Unsupported image attachment format for \`${imagePath}\`. Supported extensions for provider \`${config.provider}\`: ${supportedExtensions}.`,
        );
      }

      const metadata = await stat(resolvedPath).catch((error: unknown) =>
        fail(
          `Unable to read image attachment \`${imagePath}\`: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );

      if (!metadata.isFile()) {
        fail(`Expected image attachment \`${imagePath}\` to be a file.`);
      }

      const fileContents = await readFile(resolvedPath);

      return {
        path: resolvedPath,
        mediaType: imageMediaType,
        data: fileContents.toString("base64"),
      };
    }),
  );
};

export const resolveConversationContext = async (
  args: Pick<
    ParsedCliArgs,
    "conversationContextFile" | "globalMemoryEnabled" | "sessionMemoryEnabled"
  >,
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
    ...(baseContext?.uiControl !== undefined
      ? { uiControl: baseContext.uiControl }
      : {}),
    ...(baseContext?.uiControlEnabled !== undefined
      ? { uiControlEnabled: baseContext.uiControlEnabled }
      : {}),
    ...(args.sessionMemoryEnabled !== undefined
      ? { sessionMemoryEnabled: args.sessionMemoryEnabled }
      : {}),
    ...(args.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: args.globalMemoryEnabled }
      : {}),
  };
};

export const createInteractiveChatSessionState = (
  baseContext: TaskConversationContext | undefined,
  fallbackGlobalMemoryEnabled: boolean,
): InteractiveChatSessionState & {
  effectiveGlobalMemoryEnabled: boolean;
} => {
  const sessionState: InteractiveChatSessionState = {
    history: baseContext?.history ?? [],
    sessionMemory: baseContext?.sessionMemory ?? [],
    sessionMemoryEnabled: baseContext?.sessionMemoryEnabled ?? true,
    ...(baseContext?.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: baseContext.globalMemoryEnabled }
      : {}),
    ...(baseContext?.globalMemory !== undefined
      ? { globalMemory: baseContext.globalMemory }
      : {}),
    ...(baseContext?.uiControlEnabled !== undefined
      ? { uiControlEnabled: baseContext.uiControlEnabled }
      : {}),
    ...(baseContext?.uiControl !== undefined
      ? { uiControl: baseContext.uiControl }
      : {}),
  };

  return {
    ...sessionState,
    effectiveGlobalMemoryEnabled:
      sessionState.globalMemoryEnabled ?? fallbackGlobalMemoryEnabled,
  };
};

export const printTaskPreview = async (
  args: ParsedCliArgs,
  options?: {
    conversationContext?: TaskConversationContext;
  },
): Promise<{
  execution: TaskExecutionResult;
  preview?: TaskRunPreview;
}> => {
  const task = await applyContextPathsToTask(
    args.task ?? fail("No task was provided."),
    args.contextPaths,
    args.workspaceRoot,
  );
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
    args.agentLimits,
  );
  const imageInputs = await createImageInputsFromPaths(
    args.imagePaths,
    args.workspaceRoot,
    config,
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
      ...(imageInputs.length > 0 ? { imageInputs } : {}),
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

  if (
    execution.status === "planned" ||
    execution.status === "executed" ||
    execution.status === "cancelled"
  ) {
    if (args.json) {
      writeStdoutLine(JSON.stringify({ execution }, null, 2));
      return { execution };
    }

    printExecutionSummary(execution);
    return { execution };
  }

  if (args.json) {
    const preview = previewTaskRun(task, config, customizations);
    writeStdoutLine(JSON.stringify({ execution, preview }, null, 2));
    return { execution, preview };
  }

  printExecutionSummary(execution);
  return { execution };
};

const printInteractiveChatHelp = (): void => {
  writeStdoutLine("interactive commands:");
  writeStdoutLine("  /help  Show this help");
  writeStdoutLine("  /plan <task>  Produce a read-only approval plan");
  writeStdoutLine("  /exit  Leave interactive mode");
  writeStdoutLine("  /quit  Leave interactive mode");
};

export const runInteractiveChat = async (
  args: ParsedCliArgs,
): Promise<void> => {
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
    args.agentLimits,
  );
  const memorySettings = await loadUserMemorySettings();
  const baseConversationContext = await resolveConversationContext(args);
  const sessionState = createInteractiveChatSessionState(
    baseConversationContext,
    memorySettings.globalEnabled,
  );

  const profileSuffix = config.activeProfile
    ? `, profile ${config.activeProfile}`
    : "";
  writeStdoutLine(
    `machdoch chat (${config.mode}, ${config.model}${profileSuffix})`,
  );
  writeStdoutLine(
    "Type a task and press Enter. Use /help for commands, /exit to quit.",
  );
  writeStdoutLine();

  const interfaceHandle = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const createCurrentConversationContext = (): TaskConversationContext => ({
      history: sessionState.history,
      sessionMemory: sessionState.sessionMemory,
      sessionMemoryEnabled: sessionState.sessionMemoryEnabled,
      ...(sessionState.globalMemoryEnabled !== undefined
        ? { globalMemoryEnabled: sessionState.globalMemoryEnabled }
        : {}),
      ...(sessionState.globalMemory !== undefined
        ? { globalMemory: sessionState.globalMemory }
        : {}),
      ...(sessionState.uiControlEnabled !== undefined
        ? { uiControlEnabled: sessionState.uiControlEnabled }
        : {}),
      ...(sessionState.uiControl !== undefined
        ? { uiControl: sessionState.uiControl }
        : {}),
    });

    const executeChatTask = async (
      nextTask: string,
      modeOverride = args.mode,
    ): Promise<void> => {
      const { execution } = await printTaskPreview(
        {
          ...args,
          command: "run",
          task: nextTask,
          ...(modeOverride ? { mode: modeOverride } : {}),
        },
        {
          conversationContext: createCurrentConversationContext(),
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
    };

    const initialTask = args.task?.trim();

    if (initialTask) {
      await executeChatTask(initialTask);
      writeStdoutLine();
    }

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

      if (nextTask === "/plan") {
        writeStdoutLine("Usage: /plan <task>");
        writeStdoutLine();
        continue;
      }

      if (nextTask.startsWith("/plan ")) {
        const planTask = nextTask.slice("/plan ".length).trim();

        if (planTask.length === 0) {
          writeStdoutLine("Usage: /plan <task>");
          writeStdoutLine();
          continue;
        }

        await executeChatTask(planTask, "plan");
        writeStdoutLine();
        continue;
      }

      await executeChatTask(nextTask);
      writeStdoutLine();
    }
  } finally {
    interfaceHandle.close();
  }
};
