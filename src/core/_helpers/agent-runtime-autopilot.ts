import type {
  AgentModelToolSpec,
  AgentModelTurn,
  ResolvedTaskContext,
  RuntimeConfig,
  TaskAutopilotDecision,
  TaskAutopilotReport,
  TaskExecutionSection,
} from "../types.js";
import {
  createHostElevationRuntimeLine,
  inferTaskStrategyProfile,
} from "./agent-runtime-executor-prompts.js";
import { coerceString, coerceStringArray } from "./agent-runtime-shared.js";
import type { ExecutorCycleOutcome } from "./agent-runtime-types.js";
import { limitText } from "./runtime-text.js";

export const AUTOPILOT_MONITOR_TOOL_NAME = "report_autopilot_decision";

export const createAutopilotAuditSection = (
  report: TaskAutopilotReport,
): TaskExecutionSection => {
  const maxExecutorIterations =
    report.maxExecutorIterations === null
      ? "unlimited"
      : String(report.maxExecutorIterations);

  return {
    title: "Machdoch review",
    audience: "internal",
    lines: [
      `executor iterations: ${report.executorIterations}/${maxExecutorIterations}`,
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

export const createAutopilotMonitorTool = (): AgentModelToolSpec => {
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

export const parseAutopilotDecisionFromTurn = (
  turn: AgentModelTurn,
  pass: number,
): TaskAutopilotDecision | undefined => {
  const toolCall = turn.toolCalls.find(
    (call) => call.name === AUTOPILOT_MONITOR_TOOL_NAME,
  );

  return toolCall
    ? parseAutopilotDecisionRecord(toolCall.arguments, pass)
    : undefined;
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

const createTraceTranscript = (
  traceLines: string[],
  maxChars = 4_000,
): string => {
  if (traceLines.length === 0) {
    return "(no tool trace recorded)";
  }

  return limitText(traceLines.join("\n"), maxChars);
};

export const createAutopilotMonitorSystemPrompt = (
  config: RuntimeConfig,
): string => {
  return [
    "<role>You are Machdoch Monitor, a separate validator agent that judges whether the executor fully satisfied the user's request.</role>",
    "<review_contract>Be strict about grounded evidence. Do not accept work because it sounds plausible. If requirements are partially satisfied, not verified, or only implied, choose continue. Call the structured report_autopilot_decision tool exactly once.</review_contract>",
    "<safety_rules>Only use `complete` when the user's request is fully satisfied within the current workspace and active mode's function-call surface. Prefer a continuation request over a false positive. Required actions must be concrete, minimal, and testable.</safety_rules>",
    [
      "<review_dimensions>",
      "1. Request coverage: every explicit user requirement must be satisfied, including requested research, comparison, or best-practice review.",
      "2. Grounded evidence: acceptance requires concrete support from tool outputs, fetched documents, file changes, command output, or other observable results.",
      "3. Verification: for code or behavior changes, require the strongest relevant verification that was feasible; if it is missing or only implied, prefer continue.",
      "4. Recovery and efficiency: if the trace shows repeated identical failing tool calls or an unchanged strategy after errors, require a different approach before acceptance.",
      "5. Constraints and safety: continue when instructions, mode limits, or available function-call boundaries were skipped or only partially satisfied.",
      "6. User-input blockers: do not accept a candidate whose main result is asking the user for missing information instead of completing the requested task.",
      "</review_dimensions>",
    ].join("\n"),
    [
      "<runtime>",
      `Workspace root: ${config.workspaceRoot}`,
      `Runtime mode: ${config.mode}`,
      `Selected provider: ${config.provider}`,
      `Selected model: ${config.model}`,
      createHostElevationRuntimeLine(),
      "</runtime>",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  ].join("\n\n");
};

export const createAutopilotMonitorUserPrompt = (
  task: string,
  taskContext: ResolvedTaskContext,
  cycleResult: ExecutorCycleOutcome,
  priorDecisions: TaskAutopilotDecision[],
): string => {
  const strategyProfile = inferTaskStrategyProfile(task, taskContext);
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
    `<tool_trace>${createTraceTranscript(cycleResult.loopState.traceLines)}</tool_trace>`,
    `<prior_validator_history>${priorDecisionLines.join("\n")}</prior_validator_history>`,
    `<research_expectation>${strategyProfile.requireResearch ? "The task explicitly asks for current external guidance or best-practice research, so acceptance requires grounded evidence that such research happened when the required tools were available." : "No explicit external-research requirement was detected from the task itself."}</research_expectation>`,
    `<verification_expectation>${strategyProfile.requireVerification ? "Expect concrete verification evidence proportionate to the task, especially for code changes, fixes, or claimed improvements." : "Verification is still preferred when feasible, but the task may be primarily explanatory."}</verification_expectation>`,
    `<grounded_evidence>${createSectionTranscript(cycleResult.result.outputSections)}</grounded_evidence>`,
    "<decision_rule>Return `continue` if any user requirement appears incomplete, unverified, or contradicted by the evidence. Return `complete` only when the evidence shows the task is done as requested.</decision_rule>",
  ].join("\n\n");
};
