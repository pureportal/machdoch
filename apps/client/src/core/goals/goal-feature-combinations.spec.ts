import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableGoalModes } from "../../shared/goals.js";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { maybeExecuteExternalAgentProviderTask } from "../_helpers/external-agent-provider.js";
import { createProviderAdapter } from "../_helpers/provider-adapters.js";
import { executeTask } from "../execution.js";
import { createLocalToolRuntime } from "../local-mcp/runtime.js";
import { createInstructionDeliveryPlan } from "../instruction-system/index.js";
import {
  VALID_MODEL_PROVIDERS,
  type ConfiguredModelProvider,
  type RuntimeConfig,
} from "../runtime-contract.generated.js";
import type { AgentModelAdapter, AgentModelTurn } from "@machdoch/model-runtime/types";

vi.mock("../_helpers/external-agent-provider.js", () => ({
  maybeExecuteExternalAgentProviderTask: vi.fn(),
}));

vi.mock("../_helpers/provider-adapters.js", () => ({
  createProviderAdapter: vi.fn(),
}));

const models: Record<ConfiguredModelProvider, string> = {
  openai: "gpt-6-sol",
  anthropic: "claude-opus-4-6",
  google: "gemini-3.5-flash",
  langdock: "gpt-6-sol",
  "codex-cli": "gpt-6-sol",
  "claude-cli": "claude-opus-4-6",
  "copilot-cli": "gpt-6-sol",
};
const managedModes = ["disabled", "read-only", "machdoch"] as const;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-goal-combinations-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(workspaceRoot, "user-config"));
  await writeFile(join(workspaceRoot, "evidence.txt"), "Verified evidence");
});

afterEach(async () => {
  vi.mocked(maybeExecuteExternalAgentProviderTask).mockReset();
  vi.mocked(createProviderAdapter).mockReset();
  vi.unstubAllEnvs();
  await rm(workspaceRoot, { recursive: true, force: true });
});

const finalTurn = (decision?: "continue" | "complete"): AgentModelTurn => ({
  text: "",
  toolCalls: [
    {
      id: randomUUID(),
      name: "submit_final_response",
      arguments: {
        summary: "Review complete.",
        status: "completed",
        blockerReason: "",
        markdown: "Review complete.",
        highlights: [],
        relatedFiles: [],
        verification: ["The supplied evidence was reviewed."],
        followUps: [],
        ...(decision ? { control: { kind: "goal-evaluation", decision } } : {}),
      },
    },
  ],
});

const createConfig = (provider: ConfiguredModelProvider): RuntimeConfig => ({
  workspaceRoot,
  mode: "machdoch",
  provider,
  model: models[provider],
  reasoning: "default",
  contextWindow: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [{ provider, configured: true }],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider,
    model: models[provider],
    reasoning: "default",
  },
});

describe("goal and parallel agent combinations", () => {
  it.each(
    VALID_MODEL_PROVIDERS.flatMap((provider) =>
      getAvailableGoalModes(provider).flatMap((goalMode) =>
        managedModes.map(
          (parallelMode) => [provider, goalMode, parallelMode] as const,
        ),
      ),
    ),
  )(
    "combines %s / %s goal / %s parallel agents and isolates evaluation",
    async (provider, goalMode, parallelMode) => {
      let evaluations = 0;
      const workTools: string[][] = [];
      const evaluationTools: string[][] = [];
      const workerTools: string[][] = [];
      const parallelResults: string[] = [];
      const cliProvider = provider.endsWith("-cli");
      const workers = ["first", "second"].map((id) => ({
        id,
        objective: `Review ${id}`,
        access: "read-only",
        readPaths: ["evidence.txt"],
        writePaths: [],
      }));
      const toolContext = {
        workspaceRoot,
        memory: {
          sessionEnabled: false,
          sessionEntries: [],
          globalEnabled: false,
          globalEntries: [],
        },
      };
      vi.mocked(createProviderAdapter).mockImplementation(
        async (config, _tools, adapter) => {
          if (adapter) return adapter;
          expect(config.provider).toBe(provider);
          expect(config.model).toBe(models[provider]);
          return {
            startTurn: async (params) => {
              workerTools.push(params.tools.map((tool) => tool.name));
              return {
                text: "",
                toolCalls: [
                  {
                    id: randomUUID(),
                    name: "read_file",
                    arguments: {
                      path: "evidence.txt",
                      startLine: 1,
                      endLine: 1,
                    },
                  },
                ],
              };
            },
            continueTurn: async ({ toolResults }) => {
              expect(toolResults[0]?.isError).toBeFalsy();
              expect(toolResults[0]?.output).toContain("Verified evidence");
              return { text: "Evidence reviewed.", toolCalls: [] };
            },
          };
        },
      );
      vi.mocked(maybeExecuteExternalAgentProviderTask).mockImplementation(
        async (params) => {
          if (
            !params.resultProtocol &&
            params.scopedWorkerToolDefinitions !== undefined
          ) {
            const tools = params.scopedWorkerToolDefinitions;
            workerTools.push(tools.map((tool) => tool.spec.name));
            expect(params.nativeGoal).toBeUndefined();
            expect(params.config.provider).toBe(provider);
            expect(params.config.model).toBe(models[provider]);
            expect(params.preparedConversationContext.parallelAgentMode).toBe(
              "disabled",
            );
            const runtime = createLocalToolRuntime({
              config: params.config,
              memory: params.preparedConversationContext.memory,
              scopedToolDefinitions: tools,
              signal: params.signal!,
              onToolCall: params.onScopedWorkerToolCall!,
              onToolResult: params.onScopedWorkerToolResult!,
            });
            const result = await runtime.call("read_file", {
              path: "evidence.txt",
              startLine: 1,
              endLine: 1,
            });
            expect(
              result.toolResult.isError,
              result.toolResult.output,
            ).toBeFalsy();
            expect(result.toolResult.output).toContain("Verified evidence");
            return {
              task: params.task,
              mode: params.config.mode,
              status: "executed",
              summary: "Evidence reviewed.",
              executedTools: [],
              outputSections: [],
            };
          }
          const tools = (params.additionalToolDefinitions ?? []).map(
            (tool) => tool.spec.name,
          );
          const evaluating = params.resultProtocol?.kind === "goal-evaluation";
          expect(params.nativeGoal).toBe(
            !evaluating && goalMode === "native"
              ? "Review the supplied evidence"
              : undefined,
          );
          if (evaluating) {
            expect(params.scopedWorkerToolDefinitions).toEqual([]);
            evaluationTools.push(tools);
            evaluations += 1;
          } else {
            workTools.push(tools);
            if (parallelMode !== "disabled") {
              const parallel = params.additionalToolDefinitions!.find(
                (tool) => tool.spec.name === "run_parallel_agents",
              );
              const result = await parallel!.execute({ workers }, toolContext);
              expect(result.toolResult.isError, result.toolResult.output).toBe(
                false,
              );
              parallelResults.push(result.toolResult.output);
            }
          }
          return {
            task: params.task,
            mode: params.config.mode,
            status: "executed",
            summary: "Review complete.",
            executedTools: [],
            outputSections: [],
            ...(evaluating
              ? {
                  control: {
                    kind: "goal-evaluation",
                    decision:
                      evaluations === 1 && goalMode === "machdoch"
                        ? "continue"
                        : "complete",
                  },
                }
              : {}),
          };
        },
      );
      const modelAdapter: AgentModelAdapter = {
        startTurn: async (params) => {
          const toolNames = params.tools.map((tool) => tool.name);
          const evaluating =
            toolNames.length === 1 && toolNames[0] === "submit_final_response";
          if (evaluating) {
            evaluationTools.push(toolNames);
            evaluations += 1;
          } else {
            workTools.push(toolNames);
            if (parallelMode !== "disabled") {
              return {
                text: "",
                toolCalls: [
                  {
                    id: randomUUID(),
                    name: "run_parallel_agents",
                    arguments: { workers },
                  },
                ],
              };
            }
          }
          return finalTurn(
            evaluating
              ? evaluations === 1
                ? "continue"
                : "complete"
              : undefined,
          );
        },
        continueTurn: async ({ toolResults }) => {
          expect(toolResults).toHaveLength(1);
          expect(toolResults[0]?.isError, toolResults[0]?.output).toBe(false);
          parallelResults.push(toolResults[0]!.output);
          return finalTurn();
        },
      };
      const resolvedInstructions = createInstructionResolutionFixture({
        providerId: provider,
        surface: provider.endsWith("-cli") ? "cli" : "api",
        model: models[provider],
      });
      const result = await executeTask(
        "/goal Review the supplied evidence",
        createConfig(provider),
        { workspaceRoot, prompts: [], skills: [] },
        {
          ...(cliProvider ? {} : { modelAdapter }),
          monitorModelAdapter: {
            startTurn: async () => ({
              text: "",
              toolCalls: [
                {
                  id: randomUUID(),
                  name: "report_autopilot_decision",
                  arguments: {
                    decision: "complete",
                    confidence: "high",
                    rationale: "The requested review was completed.",
                    missingRequirements: [],
                    requiredActions: [],
                  },
                },
              ],
            }),
            continueTurn: async (): Promise<never> => {
              throw new Error("No monitor continuation was requested.");
            },
          },
          resolvedInstructions,
          instructionDeliveryPlan:
            createInstructionDeliveryPlan(resolvedInstructions),
          conversationContext: {
            sessionId: randomUUID(),
            history: [],
            goalMode,
            parallelAgentMode: parallelMode,
            adaptiveControllerOverride: true,
            sessionMemoryEnabled: false,
            workspaceMemoryEnabled: false,
            globalMemoryEnabled: false,
          },
        },
      );

      expect(result.status, result.reason ?? result.summary).toBe("executed");
      const expectedTurns = goalMode === "native" ? 1 : 2;
      expect(result.metadata?.goal).toMatchObject({
        mode: goalMode,
        status: "complete",
        turns: expectedTurns,
      });
      expect(workTools).toHaveLength(expectedTurns);
      for (const tools of workTools) {
        expect(tools.includes("run_parallel_agents")).toBe(
          parallelMode !== "disabled",
        );
      }
      expect(evaluationTools).toHaveLength(expectedTurns);
      for (const tools of evaluationTools)
        expect(tools).toEqual(cliProvider ? [] : ["submit_final_response"]);
      const expectedDelegations =
        parallelMode === "disabled" ? 0 : expectedTurns;
      expect(parallelResults).toHaveLength(expectedDelegations);
      for (const output of parallelResults) {
        expect(JSON.parse(output)).toEqual(
          workers.map(({ id }) => ({
            id,
            status: "completed",
            answer: "Evidence reviewed.",
            toolCalls: 1,
          })),
        );
      }
      expect(workerTools).toHaveLength(expectedDelegations * 2);
      for (const tools of workerTools) {
        expect(tools).toContain("read_file");
        expect(tools).not.toContain("run_parallel_agents");
        expect(tools).not.toContain("create_file");
      }
    },
  );
});
