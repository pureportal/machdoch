import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { executeTask } from "../execution.js";
import { createRalphFlowWithAgent, type RalphGenerationEvent } from "../ralph.js";
import type { RuntimeConfig } from "../types.js";
import {
  createExecutionResult,
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({
  executeTask: vi.fn(),
}));
describe("createRalphFlowWithAgent", () => {
  beforeEach(() => {
    vi.mocked(executeTask).mockReset();
  });

  it("blocks generation before execution when the name cannot become a flow id", async () => {
    await expect(
      createRalphFlowWithAgent("C:/workspace", {
        name: "!!!",
        prompt: "Create a flow.",
        config: runtimeConfig,
        customizations,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      rounds: 0,
    });
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("blocks generation before execution when maxRounds is outside the supported range", async () => {
    await expect(
      createRalphFlowWithAgent("C:/workspace", {
        name: "invalid-rounds",
        prompt: "Create a flow.",
        maxRounds: 0,
        config: runtimeConfig,
        customizations,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      rounds: 0,
      validation: expect.objectContaining({
        errors: expect.arrayContaining([
          "maxRounds must be an integer from 1 to 25.",
        ]),
      }),
      events: [],
    });
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("blocks generation before execution when the prompt is blank", async () => {
    await expect(
      createRalphFlowWithAgent("C:/workspace", {
        name: "blank-prompt",
        prompt: "   ",
        config: runtimeConfig,
        customizations,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      rounds: 0,
      validation: expect.objectContaining({
        errors: expect.arrayContaining([
          "Expected a prompt before generating a Ralph flow.",
        ]),
      }),
      events: [],
    });
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("does not persist a generated flow when local semantic validation requests retry", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockImplementation(async (task) => {
        const flowPath = /Write the finished flow JSON to this exact workspace path:\n(.+)/u
          .exec(task)?.[1]
          ?.trim();

        if (flowPath) {
          await writeFile(
            flowPath,
            JSON.stringify(
              createFlow({
                id: "blocked-flow",
                alias: "blocked-flow",
                name: "Blocked flow",
              }),
            ),
            "utf8",
          );

          return createExecutionResult();
        }

        throw new Error("Ralph generation should not launch a delegated validator.");
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "blocked-flow",
        prompt: "Create a flow that runs lint before finishing.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });

      expect(result.status).toBe("blocked");
      expect(result.validatorResults).toHaveLength(1);
      expect(result.validatorResults[0]?.summary).toContain(
        "Local Ralph generation validator returned RETRY.",
      );
      expect(executeTask).toHaveBeenCalledTimes(1);
      await expect(readFile(result.flowPath, "utf8")).rejects.toThrow();
      await expect(readdir(join(workspace, ".machdoch", "ralph", "flows")))
        .resolves.toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("retries invalid generated JSON and blocks after maxRounds is exhausted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const events: RalphGenerationEvent[] = [];

    try {
      vi.mocked(executeTask).mockImplementation(async (task) => {
        const flowPath = /Write the finished flow JSON to this exact workspace path:\n(.+)/u
          .exec(task)?.[1]
          ?.trim();

        if (flowPath) {
          await writeFile(flowPath, "{ not json", "utf8");
        }

        return createExecutionResult();
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "invalid-json-flow",
        prompt: "Create a flow.",
        maxRounds: 2,
        config: runtimeConfig,
        customizations,
        onGenerationEvent: (event) => {
          events.push(event);
        },
      });

      expect(result.status).toBe("blocked");
      expect(result.rounds).toBe(2);
      expect(result.summary).toContain(
        "Ralph flow generation did not converge after 2 round(s).",
      );
      expect(result.generatorResults).toHaveLength(2);
      expect(result.validatorResults).toHaveLength(0);
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "schema-validation-result",
          "retry-feedback",
          "blocked",
        ]),
      );
      await expect(readFile(result.flowPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts locally validated generated flows without a delegated validator call", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockImplementation(async (task) => {
        const flowPath = /Write the finished flow JSON to this exact workspace path:\n(.+)/u
          .exec(task)?.[1]
          ?.trim();

        if (flowPath) {
          await writeFile(
            flowPath,
            JSON.stringify(
              createFlow({
                id: "generated-flow",
                alias: "generated-flow",
                name: "Generated flow",
                settings: { maxTransitions: 10 },
              }),
            ),
            "utf8",
          );

          return createExecutionResult();
        }

        throw new Error("Ralph generation should not launch a delegated validator.");
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "generated-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });

      expect(result.status).toBe("created");
      expect(executeTask).toHaveBeenCalledTimes(1);
      expect(result.validatorResults).toHaveLength(1);
      expect(result.validatorResults[0]?.summary).toContain(
        "Local Ralph generation validator returned DONE.",
      );
      await expect(readFile(result.flowPath, "utf8")).resolves.toContain(
        '"schemaVersion": 1',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits generation activity events and writes generation logs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const events: RalphGenerationEvent[] = [];

    try {
      vi.mocked(executeTask).mockImplementation(async (task) => {
        const flowPath = /Write the finished flow JSON to this exact workspace path:\n(.+)/u
          .exec(task)?.[1]
          ?.trim();

        if (flowPath) {
          await writeFile(
            flowPath,
            JSON.stringify(
              createFlow({
                id: "observable-flow",
                alias: "observable-flow",
                name: "Observable flow",
                settings: { maxTransitions: 10 },
              }),
            ),
            "utf8",
          );

          return createExecutionResult();
        }

        throw new Error("Ralph generation should not launch a delegated validator.");
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "observable-flow",
        prompt: "Create a small observable flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
        onGenerationEvent: (event) => {
          events.push(event);
        },
      });

      expect(result.status).toBe("created");
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "started",
          "round-start",
          "generator-start",
          "schema-validation-result",
          "generator-file-written",
          "validator-start",
          "validator-result",
          "created",
        ]),
      );
      expect(result.validatorResults).toHaveLength(1);
      expect(result.events).toHaveLength(events.length);
      expect(result.generationLogPath).toBeTruthy();
      expect(result.traceLogPath).toBeTruthy();
      await expect(readFile(result.generationLogPath ?? "", "utf8")).resolves
        .toContain("Created Ralph flow `Observable flow`");
      await expect(readFile(result.traceLogPath ?? "", "utf8")).resolves
        .toContain('"type":"created"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("adds package-manager and visual MCP capability hints to generator tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            packageManager: "pnpm@10.12.1",
            scripts: {
              "typecheck:ui": "tsc -p tsconfig.ui.json --noEmit",
              "build:ui": "vite build",
              build: "tsc -p tsconfig.json",
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await mkdir(join(workspace, ".machdoch", "mcp"), { recursive: true });
      await writeFile(
        join(workspace, ".machdoch", "mcp", "mcp.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            servers: [
              {
                id: "tauri-live",
                enabled: true,
                transport: {
                  type: "stdio",
                  command: "tauri-driver",
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        join(workspace, ".machdoch", "mcp", "discovery-cache.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            servers: {
              "tauri-live": {
                serverId: "tauri-live",
                discoveredAt: "2026-06-16T00:00:00.000Z",
                transportType: "stdio",
                tools: [
                  {
                    name: "capture_screenshot",
                    description: "Capture a screenshot of the live Tauri window.",
                    inputSchema: {},
                  },
                ],
                resources: [],
                resourceTemplates: [],
                prompts: [],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      vi.mocked(executeTask).mockImplementation(async (task) => {
        const flowPath = /Write the finished flow JSON to this exact workspace path:\n(.+)/u
          .exec(task)?.[1]
          ?.trim();

        if (flowPath) {
          await writeFile(
            flowPath,
            JSON.stringify(
              createFlow({
                id: "ui-improvement-flow",
                alias: "ui-improvement-flow",
                name: "UI improvement loop",
                settings: {
                  maxTransitions: 30,
                },
                variables: [
                  {
                    name: "screenshotPath",
                    type: "path",
                    required: false,
                  },
                ],
              }),
            ),
            "utf8",
          );

          return createExecutionResult();
        }

        throw new Error("Ralph generation should not launch a delegated validator.");
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "ui-improvement-flow",
        prompt: "UI improvement loop.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });
      const generatorTask = vi.mocked(executeTask).mock.calls[0]?.[0] ?? "";

      expect(result.status).toBe("created");
      expect(generatorTask).toContain("Detected package manager: pnpm.");
      expect(generatorTask).toContain(
        "Prefer UI verification commands in this order: pnpm typecheck:ui && pnpm build:ui && pnpm build.",
      );
      expect(generatorTask).toContain(
        "MCP_TOOL candidate: serverId=tauri-live, toolName=capture_screenshot",
      );
      expect(generatorTask).toContain("Keep UI-improvement loops compact");
      expect(generatorTask).toContain(
        "prefer a UI_ANALYZE utility before deciding DONE",
      );
      expect(generatorTask).toContain("settings.maxTransitions");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies a default timeout to generation actor executions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockImplementation(async (task) => {
        const flowPath = /Write the finished flow JSON to this exact workspace path:\n(.+)/u
          .exec(task)?.[1]
          ?.trim();

        if (flowPath) {
          await writeFile(
            flowPath,
            JSON.stringify(
              createFlow({
                id: "timeout-flow",
                alias: "timeout-flow",
                name: "Timeout flow",
                settings: { maxTransitions: 10 },
              }),
            ),
            "utf8",
          );

          return createExecutionResult();
        }

        throw new Error("Ralph generation should not launch a delegated validator.");
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "timeout-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });

      expect(result.status).toBe("created");
      expect(
        vi.mocked(executeTask).mock.calls.map(([, , , options]) =>
          options?.maxDurationMs,
        ),
      ).toEqual([600_000]);
      expect(result.validatorResults).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("stops generation when the selected generator provider cannot execute", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockResolvedValueOnce(
        createExecutionResult({
          status: "unsupported",
          summary: "Copilot CLI is not implemented.",
          reason: "Use codex-cli for delegated CLI execution in this build.",
        }),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "unsupported-flow",
        prompt: "Create a small test flow.",
        maxRounds: 3,
        config: runtimeConfig,
        customizations,
      });

      expect(result).toMatchObject({
        status: "blocked",
        rounds: 1,
      });
      expect(result.summary).toContain("generator did not execute");
      expect(executeTask).toHaveBeenCalledTimes(1);
      await expect(readFile(result.flowPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("retries flow generation with a configured fallback provider after quota failures", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const fallbackConfig: RuntimeConfig = {
      ...runtimeConfig,
      provider: "codex-cli",
      model: "gpt-5.5",
      providerAvailability: [
        { provider: "openai", configured: true },
        { provider: "codex-cli", configured: true },
        { provider: "claude-cli", configured: true },
      ],
    };

    try {
      vi.mocked(executeTask).mockImplementation(async (task, attemptConfig) => {
        if (attemptConfig.provider === "codex-cli") {
          return createExecutionResult({
            status: "blocked",
            summary: "Codex CLI execution failed before completing the task.",
            reason:
              "Codex CLI quota exceeded: Quota exceeded. Check your plan and billing details.",
          });
        }

        const flowPath = /Write the finished flow JSON to this exact workspace path:\n(.+)/u
          .exec(task)?.[1]
          ?.trim();

        if (flowPath) {
          await writeFile(
            flowPath,
            JSON.stringify(
              createFlow({
                id: "generated-flow",
                alias: "generated-flow",
                name: "Generated flow",
                settings: { maxTransitions: 10 },
              }),
            ),
            "utf8",
          );

          return createExecutionResult();
        }

        throw new Error("Ralph generation should not launch a delegated validator.");
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "generated-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: fallbackConfig,
        customizations,
      });

      expect(result.status).toBe("created");
      expect(vi.mocked(executeTask).mock.calls.map(([, config]) => config.provider))
        .toEqual(["codex-cli", "claude-cli"]);
      expect(result.generatorResults).toHaveLength(2);
      expect(result.validatorResults).toHaveLength(1);
      expect(result.validatorResults[0]?.summary).toContain(
        "Local Ralph generation validator returned DONE.",
      );
      await expect(readFile(result.flowPath, "utf8")).resolves.toContain(
        '"schemaVersion": 1',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});


