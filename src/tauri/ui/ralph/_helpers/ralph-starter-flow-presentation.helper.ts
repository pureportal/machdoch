import type { RalphFlowSummary } from "../../../../core/ralph.js";
import {
  STARTER_RALPH_FLOWS,
  createRalphStarterFlowSummary,
  getRalphStarterFlow,
  type RalphStarterFlow,
  type RalphStarterFlowSummary,
} from "../../../../core/ralph-starter-flows.js";

export const STARTER_RALPH_FLOW_SUMMARIES: RalphStarterFlowSummary[] =
  STARTER_RALPH_FLOWS.map(createRalphStarterFlowSummary);

export interface RalphStarterFlowUpdate {
  latestVersion: number;
}

const STARTER_RALPH_FLOW_EMOJIS = {
  "security-fix-loop": "🔒",
  "autonomous-refactoring-flow": "🧹",
  "full-feature-implementation": "🚀",
  "autonomous-feature-generation-loop": "✨",
  "autonomous-code-improvement-loop": "🛠️",
  "autonomous-ui-improvement-loop": "🎨",
} as const satisfies Record<RalphStarterFlowSummary["id"], string>;

export const getStarterFlowById = (
  starterFlowId: string,
): RalphStarterFlow | undefined => {
  return getRalphStarterFlow(starterFlowId);
};

export const getStarterFlowUpdate = (
  flow: RalphFlowSummary,
): RalphStarterFlowUpdate | null => {
  if (flow.source?.kind !== "starter") {
    return null;
  }

  const starterFlow = getStarterFlowById(flow.source.id);

  if (!starterFlow || starterFlow.version <= flow.source.version) {
    return null;
  }

  return { latestVersion: starterFlow.version };
};

export const createStarterImportId = (
  starterFlow: RalphStarterFlow,
): string => {
  const randomUUID = globalThis.crypto?.randomUUID;

  if (typeof randomUUID === "function") {
    return randomUUID.call(globalThis.crypto);
  }

  return `${starterFlow.defaultAlias}-${Date.now()}`;
};

export const formatStarterFlowSubtitle = (
  starterFlow: RalphStarterFlowSummary,
): string => {
  return `${starterFlow.category} / ${starterFlow.blockCount} blocks / ${starterFlow.edgeCount} edges / ${starterFlow.variableCount} vars`;
};

export const getStarterFlowEmoji = (
  starterFlow: RalphStarterFlowSummary,
): string => STARTER_RALPH_FLOW_EMOJIS[starterFlow.id];
