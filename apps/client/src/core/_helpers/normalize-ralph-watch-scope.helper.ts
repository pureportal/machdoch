import type { RalphFlowScope } from "../ralph.js";

export const normalizeRalphWatchScope = (
  value: string | undefined,
  fallback: RalphFlowScope,
): RalphFlowScope => {
  return value === "user" || value === "workspace" ? value : fallback;
};
