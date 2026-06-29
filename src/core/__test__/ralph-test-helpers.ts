import type { RalphFlow } from "../ralph.js";
import type {
  CustomizationDiscoveryResult,
  TaskExecutionResult,
} from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";

export const createExecutionResult = (
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult => ({
  task: "task",
  mode: "machdoch",
  status: "executed",
  summary: "Done.",
  executedTools: [],
  outputSections: [],
  response: {
    markdown: "Done.",
    highlights: [],
    relatedFiles: [],
    verification: [],
    followUps: [],
  },
  ...overrides,
});

export const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: 1,
  id: "refactor-flow",
  name: "Refactor flow",
  blocks: [
    {
      id: "start",
      type: "START",
      title: "Start",
    },
    {
      id: "fix-tsc",
      type: "PROMPT",
      title: "Fix TSC",
      prompt: "Fix TypeScript errors in {{scope:path=ALL}}.",
    },
    {
      id: "validate",
      type: "VALIDATOR",
      title: "Validate",
      prompt:
        "Validate {{scope:path=ALL}} using {{lastResultSummary}}. End with RALPH_DECISION.",
      validationScope: { mode: "sinceLastValidator" },
    },
    {
      id: "success",
      type: "END",
      title: "Success",
      status: "success",
    },
  ],
  edges: [
    {
      id: "start-to-fix",
      from: "start",
      fromOutput: "SUCCESS",
      to: "fix-tsc",
    },
    {
      id: "fix-to-validate",
      from: "fix-tsc",
      fromOutput: "SUCCESS",
      to: "validate",
    },
    {
      id: "validate-done",
      from: "validate",
      fromOutput: "DONE",
      to: "success",
    },
    {
      id: "validate-continue",
      from: "validate",
      fromOutput: "CONTINUE",
      to: "fix-tsc",
    },
  ],
  ...overrides,
});

export type RalphUtilityBlockForTest = Extract<
  RalphFlow["blocks"][number],
  { type: "UTILITY" }
>;

export const createUtilityFlow = (
  utilityBlock: RalphUtilityBlockForTest,
  edges: RalphFlow["edges"],
  extraBlocks: RalphFlow["blocks"] = [],
): RalphFlow =>
  createFlow({
    blocks: [
      { id: "start", type: "START", title: "Start" },
      utilityBlock,
      ...extraBlocks,
    ],
    edges,
  });

export const runtimeConfig: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-5.5",
  reasoning: "default",
  offline: false,
  compatibility: {
    discoverGithubCustomizations: false,
  },
  providerAvailability: [
    {
      provider: "openai",
      configured: true,
    },
  ],
  webSearch: {
    activeProvider: "none",
    providerAvailability: [],
  },
  reviewModel: {
    mode: "base",
  },
};

export const customizations: CustomizationDiscoveryResult = {
  workspaceRoot: "C:/workspace",
  instructions: [],
  prompts: [],
  skills: [],
};
