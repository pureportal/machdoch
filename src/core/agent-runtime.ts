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
  MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
  MAX_EXECUTOR_TURNS,
  type AgentLoopState,
  type ExecutorContinuationRequest,
  type ExecutorCycleOutcome,
  type ModelDrivenExecutionParams,
} from "./_helpers/agent-runtime-types.js";
import {
  createToolDefinitions,
  executeToolCall,
  type ApprovalPause,
} from "./_helpers/agent-tools.js";
import {
  prepareConversationPromptContext,
  type PreparedConversationPromptContext,
} from "./_helpers/conversation-prompt-context.js";
import { createProviderAdapter } from "./_helpers/provider-adapters.js";
import { compactTraceText } from "./_helpers/runtime-text.js";
import type {
  AgentModelAdapter,
  AgentModelToolResult,
  ResolvedTaskContext,
  RuntimeConfig,
  TaskAutopilotDecision,
  TaskAutopilotReport,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionSection,
} from "./types.js";

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

const finalizeApprovalResult = (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopState,
  pause: ApprovalPause,
): TaskExecutionResult => {
  return createExecutionResult(
    {
      task,
      mode: config.mode,
      status: "approval-required",
      summary: pause.summary,
      executedTools: loopState.executedTools,
      outputSections: pause.outputSections,
    },
    pause.reason,
  );
};

const runExecutorCycle = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  overrideAdapter: AgentModelAdapter | undefined,
  continuationRequest: ExecutorContinuationRequest | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
): Promise<ExecutorCycleOutcome> => {
  const toolDefinitions = createToolDefinitions(
    config,
    conversationContext.memory,
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

  await emitAgentProgress(
    task,
    config,
    "executing",
    continuationRequest
      ? `Executor iteration ${executorIteration} started with monitor feedback from continuation ${continuationRequest.continuationIndex}.`
      : "Executor iteration 1 started.",
    loopState,
    onStateChange,
  );

  let turn = await adapter.startTurn({
    model: config.model,
    systemPrompt: createExecutorSystemPrompt(
      config,
      taskContext,
      toolSpecs,
      conversationContext,
      continuationRequest,
    ),
    userPrompt: createExecutorUserPrompt(
      task,
      taskContext,
      conversationContext,
      continuationRequest,
    ),
    tools: toolSpecs,
  });

  for (let turnIndex = 0; turnIndex < MAX_EXECUTOR_TURNS; turnIndex += 1) {
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
        result: finalizeExecutedResult(task, config, loopState),
      };
    }

    const finalResponseCall = turn.toolCalls.find(
      (call) => call.name === FINAL_RESPONSE_TOOL_NAME,
    );

    if (finalResponseCall) {
      if (turn.toolCalls.length !== 1) {
        turn = await adapter.continueTurn({
          toolResults: [
            createFinalResponseToolResult(
              finalResponseCall.id,
              "`submit_final_response` must be the only tool call in its turn.",
              true,
            ),
          ],
        });
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
        turn = await adapter.continueTurn({
          toolResults: [
            createFinalResponseToolResult(
              finalResponseCall.id,
              "`submit_final_response` requires an object payload that matches the schema.",
              true,
            ),
          ],
        });
        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected invalid payload shape.`,
        );
        continue;
      }

      const parsedPayload = parseFinalResponsePayload(
        finalResponseCall.arguments as Record<string, unknown>,
      );

      if (!parsedPayload) {
        turn = await adapter.continueTurn({
          toolResults: [
            createFinalResponseToolResult(
              finalResponseCall.id,
              "`submit_final_response` payload was missing one or more required fields.",
              true,
            ),
          ],
        });
        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected incomplete payload.`,
        );
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
        `${FINAL_RESPONSE_TOOL_NAME}: ${compactTraceText(parsedPayload.summary)}`,
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
        result: finalizeExecutedResult(
          task,
          config,
          loopState,
          parsedPayload.summary,
        ),
      };
    }

    const toolResults: AgentModelToolResult[] = [];

    for (const call of turn.toolCalls) {
      const executionOutcome = await executeToolCall(
        task,
        config,
        loopState,
        conversationContext.memory,
        toolMap,
        call,
      );

      if (executionOutcome.approvalPause) {
        return {
          loopState,
          result: finalizeApprovalResult(
            task,
            config,
            loopState,
            executionOutcome.approvalPause,
          ),
        };
      }

      const result = executionOutcome.result;

      if (!result) {
        continue;
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
    }

    turn = await adapter.continueTurn({ toolResults });
  }

  return {
    loopState,
    result: finalizeBlockedResult(
      task,
      config,
      loopState,
      "The model-driven execution loop hit its turn limit before reaching a final answer.",
      `Stopped after ${MAX_EXECUTOR_TURNS} turns to avoid an infinite loop.`,
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
  onStateChange: TaskExecutionProgressHandler | undefined,
): Promise<TaskAutopilotDecision> => {
  const monitorPass = priorDecisions.length + 1;
  const monitorTool = createAutopilotMonitorTool();
  const adapter = await createProviderAdapter(
    config,
    [monitorTool],
    overrideMonitorAdapter,
  );

  if (!adapter) {
    throw new Error(
      "Autopilot validation could not start because no monitor model adapter is available.",
    );
  }

  await emitAgentProgress(
    task,
    config,
    "monitoring",
    `Validator pass ${monitorPass} is reviewing executor iteration ${priorDecisions.filter((decision) => decision.decision === "continue").length + 1}.`,
    cycleResult.loopState,
    onStateChange,
  );

  const turn = await adapter.startTurn({
    model: config.model,
    systemPrompt: createAutopilotMonitorSystemPrompt(config),
    userPrompt: createAutopilotMonitorUserPrompt(
      task,
      taskContext,
      cycleResult,
      priorDecisions,
    ),
    tools: [monitorTool],
  });

  const decision = parseAutopilotDecisionFromTurn(turn, monitorPass);

  if (!decision) {
    throw new Error(
      "Autopilot validation did not return a structured decision.",
    );
  }

  await emitAgentProgress(
    task,
    config,
    "monitoring",
    decision.decision === "complete"
      ? `Validator pass ${monitorPass} accepted the task as complete.`
      : `Validator pass ${monitorPass} requested continuation: ${decision.rationale}`,
    cycleResult.loopState,
    onStateChange,
  );

  return decision;
};

const runModelDrivenLoop = async (
  task: string,
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  contextSections: TaskExecutionSection[],
  conversationContext: PreparedConversationPromptContext,
  executorAdapter: AgentModelAdapter | undefined,
  monitorAdapter: AgentModelAdapter | undefined,
  onStateChange: TaskExecutionProgressHandler | undefined,
): Promise<TaskExecutionResult> => {
  let cycleResult = await runExecutorCycle(
    task,
    config,
    taskContext,
    contextSections,
    conversationContext,
    executorAdapter,
    undefined,
    onStateChange,
  );
  let executorIterations = 1;
  const decisions: TaskAutopilotDecision[] = [];

  if (config.mode !== "auto" || cycleResult.result.status !== "executed") {
    return cycleResult.result;
  }

  while (true) {
    const buildAutopilotReport = (): TaskAutopilotReport => ({
      executorIterations,
      validatorPasses: decisions.length,
      continuationCount: decisions.filter(
        (decision) => decision.decision === "continue",
      ).length,
      maxExecutorIterations: MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
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
        onStateChange,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return attachAutopilotReport(
        finalizeBlockedResult(
          task,
          config,
          cycleResult.loopState,
          "Autopilot validation could not complete because the monitor step failed.",
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

    if (executorIterations >= MAX_AUTOPILOT_EXECUTOR_ITERATIONS) {
      return attachAutopilotReport(
        finalizeBlockedResult(
          task,
          config,
          cycleResult.loopState,
          "Autopilot reached its continuation limit before the monitor could verify completion.",
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
      executorAdapter,
      {
        continuationIndex: autopilotReport.continuationCount,
        rationale: decision.rationale,
        missingRequirements: decision.missingRequirements,
        requiredActions: decision.requiredActions,
      },
      onStateChange,
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
    );

    return await runModelDrivenLoop(
      params.task,
      params.config,
      params.taskContext,
      params.contextSections,
      preparedConversationContext,
      params.modelAdapter,
      params.monitorModelAdapter,
      params.onStateChange,
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
