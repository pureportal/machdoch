import type {
  AgentModelToolCall,
  RuntimeConfig,
  TaskExecutionSection,
  ToolCallEffect,
  ToolName,
  ToolRiskLevel,
  UiControlRuntimeInfo,
} from "../types.js";
import {
  createToolErrorResult,
  type AgentToolDefinition,
  type AgentToolExecutionResult,
  type ConversationMemoryRuntime,
} from "./agent-tools-shared.js";
import { createBrowserToolDefinitions } from "./browser-tool-definitions.js";
import { createFilesystemToolDefinitions } from "./filesystem-tool-definitions.js";
import { createGitToolDefinitions } from "./git-tool-definitions.js";
import { createMemoryToolDefinitions } from "./memory-tool-definitions.js";
import { createPackageToolDefinitions } from "./package-tool-definitions.js";
import { createUtilityToolDefinitions } from "./utility-tool-definitions.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
  stringifyUnknown,
} from "./runtime-text.js";
import { createDesktopUiToolDefinitions } from "./desktop-ui-tool-definitions.js";
import { createShellNetworkToolDefinitions } from "./shell-network-tool-definitions.js";

export type {
  AgentToolDefinition,
  AgentToolExecutionResult,
  ConversationMemoryRuntime,
} from "./agent-tools-shared.js";

export interface ApprovalPause {
  summary: string;
  reason: string;
  outputSections: TaskExecutionSection[];
}

export interface AgentLoopSnapshot {
  outputSections: TaskExecutionSection[];
  traceLines: string[];
}

const PLAN_MODE_READ_EFFECTS: ReadonlySet<ToolCallEffect> = new Set([
  "read",
  "external-read",
]);

const isPlanModeReadOnlyEffect = (effect: ToolCallEffect): boolean => {
  return PLAN_MODE_READ_EFFECTS.has(effect);
};

export const resolveActionDecision = (
  config: RuntimeConfig,
  tool: ToolName,
  riskLevel: ToolRiskLevel,
  options: {
    effect?: ToolCallEffect;
    isReadOnlyInPlanMode?: boolean;
  } = {},
): { decision: "allow" | "ask" | "blocked"; reason: string } => {
  if (!config.enabledTools.includes(tool)) {
    return {
      decision: "blocked",
      reason:
        "This tool is not enabled in `.machdoch/config.json`, so the runtime refused to execute it.",
    };
  }

  if (config.mode === "plan") {
    if (
      (options.effect && isPlanModeReadOnlyEffect(options.effect)) ||
      options.isReadOnlyInPlanMode === true
    ) {
      return {
        decision: "allow",
        reason:
          "Plan mode allows read-only information gathering before a proposed plan is approved.",
      };
    }

    return {
      decision: "ask",
      reason:
        "Plan mode pauses before state-changing or ambiguous actions so the user can validate the plan first.",
    };
  }

  if (config.mode === "safe") {
    return {
      decision: "ask",
      reason:
        "Safe mode never auto-executes tools; explicit approval is required first.",
    };
  }

  if (config.mode === "ask" && riskLevel !== "low") {
    return {
      decision: "ask",
      reason:
        "This action is medium/high risk and requires approval in ask mode before execution.",
    };
  }

  return {
    decision: "allow",
    reason:
      config.mode === "auto"
        ? "Auto mode allows enabled tools to run automatically within the workspace policy."
        : "This action is low risk and can proceed automatically in ask mode.",
  };
};

const createApprovalPause = (
  task: string,
  loopState: AgentLoopSnapshot,
  toolDefinition: AgentToolDefinition,
  call: AgentModelToolCall,
  reason: string,
): ApprovalPause => {
  const argsPreview = limitText(stringifyUnknown(call.arguments), 500);
  const approvalSections: TaskExecutionSection[] = [
    ...loopState.outputSections,
    {
      title: "Approval required",
      lines: [
        `task: ${task}`,
        `tool: ${call.name}`,
        `backing tool: ${toolDefinition.backingTool}`,
        `risk: ${toolDefinition.riskLevel}`,
        `reason: ${reason}`,
      ],
    },
    createTextSection("Requested arguments", argsPreview),
  ];

  if (loopState.traceLines.length > 0) {
    approvalSections.push({
      title: "Tool trace",
      lines: loopState.traceLines,
    });
  }

  return {
    summary: `The model requested \`${call.name}\`, but the current runtime mode requires approval before it can continue.`,
    reason,
    outputSections: approvalSections,
  };
};

export const createToolDefinitions = (
  config: RuntimeConfig,
  memory: ConversationMemoryRuntime,
  uiControl?: UiControlRuntimeInfo,
): AgentToolDefinition[] => {
  return [
    ...createFilesystemToolDefinitions(),
    ...createGitToolDefinitions(),
    ...createPackageToolDefinitions(),
    ...createUtilityToolDefinitions(),
    ...createBrowserToolDefinitions(),
    ...createShellNetworkToolDefinitions(config),
    ...createMemoryToolDefinitions(memory),
    ...createDesktopUiToolDefinitions(uiControl),
  ];
};

export const executeToolCall = async (
  task: string,
  config: RuntimeConfig,
  loopState: AgentLoopSnapshot,
  memory: ConversationMemoryRuntime,
  uiControl: UiControlRuntimeInfo | undefined,
  toolDefinitions: Map<string, AgentToolDefinition>,
  call: AgentModelToolCall,
): Promise<{
  result?: AgentToolExecutionResult;
  approvalPause?: ApprovalPause;
}> => {
  const toolDefinition = toolDefinitions.get(call.name);

  if (!toolDefinition) {
    return {
      result: createToolErrorResult(
        call.id,
        call.name,
        `The tool \`${call.name}\` is not registered in this runtime.`,
      ),
    };
  }

  const actionDecision = resolveActionDecision(
    config,
    toolDefinition.backingTool,
    toolDefinition.riskLevel,
    {
      effect: toolDefinition.effect,
      ...(toolDefinition.isReadOnlyInPlanMode
        ? {
            isReadOnlyInPlanMode: toolDefinition.isReadOnlyInPlanMode(
              call.arguments,
            ),
          }
        : {}),
    },
  );

  if (actionDecision.decision === "ask") {
    return {
      approvalPause: createApprovalPause(
        task,
        loopState,
        toolDefinition,
        call,
        actionDecision.reason,
      ),
    };
  }

  if (actionDecision.decision === "blocked") {
    return {
      result: createToolErrorResult(call.id, call.name, actionDecision.reason),
    };
  }

  const result = await toolDefinition.execute(call.arguments, {
    workspaceRoot: config.workspaceRoot,
    memory,
    ...(uiControl !== undefined ? { uiControl } : {}),
  });

  return {
    result: {
      ...result,
      toolResult: {
        ...result.toolResult,
        callId: call.id,
        name: call.name,
      },
      traceLines: [
        `tool_call: ${call.name}(${compactTraceText(stringifyUnknown(call.arguments))})`,
        ...result.traceLines,
      ],
    },
  };
};
