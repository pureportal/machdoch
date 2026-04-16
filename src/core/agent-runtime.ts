import type {
  AgentModelAdapter,
  AgentModelToolResult,
  AgentModelToolSpec,
  AgentModelTurn,
  ResolvedTaskContext,
  RuntimeConfig,
  TaskAutopilotDecision,
  TaskAutopilotReport,
  TaskConversationContext,
  TaskExecutionFileReference,
  TaskExecutionMemoryUpdate,
  TaskExecutionNarrative,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionSection,
  TaskExecutionState,
  ToolName,
} from "./types.js";
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

const MAX_EXECUTOR_TURNS = 16;
const MAX_AUTOPILOT_EXECUTOR_ITERATIONS = 4;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_PREVIEW_LINES = 80;
const TOOL_TRACE_PREVIEW_CHARS = 220;

interface AgentLoopState {
  executedTools: ToolName[];
  outputSections: TaskExecutionSection[];
  traceLines: string[];
  memoryUpdates: TaskExecutionMemoryUpdate[];
  lastAssistantText?: string;
  finalResponse?: TaskExecutionNarrative;
}

interface TaskFinalResponsePayload extends TaskExecutionNarrative {
  summary: string;
}
const MAX_FINAL_RESPONSE_ITEMS = 4;

interface ModelDrivenExecutionParams {
  task: string;
  config: RuntimeConfig;
  taskContext: ResolvedTaskContext;
  contextSections: TaskExecutionSection[];
  conversationContext?: TaskConversationContext;
  modelAdapter?: AgentModelAdapter;
  monitorModelAdapter?: AgentModelAdapter;
  onStateChange?: TaskExecutionProgressHandler;
}

interface ExecutorContinuationRequest {
  continuationIndex: number;
  rationale: string;
  missingRequirements: string[];
  requiredActions: string[];
}

interface ExecutorCycleOutcome {
  loopState: AgentLoopState;
  result: TaskExecutionResult;
}

const createExecutionResult = (
  base: Omit<TaskExecutionResult, "reason">,
  reason?: string,
): TaskExecutionResult => {
  return {
    ...base,
    ...(reason ? { reason } : {}),
  };
};

const isTerminalAgentProgressState = (state: TaskExecutionState): boolean => {
  return (
    state === "completed" ||
    state === "approval-required" ||
    state === "blocked" ||
    state === "unsupported" ||
    state === "cancelled"
  );
};

const emitAgentProgress = async (
  task: string,
  config: RuntimeConfig,
  state: TaskExecutionState,
  message: string,
  loopState: AgentLoopState,
  onStateChange: TaskExecutionProgressHandler | undefined,
  result?: TaskExecutionResult,
): Promise<void> => {
  if (!onStateChange) {
    return;
  }

  await onStateChange({
    task,
    mode: config.mode,
    state,
    message,
    executedTools: result?.executedTools ?? loopState.executedTools,
    outputSections: result?.outputSections ?? loopState.outputSections,
    cancellable: !isTerminalAgentProgressState(state),
    ...(result?.reason ? { reason: result.reason } : {}),
  });
};

const createLinesFromText = (
  text: string,
  maxLines = MAX_PREVIEW_LINES,
  startLine = 1,
): string[] => {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const previewLines = lines
    .slice(0, maxLines)
    .map((line, index) => `${startLine + index}: ${line}`);

  if (lines.length > maxLines) {
    previewLines.push(`… truncated after ${maxLines} of ${lines.length} lines`);
  }

  return previewLines;
};

const createTextSection = (
  title: string,
  text: string,
  maxLines = MAX_PREVIEW_LINES,
  startLine = 1,
): TaskExecutionSection => {
  const previewLines = createLinesFromText(text, maxLines, startLine);

  return {
    title,
    lines: previewLines.length > 0 ? previewLines : ["(empty)"],
  };
};

const limitText = (value: string, maxChars = MAX_OUTPUT_CHARS): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n… truncated after ${maxChars} characters`;
};

const compactTraceText = (value: string): string => {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= TOOL_TRACE_PREVIEW_CHARS) {
    return compacted;
  }

  return `${compacted.slice(0, TOOL_TRACE_PREVIEW_CHARS)}…`;
};

const normalizeFinalSummary = (text: string | undefined): string => {
  const normalized = text?.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "Completed the task with the model-driven execution loop.";
  }

  if (normalized.length <= 220) {
    return normalized;
  }

  return `${normalized.slice(0, 220)}…`;
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

const coerceString = (
  record: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = record[field];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const coerceStringArray = (
  record: Record<string, unknown>,
  field: string,
): string[] | undefined => {
  const value = record[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
};

const coerceFileReferenceArray = (
  record: Record<string, unknown>,
  field: string,
): TaskExecutionFileReference[] | undefined => {
  const value = record[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const reference = entry as Record<string, unknown>;
    const path = coerceString(reference, "path");
    const description = coerceString(reference, "description");

    if (!path || !description) {
      return [];
    }

    return [{ path, description }];
  });
};

const upsertMemoryUpdate = (
  updates: TaskExecutionMemoryUpdate[],
  nextUpdate: TaskExecutionMemoryUpdate,
): TaskExecutionMemoryUpdate[] => {
  const existingWithoutScope = updates.filter(
    (update) =>
      !(
        update.scope === nextUpdate.scope &&
        update.entry.content.toLowerCase() ===
          nextUpdate.entry.content.toLowerCase()
      ),
  );

  return [...existingWithoutScope, nextUpdate];
};

const FINAL_RESPONSE_TOOL_NAME = "submit_final_response";

const createAutopilotAuditSection = (
  report: TaskAutopilotReport,
): TaskExecutionSection => {
  return {
    title: "Autopilot audit",
    lines: [
      `executor iterations: ${report.executorIterations}/${report.maxExecutorIterations}`,
      `validator passes: ${report.validatorPasses}`,
      `validator continuation requests: ${report.continuationCount}`,
      ...report.decisions.flatMap((decision) => [
        `pass ${decision.pass}: ${decision.decision} (${decision.confidence})`,
        `  rationale: ${decision.rationale}`,
        ...(decision.missingRequirements.length > 0
          ? [
              `  missing requirements: ${decision.missingRequirements.join(", ")}`,
            ]
          : []),
        ...(decision.requiredActions.length > 0
          ? [`  required actions: ${decision.requiredActions.join(", ")}`]
          : []),
      ]),
    ],
  };
};

const createFinalResponseTool = (): AgentModelToolSpec => {
  return {
    name: FINAL_RESPONSE_TOOL_NAME,
    description:
      "Submit the final user-facing response after the task is actually complete. Call this exactly once, as the only tool in the turn, when no further execution is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description:
            "A concise plain-text completion summary for the activity feed and task card.",
        },
        markdown: {
          type: "string",
          description:
            "A compact GitHub-flavored Markdown answer for the user. Keep it brief, scannable, and grounded in actual tool results.",
        },
        highlights: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Short insight bullets that add value beyond the summary. Use an empty array when no extra highlights are needed.",
        },
        relatedFiles: {
          type: "array",
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Workspace-relative files that were changed or are especially relevant to the result.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                description: "Workspace-relative file path.",
              },
              description: {
                type: "string",
                description: "Short explanation of why the file matters.",
              },
            },
            required: ["path", "description"],
          },
        },
        verification: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Concrete checks or evidence used to verify the result. Use an empty array when verification was not possible.",
        },
        followUps: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Short remaining caveats or next steps. Use an empty array when none remain.",
        },
      },
      required: [
        "summary",
        "markdown",
        "highlights",
        "relatedFiles",
        "verification",
        "followUps",
      ],
    },
  };
};

const parseFinalResponsePayload = (
  record: Record<string, unknown>,
): TaskFinalResponsePayload | undefined => {
  const summary = coerceString(record, "summary");
  const markdown = coerceString(record, "markdown");
  const highlights = coerceStringArray(record, "highlights");
  const relatedFiles = coerceFileReferenceArray(record, "relatedFiles");
  const verification = coerceStringArray(record, "verification");
  const followUps = coerceStringArray(record, "followUps");

  if (
    !summary ||
    !markdown ||
    !highlights ||
    !relatedFiles ||
    !verification ||
    !followUps
  ) {
    return undefined;
  }

  return {
    summary,
    markdown,
    highlights,
    relatedFiles,
    verification,
    followUps,
  };
};

const createFinalResponseSections = (
  response: TaskExecutionNarrative,
): TaskExecutionSection[] => {
  return [
    createTextSection("Agent response", limitText(response.markdown)),
    ...(response.highlights.length > 0
      ? [
          {
            title: "Highlights",
            lines: response.highlights,
          },
        ]
      : []),
    ...(response.relatedFiles.length > 0
      ? [
          {
            title: "Related files",
            lines: response.relatedFiles.map(
              (fileReference) =>
                `${fileReference.path} — ${fileReference.description}`,
            ),
          },
        ]
      : []),
    ...(response.verification.length > 0
      ? [
          {
            title: "Verification",
            lines: response.verification,
          },
        ]
      : []),
    ...(response.followUps.length > 0
      ? [
          {
            title: "Follow-up",
            lines: response.followUps,
          },
        ]
      : []),
  ];
};

const createFinalResponseToolResult = (
  callId: string,
  output: string,
  isError = false,
): AgentModelToolResult => {
  return {
    callId,
    name: FINAL_RESPONSE_TOOL_NAME,
    output,
    ...(isError ? { isError: true } : {}),
  };
};

const createAssistantAnswerSection = (text: string): TaskExecutionSection => {
  return createTextSection("Agent answer", limitText(text));
};

const createExecutorSystemPrompt = (
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  tools: AgentModelToolSpec[],
  conversationContext: PreparedConversationPromptContext,
  continuationRequest?: ExecutorContinuationRequest,
): string => {
  const instructionLines =
    taskContext.applicableInstructions.length > 0
      ? taskContext.applicableInstructions.map(
          (instruction) => `${instruction.name}: ${instruction.body}`,
        )
      : ["No additional task-specific instructions were discovered."];
  const promptContextLines = taskContext.invokedPrompt
    ? [
        `Resolved prompt: /${taskContext.invokedPrompt.name}`,
        `Prompt body: ${taskContext.invokedPrompt.resolvedBody}`,
      ]
    : ["Resolved prompt: none"];

  return [
    "<role>You are Machdoch Executor, a local-first autonomous workspace agent responsible for doing the work rather than grading it.</role>",
    "<mission>Keep working until the task is complete, blocked by a real runtime limitation, or paused for approval. Use tools instead of guessing, and never claim a change, command, or fetched result unless a tool actually produced it.</mission>",
    "<operating_principles>Prefer low-risk inspection before edits. Before editing an existing file, inspect it first. Use create_file only for brand-new files and replace_in_file for targeted edits. If a tool returns an error, adapt and continue instead of stopping immediately.</operating_principles>",
    config.mode === "auto"
      ? "<autopilot_contract>You are running in Autopilot mode. A separate monitor agent will review every claimed completion. Before you stop, gather concrete verification evidence from tool results. If monitor feedback is provided, treat every missing requirement and required action as mandatory for the next iteration.</autopilot_contract>"
      : "<approval_contract>If a higher-risk action is necessary, call the tool anyway; the runtime will pause automatically if approval is required.</approval_contract>",
    continuationRequest
      ? [
          "<monitor_feedback>",
          `This is continuation iteration ${continuationRequest.continuationIndex}.`,
          `Rationale: ${continuationRequest.rationale}`,
          continuationRequest.missingRequirements.length > 0
            ? `Missing requirements: ${continuationRequest.missingRequirements.join(", ")}`
            : "Missing requirements: none listed",
          continuationRequest.requiredActions.length > 0
            ? `Required actions: ${continuationRequest.requiredActions.join(", ")}`
            : "Required actions: none listed",
          "You must address this feedback before claiming completion again.",
          "</monitor_feedback>",
        ].join("\n")
      : "<monitor_feedback>No prior monitor feedback has been issued for this task.</monitor_feedback>",
    [
      "<runtime>",
      `Workspace root: ${config.workspaceRoot}`,
      `Runtime mode: ${config.mode}`,
      `Selected provider: ${config.provider}`,
      `Selected model: ${config.model}`,
      `Enabled high-level tools: ${config.enabledTools.join(", ")}`,
      `Available agent tools: ${tools.map((tool) => tool.name).join(", ")}`,
      ...promptContextLines,
      "</runtime>",
    ].join("\n"),
    ["<instructions>", ...instructionLines, "</instructions>"].join("\n"),
    [
      "<memory_contract>",
      conversationContext.memory.sessionEnabled
        ? "Session memory is enabled. Use `remember_session_memory` for facts, preferences, or decisions that should matter later in this same session."
        : "Session memory is disabled for this run.",
      conversationContext.memory.globalEnabled
        ? "Global memory is enabled. Use `remember_global_memory` only for durable cross-session preferences or facts that will still matter in later sessions."
        : "Global memory is disabled for this run.",
      "Never store transient tool output, secrets, or speculative guesses as memory.",
      "</memory_contract>",
    ].join("\n"),
    "<final_response_contract>When the task is complete, call `submit_final_response` exactly once and make it the only tool call in that turn. The markdown must stay compact, use standard Markdown, prefer short bullet lists over long prose, and only mention files or checks that are grounded in actual tool output. Put workspace file references in `relatedFiles` instead of inventing inline file URLs.</final_response_contract>",
    "<completion_requirements>Only stop when the user request is actually satisfied and you have tool-grounded evidence for that conclusion. Do not end with freeform prose alone when you can return the structured final response.</completion_requirements>",
  ].join("\n\n");
};

const createExecutorUserPrompt = (
  task: string,
  taskContext: ResolvedTaskContext,
  conversationContext: PreparedConversationPromptContext,
  continuationRequest?: ExecutorContinuationRequest,
): string => {
  return [
    `<original_task>${task}</original_task>`,
    `<effective_task>${taskContext.effectiveTask}</effective_task>`,
    `<workspace_paths>${taskContext.workspacePaths.length > 0 ? taskContext.workspacePaths.join(", ") : "none"}</workspace_paths>`,
    continuationRequest
      ? `<current_goal>Continue the task and satisfy the monitor feedback from continuation ${continuationRequest.continuationIndex}.</current_goal>`
      : "<current_goal>Complete the task by using tools, checking the results, and continuing until the work is done.</current_goal>",
    ...(conversationContext.promptBlock
      ? [conversationContext.promptBlock]
      : []),
  ].join("\n");
};

const AUTOPILOT_MONITOR_TOOL_NAME = "report_autopilot_decision";

const createAutopilotMonitorTool = (): AgentModelToolSpec => {
  return {
    name: AUTOPILOT_MONITOR_TOOL_NAME,
    description:
      "Return the structured validation decision for the latest executor iteration. Call this exactly once after reviewing the grounded evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: {
          type: "string",
          enum: ["complete", "continue"],
          description:
            "Use `complete` only when the user request is fully satisfied with sufficient evidence. Otherwise use `continue`.",
        },
        confidence: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Your confidence in the validation judgment.",
        },
        rationale: {
          type: "string",
          description:
            "A concise explanation referencing grounded evidence or missing evidence.",
        },
        missingRequirements: {
          type: "array",
          items: { type: "string" },
          description:
            "Concrete requirements that are still unmet or not yet verified.",
        },
        requiredActions: {
          type: "array",
          items: { type: "string" },
          description:
            "Concrete next actions the executor should take before the task can be accepted.",
        },
      },
      required: [
        "decision",
        "confidence",
        "rationale",
        "missingRequirements",
        "requiredActions",
      ],
    },
  };
};

const extractJsonCandidate = (value: string): string | undefined => {
  const trimmed = value.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const startIndex = trimmed.indexOf("{");
  const endIndex = trimmed.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }

  return trimmed.slice(startIndex, endIndex + 1);
};

const parseAutopilotDecisionRecord = (
  record: Record<string, unknown>,
  pass: number,
): TaskAutopilotDecision | undefined => {
  const decision = coerceString(record, "decision");
  const confidence = coerceString(record, "confidence");
  const rationale = coerceString(record, "rationale");
  const missingRequirements = coerceStringArray(record, "missingRequirements");
  const requiredActions = coerceStringArray(record, "requiredActions");

  if (
    (decision !== "complete" && decision !== "continue") ||
    (confidence !== "low" &&
      confidence !== "medium" &&
      confidence !== "high") ||
    !rationale ||
    !missingRequirements ||
    !requiredActions
  ) {
    return undefined;
  }

  return {
    pass,
    decision,
    confidence,
    rationale,
    missingRequirements,
    requiredActions,
  };
};

const parseAutopilotDecisionFromTurn = (
  turn: AgentModelTurn,
  pass: number,
): TaskAutopilotDecision | undefined => {
  const toolCall = turn.toolCalls.find(
    (call) => call.name === AUTOPILOT_MONITOR_TOOL_NAME,
  );

  if (toolCall) {
    return parseAutopilotDecisionRecord(toolCall.arguments, pass);
  }

  const jsonCandidate = extractJsonCandidate(turn.text);

  if (!jsonCandidate) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    return parseAutopilotDecisionRecord(
      parsed as Record<string, unknown>,
      pass,
    );
  } catch {
    return undefined;
  }
};

const createSectionTranscript = (
  sections: TaskExecutionSection[],
  maxChars = 6_000,
): string => {
  return limitText(
    sections
      .map((section) => `## ${section.title}\n${section.lines.join("\n")}`)
      .join("\n\n"),
    maxChars,
  );
};

const createAutopilotMonitorSystemPrompt = (config: RuntimeConfig): string => {
  return [
    "<role>You are Machdoch Monitor, a separate validator agent that judges whether the executor fully satisfied the user's request.</role>",
    "<review_contract>Be strict about grounded evidence. Do not accept work because it sounds plausible. If requirements are partially satisfied, not verified, or only implied, choose continue. Call the structured report_autopilot_decision tool exactly once.</review_contract>",
    "<safety_rules>Only use `complete` when the user's request is fully satisfied within the current workspace and tool policy boundaries. Prefer a continuation request over a false positive. Required actions must be concrete, minimal, and testable.</safety_rules>",
    [
      "<runtime>",
      `Workspace root: ${config.workspaceRoot}`,
      `Runtime mode: ${config.mode}`,
      `Selected provider: ${config.provider}`,
      `Selected model: ${config.model}`,
      "</runtime>",
    ].join("\n"),
  ].join("\n\n");
};

const createAutopilotMonitorUserPrompt = (
  task: string,
  taskContext: ResolvedTaskContext,
  cycleResult: ExecutorCycleOutcome,
  priorDecisions: TaskAutopilotDecision[],
): string => {
  const priorDecisionLines =
    priorDecisions.length > 0
      ? priorDecisions.flatMap((decision) => [
          `Pass ${decision.pass}: ${decision.decision} (${decision.confidence})`,
          `Rationale: ${decision.rationale}`,
          ...(decision.missingRequirements.length > 0
            ? [
                `Missing requirements: ${decision.missingRequirements.join(", ")}`,
              ]
            : []),
          ...(decision.requiredActions.length > 0
            ? [`Required actions: ${decision.requiredActions.join(", ")}`]
            : []),
        ])
      : ["No prior validator decisions."];

  return [
    `<original_task>${task}</original_task>`,
    `<effective_task>${taskContext.effectiveTask}</effective_task>`,
    `<executor_summary>${cycleResult.result.summary}</executor_summary>`,
    `<executed_tools>${cycleResult.result.executedTools.join(", ") || "none"}</executed_tools>`,
    `<assistant_answer>${cycleResult.loopState.lastAssistantText ?? "(none)"}</assistant_answer>`,
    `<prior_validator_history>${priorDecisionLines.join("\n")}</prior_validator_history>`,
    `<grounded_evidence>${createSectionTranscript(cycleResult.result.outputSections)}</grounded_evidence>`,
    "<decision_rule>Return `continue` if any user requirement appears incomplete, unverified, or contradicted by the evidence. Return `complete` only when the evidence shows the task is done as requested.</decision_rule>",
  ].join("\n\n");
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
  const systemPrompt = createExecutorSystemPrompt(
    config,
    taskContext,
    toolSpecs,
    conversationContext,
    continuationRequest,
  );
  const userPrompt = createExecutorUserPrompt(
    task,
    taskContext,
    conversationContext,
    continuationRequest,
  );
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
    systemPrompt,
    userPrompt,
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
        const toolResults = [
          createFinalResponseToolResult(
            finalResponseCall.id,
            "`submit_final_response` must be the only tool call in its turn.",
            true,
          ),
        ];

        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected because additional tool calls were present in the same turn.`,
        );
        turn = await adapter.continueTurn({ toolResults });
        continue;
      }

      if (
        typeof finalResponseCall.arguments !== "object" ||
        finalResponseCall.arguments === null ||
        Array.isArray(finalResponseCall.arguments)
      ) {
        const toolResults = [
          createFinalResponseToolResult(
            finalResponseCall.id,
            "`submit_final_response` requires an object payload that matches the schema.",
            true,
          ),
        ];

        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected invalid payload shape.`,
        );
        turn = await adapter.continueTurn({ toolResults });
        continue;
      }

      const parsedPayload = parseFinalResponsePayload(
        finalResponseCall.arguments as Record<string, unknown>,
      );

      if (!parsedPayload) {
        const toolResults = [
          createFinalResponseToolResult(
            finalResponseCall.id,
            "`submit_final_response` payload was missing one or more required fields.",
            true,
          ),
        ];

        loopState.traceLines.push(
          `${FINAL_RESPONSE_TOOL_NAME}: rejected incomplete payload.`,
        );
        turn = await adapter.continueTurn({ toolResults });
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
