import {
  hasGraphCycle,
  type RalphFlow,
} from "../ralph.js";

export interface RalphGenerationStructureValidation {
  decision: "DONE" | "RETRY";
  issues: string[];
  warnings: string[];
}

const RALPH_GENERATION_EXAMPLE_BLOCK_IDS = new Set([
  "wait-before-work",
  "do-work",
  "validate-work",
  "work-note",
  "work-group",
  "main-task",
  "review-result",
]);

const createGeneratedRalphFlowQualityWarnings = (
  flow: RalphFlow,
): string[] => {
  const warnings: string[] = [];
  const visualBlocks = flow.blocks.filter(
    (block) => block.type === "NOTE" || block.type === "GROUP",
  );
  const copiedExampleBlockIds = flow.blocks
    .map((block) => block.id)
    .filter((blockId) => RALPH_GENERATION_EXAMPLE_BLOCK_IDS.has(blockId));

  if (visualBlocks.length > 0 && flow.blocks.length <= 7) {
    warnings.push(
      "Small generated flows should usually omit NOTE and GROUP blocks unless visual organization materially improves readability.",
    );
  }

  if (copiedExampleBlockIds.length > 0) {
    warnings.push(
      `Generated flow appears to reuse schema-example block id(s): ${copiedExampleBlockIds.join(", ")}. Use request-specific kebab-case ids instead.`,
    );
  }

  return warnings;
};

export const validateGeneratedRalphFlowStructure = (
  flow: RalphFlow,
): RalphGenerationStructureValidation => {
  const issues: string[] = [];

  if (hasGraphCycle(flow) && flow.settings?.maxTransitions === undefined) {
    issues.push(
      "The generated graph has a cycle but no settings.maxTransitions cap.",
    );
  }

  return {
    decision: issues.length === 0 ? "DONE" : "RETRY",
    issues,
    warnings: createGeneratedRalphFlowQualityWarnings(flow),
  };
};
