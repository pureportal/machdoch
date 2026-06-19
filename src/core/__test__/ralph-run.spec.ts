import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
describe("runRalphFlow", () => {
  beforeEach(() => {
    vi.mocked(executeTask).mockReset();
    vi.mocked(mcpClientManager.callTool).mockReset();
    vi.mocked(mcpClientManager.readResource).mockReset();
    vi.mocked(mcpClientManager.getPrompt).mockReset();
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
      }),
    );
  });

  it("pauses for input blocks and resumes with submitted values", async () => {
    const flow = createFlow({
      variables: [{ name: "details", type: "text", required: false, default: "" }],
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "collect",
          type: "INPUT",
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

    expect(result.status).toBe("completed");
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

    expect(result.status).toBe("completed");
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

    expect(result.status).toBe("completed");
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

    expect(result.status).toBe("completed");
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


