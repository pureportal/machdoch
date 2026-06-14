import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { executeTask } from "./execution.js";
import { mcpClientManager } from "./mcp/client.js";
import {
  MAX_RALPH_RESULT_CHARS,
  createRalphFlowWithAgent,
  deleteRalphFlow,
  discoverRalphFlowVariables,
  getRalphUtilityOutputs,
  getRalphFlowPath,
  listRalphFlowRevisions,
  listRalphFlows,
  normalizeRalphFlowLayout,
  parseRalphFlowJson,
  parseRalphDecision,
  readRalphFlow,
  restoreRalphFlowRevision,
  runRalphFlow,
  validateRalphFlow,
  writeRalphRunRecord,
  writeRalphFlow,
  type RalphFlow,
  type RalphRunResult,
} from "./ralph.js";
import type {
  CustomizationDiscoveryResult,
  RuntimeConfig,
  TaskExecutionResult,
} from "./types.js";

vi.mock("./execution.js", () => ({
  executeTask: vi.fn(),
}));

vi.mock("./mcp/client.js", () => ({
  mcpClientManager: {
    callTool: vi.fn(),
    readResource: vi.fn(),
    getPrompt: vi.fn(),
  },
}));

const createExecutionResult = (
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

const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
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

const runtimeConfig: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  availableProfiles: [],
  mode: "machdoch",
  provider: "openai",
  model: "gpt-5.5",
  offline: false,
  compatibility: {
    discoverGithubCustomizations: false,
    enableUiControlTools: false,
  },
  providerAvailability: [
    {
      provider: "openai",
      configured: true,
    },
  ],
  webSearch: {
    activeProvider: "disabled",
    providerAvailability: [],
  },
  reviewModel: {
    mode: "inherit",
  },
};

const customizations: CustomizationDiscoveryResult = {
  workspaceRoot: "C:/workspace",
  instructions: [],
  prompts: [],
  skills: [],
};

describe("validateRalphFlow", () => {
  it("accepts a valid prompt and validator graph", () => {
    const validation = validateRalphFlow(createFlow());

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.variables).toEqual([
      {
        name: "scope",
        type: "path",
        default: "ALL",
        required: false,
      },
    ]);
  });

  it("requires exactly one start block", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "fix-tsc",
            type: "PROMPT",
            title: "Fix TSC",
            prompt: "Fix.",
          },
        ],
        edges: [],
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "Ralph flow must contain exactly one START block.",
    );
  });

  it("warns when validator CONTINUE is not connected", () => {
    const validation = validateRalphFlow(
      createFlow({
        edges: createFlow().edges.filter(
          (edge) => edge.fromOutput !== "CONTINUE",
        ),
      }),
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain(
      "validate has no edge for output CONTINUE.",
    );
  });

  it("rejects missing edge target blocks", () => {
    const validation = validateRalphFlow(
      createFlow({
        edges: [
          ...createFlow().edges,
          {
            id: "broken",
            from: "validate",
            fromOutput: "ERROR",
            to: "missing",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(
      "edge `broken` references missing target block `missing`.",
    );
  });

  it("rejects unsupported typed variable placeholders", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "bad",
            type: "PROMPT",
            title: "Bad",
            prompt: "Use {{scope:directory}}.",
          },
        ],
        edges: [
          {
            id: "start-to-bad",
            from: "start",
            fromOutput: "SUCCESS",
            to: "bad",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain(
      "unsupported variable type `directory`",
    );
  });

  it("warns for unknown explicit result references", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "use-result",
            type: "PROMPT",
            title: "Use result",
            prompt: "Use {{summary:no-such-block}}.",
          },
        ],
        edges: [
          {
            id: "start-to-use",
            from: "start",
            fromOutput: "SUCCESS",
            to: "use-result",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings.join(" ")).toContain(
      "unknown block `no-such-block`",
    );
  });

  it("accepts MCP blocks with block-level MCP config overrides", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "search",
            type: "MCP_TOOL",
            title: "Search",
            serverId: "serper",
            toolName: "search",
            arguments: {
              query: "{{query:string=machdoch}}",
            },
            settings: {
              mcp: {
                servers: [
                  {
                    id: "serper",
                    enabled: true,
                    auth: {
                      type: "oauth",
                      accessToken: "ralph-access-token",
                      refreshToken: "ralph-refresh-token",
                    },
                  },
                ],
              },
            },
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
            id: "start-to-search",
            from: "start",
            fromOutput: "SUCCESS",
            to: "search",
          },
          {
            id: "search-to-success",
            from: "search",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      { config: runtimeConfig },
    );

    expect(validation.valid).toBe(true);
    expect(validation.variables).toEqual([
      {
        name: "query",
        type: "string",
        default: "machdoch",
        required: false,
      },
    ]);
  });

  it("accepts WAIT utilities without requiring an impossible ERROR route", () => {
    const validation = validateRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "wait",
            type: "UTILITY",
            title: "Wait",
            utility: {
              type: "WAIT",
              mode: "delay",
              delaySeconds: 0,
            },
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
            id: "start-to-wait",
            from: "start",
            fromOutput: "SUCCESS",
            to: "wait",
          },
          {
            id: "wait-to-success",
            from: "wait",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
    );

    expect(validation.valid).toBe(true);
    expect(validation.warnings.join(" ")).not.toContain(
      "wait has no edge for output ERROR",
    );
    expect(getRalphUtilityOutputs({ type: "WAIT" })).toEqual(["SUCCESS"]);
  });
});

describe("discoverRalphFlowVariables", () => {
  it("discovers prompt and attachment variables with defaults and types", () => {
    expect(
      discoverRalphFlowVariables(
        createFlow({
          blocks: [
            {
              id: "start",
              type: "START",
              title: "Start",
            },
            {
              id: "inspect",
              type: "PROMPT",
              title: "Inspect",
              prompt: "Inspect {{scope:path=ALL}} for {{enabled:boolean=true}}.",
              settings: {
                attachments: [
                  {
                    source: "variable",
                    value: "{{screenshot:image}}",
                  },
                ],
              },
            },
          ],
          edges: [],
        }),
      ),
    ).toEqual([
      {
        name: "enabled",
        type: "boolean",
        default: "true",
        required: false,
      },
      {
        name: "scope",
        type: "path",
        default: "ALL",
        required: false,
      },
      {
        name: "screenshot",
        type: "image",
        required: true,
      },
    ]);
  });

  it("treats SET_VARIABLE utility output names as run-produced variables", () => {
    expect(
      discoverRalphFlowVariables(
        createFlow({
          blocks: [
            {
              id: "start",
              type: "START",
              title: "Start",
            },
            {
              id: "set-scope",
              type: "UTILITY",
              title: "Set Scope",
              utility: {
                type: "SET_VARIABLE",
                variableName: "scope",
                value: "src/core",
              },
            },
            {
              id: "use-scope",
              type: "PROMPT",
              title: "Use Scope",
              prompt: "Use {{scope:path}}.",
            },
          ],
          edges: [],
        }),
      ),
    ).toEqual([
      {
        name: "scope",
        type: "path",
        required: false,
      },
    ]);
  });
});

describe("Ralph flow storage", () => {
  const rootsToClean: string[] = [];

  const createWorkspace = async (): Promise<string> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-ralph-flow-"));
    rootsToClean.push(workspaceRoot);

    return workspaceRoot;
  };

  afterEach(async () => {
    await Promise.all(
      rootsToClean.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("writes, lists, and reads flows from .machdoch/ralph/flows", async () => {
    const workspaceRoot = await createWorkspace();
    const flow = createFlow({ alias: "refactor-codebase" });
    const path = await writeRalphFlow(workspaceRoot, flow);

    expect(path).toBe(getRalphFlowPath(workspaceRoot, "refactor-flow"));
    await expect(readRalphFlow(workspaceRoot, "refactor-flow")).resolves.toMatchObject({
      id: "refactor-flow",
      alias: "refactor-codebase",
      variables: [
        {
          name: "scope",
          type: "path",
          default: "ALL",
          required: false,
        },
      ],
    });
    await expect(readRalphFlow(workspaceRoot, "refactor-codebase")).resolves.toMatchObject({
      id: "refactor-flow",
      alias: "refactor-codebase",
    });
    await expect(listRalphFlows(workspaceRoot)).resolves.toEqual([
      expect.objectContaining({
        id: "refactor-flow",
        alias: "refactor-codebase",
        blockCount: 4,
        edgeCount: 4,
        variableCount: 1,
      }),
    ]);
  });

  it("rejects duplicate flow aliases", async () => {
    const workspaceRoot = await createWorkspace();

    await writeRalphFlow(
      workspaceRoot,
      createFlow({ id: "first-flow", alias: "shared-alias" }),
    );

    await expect(
      writeRalphFlow(
        workspaceRoot,
        createFlow({ id: "second-flow", alias: "shared-alias" }),
      ),
    ).rejects.toThrow("Ralph flow alias `shared-alias` is already used");
  });

  it("deletes saved flows and their revisions by alias", async () => {
    const workspaceRoot = await createWorkspace();

    await writeRalphFlow(
      workspaceRoot,
      createFlow({ alias: "refactor-codebase" }),
    );
    await writeRalphFlow(
      workspaceRoot,
      createFlow({ name: "Changed", alias: "refactor-codebase" }),
      {
        createRevision: true,
        allowInvalid: true,
      },
    );

    await expect(
      listRalphFlowRevisions(workspaceRoot, "refactor-flow"),
    ).resolves.toHaveLength(1);

    const result = await deleteRalphFlow(workspaceRoot, "refactor-codebase");

    expect(result).toMatchObject({
      id: "refactor-flow",
      path: getRalphFlowPath(workspaceRoot, "refactor-flow"),
      deletedRevisions: true,
    });
    await expect(listRalphFlows(workspaceRoot)).resolves.toEqual([]);
    await expect(readRalphFlow(workspaceRoot, "refactor-flow")).rejects.toThrow(
      "was not found",
    );
    await expect(
      readdir(join(workspaceRoot, ".machdoch", "ralph", "revisions")),
    ).resolves.toEqual([]);
  });

  it("normalizes missing or null flow schema versions to the current schema", () => {
    const baseFlow = createFlow();
    const withoutSchemaVersion: Partial<RalphFlow> = { ...baseFlow };
    delete withoutSchemaVersion.schemaVersion;
    const missingSchemaVersionFlow = parseRalphFlowJson(
      JSON.stringify(withoutSchemaVersion),
    );
    const nullSchemaVersionFlow = parseRalphFlowJson(
      JSON.stringify({
        ...baseFlow,
        schemaVersion: null,
      }),
    );

    expect(validateRalphFlow(missingSchemaVersionFlow).valid).toBe(true);
    expect(missingSchemaVersionFlow.schemaVersion).toBe(1);
    expect(validateRalphFlow(nullSchemaVersionFlow).valid).toBe(true);
    expect(nullSchemaVersionFlow.schemaVersion).toBe(1);
  });

  it("keeps unsupported numeric flow schema versions invalid", () => {
    const unsupportedVersionFlow = parseRalphFlowJson(
      JSON.stringify({
        ...createFlow(),
        schemaVersion: 2,
      }),
    );

    expect(validateRalphFlow(unsupportedVersionFlow)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["schemaVersion must be 1."]),
    });
  });

  it("can persist unfinished editor drafts without allowing strict reads", async () => {
    const workspaceRoot = await createWorkspace();
    const draftFlow = createFlow({
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
        },
        {
          id: "prompt",
          type: "PROMPT",
          title: "Prompt",
          prompt: "",
        },
      ],
      edges: [],
    });

    await expect(writeRalphFlow(workspaceRoot, draftFlow)).rejects.toThrow(
      "Ralph flow is invalid",
    );

    await expect(
      writeRalphFlow(workspaceRoot, draftFlow, { allowInvalid: true }),
    ).resolves.toBe(getRalphFlowPath(workspaceRoot, "refactor-flow"));

    await expect(readRalphFlow(workspaceRoot, "refactor-flow")).rejects.toThrow(
      "Ralph flow `refactor-flow` is invalid",
    );
    await expect(
      readRalphFlow(workspaceRoot, "refactor-flow", { allowInvalid: true }),
    ).resolves.toMatchObject({
      id: "refactor-flow",
      blocks: expect.arrayContaining([
        expect.objectContaining({
          id: "prompt",
          prompt: "",
        }),
      ]),
    });
    await expect(listRalphFlows(workspaceRoot)).resolves.toEqual([
      expect.objectContaining({
        id: "refactor-flow",
        blockCount: 2,
      }),
    ]);
  });

  it("lists and restores saved flow revisions", async () => {
    const workspaceRoot = await createWorkspace();
    const firstFlow = createFlow({ name: "Initial flow" });
    const secondFlow = createFlow({
      name: "Changed flow",
      blocks: [
        ...createFlow().blocks,
        {
          id: "review",
          type: "END",
          title: "Review",
          status: "review",
        },
      ],
    });

    await writeRalphFlow(workspaceRoot, firstFlow);
    await writeRalphFlow(workspaceRoot, secondFlow, {
      createRevision: true,
      allowInvalid: true,
    });

    const revisions = await listRalphFlowRevisions(workspaceRoot, "refactor-flow");
    expect(revisions).toEqual([
      expect.objectContaining({
        flowName: "Initial flow",
        blockCount: 4,
        edgeCount: 4,
        valid: true,
      }),
    ]);

    const restored = await restoreRalphFlowRevision(
      workspaceRoot,
      "refactor-flow",
      revisions[0]?.id ?? "",
    );

    expect(restored.flow).toMatchObject({
      id: "refactor-flow",
      name: "Initial flow",
      blocks: expect.not.arrayContaining([
        expect.objectContaining({
          id: "review",
        }),
      ]),
    });
    expect(restored.revision).toMatchObject({
      id: revisions[0]?.id,
      flowName: "Initial flow",
      valid: true,
    });
    await expect(listRalphFlowRevisions(workspaceRoot, "refactor-flow")).resolves.toHaveLength(
      2,
    );
  });

  it("writes capped Ralph run records under .machdoch/ralph/runs", async () => {
    const workspaceRoot = await createWorkspace();
    const flow = createFlow({
      updatedAt: "2026-06-13T08:00:00.000Z",
    });
    const longMarkdown = "x".repeat(MAX_RALPH_RESULT_CHARS + 10);
    const runResult: RalphRunResult = {
      flow: flow.id,
      status: "completed",
      summary: "Run completed.",
      events: [
        {
          type: "block-start",
          blockId: "fix-tsc",
          attempt: 1,
        },
        {
          type: "block-output",
          blockId: "fix-tsc",
          output: "SUCCESS",
          summary: "Fixed.",
        },
      ],
      blockResults: [
        {
          blockId: "fix-tsc",
          output: "SUCCESS",
          status: "completed",
          attempt: 1,
          result: createExecutionResult({
            task: "Fix TypeScript errors.",
            summary: "Fixed.",
            response: {
              markdown: longMarkdown,
              highlights: [],
              relatedFiles: [],
              verification: [],
              followUps: [],
            },
          }),
          summary: "Fixed.",
          markdown: longMarkdown,
        },
      ],
      missingVariables: [],
      unknownVariables: [],
      validation: validateRalphFlow(flow, {
        variableValues: {
          scope: "src/core",
        },
      }),
    };

    const written = await writeRalphRunRecord(workspaceRoot, flow, runResult, {
      variableValues: {
        scope: "src/core",
      },
    });
    const rawRecord = JSON.parse(await readFile(written.path, "utf8")) as Record<
      string,
      unknown
    >;

    expect(written.path).toContain(".machdoch");
    expect(rawRecord).toMatchObject({
      schemaVersion: 1,
      id: written.id,
      flowId: "refactor-flow",
      flowName: "Refactor flow",
      flowRevisionId: "2026-06-13T08:00:00.000Z",
      status: "completed",
      variableValues: {
        scope: "src/core",
      },
      validation: {
        valid: true,
      },
    });
    expect(rawRecord.events).toEqual(runResult.events);
    expect(rawRecord.blockResults).toEqual([
      expect.objectContaining({
        blockId: "fix-tsc",
        output: "SUCCESS",
        task: "Fix TypeScript errors.",
        markdown: expect.stringContaining("[Ralph result truncated"),
      }),
    ]);
  });
});

describe("runRalphFlow", () => {
  beforeEach(() => {
    vi.mocked(executeTask).mockReset();
    vi.mocked(mcpClientManager.callTool).mockReset();
    vi.mocked(mcpClientManager.readResource).mockReset();
    vi.mocked(mcpClientManager.getPrompt).mockReset();
  });

  it("runs prompt blocks, validators, and routes to END", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Fixed TSC.",
          response: {
            markdown: "Fixed TSC.",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Valid.",
          response: {
            markdown: "Checks pass.\nRALPH_DECISION: DONE",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      );

    await expect(
      runRalphFlow(createFlow(), runtimeConfig, customizations, {
        maxTransitions: 10,
        runId: "ralph-run-1",
      }),
    ).resolves.toMatchObject({
      flow: "refactor-flow",
      status: "completed",
      blockResults: [
        expect.objectContaining({ blockId: "start", output: "SUCCESS" }),
        expect.objectContaining({ blockId: "fix-tsc", output: "SUCCESS" }),
        expect.objectContaining({ blockId: "validate", output: "DONE" }),
        expect.objectContaining({ blockId: "success" }),
      ],
    });
    expect(vi.mocked(executeTask).mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        runId: "ralph-run-1",
      }),
    );
  });

  it("appends block file attachments to executed prompt tasks", async () => {
    vi.mocked(executeTask).mockResolvedValue(
      createExecutionResult({
        summary: "Inspected.",
      }),
    );

    await runRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "inspect",
            type: "PROMPT",
            title: "Inspect",
            prompt: "Inspect the plan.",
            settings: {
              attachments: [
                {
                  source: "path",
                  value: "C:/workspace/docs/plan.md",
                  kind: "file",
                },
              ],
            },
          },
          {
            id: "success",
            type: "END",
            title: "Success",
          },
        ],
        edges: [
          {
            id: "start-to-inspect",
            from: "start",
            fromOutput: "SUCCESS",
            to: "inspect",
          },
          {
            id: "inspect-to-success",
            from: "inspect",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 10 },
    );

    expect(vi.mocked(executeTask).mock.calls[0]?.[0]).toContain(
      'Use this file: "C:/workspace/docs/plan.md"',
    );
  });

  it("passes image block attachments as model image inputs", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ralph-image-"));
    const imagePath = join(tempDirectory, "screen.png");

    await writeFile(imagePath, Buffer.from("not-a-real-png"));
    vi.mocked(executeTask).mockResolvedValue(
      createExecutionResult({
        summary: "Inspected image.",
      }),
    );

    try {
      await runRalphFlow(
        createFlow({
          blocks: [
            {
              id: "start",
              type: "START",
              title: "Start",
            },
            {
              id: "inspect",
              type: "PROMPT",
              title: "Inspect",
              prompt: "Inspect the mockup.",
              settings: {
                attachments: [
                  {
                    source: "path",
                    value: imagePath,
                    kind: "image",
                  },
                ],
              },
            },
            {
              id: "success",
              type: "END",
              title: "Success",
            },
          ],
          edges: [
            {
              id: "start-to-inspect",
              from: "start",
              fromOutput: "SUCCESS",
              to: "inspect",
            },
            {
              id: "inspect-to-success",
              from: "inspect",
              fromOutput: "SUCCESS",
              to: "success",
            },
          ],
        }),
        runtimeConfig,
        customizations,
        { maxTransitions: 10 },
      );

      expect(vi.mocked(executeTask).mock.calls[0]?.[0]).toContain(
        `Use this image: "${imagePath}"`,
      );
      expect(vi.mocked(executeTask).mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({
          imageInputs: [
            expect.objectContaining({
              path: imagePath,
              mediaType: "image/png",
              data: Buffer.from("not-a-real-png").toString("base64"),
            }),
          ],
        }),
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("falls back to validator group start for unconnected RETRY", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(createExecutionResult({ summary: "Attempt 1." }))
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Retry.",
          response: {
            markdown: "Try again.\nRALPH_DECISION: RETRY",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      )
      .mockResolvedValueOnce(createExecutionResult({ summary: "Attempt 2." }))
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Done.",
          response: {
            markdown: "Done.\nRALPH_DECISION: DONE",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      );

    const result = await runRalphFlow(createFlow(), runtimeConfig, customizations, {
      maxTransitions: 10,
    });

    expect(result.status).toBe("completed");
    expect(
      result.events.filter((event) => event.type === "edge-route"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "validate",
          output: "RETRY",
          to: "fix-tsc",
        }),
      ]),
    );
  });

  it("crashes when CONTINUE has no connected edge and is returned", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(createExecutionResult({ summary: "Attempt." }))
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Continue.",
          response: {
            markdown: "Keep going.\nRALPH_DECISION: CONTINUE",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      );

    await expect(
      runRalphFlow(
        createFlow({
          edges: createFlow().edges.filter(
            (edge) => edge.fromOutput !== "CONTINUE",
          ),
        }),
        runtimeConfig,
        customizations,
        { maxTransitions: 10 },
      ),
    ).resolves.toMatchObject({
      status: "crashed",
      summary:
        "Ralph flow crashed at `validate`: no edge handles output CONTINUE.",
    });
  });

  it("blocks before execution for missing required variables", async () => {
    const result = await runRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "inspect",
            type: "PROMPT",
            title: "Inspect",
            prompt: "Inspect {{scope:path}}.",
          },
        ],
        edges: [
          {
            id: "start-to-inspect",
            from: "start",
            fromOutput: "SUCCESS",
            to: "inspect",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 10 },
    );

    expect(result.status).toBe("blocked");
    expect(result.missingVariables).toEqual(["scope"]);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("runs MCP tool blocks and resolves argument placeholders", async () => {
    vi.mocked(mcpClientManager.callTool).mockResolvedValue({
      content: [
        {
          type: "text",
          text: "search result",
        },
      ],
      isError: false,
    } as never);

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "search",
            type: "MCP_TOOL",
            title: "Search",
            serverId: "serper",
            toolName: "search",
            arguments: {
              query: "{{query:string=machdoch}}",
            },
            settings: {
              mcp: {
                defaults: {
                  securityProfile: "weak",
                },
                servers: [
                  {
                    id: "serper",
                    enabled: true,
                    auth: {
                      type: "oauth",
                      accessToken: "ralph-access-token",
                      refreshToken: "ralph-refresh-token",
                    },
                  },
                ],
              },
            },
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
            id: "start-to-search",
            from: "start",
            fromOutput: "SUCCESS",
            to: "search",
          },
          {
            id: "search-to-success",
            from: "search",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      {
        maxTransitions: 10,
        variableValues: {
          query: "MCP consumer",
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(mcpClientManager.callTool).toHaveBeenCalledWith(
      "C:/workspace",
      "serper",
      "search",
      {
        query: "MCP consumer",
      },
      expect.objectContaining({
        configOverride: expect.objectContaining({
          defaults: {
            securityProfile: "weak",
          },
          servers: [
            expect.objectContaining({
              id: "serper",
              auth: {
                type: "oauth",
                accessToken: "ralph-access-token",
                refreshToken: "ralph-refresh-token",
              },
            }),
          ],
        }),
      }),
    );
    expect(result.blockResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "search",
          output: "SUCCESS",
          status: "completed",
        }),
      ]),
    );
  });

  it("runs SET_VARIABLE utilities and exposes structured utility data to later blocks", async () => {
    vi.mocked(executeTask).mockResolvedValue(
      createExecutionResult({
        summary: "Used utility data.",
      }),
    );

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "set-scope",
            type: "UTILITY",
            title: "Set Scope",
            utility: {
              type: "SET_VARIABLE",
              variableName: "scope",
              value: "src/core",
            },
          },
          {
            id: "use-scope",
            type: "PROMPT",
            title: "Use Scope",
            prompt: "Use {{scope:path}} and {{data:set-scope:value}}.",
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
            id: "start-to-set",
            from: "start",
            fromOutput: "SUCCESS",
            to: "set-scope",
          },
          {
            id: "set-to-use",
            from: "set-scope",
            fromOutput: "SUCCESS",
            to: "use-scope",
          },
          {
            id: "use-to-success",
            from: "use-scope",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 10 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "set-scope",
          output: "SUCCESS",
          data: {
            name: "scope",
            value: "src/core",
          },
        }),
      ]),
    );
    expect(vi.mocked(executeTask).mock.calls[0]?.[0]).toContain(
      "Use src/core and src/core.",
    );
  });

  it("passes run-scoped cache options to MCP resource blocks", async () => {
    vi.mocked(mcpClientManager.readResource).mockResolvedValue({
      contents: [
        {
          uri: "repo://machdoch/readme",
          text: "README",
        },
      ],
    } as never);

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          {
            id: "start",
            type: "START",
            title: "Start",
          },
          {
            id: "readme",
            type: "MCP_RESOURCE",
            title: "Read README",
            serverId: "github",
            uri: "repo://machdoch/readme",
            settings: {
              mcp: {
                servers: [
                  {
                    id: "github",
                    enabled: true,
                    transport: {
                      type: "streamable-http",
                      url: "https://api.githubcopilot.com/mcp/",
                    },
                  },
                ],
              },
            },
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
            id: "start-to-readme",
            from: "start",
            fromOutput: "SUCCESS",
            to: "readme",
          },
          {
            id: "readme-to-success",
            from: "readme",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      {
        maxTransitions: 10,
        runId: "ralph-run-1",
      },
    );

    expect(result.status).toBe("completed");
    expect(mcpClientManager.readResource).toHaveBeenCalledWith(
      "C:/workspace",
      "github",
      "repo://machdoch/readme",
      expect.objectContaining({
        cache: {
          runId: "ralph-run-1",
          operation: "resource",
          readOnly: true,
        },
      }),
    );
  });
});

describe("normalizeRalphFlowLayout", () => {
  it("separates overlapping generated branch nodes into readable columns", () => {
    const flow: RalphFlow = {
      schemaVersion: 1,
      id: "copy-flow",
      name: "Copy Flow",
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
          position: { x: 0, y: 0 },
        },
        {
          id: "copy",
          type: "UTILITY",
          title: "Wait for file and copy",
          utility: { type: "RUN_COMMAND", command: "copy" },
          position: { x: 80, y: 0 },
        },
        {
          id: "notify",
          type: "UTILITY",
          title: "Notify copy success",
          utility: { type: "NOTIFY", message: "Copied" },
          position: { x: 160, y: 0 },
        },
        {
          id: "copy-failed",
          type: "END",
          title: "Copy failed",
          status: "failed",
          position: { x: 170, y: 20 },
        },
        {
          id: "copy-succeeded",
          type: "END",
          title: "Copy succeeded",
          status: "success",
          position: { x: 210, y: 10 },
        },
      ],
      edges: [
        { id: "start-copy", from: "start", fromOutput: "SUCCESS", to: "copy" },
        { id: "copy-notify", from: "copy", fromOutput: "SUCCESS", to: "notify" },
        {
          id: "copy-failed",
          from: "copy",
          fromOutput: "ERROR",
          to: "copy-failed",
        },
        {
          id: "notify-end",
          from: "notify",
          fromOutput: "SUCCESS",
          to: "copy-succeeded",
        },
      ],
    };

    const arranged = normalizeRalphFlowLayout(flow);
    const positionById = new Map(
      arranged.blocks.map((block) => [block.id, block.position] as const),
    );

    expect(positionById.get("start")).toEqual({ x: 0, y: 0 });
    expect(positionById.get("copy")?.x).toBeGreaterThan(
      positionById.get("start")?.x ?? 0,
    );
    expect(positionById.get("notify")?.x).toBeGreaterThan(
      positionById.get("copy")?.x ?? 0,
    );
    expect(positionById.get("copy-succeeded")?.x).toBeGreaterThan(
      positionById.get("notify")?.x ?? 0,
    );
    expect(
      Math.abs(
        (positionById.get("notify")?.y ?? 0) -
          (positionById.get("copy-failed")?.y ?? 0),
      ),
    ).toBeGreaterThanOrEqual(190);
  });
});

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

  it("does not persist a generated flow until validator convergence", async () => {
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

        return createExecutionResult({
          response: {
            markdown: "RALPH_DECISION: RETRY",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        });
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "blocked-flow",
        prompt: "Create a blocked flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });

      expect(result.status).toBe("blocked");
      await expect(readFile(result.flowPath, "utf8")).rejects.toThrow();
      await expect(readdir(join(workspace, ".machdoch", "ralph", "flows")))
        .resolves.toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts validator DONE markers even when the validator adds trailing explanation", async () => {
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
              }),
            ),
            "utf8",
          );

          return createExecutionResult();
        }

        return createExecutionResult({
          response: {
            markdown:
              "The flow satisfies the request.\nRALPH_DECISION: DONE\n\nIt has a start, prompt, validator, and end route.",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        });
      });

      const result = await createRalphFlowWithAgent(workspace, {
        name: "generated-flow",
        prompt: "Create a small test flow.",
        maxRounds: 1,
        config: runtimeConfig,
        customizations,
      });

      expect(result.status).toBe("created");
      await expect(readFile(result.flowPath, "utf8")).resolves.toContain(
        '"schemaVersion": 1',
      );
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
});

describe("parseRalphDecision", () => {
  it("reads only the final marker line", () => {
    expect(
      parseRalphDecision(
        createExecutionResult({
          response: {
            markdown: "Earlier RALPH_DECISION: RETRY\n\nRALPH_DECISION: DONE",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBe("DONE");
  });

  it("ignores marker text that is not the final line", () => {
    expect(
      parseRalphDecision(
        createExecutionResult({
          response: {
            markdown: "RALPH_DECISION: DONE\n\nMore text.",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBeUndefined();
  });
});
