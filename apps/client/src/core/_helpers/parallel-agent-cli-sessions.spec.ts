import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { createInstructionDeliveryPlan } from "../instruction-system/index.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { TaskExecutionResult } from "../types.js";
import { maybeExecuteExternalAgentProviderTask } from "./external-agent-provider.js";
import { createParallelAgentSessionTool } from "./parallel-agent-sessions.js";

vi.mock("./external-agent-provider.js", () => ({
  maybeExecuteExternalAgentProviderTask: vi.fn(),
}));

let workspaceRoot: string | undefined;

afterEach(async () => {
  vi.mocked(maybeExecuteExternalAgentProviderTask).mockReset();
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = undefined;
});

it.each(["codex-cli", "claude-cli", "copilot-cli"] as const)(
  "spawns scoped Machdoch workers through %s",
  async (provider) => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-cli-workers-"));
    const model = provider === "claude-cli" ? "claude-opus-4-6" : "gpt-6-sol";
    const config = {
      workspaceRoot,
      mode: "machdoch",
      provider,
      model,
      reasoning: "default",
      contextWindow: "default",
      offline: false,
      compatibility: { discoverGithubCustomizations: false },
      providerAvailability: [{ provider, configured: true }],
      webSearch: { activeProvider: "none", providerAvailability: [] },
      reviewModel: { mode: "base" },
      internalTaskModel: { provider, model, reasoning: "default" },
    } satisfies RuntimeConfig;
    const instructionResolution = createInstructionResolutionFixture({
      providerId: provider,
      surface: "cli",
      model,
    });
    vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
      async (params) =>
        ({
          task: params.task,
          mode: params.config.mode,
          status: "executed",
          summary: "Worker completed.",
          executedTools: [],
          outputSections: [],
        }) satisfies TaskExecutionResult,
    );
    const tool = createParallelAgentSessionTool({
      config,
      task: "Inspect the workspace",
      taskContext: {
        task: "Inspect the workspace",
        effectiveTask: "Inspect the workspace",
        taskContextText: "",
        workspacePaths: [],
        suggestedTools: [],
        executionRole: "executor",
        applicableInstructions: [],
        instructionResolution,
      },
      instructionDeliveryPlan: createInstructionDeliveryPlan(
        instructionResolution,
      ),
      preparedConversationContext: {
        wasQueued: false,
        workspace: { selection: "selected", root: workspaceRoot },
        sections: [],
        memory: {
          sessionEnabled: false,
          sessionEntries: [],
          globalEnabled: false,
          globalEntries: [],
        },
        uiControlEnabled: false,
      },
      mode: "machdoch",
    });

    const outcome = await tool.definition.execute(
      {
        workers: [
          {
            id: "reader",
            objective: "Read notes",
            access: "read-only",
            readPaths: ["notes.txt"],
            writePaths: [],
          },
          {
            id: "writer",
            objective: "Write report",
            access: "write",
            readPaths: [],
            writePaths: ["report.txt"],
          },
        ],
      },
      {
        workspaceRoot,
        memory: {
          sessionEnabled: false,
          sessionEntries: [],
          globalEnabled: false,
          globalEntries: [],
        },
      },
    );

    expect(outcome.toolResult.isError, outcome.toolResult.output).toBe(false);
    const calls = vi.mocked(maybeExecuteExternalAgentProviderTask).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map(([params]) => params.config.mode)).toEqual([
      "ask",
      "machdoch",
    ]);
    expect(
      calls.map(
        ([params]) => params.preparedConversationContext.parallelAgentMode,
      ),
    ).toEqual(["disabled", "disabled"]);
    expect(
      calls.map(([params]) =>
        params.scopedWorkerToolDefinitions?.map((tool) => tool.spec.name),
      ),
    ).toEqual([["read_file"], ["read_file", "create_file", "replace_in_file"]]);
  },
);
