import { spawn } from "node:child_process";
import { extname } from "node:path";
import { loadWorkspaceEnv } from "../env.js";
import {
  createExecutionResult,
  emitAgentProgress,
  normalizeFinalSummary,
} from "./agent-runtime-shared.js";
import type {
  AgentLoopState,
  ModelDrivenExecutionParams,
} from "./agent-runtime-types.js";
import {
  getAgentCliProviderLabel,
  isAgentCliProvider,
  resolveAgentCliProviderBinary,
  type AgentCliProvider,
} from "./agent-cli-providers.js";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";
import { createTextSection, limitText } from "./runtime-text.js";
import type {
  ReasoningMode,
  RuntimeConfig,
  TaskActionOutputHandler,
  TaskExecutionResult,
  TaskExecutionSection,
} from "../types.js";
import { normalizeReasoningModeForProviderModel } from "../reasoning-modes.js";

interface SpawnedAgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ExternalAgentExecutionParams extends ModelDrivenExecutionParams {
  preparedConversationContext: PreparedConversationPromptContext;
}

const MAX_DIAGNOSTIC_CHARS = 12_000;
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;

type CodexCliReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

type ClaudeCliReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

type CopilotCliReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const mapReasoningToCodexCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): CodexCliReasoningEffort | undefined => {
  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "codex-cli",
    model,
  );

  if (normalizedReasoning === "default") {
    return undefined;
  }

  if (normalizedReasoning === "none") {
    return "minimal";
  }

  if (normalizedReasoning === "max") {
    return "xhigh";
  }

  return normalizedReasoning;
};

const mapReasoningToClaudeCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): ClaudeCliReasoningEffort | undefined => {
  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "claude-cli",
    model,
  );

  switch (normalizedReasoning) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalizedReasoning;
    case "default":
    case "none":
    case "minimal":
      return undefined;
  }
};

const mapReasoningToCopilotCliEffort = (
  model: string,
  reasoning: ReasoningMode,
): CopilotCliReasoningEffort | undefined => {
  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "copilot-cli",
    model,
  );

  switch (normalizedReasoning) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalizedReasoning;
    case "default":
    case "none":
    case "minimal":
      return undefined;
  }
};

const cleanCliText = (value: string): string => {
  return value.replace(ANSI_ESCAPE_PATTERN, "").trim();
};

const createExternalAgentLoopState = (
  sections: TaskExecutionSection[],
): AgentLoopState => ({
  executedTools: [],
  outputSections: sections,
  traceLines: [],
  memoryUpdates: [],
});

const formatSectionForPrompt = (section: TaskExecutionSection): string => {
  return [
    `### ${section.title}`,
    ...section.lines.map((line) => `- ${line}`),
  ].join("\n");
};

const createExternalAgentPrompt = (
  task: string,
  config: RuntimeConfig,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  providerLabel: string,
  attachmentPaths: readonly string[],
): string => {
  const modeInstruction =
    config.mode === "ask"
      ? "Run in read-only mode: inspect, reason, and answer without modifying files."
      : "Run in workspace-write mode: make the requested workspace changes when needed, then verify them.";

  return [
    `You are running as a delegated ${providerLabel} agent for Machdoch.`,
    `Workspace: ${config.workspaceRoot}`,
    `Machdoch mode: ${config.mode}`,
    `Reasoning mode: ${config.reasoning}`,
    modeInstruction,
    "Run autonomously. Do not ask the user for permission or clarification; stop only when the task is complete or a concrete blocker prevents progress.",
    "Follow all repository instructions discovered in the workspace. Do not start dev servers unless the repository instructions explicitly allow it.",
    attachmentPaths.length > 0
      ? [
          "Attached files/images available to the delegated agent:",
          ...attachmentPaths.map((path) => `- ${path}`),
        ].join("\n")
      : undefined,
    "User task:",
    task,
    conversationContext.promptBlock,
    "Resolved Machdoch context:",
    [...contextSections, ...conversationContext.sections]
      .map(formatSectionForPrompt)
      .join("\n\n"),
    "Completion contract:",
    "- Work until the task is complete or a concrete blocker prevents progress.",
    "- Final response must summarize what changed, verification performed, anything that could not be verified, and remaining assumptions or risks.",
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");
};

const shouldUseShellForExecutable = (executable: string): boolean => {
  if (process.platform !== "win32") {
    return false;
  }

  const extension = extname(executable).toLowerCase();

  return extension === ".cmd" || extension === ".bat";
};

const createChildEnv = (
  env: Record<string, string>,
): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    NO_COLOR: "1",
  };

  if (!childEnv.CODEX_API_KEY && env.OPENAI_API_KEY) {
    childEnv.CODEX_API_KEY = env.OPENAI_API_KEY;
  }

  return childEnv;
};

const createAbortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;

  if (reason instanceof Error) {
    return reason;
  }

  return new Error(
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Execution cancelled by user.",
  );
};

const emitActionOutput = (
  onActionOutput: TaskActionOutputHandler | undefined,
  stream: "stdout" | "stderr",
  chunk: string,
): void => {
  if (!onActionOutput || chunk.length === 0) {
    return;
  }

  void Promise.resolve(
    onActionOutput({
      toolName: "shell",
      stream,
      chunk,
    }),
  ).catch(() => undefined);
};

const runExternalAgentCommand = async (
  executable: string,
  args: string[],
  input: string | undefined,
  config: RuntimeConfig,
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  onActionOutput: TaskActionOutputHandler | undefined,
): Promise<SpawnedAgentResult> => {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  return await new Promise<SpawnedAgentResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: config.workspaceRoot,
      env: createChildEnv(env),
      shell: shouldUseShellForExecutable(executable),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", handleAbort);
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal: exitSignal,
        stdout,
        stderr,
      });
    };

    function handleAbort(): void {
      child.kill();
      rejectOnce(signal ? createAbortError(signal) : new Error("Execution cancelled."));
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      emitActionOutput(onActionOutput, "stdout", chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      emitActionOutput(onActionOutput, "stderr", chunk);
    });
    child.on("error", (error) => {
      rejectOnce(error);
    });
    child.on("close", (exitCode, exitSignal) => {
      resolveOnce(exitCode, exitSignal);
    });

    signal?.addEventListener("abort", handleAbort, { once: true });

    if (input !== undefined) {
      child.stdin?.write(input);
    }

    child.stdin?.end();
  });
};

interface ExternalAgentCommand {
  args: string[];
  input?: string;
  runDetail: string;
  startMessage: string;
  successDetail: string;
  commandLines: string[];
  metadata: Record<string, string | number | boolean>;
}

interface ExternalAgentCommandFactoryParams {
  config: RuntimeConfig;
  prompt: string;
  imageInputs: ModelDrivenExecutionParams["imageInputs"];
}

const getExecutorTurnLimit = (config: RuntimeConfig): number | undefined => {
  const limit = config.agentLimits?.executorTurns;

  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.trunc(limit)
    : undefined;
};

const createCodexArgs = (
  config: RuntimeConfig,
  imageInputs: ModelDrivenExecutionParams["imageInputs"],
): ExternalAgentCommand => {
  const sandbox = config.mode === "ask" ? "read-only" : "workspace-write";
  const reasoningEffort = mapReasoningToCodexCliEffort(
    config.model,
    config.reasoning,
  );
  const args = [
    "exec",
    "--cd",
    config.workspaceRoot,
    "--model",
    config.model,
    "--sandbox",
    sandbox,
    "--ask-for-approval",
    "never",
  ];

  if (reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${reasoningEffort}`);
  }

  for (const imageInput of imageInputs ?? []) {
    args.push("--image", imageInput.path);
  }

  args.push("-");

  return {
    args,
    runDetail: `Running codex exec with ${sandbox} sandbox.`,
    startMessage: `Starting Codex CLI with ${sandbox} sandbox.`,
    successDetail: "codex exec exited successfully.",
    commandLines: [`sandbox: ${sandbox}`],
    metadata: {
      sandbox,
      reasoning: config.reasoning,
    },
  };
};

const createCodexCommand = ({
  config,
  prompt,
  imageInputs,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => ({
  ...createCodexArgs(config, imageInputs),
  input: prompt,
});

const createClaudeCommand = ({
  config,
  prompt,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => {
  const permissionMode =
    config.mode === "ask" ? "plan" : "bypassPermissions";
  const effort = mapReasoningToClaudeCliEffort(config.model, config.reasoning);
  const args = [
    "-p",
    "Follow the Machdoch delegated task prompt supplied on stdin.",
    "--output-format",
    "text",
    "--model",
    config.model,
    "--permission-mode",
    permissionMode,
    "--no-session-persistence",
  ];
  const maxTurns = getExecutorTurnLimit(config);

  if (effort) {
    args.push("--effort", effort);
  }

  if (maxTurns !== undefined) {
    args.push("--max-turns", String(maxTurns));
  }

  return {
    args,
    input: prompt,
    runDetail: `Running claude -p with ${permissionMode} permission mode.`,
    startMessage: `Starting Claude CLI with ${permissionMode} permission mode.`,
    successDetail: "claude -p exited successfully.",
    commandLines: [
      `permission mode: ${permissionMode}`,
      ...(effort ? [`effort: ${effort}`] : []),
      ...(maxTurns !== undefined ? [`max turns: ${maxTurns}`] : []),
    ],
    metadata: {
      permissionMode,
      reasoning: config.reasoning,
      ...(effort ? { effort } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    },
  };
};

const isCopilotAutoModel = (model: string): boolean =>
  model.trim().toLowerCase() === "auto";

const createCopilotCommand = ({
  config,
  prompt,
}: ExternalAgentCommandFactoryParams): ExternalAgentCommand => {
  const writeMode = config.mode !== "ask";
  const effort = mapReasoningToCopilotCliEffort(
    config.model,
    config.reasoning,
  );
  const args = ["-s", "-p", prompt, "--no-ask-user"];

  if (!isCopilotAutoModel(config.model)) {
    args.push(`--model=${config.model}`);
  }

  if (effort) {
    args.push(`--effort=${effort}`);
  }

  if (writeMode) {
    args.push("--allow-all");
  } else {
    args.push(`--add-dir=${config.workspaceRoot}`);
    args.push("--allow-tool=read,url");
    args.push("--deny-tool=write,shell,memory");
  }

  return {
    args,
    runDetail: writeMode
      ? "Running copilot -p with all tools, paths, and URLs allowed."
      : "Running copilot -p in read-oriented mode.",
    startMessage: writeMode
      ? "Starting Copilot CLI with full non-interactive permissions."
      : "Starting Copilot CLI in read-oriented mode.",
    successDetail: "copilot -p exited successfully.",
    commandLines: [
      `permission mode: ${writeMode ? "allow-all" : "read-only"}`,
      `model argument: ${isCopilotAutoModel(config.model) ? "default" : config.model}`,
      ...(effort ? [`effort: ${effort}`] : []),
    ],
    metadata: {
      permissionMode: writeMode ? "allow-all" : "read-only",
      reasoning: config.reasoning,
      modelArgument: isCopilotAutoModel(config.model) ? "default" : config.model,
      ...(effort ? { effort } : {}),
    },
  };
};

const createExternalAgentCommand = (
  provider: AgentCliProvider,
  params: ExternalAgentCommandFactoryParams,
): ExternalAgentCommand => {
  switch (provider) {
    case "codex-cli":
      return createCodexCommand(params);
    case "claude-cli":
      return createClaudeCommand(params);
    case "copilot-cli":
      return createCopilotCommand(params);
  }
};

const executeExternalAgentCliTask = async (
  params: ExternalAgentExecutionParams,
  provider: AgentCliProvider,
): Promise<TaskExecutionResult> => {
  const env = await loadWorkspaceEnv(params.config.workspaceRoot);
  const binary = resolveAgentCliProviderBinary(provider, env);
  const providerLabel = getAgentCliProviderLabel(provider);
  const loopState = createExternalAgentLoopState(params.contextSections);

  if (!binary.available || !binary.executable) {
    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary:
          `${providerLabel} execution could not start because the CLI binary was not found.`,
        executedTools: [],
        outputSections: [
          ...params.contextSections,
          {
            title: providerLabel,
            tone: "danger",
            lines: [
              binary.reason ??
                `${providerLabel} was not found on PATH and no configured binary path is available.`,
            ],
          },
        ],
      },
      binary.reason,
    );
  }

  const imagePaths = (params.imageInputs ?? []).map((imageInput) => imageInput.path);
  const prompt = createExternalAgentPrompt(
    params.task,
    params.config,
    params.contextSections,
    params.preparedConversationContext,
    providerLabel,
    imagePaths,
  );
  const command = createExternalAgentCommand(
    provider,
    {
      config: params.config,
      prompt,
      imageInputs: params.imageInputs,
    },
  );

  await emitAgentProgress(
    params.task,
    params.config,
    "executing",
    command.startMessage,
    loopState,
    params.onStateChange,
    undefined,
    {
      timelineEvent: {
        kind: "model-call",
        phase: "started",
        label: providerLabel,
        detail: command.runDetail,
        tone: "info",
        provider,
        model: params.config.model,
        metadata: {
          binarySource: binary.source ?? "unknown",
          ...command.metadata,
        },
      },
    },
  );

  const startedAt = Date.now();
  const result = await runExternalAgentCommand(
    binary.executable,
    command.args,
    command.input,
    params.config,
    env,
    params.signal,
    params.onActionOutput,
  );
  const stdout = cleanCliText(result.stdout);
  const stderr = cleanCliText(result.stderr);
  const durationMs = Date.now() - startedAt;
  const commandSection: TaskExecutionSection = {
    title: providerLabel,
    lines: [
      `binary: ${binary.executable}`,
      `binary source: ${binary.source ?? "unknown"}`,
      `model: ${params.config.model}`,
      `reasoning: ${params.config.reasoning}`,
      ...command.commandLines,
      `exit code: ${result.exitCode ?? "unknown"}`,
      ...(result.signal ? [`signal: ${result.signal}`] : []),
    ],
  };

  if (result.exitCode !== 0) {
    const reason =
      stderr ||
      stdout ||
      `${providerLabel} exited with code ${result.exitCode ?? "unknown"}.`;

    await emitAgentProgress(
      params.task,
      params.config,
      "blocked",
      `${providerLabel} execution failed.`,
      loopState,
      params.onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "failed",
          label: providerLabel,
          detail: limitText(reason, 500),
          tone: "danger",
          provider,
          model: params.config.model,
          metadata: {
            durationMs,
          },
        },
      },
    );

    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary: `${providerLabel} execution failed before completing the task.`,
        executedTools: ["shell"],
        outputSections: [
          ...params.contextSections,
          commandSection,
          createTextSection(`${providerLabel} diagnostics`, reason, 80),
        ],
      },
      reason,
    );
  }

  const answer =
    stdout ||
    `${providerLabel} completed successfully but did not print a final message.`;

  await emitAgentProgress(
    params.task,
    params.config,
    "verifying",
    `${providerLabel} completed.`,
    {
      ...loopState,
      executedTools: ["shell"],
      lastAssistantText: answer,
    },
    params.onStateChange,
    undefined,
    {
      assistantText: limitText(answer, 4_000),
      timelineEvent: {
        kind: "model-call",
        phase: "completed",
        label: providerLabel,
        detail: command.successDetail,
        tone: "success",
        provider,
        model: params.config.model,
        metadata: {
          durationMs,
        },
      },
    },
  );

  return createExecutionResult({
    task: params.task,
    mode: params.config.mode,
    status: "executed",
    summary: normalizeFinalSummary(answer),
    executedTools: ["shell"],
    outputSections: [
      ...params.contextSections,
      commandSection,
      createTextSection(`${providerLabel} answer`, answer, 120),
      ...(stderr
        ? [createTextSection(`${providerLabel} diagnostics`, limitText(stderr, MAX_DIAGNOSTIC_CHARS), 80)]
        : []),
    ],
    response: {
      markdown: answer,
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  });
};

export const maybeExecuteExternalAgentProviderTask = async (
  params: ExternalAgentExecutionParams,
): Promise<TaskExecutionResult | undefined> => {
  if (!isAgentCliProvider(params.config.provider)) {
    return undefined;
  }

  return await executeExternalAgentCliTask(params, params.config.provider);
};
