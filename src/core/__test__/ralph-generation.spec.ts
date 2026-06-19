import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { executeTask } from "../execution.js";
import {
  createRalphFlowWithAgent,
  type RalphGenerationEvent,
} from "../ralph-generation.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import {
  createExecutionResult,
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

vi.mock("../execution.js", () => ({
  executeTask: vi.fn(),
}));

const createGeneratedFlowResult = (
  flow = createFlow({
    settings: { maxTransitions: 10 },
  }),
) =>
  createExecutionResult({
    summary: "Generated Ralph flow JSON.",
    response: {
      markdown: `<ralph_flow_json>\n${JSON.stringify(flow, null, 2)}\n</ralph_flow_json>`,
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  });

const createSubmittedFlowResult = (
  flow = createFlow({
    settings: { maxTransitions: 10 },
  }),
) =>
  createExecutionResult({
    summary: "Submitted Ralph flow candidate.",
    response: {
      markdown: "Submitted a valid Ralph flow candidate.",
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
    outputSections: [
      {
        title: "Submitted Ralph flow candidate",
        audience: "internal",
        lines: [
          "<ralph_flow_json>",
          ...JSON.stringify(flow, null, 2).split("\n"),
          "</ralph_flow_json>",
        ],
      },
    ],
  });

const writeStoredFlow = async (
  workspace: string,
  flow = createFlow({
    settings: { maxTransitions: 10 },
  }),
): Promise<void> => {
  const flowDirectory = join(workspace, ".machdoch", "ralph", "flows");

  await mkdir(flowDirectory, { recursive: true });
  await writeFile(
    join(flowDirectory, `${flow.id}.json`),
    `${JSON.stringify(flow, null, 2)}\n`,
    "utf8",
  );
};

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

  it("does not persist a generated flow when local structure validation requests retry", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "blocked-flow",
            alias: "blocked-flow",
            name: "Blocked flow",
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "blocked-flow",
        prompt: "Create a flow.",
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

  it("uses a structured Ralph tool submission from output sections", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createSubmittedFlowResult(
          createFlow({
            id: "structured-submit-flow",
            alias: "structured-submit-flow",
            name: "Structured submit flow",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "structured-submit-flow",
        prompt: "Create a flow using structured submission.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });
      const saved = JSON.parse(await readFile(result.flowPath, "utf8")) as {
        id: string;
        name: string;
      };

      expect(result.status).toBe("created");
      expect(saved.id).toBe(result.flow?.id);
      expect(saved.name).toBe("Structured submit flow");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses the generated flow identity when the model submits a conflicting alias", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      await writeStoredFlow(
        workspace,
        createFlow({
          id: "existing-flow",
          alias: "shared-alias",
          name: "Existing flow",
          settings: { maxTransitions: 10 },
        }),
      );
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "model-flow-id",
            alias: "shared-alias",
            name: "Fresh flow",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "fresh-flow",
        prompt: "Create a new flow but the model reuses another alias.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });
      const saved = JSON.parse(await readFile(result.flowPath, "utf8")) as {
        alias?: string;
      };

      expect(result.status).toBe("created");
      expect(result.flow?.alias).toBe("fresh-flow");
      expect(saved.alias).toBe("fresh-flow");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("allocates a fallback alias when the requested generated alias already exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      await writeStoredFlow(
        workspace,
        createFlow({
          id: "existing-flow",
          alias: "duplicate-flow",
          name: "Existing flow",
          settings: { maxTransitions: 10 },
        }),
      );
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "duplicate-flow",
            alias: "duplicate-flow",
            name: "Duplicate flow",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "duplicate-flow",
        prompt: "Create a flow whose requested alias already exists.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });
      const generatorTask = vi.mocked(executeTask).mock.calls[0]?.[0] ?? "";
      const saved = JSON.parse(await readFile(result.flowPath, "utf8")) as {
        alias?: string;
      };

      expect(result.status).toBe("created");
      expect(result.flow?.alias).toBe("duplicate-flow-1");
      expect(saved.alias).toBe("duplicate-flow-1");
      expect(generatorTask).toContain('"alias": "duplicate-flow-1"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("retries invalid generated JSON and blocks after maxRounds is exhausted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const events: RalphGenerationEvent[] = [];

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createExecutionResult({
          summary: "Generated invalid Ralph flow JSON.",
          response: {
            markdown: "<ralph_flow_json>\n{ not json\n</ralph_flow_json>",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      );

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

  it("uses the current round output after a stale validated retry artifact exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      const staleFlow = createFlow({
        id: "ui-improvement-loop",
        alias: "ui-improvement-loop",
        name: "Refactor loop",
      });
      const correctedFlow = createFlow({
        id: "ui-improvement-loop",
        alias: "ui-improvement-loop",
        name: "UI improvement loop",
        settings: { maxTransitions: 10 },
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "collect-ui-evidence",
            type: "UTILITY",
            title: "Collect UI Evidence",
            utility: {
              type: "UI_ANALYZE",
              adapter: "image",
              screenshotPath: "{{screenshotPath:path=}}",
            },
          },
          {
            id: "fix-ui",
            type: "PROMPT",
            title: "Fix UI",
            prompt: "Improve the UI for {{scope:path=ALL}}.",
          },
          {
            id: "validate-ui",
            type: "VALIDATOR",
            title: "Validate UI",
            prompt:
              "Validate the UI improvement loop and end with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
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
            id: "start-to-ui-evidence",
            from: "start",
            fromOutput: "SUCCESS",
            to: "collect-ui-evidence",
          },
          {
            id: "ui-evidence-to-fix",
            from: "collect-ui-evidence",
            fromOutput: "SUCCESS",
            to: "fix-ui",
          },
          {
            id: "ui-evidence-unavailable-to-fix",
            from: "collect-ui-evidence",
            fromOutput: "UNAVAILABLE",
            to: "fix-ui",
          },
          {
            id: "fix-to-validate",
            from: "fix-ui",
            fromOutput: "SUCCESS",
            to: "validate-ui",
          },
          {
            id: "validate-done",
            from: "validate-ui",
            fromOutput: "DONE",
            to: "success",
          },
          {
            id: "validate-continue",
            from: "validate-ui",
            fromOutput: "CONTINUE",
            to: "fix-ui",
          },
        ],
      });

      vi.mocked(executeTask)
        .mockResolvedValueOnce(createGeneratedFlowResult(staleFlow))
        .mockResolvedValueOnce(createGeneratedFlowResult(correctedFlow));

      const result = await createRalphFlowWithAgent(workspace, {
        name: "ui-improvement-loop",
        prompt: "Create a UI improvement loop.",
        maxRounds: 2,
        config: runtimeConfig,
        customizations,
      });
      const firstTask = vi.mocked(executeTask).mock.calls[0]?.[0] ?? "";
      const secondTask = vi.mocked(executeTask).mock.calls[1]?.[0] ?? "";
      const flowDirectoryEntries = await readdir(
        join(workspace, ".machdoch", "ralph", "flows"),
      );

      expect(result.status).toBe("created");
      expect(result.rounds).toBe(2);
      expect(result.flow?.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "collect-ui-evidence",
            type: "UTILITY",
            utility: expect.objectContaining({ type: "UI_ANALYZE" }),
          }),
        ]),
      );
      expect(result.validatorResults.map((validatorResult) => validatorResult.summary))
        .toEqual([
          "Local Ralph generation validator returned RETRY.",
          "Local Ralph generation validator returned DONE.",
        ]);
      expect(firstTask).toContain("-round-1.json");
      expect(secondTask).toContain("-round-2.json");
      expect(flowDirectoryEntries).toHaveLength(1);
      expect(
        flowDirectoryEntries.every((entry) => !entry.includes("-generation")),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts locally validated generated flows without a delegated validator call", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "generated-flow",
            alias: "generated-flow",
            name: "Generated flow",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "generated-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });

      expect(result.status).toBe("created");
      expect(executeTask).toHaveBeenCalledTimes(1);
      expect(vi.mocked(executeTask).mock.calls[0]?.[1].mode).toBe("ask");
      expect(vi.mocked(executeTask).mock.calls[0]?.[1].reasoning).toBe(
        "medium",
      );
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

  it("reports non-blocking quality warnings for example-shaped visual blocks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "visual-template-flow",
            alias: "visual-template-flow",
            name: "Visual template flow",
            settings: { maxTransitions: 10 },
            blocks: [
              { id: "start", type: "START", title: "Start" },
              {
                id: "main-task",
                type: "PROMPT",
                title: "Main Task",
                prompt: "Do the requested work.",
              },
              {
                id: "review-result",
                type: "VALIDATOR",
                title: "Review Result",
                prompt:
                  "Validate the completed work. End with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
                validationScope: { mode: "sinceLastValidator" },
              },
              {
                id: "success",
                type: "END",
                title: "Success",
                status: "success",
              },
              {
                id: "work-note",
                type: "NOTE",
                title: "Operator note",
                text: "Copied template note.",
              },
              {
                id: "work-group",
                type: "GROUP",
                title: "Work loop",
                childBlockIds: ["main-task", "review-result"],
              },
            ],
            edges: [
              {
                id: "start-to-main-task",
                from: "start",
                fromOutput: "SUCCESS",
                to: "main-task",
              },
              {
                id: "main-task-to-review",
                from: "main-task",
                fromOutput: "SUCCESS",
                to: "review-result",
              },
              {
                id: "review-done",
                from: "review-result",
                fromOutput: "DONE",
                to: "success",
              },
              {
                id: "review-continue",
                from: "review-result",
                fromOutput: "CONTINUE",
                to: "main-task",
              },
            ],
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "visual-template-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });
      const validatorMarkdown = result.validatorResults[0]?.response?.markdown ?? "";

      expect(result.status).toBe("created");
      expect(validatorMarkdown).toContain("Small generated flows should usually omit NOTE and GROUP blocks");
      expect(validatorMarkdown).toContain("schema-example block id(s)");
      expect(validatorMarkdown).toContain("RALPH_DECISION: DONE");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not use prompt keyword matching for generated flow validation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "required-refactoring-loop",
            alias: "required-refactoring-loop",
            name: "Required refactoring loop",
            description: "Required refactoring loop.",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "required-refactoring-loop",
        prompt: "Create a required refactoring loop.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });

      expect(result.status).toBe("created");
      expect(result.validatorResults).toHaveLength(1);
      expect(result.validatorResults[0]?.summary).toContain(
        "Local Ralph generation validator returned DONE.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("emits generation activity events and writes generation logs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const events: RalphGenerationEvent[] = [];

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "observable-flow",
            alias: "observable-flow",
            name: "Observable flow",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

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

  it("emits delegated actor progress and output events while generating", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const events: RalphGenerationEvent[] = [];

    try {
      vi.mocked(executeTask).mockImplementation(
        async (task, _attemptConfig, _customizations, executionOptions) => {
          await executionOptions?.onStateChange?.({
            task: "Ralph generator",
            mode: runtimeConfig.mode,
            state: "checking-tools",
            message: "Resolve the available tool surface before any execution starts.",
            executedTools: [],
            outputSections: [],
            cancellable: true,
          });
          await executionOptions?.onActionOutput?.({
            toolName: "codex-cli",
            stream: "stderr",
            chunk: "generator is still checking tools",
          });

          expect(task).toContain("<ralph_flow_json>");

          return createGeneratedFlowResult(
            createFlow({
              id: "observable-actor-flow",
              alias: "observable-actor-flow",
              name: "Observable actor flow",
              settings: { maxTransitions: 10 },
            }),
          );
        },
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "observable-actor-flow",
        prompt: "Create a small observable actor flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
        onGenerationEvent: (event) => {
          events.push(event);
        },
      });

      expect(result.status).toBe("created");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "actor-progress",
            actor: "generator",
            actorState: "checking-tools",
          }),
          expect.objectContaining({
            type: "actor-output",
            actor: "generator",
            actionToolName: "codex-cli",
            actionStream: "stderr",
            detail: "generator is still checking tools",
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("adds package-manager and MCP capability hints to generator tasks", async () => {
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

      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
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
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "ui-improvement-flow",
        prompt: "UI improvement loop.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });
      const generatorTask = vi.mocked(executeTask).mock.calls[0]?.[0] ?? "";
      const generatorOptions = vi.mocked(executeTask).mock.calls[0]?.[3];

      expect(result.status).toBe("created");
      expect(generatorTask).toContain("Output contract:");
      expect(generatorTask).toContain("Preferred: call ralph_submit_flow_candidate");
      expect(generatorTask).toContain("<ralph_flow_json>");
      expect(generatorTask).toContain(
        "Use graph blocks: START, PROMPT, VALIDATOR, DECISION, PACK, UTILITY, NOTE, GROUP, END.",
      );
      expect(generatorTask).toContain(
        "omit NOTE and GROUP blocks by default",
      );
      expect(generatorTask).toContain("A generated flow may have zero, one, or multiple NOTE/GROUP blocks");
      expect(generatorTask).toContain("NOTE.text");
      expect(generatorTask).toContain("GROUP.childBlockIds");
      expect(generatorTask).toContain("Minimal schema example:");
      expect(generatorTask).not.toContain('"id": "work-note"');
      expect(generatorTask).not.toContain('"id": "work-group"');
      expect(generatorTask).toContain("Do not write files yourself");
      expect(generatorTask).toContain("Use tools only when they materially reduce uncertainty.");
      expect(generatorTask).toContain("inspect workspace files or run short read-only commands");
      expect(generatorTask).toContain("Do not write files, modify code");
      expect(generatorTask).toContain("Detected package manager: pnpm.");
      expect(generatorTask).toContain(
        "Prefer verification commands in this order: pnpm typecheck:ui && pnpm build:ui && pnpm build.",
      );
      expect(generatorTask).toContain("Available MCP capabilities:");
      expect(generatorTask).toContain(
        "MCP_TOOL candidate: serverId=tauri-live, toolName=capture_screenshot",
      );
      expect(generatorTask).toContain("Keep generated flows compact");
      expect(generatorTask).toContain(
        "Use UI_ANALYZE only when it materially helps satisfy that request",
      );
      expect(generatorTask).toContain("settings.maxTransitions");
      expect(generatorTask).toContain("Generation scope: workspace.");
      expect(generatorOptions?.systemPromptSections?.join("\n")).toContain(
        "You are Ralph Flow Generator",
      );
      expect(generatorOptions?.systemPromptSections?.join("\n")).toContain(
        "Omit NOTE and GROUP blocks by default",
      );
      expect(
        generatorOptions?.additionalToolDefinitions?.map(
          (tool) => tool.spec.name,
        ),
      ).toEqual(
        expect.arrayContaining([
          "ralph_submit_generation_plan",
          "ralph_list_node_types",
          "ralph_get_node_contract",
          "ralph_list_utility_types",
          "ralph_get_utility_contract",
          "ralph_validate_candidate_flow",
          "ralph_normalize_layout",
          "ralph_submit_flow_candidate",
        ]),
      );
      expect(
        generatorOptions?.additionalToolDefinitions?.find(
          (tool) => tool.spec.name === "ralph_submit_flow_candidate",
        )?.spec.inputSchema,
      ).toMatchObject({
        properties: {
          flow: expect.objectContaining({
            properties: expect.objectContaining({
              blocks: expect.any(Object),
              edges: expect.any(Object),
            }),
          }),
          flowJson: { type: "string" },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("includes MCP capability hints without prompt keyword gating", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            packageManager: "pnpm@10.12.1",
            scripts: {
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

      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "type-reexport-cleanup-flow",
            alias: "type-reexport-cleanup-flow",
            name: "Type re-export cleanup flow",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

      const result = await createRalphFlowWithAgent(workspace, {
        name: "type-reexport-cleanup-flow",
        prompt: "Create a TypeScript re-export cleanup flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });
      const generatorTask = vi.mocked(executeTask).mock.calls[0]?.[0] ?? "";

      expect(result.status).toBe("created");
      expect(generatorTask).toContain("Detected package manager: pnpm.");
      expect(generatorTask).toContain("Available MCP capabilities:");
      expect(generatorTask).toContain(
        "MCP_TOOL candidate: serverId=tauri-live, toolName=capture_screenshot",
      );
      expect(generatorTask).not.toContain("Keep UI-improvement loops compact");
      expect(generatorTask).toContain(
        "Use UI_ANALYZE only when it materially helps satisfy that request",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies a default timeout to generation actor executions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));

    try {
      vi.mocked(executeTask).mockResolvedValue(
        createGeneratedFlowResult(
          createFlow({
            id: "timeout-flow",
            alias: "timeout-flow",
            name: "Timeout flow",
            settings: { maxTransitions: 10 },
          }),
        ),
      );

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
      ).toEqual([180_000]);
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

  it.each([
    "openai",
    "anthropic",
    "google",
    "codex-cli",
    "claude-cli",
    "copilot-cli",
  ] as const)(
    "does not fall back from %s to another provider after quota failures",
    async (provider) => {
      const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
      const selectedProviderConfig: RuntimeConfig = {
        ...runtimeConfig,
        provider,
        model: "gpt-5.5",
        providerAvailability: [
          { provider: "openai", configured: true },
          { provider: "anthropic", configured: true },
          { provider: "google", configured: true },
          { provider: "codex-cli", configured: true },
          { provider: "claude-cli", configured: true },
          { provider: "copilot-cli", configured: true },
        ],
      };

      try {
        vi.mocked(executeTask).mockResolvedValue(
          createExecutionResult({
            status: "blocked",
            summary: `${provider} execution failed before completing the task.`,
            reason:
              `${provider} quota exceeded: Quota exceeded. Check your plan and billing details.`,
          }),
        );

        const result = await createRalphFlowWithAgent(workspace, {
          name: "provider-isolation-flow",
          prompt: "Create a small test flow.",
          maxRounds: 1,
          config: selectedProviderConfig,
          customizations,
        });

        expect(result.status).toBe("blocked");
        expect(
          vi.mocked(executeTask).mock.calls.map(([, config]) => config.provider),
        ).toEqual([provider]);
        expect(result.generatorResults).toHaveLength(1);
        expect(result.validatorResults).toHaveLength(0);
        expect(result.summary).toContain(`${provider} quota exceeded`);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("does not fall back from Codex CLI to API or other CLI providers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const selectedProviderConfig: RuntimeConfig = {
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
      vi.mocked(executeTask).mockImplementation(async (_task, attemptConfig) => {
        if (attemptConfig.provider !== "codex-cli") {
          throw new Error(
            `Unexpected additional Ralph provider attempt with ${attemptConfig.provider}.`,
          );
        }

        return createExecutionResult({
          status: "blocked",
          summary: "Codex CLI execution failed before completing the task.",
          reason:
            "Codex CLI quota exceeded: Quota exceeded. Check your plan and billing details.",
        });
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "codex-only-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: selectedProviderConfig,
        customizations,
      });

      expect(result.status).toBe("blocked");
      expect(vi.mocked(executeTask).mock.calls.map(([, config]) => config.provider))
        .toEqual(["codex-cli"]);
      expect(result.generatorResults).toHaveLength(1);
      expect(result.validatorResults).toHaveLength(0);
      expect(result.summary).toContain("Codex CLI quota exceeded");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not fall back from Codex CLI after safety timeouts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-generation-"));
    const selectedProviderConfig: RuntimeConfig = {
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
      vi.mocked(executeTask).mockImplementation(async (_task, attemptConfig) => {
        if (attemptConfig.provider !== "codex-cli") {
          throw new Error(
            `Unexpected additional Ralph provider attempt with ${attemptConfig.provider}.`,
          );
        }

        return createExecutionResult({
          status: "cancelled",
          summary: "Execution stopped after exceeding the safety timeout of 3 minutes.",
          reason: "Execution stopped after exceeding the safety timeout of 3 minutes.",
        });
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "timeout-codex-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: selectedProviderConfig,
        customizations,
      });

      expect(result.status).toBe("blocked");
      expect(vi.mocked(executeTask).mock.calls.map(([, config]) => config.provider))
        .toEqual(["codex-cli"]);
      expect(vi.mocked(executeTask).mock.calls.map(([, config]) => config.mode))
        .toEqual(["ask"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});


