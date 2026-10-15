import { rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  createParallelAgentTestOptions,
  parallelWorker,
} from "../__test__/parallel-agent-test-helpers.js";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { maybeExecuteModelDrivenTask } from "../agent-runtime.js";
import { createInstructionDeliveryPlan } from "../instruction-system/index.js";
import type { AgentModelAdapter } from "../types.js";
import { createProviderAdapter } from "./provider-adapters.js";

vi.mock("./provider-adapters.js", () => ({ createProviderAdapter: vi.fn() }));

const workspaces: string[] = [];
afterEach(async () => {
  vi.mocked(createProviderAdapter).mockReset();
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const routes = [
  { provider: "openai", model: "gpt-5.2" },
  { provider: "anthropic", model: "claude-sonnet-4-5" },
  { provider: "google", model: "gemini-3-pro" },
  { provider: "langdock", model: "gpt-5" },
  { provider: "langdock", model: "claude-sonnet-4-5" },
  { provider: "langdock", model: "gemini-3-pro" },
] as const;

it.each(
  routes.flatMap((route) =>
    [false, true].map((retry) => ({ ...route, retry })),
  ),
)(
  "$provider/$model preserves parent failure until workers recover (retry: $retry)",
  async ({ provider, model, retry }) => {
    const options = await createParallelAgentTestOptions();
    workspaces.push(options.config.workspaceRoot);
    let failWorkers = true;
    let workerStarts = 0;
    vi.mocked(createProviderAdapter).mockImplementation(
      async (_config, _tools, override) =>
        override ?? {
          startTurn: async () => {
            workerStarts += 1;
            if (failWorkers) throw new Error("Temporary provider failure");
            return { text: "Verified worker finding", toolCalls: [] };
          },
          continueTurn: async () => {
            throw new Error("Unexpected worker continuation");
          },
        },
    );
    const parallelCall = {
      id: "workers",
      name: "run_parallel_agents",
      arguments: {
        workers: [parallelWorker("first"), parallelWorker("second")],
      },
    };
    let passes = 0;
    const parent: AgentModelAdapter = {
      startTurn: async () => ({ text: "", toolCalls: [parallelCall] }),
      continueTurn: async ({ toolResults }) => {
        passes += 1;
        expect(toolResults[0]?.isError).toBe(passes === 1);
        if (passes === 1 && retry) {
          failWorkers = false;
          return {
            text: "",
            toolCalls: [{ ...parallelCall, id: "retry-workers" }],
          };
        }
        return {
          text: "",
          toolCalls: [
            {
              id: "final",
              name: "submit_final_response",
              arguments: {
                summary: "Verified result",
                status: "completed",
                blockerReason: "",
                markdown: "Verified result",
                highlights: [],
                relatedFiles: [],
                verification: [],
                followUps: [],
              },
            },
          ],
        };
      },
    };
    const instructionResolution = createInstructionResolutionFixture({
      providerId: provider,
      surface: "api",
      model,
    });
    const result = await maybeExecuteModelDrivenTask({
      task: options.task,
      config: {
        ...options.config,
        provider,
        model,
        mode: "ask",
        providerAvailability: [{ provider, configured: true }],
      },
      taskContext: { ...options.taskContext, instructionResolution },
      contextSections: [],
      instructionDeliveryPlan: createInstructionDeliveryPlan(
        instructionResolution,
      ),
      modelAdapter: parent,
      conversationContext: { history: [], parallelAgentMode: "read-only" },
    });
    expect(workerStarts).toBe(retry ? 4 : 2);
    expect(result?.status, result?.summary).toBe(retry ? "executed" : "failed");
    expect(result?.metadata?.parallelWorkerFailure).toBe(!retry);
    expect(result?.response?.markdown).toContain("Verified result");
  },
);
