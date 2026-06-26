import type { RalphFlow } from "./ralph.js";
import { autonomousFeatureGenerationLoopStarterFlow } from "./ralph-starter-flows/autonomous-feature-generation-loop.js";
import { featureImplementationChecklistLoopStarterFlow } from "./ralph-starter-flows/feature-implementation-checklist-loop.js";
import { repositoryRefactorValidationLoopStarterFlow } from "./ralph-starter-flows/repository-refactor-validation-loop.js";
import { securityReviewFixLoopStarterFlow } from "./ralph-starter-flows/security-review-fix-loop.js";

export type RalphStarterFlowId =
  | "security-fix-loop"
  | "autonomous-refactoring-flow"
  | "full-feature-implementation"
  | "autonomous-feature-generation-loop";

export interface RalphStarterFlow {
  id: RalphStarterFlowId;
  defaultAlias: string;
  category: string;
  tags: string[];
  flow: RalphFlow;
}

export interface RalphStarterFlowSummary {
  id: RalphStarterFlowId;
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
    defaultAlias: starterFlow.defaultAlias,
    name: starterFlow.flow.name,
    description: starterFlow.flow.description ?? "",
    category: starterFlow.category,
    tags: [...starterFlow.tags],
    blockCount: starterFlow.flow.blocks.length,
    edgeCount: starterFlow.flow.edges.length,
    variableCount: starterFlow.flow.variables?.length ?? 0,
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
  };
};
