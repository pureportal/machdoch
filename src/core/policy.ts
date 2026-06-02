import { getToolRegistry } from "./tools.js";
import type {
  ResolvedToolPolicy,
  RuntimeConfig,
  ToolDefinition,
  ToolName,
  ToolPolicyDecision,
} from "./types.js";

/**
 * Resolves the high-level policy summary for a tool under the active runtime
 * mode. The actual model tool surface is filtered at function-call granularity.
 */
const getDecisionForTool = (
  tool: ToolDefinition,
  mode: RuntimeConfig["mode"],
): { decision: ToolPolicyDecision; reason: string } => {
  if (mode === "ask") {
    return {
      decision: "allow",
      reason:
        "Ask mode exposes only read-only function calls; state-changing calls are unavailable in this mode.",
    };
  }

  return {
    decision: "allow",
    reason: "Machdoch mode can use all function calls automatically.",
  };
};

/**
 * Resolves the allow/ask/blocked summary for tools under the active runtime
 * mode.
 */
export const resolveToolPolicies = (
  config: RuntimeConfig,
  focusTools?: ToolName[],
): ResolvedToolPolicy[] => {
  const focusSet = focusTools ? new Set(focusTools) : undefined;

  return getToolRegistry()
    .filter((tool) => (focusSet ? focusSet.has(tool.name) : true))
    .map((tool) => {
      const { decision, reason } = getDecisionForTool(tool, config.mode);

      return {
        tool,
        enabled: true,
        decision,
        reason,
      } satisfies ResolvedToolPolicy;
    });
};
