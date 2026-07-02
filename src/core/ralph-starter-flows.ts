import { discoverRalphFlowVariables } from "./_helpers/ralph-placeholders.helper.js";
import type { RalphFlow } from "./ralph.js";
import { autonomousCodeImprovementLoopStarterFlow } from "./ralph-starter-flows/autonomous-code-improvement-loop.js";
import { autonomousFeatureGenerationLoopStarterFlow } from "./ralph-starter-flows/autonomous-feature-generation-loop.js";
import { autonomousUiImprovementLoopStarterFlow } from "./ralph-starter-flows/autonomous-ui-improvement-loop.js";
import { featureImplementationChecklistLoopStarterFlow } from "./ralph-starter-flows/feature-implementation-checklist-loop.js";
import { repositoryRefactorValidationLoopStarterFlow } from "./ralph-starter-flows/repository-refactor-validation-loop.js";
import { securityReviewFixLoopStarterFlow } from "./ralph-starter-flows/security-review-fix-loop.js";

export type RalphStarterFlowId =
  | "security-fix-loop"
  | "autonomous-refactoring-flow"
  | "full-feature-implementation"
  | "autonomous-feature-generation-loop"
  | "autonomous-code-improvement-loop"
  | "autonomous-ui-improvement-loop";

export interface RalphStarterFlow {
  id: RalphStarterFlowId;
  version: number;
  defaultAlias: string;
  category: string;
  tags: string[];
  flow: RalphFlow;
}

export interface RalphStarterFlowSummary {
  id: RalphStarterFlowId;
  version: number;
  defaultAlias: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  blockCount: number;
  edgeCount: number;
  variableCount: number;
}

export interface RalphStarterFlowImportOptions {
  id: string;
  alias: string;
  importedAt: string;
}

export const STARTER_RALPH_FLOWS = [
  securityReviewFixLoopStarterFlow,
  repositoryRefactorValidationLoopStarterFlow,
  featureImplementationChecklistLoopStarterFlow,
  autonomousFeatureGenerationLoopStarterFlow,
  autonomousCodeImprovementLoopStarterFlow,
  autonomousUiImprovementLoopStarterFlow,
] as const satisfies readonly RalphStarterFlow[];

const cloneRalphFlow = (flow: RalphFlow): RalphFlow => {
  return JSON.parse(JSON.stringify(flow)) as RalphFlow;
};

export const getRalphStarterFlow = (
  id: string,
): RalphStarterFlow | undefined => {
  return STARTER_RALPH_FLOWS.find((starterFlow) => starterFlow.id === id);
};

export const createRalphStarterFlowSummary = (
  starterFlow: RalphStarterFlow,
): RalphStarterFlowSummary => {
  return {
    id: starterFlow.id,
    version: starterFlow.version,
    defaultAlias: starterFlow.defaultAlias,
    name: starterFlow.flow.name,
    description: starterFlow.flow.description ?? "",
    category: starterFlow.category,
    tags: [...starterFlow.tags],
    blockCount: starterFlow.flow.blocks.length,
    edgeCount: starterFlow.flow.edges.length,
    variableCount: discoverRalphFlowVariables(starterFlow.flow).length,
  };
};

export const createImportedRalphStarterFlow = (
  starterFlow: RalphStarterFlow,
  options: RalphStarterFlowImportOptions,
): RalphFlow => {
  const flow = cloneRalphFlow(starterFlow.flow);

  return {
    ...flow,
    id: options.id,
    alias: options.alias,
    createdAt: options.importedAt,
    updatedAt: options.importedAt,
    source: {
      kind: "starter",
      id: starterFlow.id,
      version: starterFlow.version,
      importedAt: options.importedAt,
    },
  };
};
