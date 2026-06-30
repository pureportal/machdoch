import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { executeTask } from "../execution.js";
import { mcpClientManager } from "../mcp/client.js";
import { runRalphFlow } from "../ralph.js";
import {
  createExecutionResult,
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

const playwrightMock = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock("../execution.js", () => ({
  executeTask: vi.fn(),
}));

vi.mock("../mcp/client.js", () => ({
  mcpClientManager: {
    callTool: vi.fn(),
    readResource: vi.fn(),
    getPrompt: vi.fn(),
  },
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch: playwrightMock.launch,
  },
}));

describe("runRalphFlow", () => {
  beforeEach(() => {
    vi.mocked(executeTask).mockReset();
    vi.mocked(mcpClientManager.callTool).mockReset();
    vi.mocked(mcpClientManager.readResource).mockReset();
    vi.mocked(mcpClientManager.getPrompt).mockReset();
    playwrightMock.launch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
        maxDurationMs: 3_600_000,
      }),
    );
  });

  it("passes positive prompt timeout settings into task execution options", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Fixed TSC.",
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

    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "fix-tsc",
          type: "PROMPT",
          title: "Fix TSC",
          prompt: "Fix TypeScript errors.",
          settings: {
            timeoutSeconds: 45,
          },
        },
        {
          id: "validate",
          type: "VALIDATOR",
          title: "Validate",
          prompt: "Validate the result. End with RALPH_DECISION.",
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
    });

    await runRalphFlow(flow, runtimeConfig, customizations, {
      maxTransitions: 10,
      runId: "ralph-run-timeout",
    });

    expect(vi.mocked(executeTask).mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        maxDurationMs: 45_000,
      }),
    );
  });

  it("pauses for ask-user blocks and resumes with submitted values", async () => {
    const flow = createFlow({
      variables: [{ name: "details", type: "text", required: false, default: "" }],
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "collect",
          type: "ASK_USER",
          title: "Collect Details",
          prompt: "Define the request.",
          fields: [
            {
              id: "details",
              label: "Details",
              type: "textarea",
              required: true,
              skippable: false,
              variableName: "details",
            },
          ],
        },
        { id: "success", type: "END", title: "Done" },
      ],
      edges: [
        { id: "start-to-collect", from: "start", fromOutput: "SUCCESS", to: "collect" },
        { id: "collect-to-success", from: "collect", fromOutput: "SUCCESS", to: "success" },
      ],
    });
    const paused = await runRalphFlow(flow, runtimeConfig, customizations, {
      runId: "ralph-input-run",
    });

    expect(paused.status).toBe("waiting-for-input");
    expect(paused.pendingInput).toMatchObject({
      blockId: "collect",
      fields: [expect.objectContaining({ id: "details", type: "textarea" })],
    });
    expect(paused.checkpoint).toBeDefined();

    const resumed = await runRalphFlow(flow, runtimeConfig, customizations, {
      runId: "ralph-input-run",
      checkpoint: paused.checkpoint,
      inputResponse: {
        requestId: paused.pendingInput?.id ?? "",
        action: "submit",
        values: { details: "Export button with CSV output." },
      },
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.events.map((event) => event.type)).toContain("input-submitted");
    expect(resumed.blockResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "collect",
          output: "SUCCESS",
          data: expect.objectContaining({
            values: { details: "Export button with CSV output." },
          }),
        }),
      ]),
    );
  });

  it("auto-continues ask-user blocks when required values are already available", async () => {
    const result = await runRalphFlow(
      createFlow({
        variables: [
          {
            name: "details",
            type: "text",
            required: false,
            default: "Export button with CSV output.",
          },
        ],
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "collect",
            type: "ASK_USER",
            title: "Collect Details",
            mode: "missingOnly",
            fields: [
              {
                id: "details",
                label: "Details",
                type: "textarea",
                required: true,
                variableName: "details",
              },
            ],
          },
          { id: "success", type: "END", title: "Done" },
        ],
        edges: [
          { id: "start-to-collect", from: "start", fromOutput: "SUCCESS", to: "collect" },
          { id: "collect-to-success", from: "collect", fromOutput: "SUCCESS", to: "success" },
        ],
      }),
      runtimeConfig,
      customizations,
      { runId: "ralph-input-run", maxTransitions: 10 },
    );

    expect(result.status).toBe("completed");
    expect(result.pendingInput).toBeUndefined();
    expect(result.blockResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "collect",
          output: "SUCCESS",
          summary: "Collect Details already has the required input.",
          data: expect.objectContaining({
            mode: "missingOnly",
            values: {
              details: "Export button with CSV output.",
            },
          }),
        }),
      ]),
    );
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("pauses always-ask blocks even when required values are already available", async () => {
    const result = await runRalphFlow(
      createFlow({
        variables: [
          {
            name: "details",
            type: "text",
            required: false,
            default: "Export button with CSV output.",
          },
        ],
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "collect",
            type: "ASK_USER",
            title: "Collect Details",
            mode: "alwaysAsk",
            fields: [
              {
                id: "details",
                label: "Details",
                type: "textarea",
                required: true,
                variableName: "details",
              },
            ],
          },
          { id: "success", type: "END", title: "Done" },
        ],
        edges: [
          { id: "start-to-collect", from: "start", fromOutput: "SUCCESS", to: "collect" },
          { id: "collect-to-success", from: "collect", fromOutput: "SUCCESS", to: "success" },
        ],
      }),
      runtimeConfig,
      customizations,
      { runId: "ralph-always-ask-run", maxTransitions: 10 },
    );

    expect(result.status).toBe("waiting-for-input");
    expect(result.pendingInput).toMatchObject({
      blockId: "collect",
      fields: [expect.objectContaining({ id: "details" })],
    });
    expect(
      result.blockResults.some(
        (blockResult) =>
          blockResult.blockId === "collect" && blockResult.output === "SUCCESS",
      ),
    ).toBe(false);
  });

  it("uses flow settings.maxTransitions as the default execution cap", async () => {
    const result = await runRalphFlow(
      createFlow({
        settings: {
          maxTransitions: 2,
        },
        blocks: [
          { id: "start", type: "START", title: "Start" },
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
        ],
        edges: [
          { id: "start-to-wait", from: "start", fromOutput: "SUCCESS", to: "wait" },
          { id: "wait-to-start", from: "wait", fromOutput: "SUCCESS", to: "start" },
        ],
      }),
      runtimeConfig,
      customizations,
    );

    expect(result.status).toBe("crashed");
    expect(result.summary).toBe("Ralph flow reached maxTransitions (2).");
    expect(result.blockResults.map((entry) => entry.blockId)).toEqual([
      "start",
      "wait",
    ]);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("blocks repeated identical non-success utility loops before another agent pass", async () => {
    vi.mocked(executeTask).mockResolvedValue(
      createExecutionResult({
        summary: "No current-change failure found.",
        response: {
          markdown: "No current-change failure found.",
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
      }),
    );

    const result = await runRalphFlow(
      createFlow({
        settings: { maxTransitions: 20 },
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "check",
            type: "UTILITY",
            title: "Check",
            utility: {
              type: "VALIDATE_JSON",
              input: "{}",
              schema: {
                type: "object",
                required: ["ok"],
              },
            },
          },
          {
            id: "fix",
            type: "PROMPT",
            title: "Fix",
            prompt: "Fix the check failure.",
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          { id: "start-to-check", from: "start", fromOutput: "SUCCESS", to: "check" },
          { id: "check-invalid-to-fix", from: "check", fromOutput: "INVALID", to: "fix" },
          { id: "check-success-to-success", from: "check", fromOutput: "SUCCESS", to: "success" },
          { id: "fix-to-check", from: "fix", fromOutput: "SUCCESS", to: "check" },
        ],
      }),
      runtimeConfig,
      customizations,
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain(
      "after 3 identical non-success result(s)",
    );
    expect(
      result.blockResults.filter((entry) => entry.blockId === "check"),
    ).toHaveLength(3);
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "crash",
          blockId: "check",
          output: "INVALID",
        }),
      ]),
    );
  });

  it("blocks before execution when callers supply unknown variables", async () => {
    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
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
      {
        maxTransitions: 10,
        variableValues: {
          scope: "src",
          extra: "unused",
        },
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.unknownVariables).toEqual(["extra"]);
    expect(result.summary).toBe("Unknown Ralph variable(s): extra.");
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("stops before executing the first block when the run signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runRalphFlow(createFlow(), runtimeConfig, customizations, {
      signal: controller.signal,
    });

    expect(result.status).toBe("stopped");
    expect(result.summary).toBe("Ralph run stopped.");
    expect(result.blockResults).toEqual([]);
    expect(result.events).toEqual([
      {
        type: "end",
        blockId: "start",
        status: "stopped",
        summary: "Ralph run stopped.",
      },
    ]);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("keeps running when event observers throw", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("observer failed");
    });

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "wait",
            type: "UTILITY",
            title: "Wait",
            utility: { type: "WAIT", mode: "delay", delaySeconds: 0 },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          { id: "start-to-wait", from: "start", fromOutput: "SUCCESS", to: "wait" },
          { id: "wait-to-success", from: "wait", fromOutput: "SUCCESS", to: "success" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5, onEvent },
    );

    expect(result.status).toBe("completed");
    expect(onEvent).toHaveBeenCalled();
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["block-start", "block-output", "edge-route", "end"]),
    );
  });

  it("routes prompt ERROR to an explicit ERROR edge without default retry", async () => {
    vi.mocked(executeTask).mockResolvedValue(
      createExecutionResult({
        status: "blocked",
        summary: "Provider failed.",
        reason: "No quota.",
      }),
    );

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "prompt",
            type: "PROMPT",
            title: "Prompt",
            prompt: "Run once.",
          },
          { id: "failed", type: "END", title: "Failed", status: "failed" },
        ],
        edges: [
          { id: "start-to-prompt", from: "start", fromOutput: "SUCCESS", to: "prompt" },
          { id: "prompt-error", from: "prompt", fromOutput: "ERROR", to: "failed" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("blocked");
    expect(vi.mocked(executeTask)).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.type === "retry")).toBe(false);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "edge-route",
          from: "prompt",
          output: "ERROR",
          to: "failed",
          edgeId: "prompt-error",
        }),
      ]),
    );
  });

  it("honors finite retry policies before taking an ERROR edge", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(
        createExecutionResult({
          status: "blocked",
          summary: "First failure.",
          reason: "Try again.",
        }),
      )
      .mockResolvedValueOnce(
        createExecutionResult({
          status: "blocked",
          summary: "Second failure.",
          reason: "Still failing.",
        }),
      );

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "prompt",
            type: "PROMPT",
            title: "Prompt",
            prompt: "Run with one retry.",
            settings: {
              retry: { mode: "finite", maxRetries: 1, delaySeconds: 0 },
            },
          },
          { id: "failed", type: "END", title: "Failed", status: "failed" },
        ],
        edges: [
          { id: "start-to-prompt", from: "start", fromOutput: "SUCCESS", to: "prompt" },
          { id: "prompt-error", from: "prompt", fromOutput: "ERROR", to: "failed" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("blocked");
    expect(vi.mocked(executeTask)).toHaveBeenCalledTimes(2);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "retry",
          blockId: "prompt",
          attempt: 2,
        }),
        expect.objectContaining({
          type: "block-start",
          blockId: "prompt",
          attempt: 2,
        }),
        expect.objectContaining({
          type: "edge-route",
          from: "prompt",
          output: "ERROR",
          to: "failed",
        }),
      ]),
    );
  });

  it("runs prompt maxIterations in one conversation context", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "First pass.",
          response: {
            markdown: "First response.",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Second pass.",
          response: {
            markdown: "Second response.",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      );

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "prompt",
            type: "PROMPT",
            title: "Prompt",
            prompt: "Iterate on the task.",
            settings: {
              maxIterations: 2,
            },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          { id: "start-to-prompt", from: "start", fromOutput: "SUCCESS", to: "prompt" },
          { id: "prompt-success", from: "prompt", fromOutput: "SUCCESS", to: "success" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    const secondConversationContext =
      vi.mocked(executeTask).mock.calls[1]?.[3]?.conversationContext;

    expect(result.status).toBe("completed");
    expect(vi.mocked(executeTask)).toHaveBeenCalledTimes(2);
    expect(secondConversationContext?.history).toEqual([
      {
        role: "user",
        content: expect.stringContaining("Iterate on the task."),
      },
      { role: "assistant", content: "First response." },
      {
        role: "user",
        content: expect.stringContaining("Iterate on the task."),
      },
      { role: "assistant", content: "Second response." },
    ]);
  });

  it("skips generated, dependency, and build folders when searching files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-search-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "node_modules", "package", "src"), {
        recursive: true,
      });
      await mkdir(join(workspace, ".machdoch", "ralph", "flows", "src"), {
        recursive: true,
      });
      await writeFile(join(workspace, "src", "App.tsx"), "export {};\n", "utf8");
      await writeFile(
        join(workspace, "node_modules", "package", "src", "Hidden.tsx"),
        "export {};\n",
        "utf8",
      );
      await writeFile(
        join(workspace, ".machdoch", "ralph", "flows", "src", "Generated.tsx"),
        "export {};\n",
        "utf8",
      );

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "search",
              type: "UTILITY",
              title: "Search",
              utility: {
                type: "SEARCH_FILES",
                rootPath: ".",
                pattern: "src",
                glob: "*.tsx",
              },
            },
            { id: "success", type: "END", title: "Success" },
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
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 5 },
      );

      const searchResult = result.blockResults.find(
        (entry) => entry.blockId === "search",
      );
      const searchData = searchResult?.data as
        | { results: string[]; count: number }
        | undefined;
      const normalizedResults =
        searchData?.results.map((entry) => entry.replace(/\\/gu, "/")) ?? [];

      expect(result.status).toBe("completed");
      expect(searchData?.count).toBe(1);
      expect(normalizedResults).toEqual([
        expect.stringMatching(/\/src\/App\.tsx$/u),
      ]);
      expect(normalizedResults.join("\n")).not.toContain("node_modules");
      expect(normalizedResults.join("\n")).not.toContain(".machdoch");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("matches SEARCH_FILES globs against paths relative to the search root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-search-glob-"));

    try {
      await mkdir(join(workspace, "src", "nested"), { recursive: true });
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(join(workspace, "src", "index.ts"), "export {};\n", "utf8");
      await writeFile(
        join(workspace, "src", "nested", "view.ts"),
        "export {};\n",
        "utf8",
      );
      await writeFile(join(workspace, "docs", "guide.ts"), "not source\n", "utf8");

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "search",
              type: "UTILITY",
              title: "Search",
              utility: {
                type: "SEARCH_FILES",
                rootPath: ".",
                glob: "src/**/*.ts",
              },
            },
            { id: "success", type: "END", title: "Success" },
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
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 5 },
      );

      const searchData = result.blockResults.find((entry) => entry.blockId === "search")
        ?.data as { results: string[]; count: number } | undefined;
      const normalizedResults =
        searchData?.results.map((entry) => entry.replace(/\\/gu, "/")) ?? [];

      expect(result.status).toBe("completed");
      expect(searchData?.count).toBe(2);
      expect(normalizedResults).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/\/src\/index\.ts$/u),
          expect.stringMatching(/\/src\/nested\/view\.ts$/u),
        ]),
      );
      expect(normalizedResults.join("\n")).not.toContain("docs");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes deterministic condition, file existence, and delete utilities", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-file-utilities-"));
    const trackedPath = join(workspace, "tracked.md");

    try {
      await writeFile(trackedPath, "# Tracked\n", "utf8");

      const result = await runRalphFlow(
        createFlow({
          variables: [
            { name: "enabled", type: "boolean", required: false, default: "true" },
            { name: "trackedPath", type: "path", required: false, default: "tracked.md" },
          ],
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "condition",
              type: "UTILITY",
              title: "Condition",
              utility: {
                type: "CONDITION",
                condition: {
                  style: "javascript",
                  expression: 'variables.enabled === "true"',
                },
              },
            },
            {
              id: "exists-before",
              type: "UTILITY",
              title: "Exists Before",
              utility: {
                type: "FILE_EXISTS",
                path: "{{trackedPath:path=tracked.md}}",
              },
            },
            {
              id: "delete",
              type: "UTILITY",
              title: "Delete",
              utility: {
                type: "DELETE_FILE",
                path: "{{trackedPath:path=tracked.md}}",
              },
            },
            {
              id: "exists-after",
              type: "UTILITY",
              title: "Exists After",
              utility: {
                type: "FILE_EXISTS",
                path: "{{trackedPath:path=tracked.md}}",
              },
            },
            {
              id: "delete-again",
              type: "UTILITY",
              title: "Delete Again",
              utility: {
                type: "DELETE_FILE",
                path: "{{trackedPath:path=tracked.md}}",
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-condition", from: "start", fromOutput: "SUCCESS", to: "condition" },
            { id: "condition-match", from: "condition", fromOutput: "MATCH", to: "exists-before" },
            { id: "exists-before-delete", from: "exists-before", fromOutput: "EXISTS", to: "delete" },
            { id: "delete-to-exists-after", from: "delete", fromOutput: "SUCCESS", to: "exists-after" },
            { id: "exists-after-missing", from: "exists-after", fromOutput: "MISSING", to: "delete-again" },
            { id: "delete-again-not-found", from: "delete-again", fromOutput: "NOT_FOUND", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          maxTransitions: 10,
          variableValues: {
            enabled: "true",
            trackedPath: "tracked.md",
          },
        },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ blockId: "condition", output: "MATCH" }),
          expect.objectContaining({ blockId: "exists-before", output: "EXISTS" }),
          expect.objectContaining({ blockId: "delete", output: "SUCCESS" }),
          expect.objectContaining({ blockId: "exists-after", output: "MISSING" }),
          expect.objectContaining({ blockId: "delete-again", output: "NOT_FOUND" }),
        ]),
      );
      await expect(readFile(trackedPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs JSON file, move/archive, and loop counter utilities", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-json-utilities-"));

    try {
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "write-json",
              type: "UTILITY",
              title: "Write JSON",
              utility: {
                type: "WRITE_JSON",
                path: "state/goal.json",
                input: "{\"goal\":\"ship\",\"stats\":{\"passes\":1}}",
              },
            },
            {
              id: "patch-json",
              type: "UTILITY",
              title: "Patch JSON",
              utility: {
                type: "PATCH_JSON",
                path: "state/goal.json",
                input: "{\"stats\":{\"verified\":true}}",
                jsonPatchMode: "merge",
              },
            },
            {
              id: "read-json",
              type: "UTILITY",
              title: "Read JSON",
              utility: {
                type: "READ_JSON",
                path: "state/goal.json",
                schema: {
                  type: "object",
                  required: ["goal", "stats"],
                },
              },
            },
            {
              id: "append-jsonl",
              type: "UTILITY",
              title: "Append JSONL",
              utility: {
                type: "APPEND_JSONL",
                path: "state/events.jsonl",
                input: "{{data:read-json:json}}",
              },
            },
            {
              id: "move-file",
              type: "UTILITY",
              title: "Move File",
              utility: {
                type: "MOVE_FILE",
                path: "state/goal.json",
                outputPath: "state/archive/goal.json",
              },
            },
            {
              id: "archive-file",
              type: "UTILITY",
              title: "Archive File",
              utility: {
                type: "ARCHIVE_FILE",
                path: "state/archive/goal.json",
                rootPath: "state/completed",
              },
            },
            {
              id: "counter-one",
              type: "UTILITY",
              title: "Counter One",
              utility: {
                type: "LOOP_COUNTER",
                path: "state/counters.json",
                counterName: "goal",
                counterKey: "active",
                maxAttempts: 1,
              },
            },
            {
              id: "counter-two",
              type: "UTILITY",
              title: "Counter Two",
              utility: {
                type: "LOOP_COUNTER",
                path: "state/counters.json",
                counterName: "goal",
                counterKey: "active",
                maxAttempts: 1,
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-write", from: "start", fromOutput: "SUCCESS", to: "write-json" },
            { id: "write-to-patch", from: "write-json", fromOutput: "SUCCESS", to: "patch-json" },
            { id: "patch-to-read", from: "patch-json", fromOutput: "SUCCESS", to: "read-json" },
            { id: "read-to-append", from: "read-json", fromOutput: "SUCCESS", to: "append-jsonl" },
            { id: "append-to-move", from: "append-jsonl", fromOutput: "SUCCESS", to: "move-file" },
            { id: "move-to-archive", from: "move-file", fromOutput: "SUCCESS", to: "archive-file" },
            { id: "archive-to-counter-one", from: "archive-file", fromOutput: "SUCCESS", to: "counter-one" },
            { id: "counter-one-to-counter-two", from: "counter-one", fromOutput: "CONTINUE", to: "counter-two" },
            { id: "counter-two-to-success", from: "counter-two", fromOutput: "LIMIT_REACHED", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 20 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ blockId: "write-json", output: "SUCCESS" }),
          expect.objectContaining({
            blockId: "read-json",
            output: "SUCCESS",
            data: expect.objectContaining({
              json: {
                goal: "ship",
                stats: { passes: 1, verified: true },
              },
            }),
          }),
          expect.objectContaining({ blockId: "counter-one", output: "CONTINUE" }),
          expect.objectContaining({
            blockId: "counter-two",
            output: "LIMIT_REACHED",
          }),
        ]),
      );

      const archiveResult = result.blockResults.find(
        (entry) => entry.blockId === "archive-file",
      );
      const archivePath = (archiveResult?.data as { to?: string } | undefined)?.to;

      expect(archivePath).toBeTruthy();
      await expect(readFile(archivePath!, "utf8")).resolves.toContain(
        "\"verified\": true",
      );
      await expect(readFile(join(workspace, "state", "events.jsonl"), "utf8"))
        .resolves.toContain("\"goal\":\"ship\"");
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs JSONL history and JSON task utilities", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-json-task-"));

    try {
      await mkdir(join(workspace, "state"), { recursive: true });
      await writeFile(
        join(workspace, "state", "events.jsonl"),
        [
          JSON.stringify({ id: "event-1", status: "done", title: "Complete" }),
          JSON.stringify({ id: "event-2", status: "open", title: "Open" }),
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(workspace, "state", "tasks.json"),
        JSON.stringify(
          {
            tasks: [
              { id: "task-1", title: "First", status: "todo", priority: 2 },
              { id: "task-2", title: "Second", status: "done" },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "read-jsonl",
              type: "UTILITY",
              title: "Read JSONL",
              utility: {
                type: "READ_JSONL",
                path: "state/events.jsonl",
              },
            },
            {
              id: "query-jsonl",
              type: "UTILITY",
              title: "Query JSONL",
              utility: {
                type: "QUERY_JSONL",
                path: "state/events.jsonl",
                condition: {
                  style: "json-path",
                  path: "$.status",
                  operator: "equals",
                  value: "done",
                },
              },
            },
            {
              id: "select-task",
              type: "UTILITY",
              title: "Select Task",
              utility: {
                type: "SELECT_JSON_TASK",
                path: "state/tasks.json",
                jsonPath: "tasks",
                strategy: "priority",
              },
            },
            {
              id: "mark-task",
              type: "UTILITY",
              title: "Mark Task",
              utility: {
                type: "MARK_JSON_TASK",
                path: "state/tasks.json",
                jsonPath: "tasks",
                input: "{{data:select-task:task}}",
                status: "done",
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-read", from: "start", fromOutput: "SUCCESS", to: "read-jsonl" },
            { id: "read-to-query", from: "read-jsonl", fromOutput: "SUCCESS", to: "query-jsonl" },
            { id: "query-to-select", from: "query-jsonl", fromOutput: "SUCCESS", to: "select-task" },
            { id: "select-to-mark", from: "select-task", fromOutput: "SELECTED", to: "mark-task" },
            { id: "mark-to-success", from: "mark-task", fromOutput: "SUCCESS", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "query-jsonl",
            output: "SUCCESS",
            data: expect.objectContaining({ count: 1 }),
          }),
          expect.objectContaining({
            blockId: "select-task",
            output: "SELECTED",
            data: expect.objectContaining({
              task: expect.objectContaining({ id: "task-1", status: "in_progress" }),
            }),
          }),
          expect.objectContaining({ blockId: "mark-task", output: "SUCCESS" }),
        ]),
      );
      await expect(readFile(join(workspace, "state", "tasks.json"), "utf8"))
        .resolves.toContain("\"status\": \"done\"");
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("retries PROMPT_JSON until schema-valid JSON is produced", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-prompt-json-"));

    vi.mocked(executeTask)
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Invalid JSON shape.",
          response: {
            markdown: "{\"name\":\"candidate\"}",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createExecutionResult({
          summary: "Valid JSON.",
          response: {
            markdown: "```json\n{\"name\":\"candidate\",\"score\":7}\n```",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      );

    try {
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "prompt-json",
              type: "UTILITY",
              title: "Prompt JSON",
              utility: {
                type: "PROMPT_JSON",
                prompt: "Create a candidate score.",
                outputPath: "state/candidate.json",
                maxAttempts: 2,
                schema: {
                  type: "object",
                  required: ["name", "score"],
                  properties: {
                    name: { type: "string" },
                    score: { type: "number" },
                  },
                },
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-prompt", from: "start", fromOutput: "SUCCESS", to: "prompt-json" },
            { id: "prompt-to-success", from: "prompt-json", fromOutput: "SUCCESS", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(executeTask).toHaveBeenCalledTimes(2);
      expect(result.blockResults.find((entry) => entry.blockId === "prompt-json"))
        .toMatchObject({
          output: "SUCCESS",
          data: expect.objectContaining({
            output: { name: "candidate", score: 7 },
            attempts: 2,
          }),
        });
      await expect(readFile(join(workspace, "state", "candidate.json"), "utf8"))
        .resolves.toContain("\"score\": 7");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes VALIDATOR_JSON decisions from schema-valid model output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-validator-json-"));

    vi.mocked(executeTask).mockResolvedValueOnce(
      createExecutionResult({
        summary: "Continue.",
        response: {
          markdown: JSON.stringify({
            decision: "CONTINUE",
            confidence: "high",
            summary: "More work remains.",
            evidence: ["Task one is incomplete."],
            remainingWork: ["Finish task one."],
          }),
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
      }),
    );

    try {
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "validator-json",
              type: "UTILITY",
              title: "Validator JSON",
              utility: {
                type: "VALIDATOR_JSON",
                prompt: "Return a validator decision.",
              },
            },
            { id: "continue", type: "END", title: "Continue" },
          ],
          edges: [
            { id: "start-to-validator", from: "start", fromOutput: "SUCCESS", to: "validator-json" },
            { id: "validator-to-continue", from: "validator-json", fromOutput: "CONTINUE", to: "continue" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "validator-json",
            output: "CONTINUE",
            data: expect.objectContaining({ decision: "CONTINUE" }),
          }),
        ]),
      );
      expect(vi.mocked(executeTask).mock.calls[0]?.[3]).toMatchObject({
        structuredOutput: {
          name: "ralph_validator-json",
          strict: true,
          schema: expect.objectContaining({
            required: ["decision", "confidence", "summary", "evidence", "remainingWork"],
          }),
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects project commands from package scripts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-project-commands-"));

    try {
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@11.0.0",
          scripts: {
            typecheck: "tsc --noEmit",
            lint: "eslint src",
            test: "vitest run",
          },
        }),
        "utf8",
      );

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "detect",
              type: "UTILITY",
              title: "Detect Commands",
              utility: {
                type: "DETECT_PROJECT_COMMANDS",
                rootPath: ".",
                outputPath: "state/project-commands.json",
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-detect", from: "start", fromOutput: "SUCCESS", to: "detect" },
            { id: "detect-to-success", from: "detect", fromOutput: "SUCCESS", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults.find((entry) => entry.blockId === "detect"))
        .toMatchObject({
          output: "SUCCESS",
          data: expect.objectContaining({
            verificationCommand: "pnpm typecheck && pnpm lint && pnpm test",
          }),
        });
      await expect(readFile(join(workspace, "state", "project-commands.json"), "utf8"))
        .resolves.toContain("pnpm typecheck");
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("records out-of-scope changed files as advisory by default", async () => {
    const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" });

    if (gitAvailable.status !== 0) {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-guard-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 1;\n",
        "utf8",
      );
      await writeFile(join(workspace, "RALPH_REFACTOR_NOTES.md"), "before\n", "utf8");
      await writeFile(join(workspace, "docs", "note.md"), "before\n", "utf8");

      expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace }).status,
      ).toBe(0);

      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 2;\n",
        "utf8",
      );
      await writeFile(join(workspace, "RALPH_REFACTOR_NOTES.md"), "after\n", "utf8");
      await writeFile(join(workspace, "docs", "note.md"), "after\n", "utf8");

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "scope-guard",
              type: "UTILITY",
              title: "Scope Guard",
              utility: {
                type: "CHANGE_SCOPE_GUARD",
                cwd: ".",
                input: JSON.stringify({
                  scope: {
                    paths: ["src"],
                    globs: ["src/**/*.ts"],
                  },
                  allowedPaths: ["RALPH_REFACTOR_NOTES.md"],
                }),
              },
            },
            { id: "success", type: "END", title: "Success" },
            { id: "blocked", type: "END", title: "Blocked", status: "failed" },
          ],
          edges: [
            { id: "start-to-guard", from: "start", fromOutput: "SUCCESS", to: "scope-guard" },
            { id: "guard-to-success", from: "scope-guard", fromOutput: "IN_SCOPE", to: "success" },
            { id: "guard-to-blocked", from: "scope-guard", fromOutput: "OUT_OF_SCOPE", to: "blocked" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "scope-guard",
            output: "IN_SCOPE",
            data: expect.objectContaining({
              enforcement: "advisory",
              outOfScopeFiles: [],
              advisoryOutOfScopeFiles: expect.arrayContaining(["docs/note.md"]),
              unrelatedWorkspaceFiles: expect.arrayContaining(["docs/note.md"]),
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses the latest prior git snapshot as an implicit scope guard baseline", async () => {
    const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" });

    if (gitAvailable.status !== 0) {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-guard-implicit-baseline-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 1;\n",
        "utf8",
      );
      await writeFile(join(workspace, "docs", "note.md"), "before\n", "utf8");

      expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace }).status,
      ).toBe(0);

      await writeFile(join(workspace, "docs", "note.md"), "dirty before run\n", "utf8");

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "git-snapshot-before",
              type: "UTILITY",
              title: "Git Snapshot",
              utility: {
                type: "GIT_SNAPSHOT",
                cwd: ".",
              },
            },
            {
              id: "write",
              type: "UTILITY",
              title: "Write Src",
              utility: {
                type: "WRITE_FILE",
                path: "src/feature.ts",
                content: "export const value = 2;\n",
              },
            },
            {
              id: "scope-guard",
              type: "UTILITY",
              title: "Scope Guard",
              utility: {
                type: "CHANGE_SCOPE_GUARD",
                cwd: ".",
                input: JSON.stringify({ paths: ["src"] }),
              },
            },
            { id: "success", type: "END", title: "Success" },
            { id: "blocked", type: "END", title: "Blocked", status: "failed" },
          ],
          edges: [
            { id: "start-to-snapshot", from: "start", fromOutput: "SUCCESS", to: "git-snapshot-before" },
            { id: "snapshot-to-write", from: "git-snapshot-before", fromOutput: "SUCCESS", to: "write" },
            { id: "write-to-guard", from: "write", fromOutput: "SUCCESS", to: "scope-guard" },
            { id: "guard-to-success", from: "scope-guard", fromOutput: "IN_SCOPE", to: "success" },
            { id: "guard-to-blocked", from: "scope-guard", fromOutput: "OUT_OF_SCOPE", to: "blocked" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "scope-guard",
            output: "IN_SCOPE",
            data: expect.objectContaining({
              baselineSource: "implicit",
              baselineBlockId: "git-snapshot-before",
              ignoredBaselineFiles: ["docs/note.md"],
              guardedFiles: ["src/feature.ts"],
              outOfScopeFiles: [],
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps unstaged tracked files in allowed scope", async () => {
    const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" });

    if (gitAvailable.status !== 0) {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-guard-tracked-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 1;\n",
        "utf8",
      );
      await writeFile(join(workspace, "RALPH_REFACTOR_NOTES.md"), "before\n", "utf8");

      expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace }).status,
      ).toBe(0);

      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 2;\n",
        "utf8",
      );
      await writeFile(join(workspace, "RALPH_REFACTOR_NOTES.md"), "after\n", "utf8");

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "scope-guard",
              type: "UTILITY",
              title: "Scope Guard",
              utility: {
                type: "CHANGE_SCOPE_GUARD",
                cwd: ".",
                input: JSON.stringify({
                  scope: {
                    paths: ["src"],
                    globs: ["src/**/*.ts"],
                  },
                  allowedPaths: ["RALPH_REFACTOR_NOTES.md"],
                }),
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-guard", from: "start", fromOutput: "SUCCESS", to: "scope-guard" },
            { id: "guard-to-success", from: "scope-guard", fromOutput: "IN_SCOPE", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "scope-guard",
            output: "IN_SCOPE",
            data: expect.objectContaining({
              changedFiles: ["RALPH_REFACTOR_NOTES.md", "src/feature.ts"],
              guardedFiles: ["RALPH_REFACTOR_NOTES.md", "src/feature.ts"],
              outOfScopeFiles: [],
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes scope guard allowed paths before matching changed files", async () => {
    const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" });

    if (gitAvailable.status !== 0) {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-guard-rules-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 1;\n",
        "utf8",
      );
      await writeFile(join(workspace, "docs", "note.md"), "before\n", "utf8");

      expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace }).status,
      ).toBe(0);

      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 2;\n",
        "utf8",
      );
      await writeFile(join(workspace, "docs", "note.md"), "after\n", "utf8");

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "scope-guard",
              type: "UTILITY",
              title: "Scope Guard",
              utility: {
                type: "CHANGE_SCOPE_GUARD",
                cwd: ".",
                input: JSON.stringify({
                  allowedPaths: [join(workspace, "docs")],
                  allowedGlobs: ["./src/**/*.ts"],
                }),
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-guard", from: "start", fromOutput: "SUCCESS", to: "scope-guard" },
            { id: "guard-to-success", from: "scope-guard", fromOutput: "IN_SCOPE", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "scope-guard",
            output: "IN_SCOPE",
            data: expect.objectContaining({
              guardedFiles: expect.arrayContaining([
                "docs/note.md",
                "src/feature.ts",
              ]),
              outOfScopeFiles: [],
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("ignores files already dirty in the scope guard baseline", async () => {
    const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" });

    if (gitAvailable.status !== 0) {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-guard-baseline-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 1;\n",
        "utf8",
      );
      await writeFile(join(workspace, "docs", "note.md"), "before\n", "utf8");

      expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace }).status,
      ).toBe(0);

      await writeFile(join(workspace, "docs", "note.md"), "dirty before run\n", "utf8");

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "snapshot",
              type: "UTILITY",
              title: "Snapshot",
              utility: {
                type: "GIT_SNAPSHOT",
                cwd: ".",
              },
            },
            {
              id: "write",
              type: "UTILITY",
              title: "Write Src",
              utility: {
                type: "WRITE_FILE",
                path: "src/feature.ts",
                content: "export const value = 2;\n",
              },
            },
            {
              id: "scope-guard",
              type: "UTILITY",
              title: "Scope Guard",
              utility: {
                type: "CHANGE_SCOPE_GUARD",
                cwd: ".",
                input: JSON.stringify({ paths: ["src"] }),
                baseline: "{{result:snapshot}}",
              },
            },
            { id: "success", type: "END", title: "Success" },
            { id: "blocked", type: "END", title: "Blocked" },
          ],
          edges: [
            { id: "start-to-snapshot", from: "start", fromOutput: "SUCCESS", to: "snapshot" },
            { id: "snapshot-to-write", from: "snapshot", fromOutput: "SUCCESS", to: "write" },
            { id: "write-to-guard", from: "write", fromOutput: "SUCCESS", to: "scope-guard" },
            { id: "guard-to-success", from: "scope-guard", fromOutput: "IN_SCOPE", to: "success" },
            { id: "guard-to-blocked", from: "scope-guard", fromOutput: "OUT_OF_SCOPE", to: "blocked" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "scope-guard",
            output: "IN_SCOPE",
            data: expect.objectContaining({
              baselineFiles: ["docs/note.md"],
              guardedFiles: ["src/feature.ts"],
              outOfScopeFiles: [],
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("guards files that changed after the scope guard baseline and can retry the checkpoint", async () => {
    const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" });

    if (gitAvailable.status !== 0) {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-guard-drift-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(
        join(workspace, "src", "feature.ts"),
        "export const value = 1;\n",
        "utf8",
      );
      await writeFile(join(workspace, "docs", "note.md"), "before\n", "utf8");

      expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: workspace,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace })
          .status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace }).status,
      ).toBe(0);

      await writeFile(join(workspace, "docs", "note.md"), "dirty before run\n", "utf8");

      const flow = createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "snapshot",
            type: "UTILITY",
            title: "Snapshot",
            utility: {
              type: "GIT_SNAPSHOT",
              cwd: ".",
            },
          },
          {
            id: "write-src",
            type: "UTILITY",
            title: "Write Src",
            utility: {
              type: "WRITE_FILE",
              path: "src/feature.ts",
              content: "export const value = 2;\n",
            },
          },
          {
            id: "write-docs",
            type: "UTILITY",
            title: "Write Docs",
            utility: {
              type: "WRITE_FILE",
              path: "docs/note.md",
              content: "changed after baseline\n",
            },
          },
          {
            id: "scope-guard",
            type: "UTILITY",
            title: "Scope Guard",
            utility: {
              type: "CHANGE_SCOPE_GUARD",
              cwd: ".",
              input: JSON.stringify({ paths: ["src"] }),
              baseline: "{{result:snapshot}}",
              enforce: true,
            },
          },
          { id: "success", type: "END", title: "Success" },
          { id: "blocked", type: "END", title: "Blocked", status: "failed" },
        ],
        edges: [
          { id: "start-to-snapshot", from: "start", fromOutput: "SUCCESS", to: "snapshot" },
          { id: "snapshot-to-write-src", from: "snapshot", fromOutput: "SUCCESS", to: "write-src" },
          { id: "write-src-to-write-docs", from: "write-src", fromOutput: "SUCCESS", to: "write-docs" },
          { id: "write-docs-to-guard", from: "write-docs", fromOutput: "SUCCESS", to: "scope-guard" },
          { id: "guard-to-success", from: "scope-guard", fromOutput: "IN_SCOPE", to: "success" },
          { id: "guard-to-blocked", from: "scope-guard", fromOutput: "OUT_OF_SCOPE", to: "blocked" },
        ],
      });

      const blocked = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(blocked.status).toBe("blocked");
      expect(blocked.checkpoint?.currentBlockId).toBe("scope-guard");
      expect(blocked.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "scope-guard",
            output: "OUT_OF_SCOPE",
            data: expect.objectContaining({
              baselineFiles: ["docs/note.md"],
              changedSinceBaselineFiles: ["docs/note.md"],
              outOfScopeFiles: ["docs/note.md"],
            }),
          }),
        ]),
      );

      await writeFile(join(workspace, "docs", "note.md"), "dirty before run\n", "utf8");

      const resumed = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          maxTransitions: 10,
          checkpoint: blocked.checkpoint,
        },
      );
      const latestScopeGuardResult = resumed.blockResults
        .filter((result) => result.blockId === "scope-guard")
        .at(-1);

      expect(resumed.status).toBe("completed");
      expect(latestScopeGuardResult).toMatchObject({
        output: "IN_SCOPE",
        data: expect.objectContaining({
          ignoredBaselineFiles: ["docs/note.md"],
          guardedFiles: ["src/feature.ts"],
          outOfScopeFiles: [],
        }),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("scans, updates, selects, and marks JSON scope registries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-registry-"));
    const registryPath =
      ".machdoch/ralph/scope-registry/test-flow.scope-registry.json";

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "packages", "api"), { recursive: true });
      await writeFile(join(workspace, "package.json"), "{}", "utf8");
      await writeFile(join(workspace, "src", "index.ts"), "", "utf8");
      await writeFile(join(workspace, "packages", "api", "package.json"), "{}", "utf8");

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "scan-scopes",
              type: "UTILITY",
              title: "Scan Scopes",
              utility: {
                type: "SCAN_SCOPE_EVIDENCE",
                rootPath: ".",
                maxDepth: 3,
              },
            },
            {
              id: "update-registry",
              type: "UTILITY",
              title: "Update Registry",
              utility: {
                type: "UPDATE_SCOPE_REGISTRY",
                flowAlias: "test-flow",
                registryPath,
                strategy: "start-to-end",
              },
            },
            {
              id: "select-scope",
              type: "UTILITY",
              title: "Select Scope",
              utility: {
                type: "SELECT_SCOPE",
                flowAlias: "test-flow",
                registryPath,
                strategy: "start-to-end",
              },
            },
            {
              id: "mark-scope",
              type: "UTILITY",
              title: "Mark Scope",
              utility: {
                type: "MARK_SCOPE_RESULT",
                flowAlias: "test-flow",
                registryPath,
                result: "DONE",
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-scan", from: "start", fromOutput: "SUCCESS", to: "scan-scopes" },
            { id: "scan-to-update", from: "scan-scopes", fromOutput: "SUCCESS", to: "update-registry" },
            { id: "update-to-select", from: "update-registry", fromOutput: "SUCCESS", to: "select-scope" },
            { id: "select-to-mark", from: "select-scope", fromOutput: "SELECTED", to: "mark-scope" },
            { id: "mark-to-success", from: "mark-scope", fromOutput: "SUCCESS", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );
      const registry = JSON.parse(
        await readFile(
          join(
            workspace,
            ".machdoch",
            "ralph",
            "scope-registry",
            "test-flow.scope-registry.json",
          ),
          "utf8",
        ),
      ) as {
        scopes: Array<{ id: string; status: string; validatedCount: number }>;
        selection: { currentScopeId: string | null; completedScopeIds: string[] };
      };

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ blockId: "scan-scopes", output: "SUCCESS" }),
          expect.objectContaining({ blockId: "update-registry", output: "SUCCESS" }),
          expect.objectContaining({ blockId: "select-scope", output: "SELECTED" }),
          expect.objectContaining({ blockId: "mark-scope", output: "SUCCESS" }),
        ]),
      );
      expect(registry.scopes.filter((scope) => scope.status === "active").length)
        .toBeGreaterThan(1);
      expect(registry.selection.currentScopeId).toBeNull();
      expect(registry.selection.completedScopeIds).toHaveLength(1);
      expect(
        registry.scopes.some((scope) => scope.validatedCount === 1),
      ).toBe(true);
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes HTTP_FETCH SUCCESS, HTTP_ERROR, and TIMEOUT outputs", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "AbortError";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockRejectedValueOnce(timeoutError);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "fetch-ok",
            type: "UTILITY",
            title: "Fetch OK",
            utility: { type: "HTTP_FETCH", url: "https://example.test/ok" },
          },
          {
            id: "fetch-http-error",
            type: "UTILITY",
            title: "Fetch HTTP Error",
            utility: { type: "HTTP_FETCH", url: "https://example.test/error" },
          },
          {
            id: "fetch-timeout",
            type: "UTILITY",
            title: "Fetch Timeout",
            utility: { type: "HTTP_FETCH", url: "https://example.test/timeout" },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          { id: "start-to-ok", from: "start", fromOutput: "SUCCESS", to: "fetch-ok" },
          {
            id: "ok-to-http-error",
            from: "fetch-ok",
            fromOutput: "SUCCESS",
            to: "fetch-http-error",
          },
          {
            id: "http-error-to-timeout",
            from: "fetch-http-error",
            fromOutput: "HTTP_ERROR",
            to: "fetch-timeout",
          },
          {
            id: "timeout-to-success",
            from: "fetch-timeout",
            fromOutput: "TIMEOUT",
            to: "success",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 10 },
    );

    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.blockResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "fetch-ok",
          output: "SUCCESS",
          status: "completed",
          data: expect.objectContaining({
            status: 200,
            ok: true,
            body: { ok: true },
          }),
        }),
        expect.objectContaining({
          blockId: "fetch-http-error",
          output: "HTTP_ERROR",
          status: "error",
        }),
        expect.objectContaining({
          blockId: "fetch-timeout",
          output: "TIMEOUT",
          status: "error",
        }),
      ]),
    );
  });

  it("routes POLL TIMEOUT after finite unmatched attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        new Response('{"ready":false}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "poll",
            type: "UTILITY",
            title: "Poll",
            utility: {
              type: "POLL",
              url: "https://example.test/status",
              maxAttempts: 2,
              intervalSeconds: 0,
              condition: {
                style: "json-path",
                path: "body.ready",
                operator: "equals",
                value: "true",
              },
            },
          },
          { id: "timeout", type: "END", title: "Timed out", status: "failed" },
        ],
        edges: [
          { id: "start-to-poll", from: "start", fromOutput: "SUCCESS", to: "poll" },
          {
            id: "poll-timeout",
            from: "poll",
            fromOutput: "TIMEOUT",
            to: "timeout",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.blockResults.find((entry) => entry.blockId === "poll"))
      .toMatchObject({
        output: "TIMEOUT",
        status: "error",
        data: expect.objectContaining({
          body: { ready: false },
        }),
      });
  });

  it("routes filesystem, JSON, empty search, failed check, and notification utilities", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-utilities-"));

    try {
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "write",
              type: "UTILITY",
              title: "Write",
              utility: {
                type: "WRITE_FILE",
                path: "data/input.json",
                content: "{\"value\":2}",
              },
            },
            {
              id: "read",
              type: "UTILITY",
              title: "Read",
              utility: {
                type: "READ_FILE",
                path: "data/input.json",
              },
            },
            {
              id: "transform",
              type: "UTILITY",
              title: "Transform",
              utility: {
                type: "TRANSFORM_JSON",
                input: "{{data:read:content}}",
                expression: "({ doubled: input.value * 2 })",
              },
            },
            {
              id: "validate-json",
              type: "UTILITY",
              title: "Validate JSON",
              utility: {
                type: "VALIDATE_JSON",
                input: "{{data:transform:output}}",
                schema: {
                  type: "object",
                  required: ["status"],
                },
              },
            },
            {
              id: "search-empty",
              type: "UTILITY",
              title: "Search Empty",
              utility: {
                type: "SEARCH_FILES",
                rootPath: ".",
                pattern: "definitely-not-present",
              },
            },
            {
              id: "check",
              type: "UTILITY",
              title: "Check",
              utility: {
                type: "RUN_CHECK",
                command: "exit 7",
              },
            },
            {
              id: "notify",
              type: "UTILITY",
              title: "Notify",
              utility: {
                type: "NOTIFY",
                message: "Utilities finished.",
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-write", from: "start", fromOutput: "SUCCESS", to: "write" },
            { id: "write-to-read", from: "write", fromOutput: "SUCCESS", to: "read" },
            {
              id: "read-to-transform",
              from: "read",
              fromOutput: "SUCCESS",
              to: "transform",
            },
            {
              id: "transform-to-validate",
              from: "transform",
              fromOutput: "SUCCESS",
              to: "validate-json",
            },
            {
              id: "validate-invalid-to-search",
              from: "validate-json",
              fromOutput: "INVALID",
              to: "search-empty",
            },
            {
              id: "search-empty-to-check",
              from: "search-empty",
              fromOutput: "EMPTY",
              to: "check",
            },
            {
              id: "check-failed-to-notify",
              from: "check",
              fromOutput: "FAILED",
              to: "notify",
            },
            {
              id: "notify-to-success",
              from: "notify",
              fromOutput: "SUCCESS",
              to: "success",
            },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 20 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "write",
            output: "SUCCESS",
            data: expect.objectContaining({ bytes: 11 }),
          }),
          expect.objectContaining({
            blockId: "read",
            output: "SUCCESS",
            data: expect.objectContaining({ content: "{\"value\":2}" }),
          }),
          expect.objectContaining({
            blockId: "transform",
            output: "SUCCESS",
            data: expect.objectContaining({ output: { doubled: 4 } }),
          }),
          expect.objectContaining({
            blockId: "validate-json",
            output: "INVALID",
            status: "error",
          }),
          expect.objectContaining({
            blockId: "search-empty",
            output: "EMPTY",
            status: "error",
            data: expect.objectContaining({ count: 0 }),
          }),
          expect.objectContaining({
            blockId: "check",
            output: "FAILED",
            status: "error",
            data: expect.objectContaining({
              exitCode: expect.any(Number),
            }),
          }),
          expect.objectContaining({
            blockId: "notify",
            output: "SUCCESS",
            data: { message: "Utilities finished." },
          }),
        ]),
      );
      const checkData = result.blockResults.find((entry) => entry.blockId === "check")
        ?.data as { exitCode?: number } | undefined;
      expect(checkData?.exitCode).not.toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs RUN_CHECK fallback command when the primary command resolves blank", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-check-fallback-"));

    try {
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "check",
              type: "UTILITY",
              title: "Check",
              utility: {
                type: "RUN_CHECK",
                command: "{{verificationCommand:text=}}",
                fallbackCommand: "node -e \"process.stdout.write('fallback-check')\"",
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-check", from: "start", fromOutput: "SUCCESS", to: "check" },
            {
              id: "check-to-success",
              from: "check",
              fromOutput: "SUCCESS",
              to: "success",
            },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "check",
            output: "SUCCESS",
            data: expect.objectContaining({
              command: expect.stringContaining("fallback-check"),
              stdout: "fallback-check",
            }),
          }),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("collects manual screenshot evidence with UI_ANALYZE image adapter", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-ui-image-"));
    const screenshotPath = join(workspace, "screen.png");

    try {
      await writeFile(screenshotPath, Buffer.from("fake screenshot"));

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "analyze-ui",
              type: "UTILITY",
              title: "Analyze UI",
              utility: {
                type: "UI_ANALYZE",
                adapter: "image",
                screenshotPath,
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            {
              id: "start-to-analyze",
              from: "start",
              fromOutput: "SUCCESS",
              to: "analyze-ui",
            },
            {
              id: "analyze-to-success",
              from: "analyze-ui",
              fromOutput: "SUCCESS",
              to: "success",
            },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 5 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults.find((entry) => entry.blockId === "analyze-ui"))
        .toMatchObject({
          output: "SUCCESS",
          data: expect.objectContaining({
            adapter: "image",
            screenshotPath,
            artifacts: {
              screenshots: [screenshotPath],
            },
          }),
        });
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes missing UI_ANALYZE image evidence through UNAVAILABLE", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-ui-missing-image-"));

    try {
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "analyze-ui",
              type: "UTILITY",
              title: "Analyze UI",
              utility: {
                type: "UI_ANALYZE",
                adapter: "image",
                screenshotPath: "missing.png",
              },
            },
            { id: "unavailable", type: "END", title: "Unavailable" },
          ],
          edges: [
            {
              id: "start-to-analyze",
              from: "start",
              fromOutput: "SUCCESS",
              to: "analyze-ui",
            },
            {
              id: "analyze-unavailable",
              from: "analyze-ui",
              fromOutput: "UNAVAILABLE",
              to: "unavailable",
            },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 5 },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults.find((entry) => entry.blockId === "analyze-ui"))
        .toMatchObject({
          output: "UNAVAILABLE",
          status: "error",
          data: expect.objectContaining({
            adapter: "image",
            server: expect.objectContaining({
              ready: false,
            }),
            artifacts: {
              screenshots: [],
            },
          }),
        });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns UNAVAILABLE for UI_ANALYZE browser targets that fail health checks", async () => {
    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "analyze-ui",
            type: "UTILITY",
            title: "Analyze UI",
            utility: {
              type: "UI_ANALYZE",
              adapter: "browser",
              targetUrl: "http://127.0.0.1:9",
              timeoutSeconds: 1,
              server: {
                mode: "existing",
                healthUrl: "http://127.0.0.1:9",
              },
            },
          },
          { id: "unavailable", type: "END", title: "Unavailable" },
        ],
        edges: [
          {
            id: "start-to-analyze",
            from: "start",
            fromOutput: "SUCCESS",
            to: "analyze-ui",
          },
          {
            id: "analyze-unavailable",
            from: "analyze-ui",
            fromOutput: "UNAVAILABLE",
            to: "unavailable",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "analyze-ui"))
      .toMatchObject({
        output: "UNAVAILABLE",
        data: expect.objectContaining({
          adapter: "browser",
          server: expect.objectContaining({
            mode: "existing",
            ready: false,
          }),
        }),
      });
  });

  it("returns UNAVAILABLE instead of starting managed UI_ANALYZE servers", async () => {
    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "analyze-ui",
            type: "UTILITY",
            title: "Analyze UI",
            utility: {
              type: "UI_ANALYZE",
              adapter: "browser",
              targetUrl: "http://127.0.0.1:5173",
              server: {
                mode: "managed",
                command: "pnpm dev",
              },
            },
          },
          { id: "unavailable", type: "END", title: "Unavailable" },
        ],
        edges: [
          {
            id: "start-to-analyze",
            from: "start",
            fromOutput: "SUCCESS",
            to: "analyze-ui",
          },
          {
            id: "analyze-unavailable",
            from: "analyze-ui",
            fromOutput: "UNAVAILABLE",
            to: "unavailable",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "analyze-ui"))
      .toMatchObject({
        output: "UNAVAILABLE",
        data: expect.objectContaining({
          adapter: "browser",
          server: {
            mode: "managed",
            ready: false,
          },
        }),
      });
  });

  it("collects enriched browser evidence with default UI_ANALYZE viewports", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-ui-browser-"));
    const evaluateResult = {
      issues: [
        {
          severity: "warning",
          category: "interaction",
          message: "Interactive target may be smaller than 44 by 44 CSS pixels.",
          selector: "button#tiny",
          evidence: { width: 32, height: 32 },
        },
        {
          severity: "warning",
          category: "contrast",
          message: "Text may not meet computed contrast requirements.",
          selector: "p.status",
          evidence: { contrastRatio: 2.4, requiredRatio: 4.5 },
        },
      ],
      analysis: {
        viewport: {
          width: 390,
          height: 844,
          scrollWidth: 420,
          scrollHeight: 1200,
          horizontalOverflowPixels: 30,
        },
        viewportMeta: {
          present: true,
          content: "width=device-width, initial-scale=1",
          hasDeviceWidth: true,
          hasInitialScale: true,
          warnings: [],
        },
        structure: {
          headings: [{ level: 1, text: "Dashboard" }],
          h1Count: 1,
          landmarkCounts: {
            header: 1,
            nav: 1,
            main: 1,
            aside: 0,
            footer: 0,
            search: 0,
          },
          navigationCount: 1,
          mainCount: 1,
          formCount: 0,
          interactiveCount: 1,
          imageCount: 0,
          missingAltImageCount: 0,
        },
        textDensity: {
          characterCount: 14,
          wordCount: 2,
          blockCount: 1,
          denseBlockCount: 0,
          maxBlockCharacters: 14,
          denseBlocks: [],
        },
        layout: {
          hasHorizontalOverflow: true,
          clippedElementCount: 0,
          clippedElements: [],
          overflowElementCount: 1,
          overflowElements: [{ selector: "main", width: 420, height: 900 }],
          overlapCandidateCount: 0,
          overlapCandidates: [],
        },
        interaction: {
          smallTargetCount: 1,
          smallTargets: [{ selector: "button#tiny", width: 32, height: 32 }],
        },
        contrast: {
          checkedTextElementCount: 1,
          lowContrastCount: 1,
          lowContrastElements: [
            {
              selector: "p.status",
              contrastRatio: 2.4,
              requiredRatio: 4.5,
            },
          ],
        },
      },
    };
    const locator = {
      innerText: vi.fn().mockResolvedValue("Dashboard Ready"),
      ariaSnapshot: vi.fn().mockResolvedValue("- main: Dashboard"),
    };
    const page = {
      on: vi.fn(),
      setDefaultTimeout: vi.fn(),
      goto: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue("Dashboard"),
      locator: vi.fn().mockReturnValue(locator),
      evaluate: vi.fn().mockResolvedValue(evaluateResult),
      url: vi.fn().mockReturnValue("http://127.0.0.1:4173/dashboard"),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    playwrightMock.launch.mockResolvedValue(browser);

    try {
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "analyze-ui",
              type: "UTILITY",
              title: "Analyze UI",
              utility: {
                type: "UI_ANALYZE",
                adapter: "browser",
                targetUrl: "http://127.0.0.1:4173/dashboard",
                server: {
                  mode: "none",
                },
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            {
              id: "start-to-analyze",
              from: "start",
              fromOutput: "SUCCESS",
              to: "analyze-ui",
            },
            {
              id: "analyze-to-success",
              from: "analyze-ui",
              fromOutput: "SUCCESS",
              to: "success",
            },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 5, runId: "ui-browser-defaults" },
      );

      expect(result.status).toBe("completed");
      expect(browser.newContext).toHaveBeenCalledTimes(4);
      expect(browser.newContext).toHaveBeenNthCalledWith(4, {
        viewport: {
          width: 320,
          height: 568,
        },
      });
      expect(page.evaluate).toHaveBeenCalledTimes(4);
      expect(result.blockResults.find((entry) => entry.blockId === "analyze-ui"))
        .toMatchObject({
          output: "SUCCESS",
          data: expect.objectContaining({
            adapter: "browser",
            viewports: expect.arrayContaining([
              expect.objectContaining({
                name: "small-mobile",
                width: 320,
                height: 568,
                analysis: expect.objectContaining({
                  interaction: expect.objectContaining({
                    smallTargetCount: 1,
                  }),
                  layout: expect.objectContaining({
                    hasHorizontalOverflow: true,
                  }),
                }),
              }),
            ]),
            issues: expect.arrayContaining([
              expect.objectContaining({
                category: "interaction",
                selector: "button#tiny",
                viewport: "small-mobile",
                evidence: expect.objectContaining({
                  width: 32,
                  height: 32,
                }),
              }),
              expect.objectContaining({
                category: "contrast",
                selector: "p.status",
                viewport: "small-mobile",
              }),
            ]),
          }),
        });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can collect UI evidence through a configured Tauri MCP tool", async () => {
    vi.mocked(mcpClientManager.callTool).mockResolvedValue({
      content: [
        {
          type: "text",
          text: "screenshot captured",
        },
      ],
      isError: false,
    } as never);

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "analyze-ui",
            type: "UTILITY",
            title: "Analyze UI",
            utility: {
              type: "UI_ANALYZE",
              adapter: "tauri-mcp",
              mcpServerId: "tauri",
              mcpToolName: "capture_screenshot",
              mcpArguments: {
                window: "{{window:string=main}}",
              },
            },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          {
            id: "start-to-analyze",
            from: "start",
            fromOutput: "SUCCESS",
            to: "analyze-ui",
          },
          {
            id: "analyze-to-success",
            from: "analyze-ui",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      {
        maxTransitions: 5,
        variableValues: {
          window: "main",
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(mcpClientManager.callTool).toHaveBeenCalledWith(
      "C:/workspace",
      "tauri",
      "capture_screenshot",
      { window: "main" },
      expect.objectContaining({}),
    );
    expect(result.blockResults.find((entry) => entry.blockId === "analyze-ui"))
      .toMatchObject({
        output: "SUCCESS",
        data: expect.objectContaining({
          adapter: "tauri-mcp",
          mcpResult: expect.objectContaining({
            isError: false,
          }),
        }),
      });
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

  it("routes decision labels from the last valid marker even with trailing output", async () => {
    vi.mocked(executeTask).mockResolvedValueOnce(
      createExecutionResult({
        summary: "Decision selected RUN.",
        response: {
          markdown: "I will run the test.\nRALPH_DECISION: RUN\nRoute selected.",
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
      }),
    );

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "choose",
            type: "DECISION",
            title: "Choose",
            prompt: "Choose RUN or SKIP.",
            labels: ["RUN", "SKIP"],
          },
          { id: "run", type: "END", title: "Run", status: "success" },
          { id: "skip", type: "END", title: "Skip", status: "success" },
          { id: "failed", type: "END", title: "Failed", status: "failed" },
        ],
        edges: [
          { id: "start-to-choose", from: "start", fromOutput: "SUCCESS", to: "choose" },
          { id: "choose-run", from: "choose", fromOutput: "RUN", to: "run" },
          { id: "choose-skip", from: "choose", fromOutput: "SKIP", to: "skip" },
          { id: "choose-error", from: "choose", fromOutput: "ERROR", to: "failed" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "choose"))
      .toMatchObject({
        output: "RUN",
        status: "completed",
      });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "edge-route",
          from: "choose",
          output: "RUN",
          to: "run",
        }),
      ]),
    );
  });

  it("routes invalid decision outputs to ERROR instead of retrying by default", async () => {
    vi.mocked(executeTask).mockResolvedValueOnce(
      createExecutionResult({
        summary: "No supported decision marker.",
        response: {
          markdown: "I am unsure, so I will explain instead of choosing.",
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
      }),
    );

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "choose",
            type: "DECISION",
            title: "Choose",
            prompt: "Choose RUN or SKIP.",
            labels: ["RUN", "SKIP"],
          },
          { id: "run", type: "END", title: "Run", status: "success" },
          { id: "failed", type: "END", title: "Failed", status: "failed" },
        ],
        edges: [
          { id: "start-to-choose", from: "start", fromOutput: "SUCCESS", to: "choose" },
          { id: "choose-run", from: "choose", fromOutput: "RUN", to: "run" },
          { id: "choose-error", from: "choose", fromOutput: "ERROR", to: "failed" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(vi.mocked(executeTask)).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("blocked");
    expect(result.blockResults.find((entry) => entry.blockId === "choose"))
      .toMatchObject({
        output: "ERROR",
        status: "error",
      });
    expect(result.blockResults.find((entry) => entry.blockId === "choose")?.error)
      .toContain("did not return a supported RALPH_DECISION marker");
    expect(result.events.some((event) => event.type === "retry")).toBe(false);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "edge-route",
          from: "choose",
          output: "ERROR",
          to: "failed",
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

  it("routes MCP tool call errors through ERROR edges", async () => {
    vi.mocked(mcpClientManager.callTool).mockResolvedValue({
      content: [
        {
          type: "text",
          text: "tool failed",
        },
      ],
      isError: true,
    } as never);

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
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
                  },
                ],
              },
            },
          },
          { id: "failed", type: "END", title: "Failed", status: "failed" },
        ],
        edges: [
          {
            id: "start-to-search",
            from: "start",
            fromOutput: "SUCCESS",
            to: "search",
          },
          {
            id: "search-to-failed",
            from: "search",
            fromOutput: "ERROR",
            to: "failed",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("blocked");
    expect(result.blockResults.find((entry) => entry.blockId === "search"))
      .toMatchObject({
        output: "ERROR",
        status: "error",
        error: expect.stringContaining("tool failed"),
      });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "edge-route",
          from: "search",
          output: "ERROR",
          to: "failed",
        }),
      ]),
    );
  });

  it("runs MCP prompt blocks and stringifies prompt arguments", async () => {
    vi.mocked(mcpClientManager.getPrompt).mockResolvedValue({
      description: "Prompt description",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Generated prompt",
          },
        },
      ],
    } as never);

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "prompt-template",
            type: "MCP_PROMPT",
            title: "Prompt Template",
            serverId: "templates",
            promptName: "review",
            arguments: {
              topic: "{{topic:string=Ralph}}",
              count: 2,
            },
            settings: {
              mcp: {
                servers: [
                  {
                    id: "templates",
                    enabled: true,
                    transport: {
                      type: "streamable-http",
                      url: "https://example.test/mcp",
                    },
                  },
                ],
              },
            },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          {
            id: "start-to-prompt-template",
            from: "start",
            fromOutput: "SUCCESS",
            to: "prompt-template",
          },
          {
            id: "prompt-template-to-success",
            from: "prompt-template",
            fromOutput: "SUCCESS",
            to: "success",
          },
        ],
      }),
      runtimeConfig,
      customizations,
      {
        maxTransitions: 5,
        runId: "ralph-run-1",
      },
    );

    expect(result.status).toBe("completed");
    expect(mcpClientManager.getPrompt).toHaveBeenCalledWith(
      "C:/workspace",
      "templates",
      "review",
      {
        topic: "Ralph",
        count: "2",
      },
      expect.objectContaining({
        cache: {
          runId: "ralph-run-1",
          operation: "prompt",
          readOnly: true,
        },
      }),
    );
    expect(result.blockResults.find((entry) => entry.blockId === "prompt-template"))
      .toMatchObject({
        output: "SUCCESS",
        status: "completed",
        markdown: expect.stringContaining("Generated prompt"),
      });
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


