import type {
  AgentModelToolCall,
  RuntimeConfig,
  TaskActionOutputHandler,
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
import {
  createMacroRecorderToolDefinitions,
  recordMacroToolCall,
} from "./macro-recorder-tool-definitions.js";
import { createPackageToolDefinitions } from "./package-tool-definitions.js";
import { createUtilityToolDefinitions } from "./utility-tool-definitions.js";
import {
  compactTraceText,
  stringifyUnknown,
} from "./runtime-text.js";
import { createDesktopUiToolDefinitions } from "./desktop-ui-tool-definitions.js";
import { createShellNetworkToolDefinitions } from "./shell-network-tool-definitions.js";

export type {
  AgentToolDefinition,
  AgentToolExecutionResult,
  ConversationMemoryRuntime,
} from "./agent-tools-shared.js";

const READ_ONLY_EFFECTS: ReadonlySet<ToolCallEffect> = new Set([
  "read",
  "external-read",
]);

const isReadOnlyEffect = (effect: ToolCallEffect): boolean => {
  return READ_ONLY_EFFECTS.has(effect);
};

const isReadOnlyAction = (
  effect: ToolCallEffect,
  isReadOnlyOverride?: boolean,
): boolean => {
  return isReadOnlyEffect(effect) || isReadOnlyOverride === true;
};

export const resolveActionDecision = (
  config: RuntimeConfig,
  _tool: ToolName,
  _riskLevel: ToolRiskLevel,
  options: {
    effect?: ToolCallEffect;
    isReadOnlyInPlanMode?: boolean;
  } = {},
): { decision: "allow" | "blocked"; reason: string } => {
  const isReadOnly = isReadOnlyAction(
    options.effect ?? "external-side-effect",
    options.isReadOnlyInPlanMode,
  );

  if (config.mode === "ask" && !isReadOnly) {
    return {
      decision: "blocked",
      reason:
        "Ask mode only allows read-only function calls. Switch to machdoch mode to let the agent change files, run side-effecting commands, drive UI input, or mutate external state.",
    };
  }

  return {
    decision: "allow",
    reason:
      config.mode === "ask"
        ? "Ask mode allows this read-only function call."
        : "Machdoch mode allows function calls to run automatically.",
  };
};

const isReadOnlyToolDefinition = (
  definition: AgentToolDefinition,
): boolean => {
  return isReadOnlyAction(definition.effect);
};

export const createToolDefinitions = (
  config: RuntimeConfig,
  memory: ConversationMemoryRuntime,
  uiControl?: UiControlRuntimeInfo,
): AgentToolDefinition[] => {
  const definitions = [
    ...createFilesystemToolDefinitions(),
    ...createGitToolDefinitions(),
    ...createPackageToolDefinitions(),
    ...createUtilityToolDefinitions(),
    ...createMacroRecorderToolDefinitions(),
    ...createBrowserToolDefinitions(),
    ...createShellNetworkToolDefinitions(config),
    ...createMemoryToolDefinitions(memory),
    ...createDesktopUiToolDefinitions(uiControl),
  ];

  if (config.mode === "ask") {
    return definitions.filter(isReadOnlyToolDefinition);
  }

  return definitions;
};

export const executeToolCall = async (
  config: RuntimeConfig,
  memory: ConversationMemoryRuntime,
  uiControl: UiControlRuntimeInfo | undefined,
  toolDefinitions: Map<string, AgentToolDefinition>,
  call: AgentModelToolCall,
  onActionOutput?: TaskActionOutputHandler,
): Promise<{
  result?: AgentToolExecutionResult;
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

  if (actionDecision.decision === "blocked") {
    return {
      result: createToolErrorResult(call.id, call.name, actionDecision.reason),
    };
  }

  const result = await toolDefinition.execute(call.arguments, {
    workspaceRoot: config.workspaceRoot,
    memory,
    ...(uiControl !== undefined ? { uiControl } : {}),
    ...(onActionOutput
      ? {
          onOutput: (output): void => {
            try {
              void Promise.resolve(
                onActionOutput({
                  toolName: call.name,
                  ...output,
                }),
              ).catch(() => undefined);
            } catch {
              // Progress streaming should not make the backing tool fail.
            }
          },
        }
      : {}),
  });
  if (!result.toolResult.isError) {
    recordMacroToolCall({
      toolName: call.name,
      backingTool: toolDefinition.backingTool,
      riskLevel: toolDefinition.riskLevel,
      effect: toolDefinition.effect,
      arguments: call.arguments,
      output: result.toolResult.output,
    });
  }

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
