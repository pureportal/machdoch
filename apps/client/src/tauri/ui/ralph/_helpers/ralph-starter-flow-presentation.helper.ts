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

export interface RalphStarterAutonomyReadiness {
  ready: boolean;
  label: string;
  requiredVariables: string[];
  capabilities: string[];
  notes: string[];
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

export const getStarterFlowAutonomyReadiness = (
  starterFlowSummary: RalphStarterFlowSummary,
): RalphStarterAutonomyReadiness => {
  const starterFlow = getStarterFlowById(starterFlowSummary.id);

  if (!starterFlow) {
    return {
      ready: false,
      label: "Unavailable",
      requiredVariables: [],
      capabilities: [],
      notes: ["The bundled starter definition is unavailable."],
    };
  }

  const flow = starterFlow.flow;
  const requiredVariables = (flow.variables ?? [])
    .filter(
      (variable) =>
        variable.required === true && !(variable.default ?? "").trim(),
    )
    .map((variable) => variable.name);
  const hasAgentBlocks = flow.blocks.some((block) =>
    ["PROMPT", "VALIDATOR", "DECISION", "PACK"].includes(block.type) ||
    (block.type === "UTILITY" &&
      ["PROMPT_JSON", "VALIDATOR_JSON"].includes(block.utility.type)),
  );
  const hasCommandBlocks = flow.blocks.some(
    (block) =>
      block.type === "UTILITY" &&
      ["RUN_COMMAND", "RUN_CHECK", "DETECT_PROJECT_COMMANDS"].includes(
        block.utility.type,
      ),
  );
  const hasNetworkBlocks = flow.blocks.some(
    (block) =>
      ("settings" in block && block.settings?.webAccess === true) ||
      (block.type === "UTILITY" &&
        ["HTTP_FETCH", "POLL", "UI_ANALYZE"].includes(block.utility.type)),
  );
  const hasVisualBlocks = flow.blocks.some(
    (block) => block.type === "UTILITY" && block.utility.type === "UI_ANALYZE",
  );
  const capabilities = [
    ...(hasAgentBlocks ? ["agent"] : []),
    ...(hasCommandBlocks ? ["commands"] : []),
    ...(hasAgentBlocks ? ["writes"] : []),
    ...(hasNetworkBlocks ? ["network"] : []),
    ...(hasVisualBlocks ? ["visual"] : []),
  ];
  const hasAlwaysOnHumanInput = flow.blocks.some(
    (block) => block.type === "ASK_USER",
  );
  const interviewDefault = flow.variables?.find(
    (variable) => variable.name === "enableInterview",
  )?.default;
  const hasEnabledInterview =
    flow.blocks.some((block) => block.type === "INTERVIEW") &&
    interviewDefault !== "false";
  const notes = [
    ...(requiredVariables.length > 0
      ? [`Launch input: ${requiredVariables.join(", ")}`]
      : ["No launch-time input is required."]),
    ...(hasVisualBlocks
      ? ["Visual evidence uses an existing URL, app target, or screenshot."]
      : []),
  ];
  const ready =
    requiredVariables.length === 0 &&
    !hasAlwaysOnHumanInput &&
    !hasEnabledInterview;

  return {
    ready,
    label: ready
      ? "Unattended ready"
      : requiredVariables.length > 0
        ? `${requiredVariables.length} launch input required`
        : "Human input enabled",
    requiredVariables,
    capabilities,
    notes,
  };
};

export const getStarterFlowEmoji = (
  starterFlow: RalphStarterFlowSummary,
): string => STARTER_RALPH_FLOW_EMOJIS[starterFlow.id];
