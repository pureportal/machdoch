import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RALPH_RESULT_CHARS,
  createRalphRunLogger,
  deleteRalphFlow,
  getRalphFlowPath,
  listRalphFlowRevisions,
  listRalphFlows,
  listRalphRunRecords,
  parseRalphFlowJson,
  readRalphFlow,
  readRalphRunLog,
  readRalphRunRecord,
  resolveRalphFlowReference,
  restoreRalphFlowRevision,
  validateRalphFlow,
  writeRalphFlow,
  writeRalphRunRecord,
  type RalphFlow,
  type RalphRunResult,
} from "../ralph.js";
import { createExecutionResult, createFlow } from "./ralph-test-helpers.js";
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

  it("writes, lists, and reads user-scoped flows from the user config directory", async () => {
    const workspaceRoot = await createWorkspace();
    const userConfigRoot = await mkdtemp(join(tmpdir(), "machdoch-ralph-user-"));
    const previousUserConfigRoot = process.env.MACHDOCH_USER_CONFIG_DIR;
    rootsToClean.push(userConfigRoot);
    process.env.MACHDOCH_USER_CONFIG_DIR = userConfigRoot;

    try {
      const flow = createFlow({
        id: "global-refactor",
        alias: "global-refactor",
        name: "Global refactor",
      });
      const path = await writeRalphFlow(workspaceRoot, flow, { scope: "user" });

      expect(path).toBe(getRalphFlowPath(workspaceRoot, "global-refactor", "user"));
      await expect(
        readRalphFlow(workspaceRoot, "global-refactor", { scope: "user" }),
      ).resolves.toMatchObject({
        id: "global-refactor",
        alias: "global-refactor",
      });
      await expect(listRalphFlows(workspaceRoot, { scope: "user" })).resolves.toEqual([
        expect.objectContaining({
          id: "global-refactor",
          scope: "user",
          blockCount: 4,
        }),
      ]);
      await expect(readRalphFlow(workspaceRoot, "global-refactor")).rejects.toThrow(
        "was not found",
      );
    } finally {
      if (previousUserConfigRoot === undefined) {
        delete process.env.MACHDOCH_USER_CONFIG_DIR;
      } else {
        process.env.MACHDOCH_USER_CONFIG_DIR = previousUserConfigRoot;
      }
    }
  });

  it("ignores hidden generation artifacts when saving and listing flows", async () => {
    const workspaceRoot = await createWorkspace();
    await writeRalphFlow(
      workspaceRoot,
      createFlow({
        id: "existing-flow",
        alias: "existing-flow",
        name: "Existing flow",
      }),
    );
    await writeFile(
      join(
        workspaceRoot,
        ".machdoch",
        "ralph",
        "flows",
        ".stale-generation.json",
      ),
      `${JSON.stringify(
        createFlow({
          id: "stale-flow",
          alias: "refactor-codebase",
          name: "Stale generated flow",
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      writeRalphFlow(
        workspaceRoot,
        createFlow({ alias: "refactor-codebase" }),
      ),
    ).resolves.toBe(getRalphFlowPath(workspaceRoot, "refactor-flow"));
    await expect(listRalphFlows(workspaceRoot)).resolves.toEqual([
      expect.objectContaining({
        id: "existing-flow",
        alias: "existing-flow",
      }),
      expect.objectContaining({
        id: "refactor-flow",
        alias: "refactor-codebase",
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

  it("resolves direct flow ids before alias matches and rejects ambiguous aliases", async () => {
    const workspaceRoot = await createWorkspace();
    const flowDirectory = join(workspaceRoot, ".machdoch", "ralph", "flows");

    await writeRalphFlow(
      workspaceRoot,
      createFlow({
        id: "direct-flow",
        alias: "shared-alias",
        name: "Direct flow",
      }),
    );
    await writeFile(
      join(flowDirectory, "alias-one.json"),
      `${JSON.stringify(
        createFlow({
          id: "alias-one",
          alias: "ambiguous",
          name: "Alias One",
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(flowDirectory, "alias-two.json"),
      `${JSON.stringify(
        createFlow({
          id: "alias-two",
          alias: "ambiguous",
          name: "Alias Two",
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(flowDirectory, "invalid.json"), "{ not json", "utf8");

    await expect(
      resolveRalphFlowReference(workspaceRoot, "direct-flow"),
    ).resolves.toMatchObject({
      id: "direct-flow",
      flow: expect.objectContaining({ name: "Direct flow" }),
    });
    await expect(
      resolveRalphFlowReference(workspaceRoot, "shared-alias"),
    ).resolves.toMatchObject({
      id: "direct-flow",
    });
    await expect(
      resolveRalphFlowReference(workspaceRoot, "ambiguous"),
    ).rejects.toThrow("Ralph flow alias `ambiguous` is not unique.");
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

  it("reads, lists, filters, and loads logs for file-backed run records", async () => {
    const workspaceRoot = await createWorkspace();
    const flow = createFlow();
    const logger = await createRalphRunLogger(workspaceRoot, flow, {
      runId: "run/with spaces",
      variableValues: {
        scope: "src/core",
      },
    });
    logger.simple({
      kind: "block-output",
      message: "Fixed.",
      blockId: "fix-tsc",
      output: "SUCCESS",
    });
    logger.trace({
      kind: "trace",
      message: "Detailed trace.",
      blockId: "fix-tsc",
      details: {
        safe: true,
      },
    });
    await logger.flush();
    const paths = logger.paths;

    if (!paths) {
      throw new Error("Expected file-backed Ralph run logger paths.");
    }

    const runResult: RalphRunResult = {
      runId: logger.runId,
      startedAt: "2026-06-13T09:00:00.000Z",
      finishedAt: "2026-06-13T09:00:01.000Z",
      flow: flow.id,
      status: "completed",
      summary: "Run completed.",
      events: [],
      blockResults: [],
      missingVariables: [],
      unknownVariables: [],
      validation: validateRalphFlow(flow, {
        variableValues: {
          scope: "src/core",
        },
      }),
    };

    const written = await writeRalphRunRecord(workspaceRoot, flow, runResult, {
      paths,
      variableValues: {
        scope: "src/core",
      },
    });

    await expect(readRalphRunRecord(workspaceRoot, written.id)).resolves.toMatchObject({
      path: written.path,
      record: {
        id: written.id,
        status: "completed",
        variableValues: {
          scope: "src/core",
        },
      },
    });
    await expect(listRalphRunRecords(workspaceRoot)).resolves.toEqual([
      expect.objectContaining({
        id: written.id,
        flowId: "refactor-flow",
        status: "completed",
        simpleLogPath: paths.simpleMarkdownPath,
        traceLogPath: paths.traceJsonlPath,
      }),
    ]);
    await expect(
      listRalphRunRecords(workspaceRoot, { flowId: "missing-flow" }),
    ).resolves.toEqual([]);
    await expect(readRalphRunLog(workspaceRoot, written.id)).resolves.toMatchObject({
      kind: "simple",
      content: expect.stringContaining("Fixed."),
    });
    await expect(
      readRalphRunLog(workspaceRoot, written.id, "trace"),
    ).resolves.toMatchObject({
      kind: "trace",
      content: expect.stringContaining("Detailed trace."),
    });
  });
});


