import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { CliUsageError } from "./cli-error.js";
import { parseConversationContext } from "./cli-chat-sessions.js";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { createTaskExecutionController } from "../../core/execution.js";
import {
  createImageInputUnsupportedModelMessage,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
  providerSupportsImageInputMediaType,
} from "../../core/model-capabilities.js";
import { previewTaskRun } from "../../core/task-runner.js";
import type {
  AgentModelImageInput,
  TaskConversationContext,
  TaskExecutionResult,
  TaskRunPreview,
} from "../../core/types.js";
import type { RuntimeConfig } from "../../core/runtime-contract.generated.js";
import type { ParsedCliArgs } from "./cli-args.js";
import {
  attachCancellationHandlers,
  createActionFeedbackProgressReporter,
  createStructuredActionOutputReporter,
  createVerboseProgressReporter,
  printExecutionSummary,
  writeStderrLine,
  writeStdoutLine,
} from "./cli-io.js";
import { createDiscoveryOptions } from "./cli-output.js";

const fail = (message: string): never => {
  throw new CliUsageError(message);
};

type CliContextPathKind = "file" | "folder" | "path";

interface CliContextPathEntry {
  path: string;
  kind: CliContextPathKind;
}

const loadConversationContextFromFile = async (
  filePath: string,
): Promise<TaskConversationContext> => {
  const raw = await readFile(filePath, "utf8");

  return parseConversationContext(JSON.parse(raw) as unknown);
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
    fail(
      createImageInputUnsupportedModelMessage(config.provider, config.model),
    );
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
            config.model,
          ).join(", ")}.`,
        );

      if (
        !providerSupportsImageInputMediaType(
          config.provider,
          imageMediaType,
          config.model,
        )
      ) {
        const supportedExtensions = getSupportedImageInputExtensions(
          config.provider,
          config.model,
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
    ...(baseContext?.sessionId !== undefined
      ? { sessionId: baseContext.sessionId }
      : {}),
    ...(baseContext?.workspaceMemoryEnabled !== undefined
      ? { workspaceMemoryEnabled: baseContext.workspaceMemoryEnabled }
      : {}),
    ...(baseContext?.workspace !== undefined
      ? { workspace: baseContext.workspace }
      : {}),
    ...(baseContext?.workspaceRun !== undefined
      ? { workspaceRun: baseContext.workspaceRun }
      : {}),
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

export const printTaskPreview = async (
  args: ParsedCliArgs,
  options?: {
    conversationContext?: TaskConversationContext;
    showActionFeedback?: boolean;
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
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
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
  const showActionFeedback =
    !args.json &&
    (options?.showActionFeedback === true || args.command === "run");
  const actionFeedbackReporter = showActionFeedback
    ? createActionFeedbackProgressReporter(
        options?.showActionFeedback
          ? writeStdoutLine
          : (line = ""): void => {
              writeStderrLine(line);
            },
      )
    : undefined;
  const structuredActionOutputReporter =
    args.json && args.verbose
      ? createStructuredActionOutputReporter(task, config.mode, writeStderrLine)
      : undefined;
  const onStateChange = args.verbose
    ? createVerboseProgressReporter(writeStderrLine, {
        structured: args.json,
      })
    : actionFeedbackReporter?.report;
  const controller = createTaskExecutionController(
    task,
    config,
    customizations,
    {
      ...(onStateChange ? { onStateChange } : {}),
      ...(actionFeedbackReporter
        ? { onActionOutput: actionFeedbackReporter.reportOutput }
        : structuredActionOutputReporter
          ? { onActionOutput: structuredActionOutputReporter }
          : {}),
      ...(conversationContext ? { conversationContext } : {}),
      ...(imageInputs.length > 0 ? { imageInputs } : {}),
      ...(args.deterministicAction
        ? { deterministicAction: args.deterministicAction }
        : {}),
      ...(args.skipFileChangeDetection ? { captureFileChanges: false } : {}),
      ...(process.env.MACHDOCH_DESKTOP_MANAGES_TASK_TIMEOUT === "true"
        ? { idleTimeoutMs: null }
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
    actionFeedbackReporter?.finish();
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
