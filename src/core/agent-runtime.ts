import {
  createAutopilotAuditSection,
  createAutopilotMonitorSystemPrompt,
  createAutopilotMonitorTool,
  createAutopilotMonitorUserPrompt,
  parseAutopilotDecisionFromTurn,
} from "./_helpers/agent-runtime-autopilot.js";
import {
  createExecutorSystemPrompt,
  createExecutorUserPrompt,
} from "./_helpers/agent-runtime-executor-prompts.js";
import {
  createAssistantAnswerSection,
  createFinalResponseSections,
  createFinalResponseTool,
  createFinalResponseToolResult,
  FINAL_RESPONSE_TOOL_NAME,
  parseFinalResponsePayload,
} from "./_helpers/agent-runtime-final-response.js";
import {
  createExecutionResult,
  emitAgentProgress,
  normalizeFinalSummary,
  upsertMemoryUpdate,
} from "./_helpers/agent-runtime-shared.js";
import {
  MAX_CONSECUTIVE_IDENTICAL_TOOL_ERRORS,
  resolveRuntimeAgentLimits,
  type AgentLoopState,
  type ExecutorContinuationRequest,
  type ExecutorCycleOutcome,
  type ModelDrivenExecutionParams,
} from "./_helpers/agent-runtime-types.js";
import {
  createToolDefinitions,
  executeToolCall,
} from "./_helpers/agent-tools.js";
import {
  prepareConversationPromptContext,
  type PreparedConversationPromptContext,
} from "./_helpers/conversation-prompt-context.js";
import { createProviderAdapter } from "./_helpers/provider-adapters.js";
import { resolveReviewModelRuntimeConfig } from "./review-model.js";
import { compactTraceText, stringifyUnknown } from "./_helpers/runtime-text.js";
import type {
  AgentModelAdapter,
  AgentModelStreamUsage,
  AgentModelStreamEvent,
  AgentModelTurn,
  AgentModelToolCall,
  AgentModelToolResult,
  ResolvedTaskContext,
  RuntimeConfig,
  TaskActionOutputHandler,
  TaskAutopilotDecision,
  TaskAutopilotReport,
  TaskExecutionProgress,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionSection,
  TaskExecutionState,
} from "./types.js";

const MODEL_STREAM_PROGRESS_INTERVAL_MS = 250;
const MODEL_STREAM_CONTENT_LIMIT = 4_000;

type ProgressTimelineEvent = NonNullable<
  TaskExecutionProgress["timelineEvent"]
>;
type ProgressTokenUsage = NonNullable<ProgressTimelineEvent["tokenUsage"]>;
type ProgressMetadataValue = string | number | boolean;

const limitStreamContent = (value: string): string => {
  if (value.length <= MODEL_STREAM_CONTENT_LIMIT) {
    return value;
  }

  return value.slice(value.length - MODEL_STREAM_CONTENT_LIMIT);
};

const normalizeTokenCount = (value: number | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
};

const createTokenUsageSnapshot = (
  usage: AgentModelStreamUsage,
): ProgressTokenUsage | undefined => {
  const inputTokens = normalizeTokenCount(usage.inputTokens);
  const outputTokens = normalizeTokenCount(usage.outputTokens);
  const totalTokens = normalizeTokenCount(usage.totalTokens);
  const cachedInputTokens = normalizeTokenCount(usage.cachedInputTokens);
  const reasoningTokens = normalizeTokenCount(usage.reasoningTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
};

const formatTokenUsage = (usage: ProgressTokenUsage): string => {
  const parts = [
    usage.inputTokens !== undefined ? `${usage.inputTokens} input` : undefined,
    usage.outputTokens !== undefined
      ? `${usage.outputTokens} output`
      : undefined,
    usage.totalTokens !== undefined ? `${usage.totalTokens} total` : undefined,
    usage.cachedInputTokens !== undefined
      ? `${usage.cachedInputTokens} cached`
      : undefined,
    usage.reasoningTokens !== undefined
      ? `${usage.reasoningTokens} reasoning`
      : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.join(", ");
};

const createProgressMetadata = (
  values: Record<string, ProgressMetadataValue | undefined>,
): Record<string, ProgressMetadataValue> | undefined => {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, ProgressMetadataValue] =>
      entry[1] !== undefined,
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const createModelStreamProgressEmitter = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  state: TaskExecutionState,
  onStateChange: TaskExecutionProgressHandler | undefined,
  createTimelineMetadata?: () => Record<string, ProgressMetadataValue> | undefined,
): {
  handleEvent: (event: AgentModelStreamEvent) => void;
  flush: () => Promise<void>;
} => {
  let assistantText = loopState.lastAssistantText ?? "";
  let reasoningText = "";
  let modelStream: NonNullable<TaskExecutionProgress["modelStream"]> | undefined;
  let lastEmitAt = 0;
  let hasPendingEmit = false;

  const emit = (force = false): void => {
    if (!onStateChange) {
      return;
    }

    const now = Date.now();

    if (!force && now - lastEmitAt < MODEL_STREAM_PROGRESS_INTERVAL_MS) {
      hasPendingEmit = true;
      return;
    }

    lastEmitAt = now;
    hasPendingEmit = false;

    const message =
      modelStream?.kind === "tool-call"
        ? `${modelStream.complete ? "Finished" : "Streaming"} model tool input for ${modelStream.label}.`
        : modelStream?.kind === "tool-result"
          ? `Forwarding tool result for ${modelStream.label}.`
          : modelStream?.kind === "reasoning"
            ? "Streaming model reasoning."
            : modelStream?.kind === "status"
              ? modelStream.label
        : "Streaming model response.";

    void emitAgentProgress(
      task,
      config,
      state,
      message,
      loopState,
      onStateChange,
      undefined,
      {
        ...(assistantText
          ? { assistantText: limitStreamContent(assistantText) }
          : {}),
        ...(modelStream
          ? {
              modelStream: {
                ...modelStream,
                content: limitStreamContent(modelStream.content),
              },
            }
          : {}),
      },
    ).catch(() => undefined);
  };

  return {
    handleEvent: (event): void => {
      switch (event.type) {
        case "text-delta": {
          if (!event.delta) {
            return;
          }

          assistantText += event.delta;
          loopState.lastAssistantText = assistantText.trim();
          modelStream = {
            kind: "assistant",
            label: "Assistant draft",
            content: assistantText,
          };
          emit();
          return;
        }

        case "reasoning-delta": {
          if (!event.delta) {
            return;
          }

          reasoningText += event.delta;
          modelStream = {
            kind: "reasoning",
            label: "Model reasoning",
            content: reasoningText,
          };
          emit();
          return;
        }

        case "status": {
          const provider = event.provider ? `${event.provider} ` : "";

          modelStream = {
            kind: "status",
            label: event.message ?? `${provider}stream ${event.status}`,
            content: event.rawEventType ?? event.status,
            complete:
              event.status === "completed" || event.status === "stopped",
          };
          emit(true);
          return;
        }

        case "tool-call-start": {
          const label = event.name ?? event.id ?? "tool call";

          modelStream = {
            kind: "tool-call",
            label,
            content: "",
          };
          emit(true);
          return;
        }

        case "tool-call-arguments-delta": {
          const label =
            event.name ?? modelStream?.label ?? event.id ?? "tool call";
          const content =
            event.snapshot ??
            `${modelStream?.kind === "tool-call" ? modelStream.content : ""}${event.delta}`;

          modelStream = {
            kind: "tool-call",
            label,
            content,
          };
          emit();
          return;
        }

        case "tool-call-done": {
          modelStream = {
            kind: "tool-call",
            label: event.name,
            content: event.argumentsText ?? modelStream?.content ?? "",
            complete: true,
          };
          emit(true);
          return;
        }

        case "tool-result": {
          modelStream = {
            kind: "tool-result",
            label: event.name,
            content: event.output,
            complete: true,
          };
          emit(true);
          return;
        }

        case "usage": {
          const tokenUsage = createTokenUsageSnapshot(event.usage);

          if (!tokenUsage) {
            return;
          }

          const metadata = createTimelineMetadata?.();

          void emitAgentProgress(
            task,
            config,
            state,
            "Model token usage reported.",
            loopState,
            onStateChange,
            undefined,
            {
              timelineEvent: {
                kind: "model-call",
                phase: "usage",
                label: "Token usage",
                detail: formatTokenUsage(tokenUsage),
                tone: "info",
                provider: event.provider ?? config.provider,
                model: config.model,
                tokenUsage,
                ...(metadata ? { metadata } : {}),
              },
            },
          ).catch(() => undefined);
          return;
        }

        case "error": {
          modelStream = {
            kind: "status",
            label: `Model stream error: ${event.message}`,
            content: event.code ?? event.param ?? event.message,
            complete: true,
          };
          emit(true);
          return;
        }
      }
    },
    flush: async (): Promise<void> => {
      if (!hasPendingEmit && !assistantText && !modelStream) {
        return;
      }

      try {
        await emitAgentProgress(
          task,
          config,
          state,
          modelStream?.kind === "tool-call"
            ? `Finished streaming model tool input for ${modelStream.label}.`
            : modelStream?.kind === "reasoning"
              ? "Finished streaming model reasoning."
              : modelStream?.kind === "tool-result"
                ? `Forwarded tool result for ${modelStream.label}.`
                : modelStream?.kind === "status"
                  ? modelStream.label
                  : "Finished streaming model response.",
          loopState,
          onStateChange,
          undefined,
          {
            ...(assistantText
              ? { assistantText: limitStreamContent(assistantText) }
              : {}),
            ...(modelStream
              ? {
                  modelStream: {
                    ...modelStream,
                    content: limitStreamContent(modelStream.content),
                    complete: true,
                  },
                }
              : {}),
          },
        );
      } catch {
        // Stream updates are best-effort progress; execution should continue.
      }
    },
  };
};

const attachAutopilotReport = (
  result: TaskExecutionResult,
  report: TaskAutopilotReport,
): TaskExecutionResult => {
  return {
    ...result,
    outputSections: [
      ...result.outputSections,
      createAutopilotAuditSection(report),
    ],
    autopilot: report,
  };
};

const finalizeExecutedResult = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  summaryOverride?: string,
): TaskExecutionResult => {
  const outputSections = [...loopState.outputSections];

  if (loopState.finalResponse) {
    outputSections.push(
      ...createFinalResponseSections(loopState.finalResponse),
    );
  } else if (loopState.lastAssistantText?.trim()) {
    outputSections.push(
      createAssistantAnswerSection(loopState.lastAssistantText),
    );
  }

  if (loopState.traceLines.length > 0) {
    outputSections.push({
      title: "Tool trace",
      audience: "internal",
      lines: loopState.traceLines,
    });
  }

  return createExecutionResult({
    task,
    mode: config.mode,
    status: "executed",
    summary:
      summaryOverride?.trim() ||
      normalizeFinalSummary(
        loopState.finalResponse?.markdown ?? loopState.lastAssistantText,
      ),
    executedTools: loopState.executedTools,
    outputSections,
    ...(loopState.memoryUpdates.length > 0
      ? { memoryUpdates: loopState.memoryUpdates }
      : {}),
    ...(loopState.finalResponse ? { response: loopState.finalResponse } : {}),
  });
};

const finalizeBlockedResult = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  summary: string,
  reason: string,
): TaskExecutionResult => {
  const outputSections = [...loopState.outputSections];

  if (loopState.finalResponse) {
    outputSections.push(
      ...createFinalResponseSections(loopState.finalResponse),
    );
  } else if (loopState.lastAssistantText?.trim()) {
    outputSections.push(
      createAssistantAnswerSection(loopState.lastAssistantText),
    );
  }

  if (loopState.traceLines.length > 0) {
    outputSections.push({
      title: "Tool trace",
      audience: "internal",
      lines: loopState.traceLines,
    });
  }

  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "blocked",
      summary,
      executedTools: loopState.executedTools,
      outputSections,
      ...(loopState.memoryUpdates.length > 0
        ? { memoryUpdates: loopState.memoryUpdates }
        : {}),
      ...(loopState.finalResponse ? { response: loopState.finalResponse } : {}),
    },
    reason,
  );
};

const finalizeUnstructuredModelResponseResult = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
): TaskExecutionResult => {
  return finalizeBlockedResult(
    task,
    config,
    loopState,
    "The model-driven execution stopped without submitting a structured final response.",
    "The executor must finish by calling `submit_final_response` with status `completed` or `blocked`.",
  );
};

const throwIfExecutionAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;

  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Execution cancelled by user.",
  );
};

const stableSerializeValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializeValue(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerializeValue(entryValue)}`,
      )
      .join(",")}}`;
  }

  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return stringifyUnknown(value);
  }
};

const createToolCallSignature = (
  name: string,
  args: Record<string, unknown>,
): string => {
  return `${name}:${stableSerializeValue(args)}`;
};

const getStringArg = (
  args: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = args[key];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const getNumberArg = (
  args: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = args[key];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const formatToolName = (name: string): string => {
  return name.replace(/_/gu, " ");
};

const formatQuotedValue = (value: string): string => {
  return `"${compactTraceText(value)}"`;
};

const createToolTargetPhrase = (call: AgentModelToolCall): string => {
  const args = call.arguments;
  const path = getStringArg(args, "path");
  const command = getStringArg(args, "command");
  const query = getStringArg(args, "query");
  const url = getStringArg(args, "url");
  const name = getStringArg(args, "name");
  const packageName = getStringArg(args, "packageName");
  const selector = getStringArg(args, "selector");
  const startLine = getNumberArg(args, "startLine");
  const endLine = getNumberArg(args, "endLine");

  if (call.name === "run_shell_command" && command) {
    return `: ${compactTraceText(command)}`;
  }

  if (call.name === "fetch_url" && url) {
    return ` from ${url}`;
  }

  if (
    (call.name === "search_web" || call.name === "search_workspace") &&
    query
  ) {
    return ` for ${formatQuotedValue(query)}`;
  }

  if (path) {
    const lineRange =
      startLine !== undefined && endLine !== undefined
        ? ` lines ${startLine}-${endLine}`
        : "";

    return ` on ${path}${lineRange}`;
  }

  if (packageName) {
    return ` for ${packageName}`;
  }

  if (name) {
    return ` for ${name}`;
  }

  if (selector) {
    return ` at ${selector}`;
  }

  return "";
};

const createToolRequestProgressMessage = (
  call: AgentModelToolCall,
): string => {
  return `Requested ${formatToolName(call.name)}${createToolTargetPhrase(call)}.`;
};

const createToolResultProgressMessage = (
  call: AgentModelToolCall,
  result: { toolResult: AgentModelToolResult; traceLines: string[] },
): string => {
  const resultSummary =
    result.traceLines.find((line) => !line.startsWith("tool_call:")) ??
    result.toolResult.output;
  const outcome = result.toolResult.isError ? "failed" : "finished";
  const detail = compactTraceText(resultSummary);

  return `${formatToolName(call.name)} ${outcome}${createToolTargetPhrase(call)}${
    detail ? `: ${detail}` : "."
  }`;
};

const hasResolvedGroundingContext = (
  taskContext: ResolvedTaskContext,
): boolean => {
  return (
    taskContext.workspacePaths.length > 0 ||
    (taskContext.invokedPrompt?.tools.length ?? 0) > 0
  );
};

const hasRunnableSuggestedTool = (
  taskContext: ResolvedTaskContext,
): boolean => {
  return taskContext.suggestedTools.length > 0;
};

const shouldRejectPrematureBlockedFinalResponse = (
  taskContext: ResolvedTaskContext,
  loopState: AgentLoopState,
  status: string,
): boolean => {
  if (
    status !== "blocked" ||
    loopState.executedTools.length > 0
  ) {
    return false;
  }

  return (
    hasResolvedGroundingContext(taskContext) &&
    hasRunnableSuggestedTool(taskContext)
  );
};

const createPrematureBlockedFinalResponseMessage = (): string => {
  return [
    "Premature final response rejected: this task has resolved workspace context or declared prompt tools, but no tool has run yet.",
    "Treat the current `<original_task>` and `<effective_task>` as authoritative over prior conversation.",
    "Use the available tools for the resolved context before blocking.",
    "Infer labels from repository URLs, domains, target folders, and file paths when they are provided instead of asking the user for a generic name.",
    "Only submit a blocked final response after a concrete attempted lookup/action or when an actually unavailable credential, tool, mode limit, or detail prevents progress.",
  ].join(" ");
};

const runExecutorCycle = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  imageInputs: ModelDrivenExecutionParams["imageInputs"],
  overrideAdapter: AgentModelAdapter | undefined,
  continuationRequest: ExecutorContinuationRequest | undefined,
  signal: AbortSignal | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
  onActionOutput: TaskActionOutputHandler | undefined,
): Promise<ExecutorCycleOutcome> => {
  throwIfExecutionAborted(signal);

  const toolDefinitions = createToolDefinitions(
    config,
    conversationContext.memory,
    conversationContext.uiControlEnabled
      ? conversationContext.uiControl
      : undefined,
  );
  const finalResponseTool = createFinalResponseTool();
  const toolSpecs = [
    ...toolDefinitions.map((toolDefinition) => toolDefinition.spec),
    finalResponseTool,
  ];
  const toolMap = new Map(
    toolDefinitions.map((toolDefinition) => [
      toolDefinition.spec.name,
      toolDefinition,
    ]),
  );
  const loopState: AgentLoopState = {
    executedTools: [],
    outputSections: [...contextSections, ...conversationContext.sections],
    traceLines: [],
    memoryUpdates: [],
  };
  const executorIteration = continuationRequest
    ? continuationRequest.continuationIndex + 1
    : 1;
  const adapter = await createProviderAdapter(
    config,
    toolSpecs,
    overrideAdapter,
  );

  if (!adapter) {
    return {
      loopState,
      result: finalizeBlockedResult(
        task,
        config,
        loopState,
        "Model-driven execution could not start because no executor model adapter is available.",
        "No executor model adapter is available for the current provider and runtime configuration.",
      ),
    };
  }

  let modelCallSequence = 1;
  const initialModelCallLabel = `Executor model call ${modelCallSequence}`;
  const initialModelCallStartedAt = Date.now();

  await emitAgentProgress(
    task,
    config,
    "executing",
    continuationRequest
      ? `Executor iteration ${executorIteration} started with monitor feedback from continuation ${continuationRequest.continuationIndex}.`
      : "Executor iteration 1 started.",
    loopState,
    onStateChange,
    undefined,
    {
      timelineEvent: {
        kind: "model-call",
        phase: "started",
        label: initialModelCallLabel,
        detail: `Starting executor iteration ${executorIteration} with ${config.model}.`,
        tone: "info",
        provider: config.provider,
        model: config.model,
        metadata: {
          executorIteration,
          modelCall: modelCallSequence,
        },
      },
    },
  );

  const modelStreamProgress = createModelStreamProgressEmitter(
    task,
    config,
    loopState,
    "executing",
    onStateChange,
    () =>
      createProgressMetadata({
        executorIteration,
        modelCall: modelCallSequence,
      }),
  );

  let turn: AgentModelTurn;

  try {
    turn = await adapter.startTurn({
      model: config.model,
      systemPrompt: createExecutorSystemPrompt(
        config,
        taskContext,
        toolSpecs,
        conversationContext,
        continuationRequest,
      ),
      userPrompt: createExecutorUserPrompt(
        config,
        task,
        taskContext,
        conversationContext,
        continuationRequest,
      ),
      ...(imageInputs && imageInputs.length > 0 ? { imageInputs } : {}),
      tools: toolSpecs,
      ...(signal ? { signal } : {}),
      ...(onStateChange
        ? { onStreamEvent: modelStreamProgress.handleEvent }
        : {}),
    });
    await modelStreamProgress.flush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metadata = createProgressMetadata({
      executorIteration,
      modelCall: modelCallSequence,
      durationMs: Date.now() - initialModelCallStartedAt,
    });

    await emitAgentProgress(
      task,
      config,
      "executing",
      `${initialModelCallLabel} failed.`,
      loopState,
      onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "failed",
          label: initialModelCallLabel,
          detail: message,
          tone: "danger",
          provider: config.provider,
          model: config.model,
          ...(metadata ? { metadata } : {}),
        },
      },
    );
    throw error;
  }

  {
    const metadata = createProgressMetadata({
      executorIteration,
      modelCall: modelCallSequence,
      durationMs: Date.now() - initialModelCallStartedAt,
      toolCalls: turn.toolCalls.length,
      ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
    });

    await emitAgentProgress(
      task,
      config,
      "executing",
      `${initialModelCallLabel} completed.`,
      loopState,
      onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "completed",
          label: initialModelCallLabel,
          detail: `Returned ${turn.toolCalls.length} tool call(s).`,
          tone: "success",
          provider: config.provider,
          model: config.model,
          ...(metadata ? { metadata } : {}),
        },
      },
    );
  }

  const continueTurnWithProgress = async (
    toolResults: AgentModelToolResult[],
  ): Promise<AgentModelTurn> => {
    modelCallSequence += 1;
    const modelCallLabel = `Executor model call ${modelCallSequence}`;
    const modelCallStartedAt = Date.now();
    const startMetadata = createProgressMetadata({
      executorIteration,
      modelCall: modelCallSequence,
      toolResults: toolResults.length,
    });

    await emitAgentProgress(
      task,
      config,
      "executing",
      `${modelCallLabel} started with ${toolResults.length} tool result(s).`,
      loopState,
      onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "started",
          label: modelCallLabel,
          detail: `Continuing executor iteration ${executorIteration}.`,
          tone: "info",
          provider: config.provider,
          model: config.model,
          ...(startMetadata ? { metadata: startMetadata } : {}),
        },
      },
    );

    let nextTurn: AgentModelTurn;

    try {
      nextTurn = await adapter.continueTurn({
        toolResults,
        ...(signal ? { signal } : {}),
        ...(onStateChange
          ? { onStreamEvent: modelStreamProgress.handleEvent }
          : {}),
      });

      await modelStreamProgress.flush();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const metadata = createProgressMetadata({
        executorIteration,
        modelCall: modelCallSequence,
        durationMs: Date.now() - modelCallStartedAt,
        toolResults: toolResults.length,
      });

      await emitAgentProgress(
        task,
        config,
        "executing",
        `${modelCallLabel} failed.`,
        loopState,
        onStateChange,
        undefined,
        {
          timelineEvent: {
            kind: "model-call",
            phase: "failed",
            label: modelCallLabel,
            detail: message,
            tone: "danger",
            provider: config.provider,
            model: config.model,
            ...(metadata ? { metadata } : {}),
          },
        },
      );
      throw error;
    }

    {
      const metadata = createProgressMetadata({
        executorIteration,
        modelCall: modelCallSequence,
        durationMs: Date.now() - modelCallStartedAt,
        toolResults: toolResults.length,
        toolCalls: nextTurn.toolCalls.length,
        ...(nextTurn.stopReason ? { stopReason: nextTurn.stopReason } : {}),
      });

      await emitAgentProgress(
        task,
        config,
        "executing",
        `${modelCallLabel} completed.`,
        loopState,
        onStateChange,
        undefined,
        {
          timelineEvent: {
            kind: "model-call",
            phase: "completed",
            label: modelCallLabel,
            detail: `Returned ${nextTurn.toolCalls.length} tool call(s).`,
            tone: "success",
            provider: config.provider,
            model: config.model,
            ...(metadata ? { metadata } : {}),
          },
        },
      );
    }

    return nextTurn;
  };
  let lastConsecutiveToolError:
    | {
        signature: string;
        count: number;
      }
    | undefined;

  const executorTurnLimit = resolveRuntimeAgentLimits(config).executorTurns;
  let turnIndex = 0;
  let rejectedPrematureFinalResponse = false;

  while (executorTurnLimit === null || turnIndex < executorTurnLimit) {
    throwIfExecutionAborted(signal);
    turnIndex += 1;

    if (turn.text.trim()) {
      loopState.lastAssistantText = turn.text.trim();
      loopState.traceLines.push(`assistant: ${compactTraceText(turn.text)}`);
    }

    if (turn.toolCalls.length === 0) {
      await emitAgentProgress(
        task,
        config,
        "verifying",
        `Executor iteration ${executorIteration} produced a candidate completion for validation.`,
        loopState,
        onStateChange,
      );

      return {
        loopState,
        result: finalizeUnstructuredModelResponseResult(
          task,
          config,
          loopState,
        ),
      };
    }

    const finalResponseCall = turn.toolCalls.find(
      (call) => call.name === FINAL_RESPONSE_TOOL_NAME,
    );

    if (finalResponseCall) {
      if (turn.toolCalls.length !== 1) {
        turn = await continueTurnWithProgress([
            createFinalResponseToolResult(
              finalResponseCall.id,
              "`submit_final_response` must be the only tool call in its turn.",
              true,
            ),
        ]);
        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected because additional tool calls were present in the same turn.`,
        );
        continue;
      }

      if (
        typeof finalResponseCall.arguments !== "object" ||
        finalResponseCall.arguments === null ||
        Array.isArray(finalResponseCall.arguments)
      ) {
        turn = await continueTurnWithProgress([
            createFinalResponseToolResult(
              finalResponseCall.id,
              "`submit_final_response` requires an object payload that matches the schema.",
              true,
            ),
        ]);
        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected invalid payload shape.`,
        );
        continue;
      }

      const parsedPayload = parseFinalResponsePayload(
        finalResponseCall.arguments as Record<string, unknown>,
      );

      if (!parsedPayload) {
        turn = await continueTurnWithProgress([
            createFinalResponseToolResult(
              finalResponseCall.id,
              "`submit_final_response` payload was missing one or more required fields.",
              true,
            ),
        ]);
        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected incomplete payload.`,
        );
        continue;
      }

      if (
        !rejectedPrematureFinalResponse &&
        shouldRejectPrematureBlockedFinalResponse(
          taskContext,
          loopState,
          parsedPayload.status,
        )
      ) {
        const rejectionMessage = createPrematureBlockedFinalResponseMessage();

        rejectedPrematureFinalResponse = true;
        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected premature blocked response before any tool use.`,
        );
        loopState.outputSections.push({
          title: "Final response guard",
          tone: "warning",
          lines: [rejectionMessage],
        });
        turn = await continueTurnWithProgress([
            createFinalResponseToolResult(
              finalResponseCall.id,
              rejectionMessage,
              true,
            ),
        ]);
        continue;
      }

      loopState.finalResponse = {
        markdown: parsedPayload.markdown,
        highlights: parsedPayload.highlights,
        relatedFiles: parsedPayload.relatedFiles,
        verification: parsedPayload.verification,
        followUps: parsedPayload.followUps,
      };
      loopState.lastAssistantText = parsedPayload.markdown;
      loopState.traceLines.push(
        `${FINAL_RESPONSE_TOOL_NAME}(${parsedPayload.status}): ${compactTraceText(parsedPayload.summary)}`,
      );

      await emitAgentProgress(
        task,
        config,
        "verifying",
        `Executor iteration ${executorIteration} submitted a structured final response for validation.`,
        loopState,
        onStateChange,
      );

      return {
        loopState,
        result:
          parsedPayload.status === "blocked"
            ? finalizeBlockedResult(
                task,
                config,
                loopState,
                parsedPayload.summary,
                parsedPayload.blockerReason,
              )
            : finalizeExecutedResult(
                task,
                config,
                loopState,
                parsedPayload.summary,
              ),
      };
    }

    const toolResults: AgentModelToolResult[] = [];

    for (const call of turn.toolCalls) {
      throwIfExecutionAborted(signal);

      const callSignature = createToolCallSignature(call.name, call.arguments);

      if (
        lastConsecutiveToolError?.signature === callSignature &&
        lastConsecutiveToolError.count >= MAX_CONSECUTIVE_IDENTICAL_TOOL_ERRORS
      ) {
        const repeatedFailureMessage = `The tool call \`${call.name}\` with the same arguments already failed ${lastConsecutiveToolError.count} consecutive time(s) in this executor iteration. Do not retry it unchanged. Change the arguments, inspect more context, switch tools, or explain the blocker.`;

        toolResults.push({
          callId: call.id,
          name: call.name,
          output: repeatedFailureMessage,
          isError: true,
        });
        loopState.traceLines.push(
          `tool_guard: prevented repeated failing call ${call.name} after ${lastConsecutiveToolError.count} consecutive identical error(s).`,
        );
        loopState.outputSections.push({
          title: "Tool retry guard",
          tone: "danger",
          lines: [repeatedFailureMessage],
        });
        lastConsecutiveToolError = {
          signature: callSignature,
          count: lastConsecutiveToolError.count + 1,
        };
        const retryMetadata = createProgressMetadata({
          executorIteration,
          turn: turnIndex,
          retryCount: lastConsecutiveToolError.count,
        });

        await emitAgentProgress(
          task,
          config,
          "executing",
          `Skipped ${formatToolName(call.name)}${createToolTargetPhrase(call)}: repeated unchanged failure.`,
          loopState,
          onStateChange,
          undefined,
          {
            timelineEvent: {
              kind: "retry",
              phase: "skipped",
              label: "Retry guard",
              detail: repeatedFailureMessage,
              tone: "danger",
              toolName: call.name,
              callId: call.id,
              ...(retryMetadata ? { metadata: retryMetadata } : {}),
            },
          },
        );
        continue;
      }

      const requestMessage = createToolRequestProgressMessage(call);
      const requestMetadata = createProgressMetadata({
        executorIteration,
        turn: turnIndex,
        argumentsPreview: compactTraceText(stringifyUnknown(call.arguments)),
      });
      const toolCallStartedAt = Date.now();

      await emitAgentProgress(
        task,
        config,
        "executing",
        requestMessage,
        loopState,
        onStateChange,
        undefined,
        {
          timelineEvent: {
            kind: "tool-call",
            phase: "started",
            label: `Tool call: ${formatToolName(call.name)}`,
            detail: requestMessage,
            tone: "info",
            toolName: call.name,
            callId: call.id,
            ...(requestMetadata ? { metadata: requestMetadata } : {}),
          },
        },
      );

      const executionOutcome = await executeToolCall(
        config,
        conversationContext.memory,
        conversationContext.uiControlEnabled
          ? conversationContext.uiControl
          : undefined,
        toolMap,
        call,
        onActionOutput,
      );

      const result = executionOutcome.result;

      if (!result) {
        continue;
      }

      if (result.toolResult.isError) {
        lastConsecutiveToolError =
          lastConsecutiveToolError?.signature === callSignature
            ? {
                signature: callSignature,
                count: lastConsecutiveToolError.count + 1,
              }
            : {
                signature: callSignature,
                count: 1,
              };
      } else {
        lastConsecutiveToolError = undefined;
      }

      toolResults.push(result.toolResult);
      loopState.traceLines.push(...result.traceLines);
      loopState.outputSections.push(...result.sections);

      if (result.memoryUpdate) {
        loopState.memoryUpdates = upsertMemoryUpdate(
          loopState.memoryUpdates,
          result.memoryUpdate,
        );
      }

      const toolDefinition = toolMap.get(call.name);

      if (
        toolDefinition &&
        !loopState.executedTools.includes(toolDefinition.backingTool) &&
        !result.toolResult.isError
      ) {
        loopState.executedTools.push(toolDefinition.backingTool);
      }

      const resultMessage = createToolResultProgressMessage(call, result);
      const resultMetadata = createProgressMetadata({
        executorIteration,
        turn: turnIndex,
        durationMs: Date.now() - toolCallStartedAt,
        outputPreview: compactTraceText(result.toolResult.output),
      });

      await emitAgentProgress(
        task,
        config,
        "executing",
        resultMessage,
        loopState,
        onStateChange,
        undefined,
        {
          timelineEvent: {
            kind: "tool-call",
            phase: result.toolResult.isError ? "failed" : "completed",
            label: `Tool call: ${formatToolName(call.name)}`,
            detail: resultMessage,
            tone: result.toolResult.isError ? "danger" : "success",
            toolName: call.name,
            callId: call.id,
            ...(resultMetadata ? { metadata: resultMetadata } : {}),
          },
        },
      );
    }

    turn = await continueTurnWithProgress(toolResults);
  }

  return {
    loopState,
    result: finalizeBlockedResult(
      task,
      config,
      loopState,
      "The model-driven execution loop hit its turn limit before reaching a final answer.",
      `Stopped after ${executorTurnLimit} turns to avoid an infinite loop.`,
    ),
  };
};

const runAutopilotMonitorPass = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  cycleResult: ExecutorCycleOutcome,
  priorDecisions: TaskAutopilotDecision[],
  overrideMonitorAdapter: AgentModelAdapter | undefined,
  signal: AbortSignal | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
): Promise<TaskAutopilotDecision> => {
  throwIfExecutionAborted(signal);

  const monitorPass = priorDecisions.length + 1;
  const monitorTool = createAutopilotMonitorTool();
  const reviewConfig = resolveReviewModelRuntimeConfig(config);
  const adapter = await createProviderAdapter(
    reviewConfig,
    [monitorTool],
    overrideMonitorAdapter,
  );

  if (!adapter) {
    throw new Error(
      "Machdoch validation could not start because no monitor model adapter is available.",
    );
  }

  await emitAgentProgress(
    task,
    reviewConfig,
    "monitoring",
    `Validator pass ${monitorPass} is reviewing executor iteration ${priorDecisions.filter((decision) => decision.decision === "continue").length + 1}.`,
    cycleResult.loopState,
    onStateChange,
    undefined,
    {
      timelineEvent: {
        kind: "validator",
        phase: "started",
        label: `Validator pass ${monitorPass}`,
        detail: `Reviewing executor iteration ${priorDecisions.filter((decision) => decision.decision === "continue").length + 1}.`,
        tone: "info",
        metadata: {
          validatorPass: monitorPass,
          executorIteration:
            priorDecisions.filter((decision) => decision.decision === "continue")
              .length + 1,
        },
      },
    },
  );

  const monitorModelCallStartedAt = Date.now();

  await emitAgentProgress(
    task,
    reviewConfig,
    "monitoring",
    `Validator model call ${monitorPass} started.`,
    cycleResult.loopState,
    onStateChange,
    undefined,
    {
      timelineEvent: {
        kind: "model-call",
        phase: "started",
        label: `Validator model call ${monitorPass}`,
        detail: `Starting ${reviewConfig.model} validation pass.`,
        tone: "info",
        provider: reviewConfig.provider,
        model: reviewConfig.model,
        metadata: {
          validatorPass: monitorPass,
        },
      },
    },
  );

  let turn: AgentModelTurn;

  try {
    turn = await adapter.startTurn({
      model: reviewConfig.model,
      systemPrompt: createAutopilotMonitorSystemPrompt(reviewConfig),
      userPrompt: createAutopilotMonitorUserPrompt(
        task,
        taskContext,
        cycleResult,
        priorDecisions,
      ),
      tools: [monitorTool],
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metadata = createProgressMetadata({
      validatorPass: monitorPass,
      durationMs: Date.now() - monitorModelCallStartedAt,
    });

    await emitAgentProgress(
      task,
      reviewConfig,
      "monitoring",
      `Validator model call ${monitorPass} failed.`,
      cycleResult.loopState,
      onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "failed",
          label: `Validator model call ${monitorPass}`,
          detail: message,
          tone: "danger",
          provider: reviewConfig.provider,
          model: reviewConfig.model,
          ...(metadata ? { metadata } : {}),
        },
      },
    );
    throw error;
  }

  {
    const metadata = createProgressMetadata({
      validatorPass: monitorPass,
      durationMs: Date.now() - monitorModelCallStartedAt,
      toolCalls: turn.toolCalls.length,
      ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
    });

    await emitAgentProgress(
      task,
      reviewConfig,
      "monitoring",
      `Validator model call ${monitorPass} completed.`,
      cycleResult.loopState,
      onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "model-call",
          phase: "completed",
          label: `Validator model call ${monitorPass}`,
          detail: `Returned ${turn.toolCalls.length} tool call(s).`,
          tone: "success",
          provider: reviewConfig.provider,
          model: reviewConfig.model,
          ...(metadata ? { metadata } : {}),
        },
      },
    );
  }

  const decision = parseAutopilotDecisionFromTurn(turn, monitorPass);

  if (!decision) {
    await emitAgentProgress(
      task,
      reviewConfig,
      "monitoring",
      `Validator pass ${monitorPass} returned an invalid decision.`,
      cycleResult.loopState,
      onStateChange,
      undefined,
      {
        timelineEvent: {
          kind: "validator",
          phase: "failed",
          label: `Validator pass ${monitorPass}`,
          detail: "Machdoch validation did not return a structured decision.",
          tone: "danger",
          metadata: {
            validatorPass: monitorPass,
          },
        },
      },
    );
    throw new Error(
      "Machdoch validation did not return a structured decision.",
    );
  }

  await emitAgentProgress(
    task,
    reviewConfig,
    "monitoring",
    decision.decision === "complete"
      ? `Validator pass ${monitorPass} accepted the task as complete.`
      : `Validator pass ${monitorPass} requested continuation: ${decision.rationale}`,
    cycleResult.loopState,
    onStateChange,
    undefined,
    {
      timelineEvent: {
        kind: "validator",
        phase:
          decision.decision === "complete"
            ? "passed"
            : "requested-continuation",
        label: `Validator pass ${monitorPass}`,
        detail: decision.rationale,
        tone: decision.decision === "complete" ? "success" : "warning",
        metadata: {
          validatorPass: monitorPass,
          confidence: decision.confidence,
          missingRequirements: decision.missingRequirements.length,
          requiredActions: decision.requiredActions.length,
        },
      },
    },
  );

  return decision;
};

const runModelDrivenLoop = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  imageInputs: ModelDrivenExecutionParams["imageInputs"],
  executorAdapter: AgentModelAdapter | undefined,
  monitorAdapter: AgentModelAdapter | undefined,
  signal: AbortSignal | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
  onActionOutput: TaskActionOutputHandler | undefined,
): Promise<TaskExecutionResult> => {
  let cycleResult = await runExecutorCycle(
    task,
    config,
    taskContext,
    contextSections,
    conversationContext,
    imageInputs,
    executorAdapter,
    undefined,
    signal,
    onStateChange,
    onActionOutput,
  );
  let executorIterations = 1;
  const decisions: TaskAutopilotDecision[] = [];
  const autopilotExecutorIterationLimit =
    resolveRuntimeAgentLimits(config).autopilotExecutorIterations;

  if (config.mode !== "machdoch" || cycleResult.result.status !== "executed") {
    return cycleResult.result;
  }

  while (true) {
    const buildAutopilotReport = (): TaskAutopilotReport => ({
      executorIterations,
      validatorPasses: decisions.length,
      continuationCount: decisions.filter(
        (decision) => decision.decision === "continue",
      ).length,
      maxExecutorIterations: autopilotExecutorIterationLimit,
      decisions: [...decisions],
    });

    let decision: TaskAutopilotDecision;

    try {
      decision = await runAutopilotMonitorPass(
        task,
        config,
        taskContext,
        cycleResult,
        decisions,
        monitorAdapter,
        signal,
        onStateChange,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return attachAutopilotReport(
        finalizeBlockedResult(
          task,
          config,
          cycleResult.loopState,
          "Machdoch validation could not complete because the monitor step failed.",
          message,
        ),
        buildAutopilotReport(),
      );
    }

    decisions.push(decision);
    const autopilotReport = buildAutopilotReport();

    if (decision.decision === "complete") {
      return attachAutopilotReport(cycleResult.result, autopilotReport);
    }

    if (
      autopilotExecutorIterationLimit !== null &&
      executorIterations >= autopilotExecutorIterationLimit
    ) {
      return attachAutopilotReport(
        finalizeBlockedResult(
          task,
          config,
          cycleResult.loopState,
          "Machdoch reached its continuation limit before the monitor could verify completion.",
          `The monitor requested more work after ${executorIterations} executor iteration(s). Last rationale: ${decision.rationale}`,
        ),
        autopilotReport,
      );
    }

    cycleResult = await runExecutorCycle(
      task,
      config,
      taskContext,
      contextSections,
      conversationContext,
      imageInputs,
      executorAdapter,
      {
        continuationIndex: autopilotReport.continuationCount,
        rationale: decision.rationale,
        missingRequirements: decision.missingRequirements,
        requiredActions: decision.requiredActions,
      },
      signal,
      onStateChange,
      onActionOutput,
    );
    executorIterations += 1;

    if (cycleResult.result.status !== "executed") {
      return attachAutopilotReport(cycleResult.result, buildAutopilotReport());
    }
  }
};

const shouldAttemptModelExecution = (
  config: RuntimeConfig,
  overrideAdapter: AgentModelAdapter | undefined,
): boolean => {
  if (overrideAdapter) {
    return true;
  }

  if (config.offline || config.provider === "unconfigured") {
    return false;
  }

  return config.providerAvailability.some(
    (entry) => entry.provider === config.provider && entry.configured,
  );
};

export const maybeExecuteModelDrivenTask = async (
  params: ModelDrivenExecutionParams,
): Promise<TaskExecutionResult | undefined> => {
  if (!shouldAttemptModelExecution(params.config, params.modelAdapter)) {
    return undefined;
  }

  try {
    const preparedConversationContext = await prepareConversationPromptContext(
      params.task,
      params.config,
      params.conversationContext,
      params.signal,
    );

    return await runModelDrivenLoop(
      params.task,
      params.config,
      params.taskContext,
      params.contextSections,
      preparedConversationContext,
      params.imageInputs,
      params.modelAdapter,
      params.monitorModelAdapter,
      params.signal,
      params.onStateChange,
      params.onActionOutput,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return createExecutionResult(
      {
        task: params.task,
        mode: params.config.mode,
        status: "blocked",
        summary:
          "Model-driven execution could not start or continue because the provider request failed.",
        executedTools: [],
        outputSections: [
          ...params.contextSections,
          {
            title: "Model runtime error",
            lines: [message],
          },
        ],
      },
      message,
    );
  }
};
