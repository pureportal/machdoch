import { readFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { loadUserMemorySettings } from "../../core/env.js";
import { createTaskExecutionController } from "../../core/execution.js";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../../core/memory.js";
import { previewTaskRun } from "../../core/task-runner.js";
import type {
  ConversationHistoryEntry,
  ConversationMemoryEntry,
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
import {
  createBodyPreviewLines,
  createDiscoveryOptions,
} from "./cli-output.js";

const fail = (message: string): never => {
  throw new Error(message);
};

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

const printInteractiveChatHelp = (): void => {
  writeStdoutLine("interactive commands:");
  writeStdoutLine("  /help  Show this help");
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
  );
  const memorySettings = await loadUserMemorySettings();
  const baseConversationContext = await resolveConversationContext(args);
  const {
    effectiveGlobalMemoryEnabled,
    ...sessionState
  }: InteractiveChatSessionState & {
    effectiveGlobalMemoryEnabled: boolean;
  } = createInteractiveChatSessionState(
    baseConversationContext,
    memorySettings.globalEnabled,
  );

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

    const executeChatTask = async (nextTask: string): Promise<void> => {
      const { execution } = await printTaskPreview(
        {
          ...args,
          command: "run",
          task: nextTask,
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

      await executeChatTask(nextTask);
      writeStdoutLine();
    }
  } finally {
    interfaceHandle.close();
  }
};
