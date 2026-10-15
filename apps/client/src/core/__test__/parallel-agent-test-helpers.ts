import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstructionResolutionFixture } from "./instruction-test-helpers.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { ParallelAgentMode, ResolvedTaskContext } from "../types.js";
import {
  createParallelAgentSessionTool,
  type ParallelWorkerPlan,
} from "../_helpers/parallel-agent-sessions.js";

export const createParallelAgentTestOptions = async (
  mode: ParallelAgentMode = "read-only",
) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-parallel-"));

  const config: RuntimeConfig = {
    workspaceRoot,
    mode: "machdoch",
    provider: "openai",
    model: "test-model",
    reasoning: "default",
    contextWindow: "default",
    offline: false,
    compatibility: { discoverGithubCustomizations: false },
    providerAvailability: [{ provider: "openai", configured: true }],
    webSearch: { activeProvider: "none", providerAvailability: [] },
    reviewModel: { mode: "base" },
    internalTaskModel: {
      provider: "openai",
      model: "test-model",
      reasoning: "default",
    },
  };
  const taskContext: ResolvedTaskContext = {
    task: "Inspect the workspace",
    effectiveTask: "Inspect the workspace",
    taskContextText: "",
    workspacePaths: [],
    suggestedTools: [],
    executionRole: "executor",
    applicableInstructions: [],
    instructionResolution: createInstructionResolutionFixture(),
  };
  return { config, task: "Inspect the workspace", taskContext, mode };
};

export const parallelWorker = (
  id: string,
  overrides: Partial<ParallelWorkerPlan> = {},
): ParallelWorkerPlan => ({
  id,
  objective: `Inspect ${id}`,
  access: "read-only",
  readPaths: [],
  writePaths: [],
  ...overrides,
});

export const executeParallelWorkers = async (
  tool: ReturnType<typeof createParallelAgentSessionTool>,
  workers: ParallelWorkerPlan[],
) =>
  tool.definition.execute(
    { workers },
    {
      workspaceRoot: "unused",
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
    },
  );
