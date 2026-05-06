import { getToolRegistry } from "./tools.js";
import type {
  ResolvedToolPolicy,
  RuntimeConfig,
  ToolDefinition,
  ToolName,
  ToolPolicyDecision,
} from "./types.js";

/**
 * Resolves the decision for an enabled tool under the active runtime mode.
 */
const getDecisionForEnabledTool = (
  tool: ToolDefinition,
  mode: RuntimeConfig["mode"],
): { decision: ToolPolicyDecision; reason: string } => {
  if (mode === "plan") {
    if (tool.name === "utilities") {
      return {
        decision: "allow",
        reason:
          "Plan mode allows deterministic utility helpers because they do not inspect or mutate external state.",
      };
    }

    return {
      decision: "ask",
      reason:
        "Plan mode permits read-only sub-actions but pauses before state-changing or ambiguous actions until the plan is validated.",
    };
  }

  if (mode === "safe") {
    return {
      decision: "ask",
      reason:
        "Safe mode never auto-executes tools; every enabled tool requires approval first.",
    };
  }

  if (mode === "ask") {
    if (tool.riskLevel === "low") {
      return {
        decision: "allow",
        reason:
          "This tool is low risk and can proceed automatically in ask mode unless a specific action is escalated.",
      };
    }

    return {
      decision: "ask",
      reason:
        "This tool is medium/high risk and requires approval in ask mode before execution.",
    };
  }

  return {
    decision: "allow",
    reason:
      "Auto mode allows enabled tools to run automatically within the configured workspace policy.",
  };
};

/**
 * Resolves the allow/ask/blocked decision for tools under the active runtime
 * mode and enabled-tool configuration.
 */
export const resolveToolPolicies = (
  config: RuntimeConfig,
  focusTools?: ToolName[],
): ResolvedToolPolicy[] => {
  const focusSet = focusTools ? new Set(focusTools) : undefined;

  return getToolRegistry()
    .filter((tool) => (focusSet ? focusSet.has(tool.name) : true))
    .map((tool) => {
      const enabled = config.enabledTools.includes(tool.name);

      if (!enabled) {
        return {
          tool,
          enabled: false,
          decision: "blocked",
          reason:
            "This tool is not enabled in `.machdoch/config.json`, so the runtime should not use it.",
        } satisfies ResolvedToolPolicy;
      }

      const { decision, reason } = getDecisionForEnabledTool(tool, config.mode);

      return {
        tool,
        enabled: true,
        decision,
        reason,
      } satisfies ResolvedToolPolicy;
    });
};
