import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { executeTask } from "../execution.js";
import { mcpClientManager } from "../mcp/client.js";
import {
  createRalphRunLogger,
  readRalphExecutionHistoryResults,
  runRalphFlow,
  type RalphRunCheckpoint,
  type RalphRunRecord,
} from "../ralph.js";
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

const GIT_SCOPE_GUARD_TEST_TIMEOUT_MS = 90_000;

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
    const defaultExecutionOptions = vi.mocked(executeTask).mock.calls[0]?.[3];

    expect(defaultExecutionOptions).toEqual(
      expect.objectContaining({
        runId: "ralph-run-1",
      }),
    );
    expect(defaultExecutionOptions).not.toHaveProperty("maxDurationMs");
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
    const pausedCheckpoint = paused.checkpoint;
    if (!pausedCheckpoint) {
      throw new Error("Expected waiting Ralph run to include a checkpoint.");
    }

    const resumed = await runRalphFlow(flow, runtimeConfig, customizations, {
      runId: "ralph-input-run",
      checkpoint: pausedCheckpoint,
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

  it("atomically persists the routed successor as the block-boundary checkpoint", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-boundary-record-"));
    const logDirectory = join(workspace, "run-log");
    const logger = {
      runId: "boundary-run",
      paths: {
        id: "boundary-run",
        directory: logDirectory,
        recordPath: join(logDirectory, "run.json"),
        simpleJsonlPath: join(logDirectory, "simple.jsonl"),
        simpleMarkdownPath: join(logDirectory, "simple.md"),
        traceJsonlPath: join(logDirectory, "trace.jsonl"),
      },
      simple: vi.fn(),
      trace: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const flow = createFlow({
        variables: [
          { name: "approval", type: "string", default: "", required: false },
        ],
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "side-effect",
            type: "UTILITY",
            title: "Side effect",
            utility: { type: "NOTIFY", message: "Applied once." },
          },
          {
            id: "collect",
            type: "ASK_USER",
            title: "Collect",
            mode: "alwaysAsk",
            fields: [
              {
                id: "approval",
                label: "Approval",
                type: "text",
                required: true,
                variableName: "approval",
              },
            ],
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          { id: "start-to-effect", from: "start", fromOutput: "SUCCESS", to: "side-effect" },
          { id: "effect-to-collect", from: "side-effect", fromOutput: "SUCCESS", to: "collect" },
          { id: "collect-to-success", from: "collect", fromOutput: "SUCCESS", to: "success" },
        ],
      });
      const paused = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { logger, maxTransitions: 10 },
      );
      const persisted = JSON.parse(
        await readFile(logger.paths.recordPath, "utf8"),
      ) as { checkpoint?: { currentBlockId?: string } };

      expect(paused.status).toBe("waiting-for-input");
      expect(persisted.checkpoint?.currentBlockId).toBe("collect");
      expect(paused.blockResults.filter((entry) => entry.blockId === "side-effect"))
        .toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("caps restored checkpoint history when pausing again", async () => {
    const historicalResult = {
      blockId: "start",
      output: "SUCCESS",
      status: "skipped",
      attempt: 1,
      summary: "Start.",
    } as const;
    const checkpoint: RalphRunCheckpoint = {
      currentBlockId: "collect",
      transitions: 0,
      variables: { approval: "" },
      resultsByBlock: { start: historicalResult },
      runLog: Array.from({ length: 1_100 }, (_, index) => `entry-${index}`),
      blockResults: Array.from({ length: 1_100 }, () => ({ ...historicalResult })),
      events: Array.from({ length: 2_100 }, (_, index) => ({
        type: "block-start" as const,
        blockId: "start",
        attempt: index + 1,
      })),
      errorCounts: {},
      repeatedFailures: {},
    };
    const flow = createFlow({
      variables: [
        { name: "approval", type: "string", default: "", required: false },
      ],
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "collect",
          type: "ASK_USER",
          title: "Collect",
          mode: "alwaysAsk",
          fields: [
            {
              id: "approval",
              label: "Approval",
              type: "text",
              required: true,
              variableName: "approval",
            },
          ],
        },
        { id: "success", type: "END", title: "Success" },
      ],
      edges: [
        { id: "start-to-collect", from: "start", fromOutput: "SUCCESS", to: "collect" },
        { id: "collect-to-success", from: "collect", fromOutput: "SUCCESS", to: "success" },
      ],
    });

    const paused = await runRalphFlow(flow, runtimeConfig, customizations, {
      checkpoint,
      runId: "compacted-run",
    });

    expect(paused.status).toBe("waiting-for-input");
    expect(paused.checkpoint?.blockResults).toHaveLength(1_000);
    expect(paused.checkpoint?.events).toHaveLength(2_000);
    expect(paused.checkpoint?.runLog).toHaveLength(1_000);
  });

  it("continues autonomously across transition-budget segments without a fake terminal END", async () => {
    const flow = createFlow({
      settings: {
        maxTransitions: 2,
        autonomy: true,
      },
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "wait-one",
          type: "UTILITY",
          title: "Wait one",
          utility: { type: "WAIT", mode: "delay", delaySeconds: 0 },
        },
        {
          id: "wait-two",
          type: "UTILITY",
          title: "Wait two",
          utility: { type: "WAIT", mode: "delay", delaySeconds: 0 },
        },
        { id: "success", type: "END", title: "Success" },
      ],
      edges: [
        { id: "start-to-one", from: "start", fromOutput: "SUCCESS", to: "wait-one" },
        { id: "one-to-two", from: "wait-one", fromOutput: "SUCCESS", to: "wait-two" },
        { id: "two-to-success", from: "wait-two", fromOutput: "SUCCESS", to: "success" },
      ],
    });
    const exhausted = await runRalphFlow(flow, runtimeConfig, customizations, {
      runId: "transition-run",
    });

    expect(exhausted.status).toBe("completed");
    expect(exhausted.checkpoint).toBeUndefined();
    expect(exhausted.blockResults.map((entry) => entry.blockId)).toEqual([
      "start",
      "wait-one",
      "wait-two",
      "success",
    ]);
    expect(exhausted.autonomy?.totalTransitions).toBe(3);
    expect(exhausted.events.filter((event) => event.type === "end")).toHaveLength(1);
  });

  it("recovers a failed-END ERROR route with bounded autonomous retry", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(
        createExecutionResult({
          status: "blocked",
          summary: "Transient provider failure.",
          reason: "Retryable failure.",
        }),
      )
      .mockResolvedValueOnce(createExecutionResult({ summary: "Recovered." }));

    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "work", type: "PROMPT", title: "Work", prompt: "Do work." },
          { id: "success", type: "END", title: "Success" },
          { id: "failed", type: "END", title: "Failed", status: "failed" },
        ],
        edges: [
          { id: "start-to-work", from: "start", fromOutput: "SUCCESS", to: "work" },
          { id: "work-success", from: "work", fromOutput: "SUCCESS", to: "success" },
          { id: "work-error", from: "work", fromOutput: "ERROR", to: "failed" },
        ],
      }),
      runtimeConfig,
      customizations,
      {
        maxTransitions: 10,
        autonomy: {
          maxRecoveryAttempts: 2,
          backoff: { initialDelaySeconds: 0, maxDelaySeconds: 0 },
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(result.autonomy).toMatchObject({
      recoveryAttempts: [
        expect.objectContaining({
          blockId: "work",
          output: "ERROR",
          failedEndBlockId: "failed",
          attempt: 1,
        }),
      ],
      recovered: [
        expect.objectContaining({ blockId: "work", attempts: 1 }),
      ],
      deferred: [],
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "retry",
          blockId: "work",
          recovery: expect.objectContaining({ failedEndBlockId: "failed" }),
        }),
      ]),
    );
  });

  it("defers exhausted INVALID work to a configured executable block", async () => {
    const result = await runRalphFlow(
      createFlow({
        settings: {
          maxTransitions: 10,
          autonomy: {
            maxRecoveryAttempts: 1,
            backoff: { initialDelaySeconds: 0, maxDelaySeconds: 0 },
            recoveryExhaustion: "defer",
            deferToBlockId: "defer-work",
          },
        },
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "validate",
            type: "UTILITY",
            title: "Validate",
            utility: {
              type: "VALIDATE_JSON",
              input: "{}",
              schema: { type: "object", required: ["ok"] },
            },
          },
          {
            id: "defer-work",
            type: "UTILITY",
            title: "Defer work",
            utility: { type: "NOTIFY", message: "Deferred." },
          },
          { id: "success", type: "END", title: "Success" },
          { id: "failed", type: "END", title: "Failed", status: "failed" },
        ],
        edges: [
          { id: "start-to-validate", from: "start", fromOutput: "SUCCESS", to: "validate" },
          { id: "validate-invalid", from: "validate", fromOutput: "INVALID", to: "failed" },
          { id: "defer-to-success", from: "defer-work", fromOutput: "SUCCESS", to: "success" },
        ],
      }),
      runtimeConfig,
      customizations,
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.filter((entry) => entry.blockId === "validate"))
      .toHaveLength(2);
    expect(result.autonomy?.deferred).toEqual([
      expect.objectContaining({
        blockId: "validate",
        output: "INVALID",
        routedToBlockId: "defer-work",
      }),
    ]);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "edge-route",
          from: "validate",
          to: "defer-work",
          deferred: expect.objectContaining({ blockId: "validate" }),
        }),
      ]),
    );
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
      await writeFile(join(workspace, "src", "Other.tsx"), "export {};\n", "utf8");
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
                maxResults: 1,
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
        | { results: string[]; count: number; truncated: boolean; limit: number }
        | undefined;
      const normalizedResults =
        searchData?.results.map((entry) => entry.replace(/\\/gu, "/")) ?? [];

      expect(result.status).toBe("completed");
      expect(searchData?.count).toBe(1);
      expect(searchData).toMatchObject({ truncated: true, limit: 1 });
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

  it("defers repeated identical failures instead of persisting a resume loop", async () => {
    vi.mocked(executeTask).mockResolvedValue(
      createExecutionResult({ summary: "Repair attempted." }),
    );

    const result = await runRalphFlow(
      createFlow({
        settings: {
          maxTransitions: 20,
          autonomy: {
            recoveryExhaustion: "defer",
            deferToBlockId: "defer-work",
            backoff: { initialDelaySeconds: 0, maxDelaySeconds: 0 },
          },
        },
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "check",
            type: "UTILITY",
            title: "Check",
            utility: {
              type: "VALIDATE_JSON",
              input: "{}",
              schema: { type: "object", required: ["ok"] },
            },
          },
          { id: "fix", type: "PROMPT", title: "Fix", prompt: "Repair." },
          {
            id: "defer-work",
            type: "UTILITY",
            title: "Defer",
            utility: { type: "NOTIFY", message: "Deferred." },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          { id: "start-to-check", from: "start", fromOutput: "SUCCESS", to: "check" },
          { id: "check-to-fix", from: "check", fromOutput: "INVALID", to: "fix" },
          { id: "fix-to-check", from: "fix", fromOutput: "SUCCESS", to: "check" },
          { id: "defer-to-success", from: "defer-work", fromOutput: "SUCCESS", to: "success" },
        ],
      }),
      runtimeConfig,
      customizations,
    );

    expect(result.status).toBe("completed");
    expect(result.autonomy).toMatchObject({
      deferred: [
        expect.objectContaining({
          blockId: "check",
          attempts: 3,
          routedToBlockId: "defer-work",
        }),
      ],
      exhaustion: {
        kind: "repeated-failure",
        blockId: "check",
      },
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "edge-route",
          from: "check",
          to: "defer-work",
        }),
      ]),
    );
  });

  it("keeps inline numeric defaults when callers submit blank variable values", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-counter-default-"));

    try {
      const result = await runRalphFlow(
        createFlow({
          variables: [
            { name: "maxPasses", type: "number", default: "1", required: false },
          ],
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "counter-one",
              type: "UTILITY",
              title: "Counter One",
              utility: {
                type: "LOOP_COUNTER",
                path: "state/counters.json",
                counterName: "blank-default",
                counterKey: "active",
                maxAttempts: "{{maxPasses:number=1}}",
              },
            },
            {
              id: "counter-two",
              type: "UTILITY",
              title: "Counter Two",
              utility: {
                type: "LOOP_COUNTER",
                path: "state/counters.json",
                counterName: "blank-default",
                counterKey: "active",
                maxAttempts: "{{maxPasses:number=1}}",
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-counter-one", from: "start", fromOutput: "SUCCESS", to: "counter-one" },
            { id: "counter-one-to-counter-two", from: "counter-one", fromOutput: "CONTINUE", to: "counter-two" },
            { id: "counter-two-to-success", from: "counter-two", fromOutput: "LIMIT_REACHED", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          maxTransitions: 10,
          variableValues: { maxPasses: "" },
        },
      );

      expect(result.status).toBe("completed");
      expect(result.blockResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockId: "counter-one",
            output: "CONTINUE",
            data: expect.objectContaining({ limit: 1 }),
          }),
          expect.objectContaining({
            blockId: "counter-two",
            output: "LIMIT_REACHED",
            data: expect.objectContaining({ limit: 1 }),
          }),
        ]),
      );
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
              task: expect.objectContaining({ id: "task-1", status: "implementing" }),
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

  it("enforces and records deterministic JSON work-item state transitions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-work-item-state-"));

    try {
      await mkdir(join(workspace, "state"), { recursive: true });
      await writeFile(
        join(workspace, "state", "tasks.json"),
        JSON.stringify({
          tasks: [{ id: "task-1", title: "First", status: "planned" }],
        }),
        "utf8",
      );

      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "implement",
              type: "UTILITY",
              title: "Implement",
              utility: {
                type: "MARK_JSON_TASK",
                path: "state/tasks.json",
                taskId: "task-1",
                status: "implementing",
                enforce: true,
              },
            },
            {
              id: "verify",
              type: "UTILITY",
              title: "Verify",
              utility: {
                type: "MARK_JSON_TASK",
                path: "state/tasks.json",
                taskId: "task-1",
                status: "verifying",
                enforce: true,
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-implement", from: "start", fromOutput: "SUCCESS", to: "implement" },
            { id: "implement-to-verify", from: "implement", fromOutput: "SUCCESS", to: "verify" },
            { id: "verify-to-success", from: "verify", fromOutput: "SUCCESS", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10, runId: "work-item-run" },
      );
      const stored = JSON.parse(
        await readFile(join(workspace, "state", "tasks.json"), "utf8"),
      ) as { tasks: Array<Record<string, unknown>> };

      expect(result.status).toBe("completed");
      expect(stored.tasks[0]).toMatchObject({
        id: "task-1",
        workItemId: "task-1",
        runId: "work-item-run",
        status: "verifying",
        stateHistory: [
          expect.objectContaining({ from: "planned", to: "implementing" }),
          expect.objectContaining({ from: "implementing", to: "verifying" }),
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("selects a bounded compatible JSON task batch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-json-task-batch-"));

    try {
      await mkdir(join(workspace, "state"), { recursive: true });
      await writeFile(
        join(workspace, "state", "tasks.json"),
        JSON.stringify(
          {
            tasks: [
              {
                id: "task-1",
                title: "Create service",
                status: "todo",
                batchKey: "service",
              },
              {
                id: "task-2",
                title: "Wire service tests",
                status: "todo",
                batchKey: "service",
                dependsOn: ["task-1"],
              },
              {
                id: "task-3",
                title: "Update UI",
                status: "todo",
                batchKey: "ui",
              },
              {
                id: "task-4",
                title: "Previously deferred",
                status: "deferred",
                batchKey: "service",
              },
              {
                id: "task-5",
                title: "No action needed",
                status: "no_action",
                batchKey: "service",
              },
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
              id: "select-task",
              type: "UTILITY",
              title: "Select Task",
              utility: {
                type: "SELECT_JSON_TASK",
                path: "state/tasks.json",
                jsonPath: "tasks",
                strategy: "start-to-end",
                maxTasks: 3,
              },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-select", from: "start", fromOutput: "SUCCESS", to: "select-task" },
            { id: "select-to-success", from: "select-task", fromOutput: "SELECTED", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 5 },
      );

      const selectResult = result.blockResults.find(
        (entry) => entry.blockId === "select-task",
      );
      const storedTasks = JSON.parse(
        await readFile(join(workspace, "state", "tasks.json"), "utf8"),
      ) as { tasks: Array<{ id: string; status: string; attempts?: number }> };

      expect(result.status).toBe("completed");
      expect(selectResult).toMatchObject({
        output: "SELECTED",
        data: expect.objectContaining({
          task: expect.objectContaining({
            id: "task-1",
            workItemId: "task-1",
            runId: expect.any(String),
            stateHistory: [
              expect.objectContaining({ from: "planned", to: "implementing" }),
            ],
          }),
          tasks: [
            expect.objectContaining({ id: "task-1", status: "implementing" }),
            expect.objectContaining({ id: "task-2", status: "implementing" }),
          ],
          indexes: [0, 1],
          count: 2,
          batch: expect.objectContaining({
            taskIds: ["task-1", "task-2"],
          }),
        }),
      });
      expect(storedTasks.tasks.map((task) => [task.id, task.status, task.attempts]))
        .toEqual([
          ["task-1", "implementing", 1],
          ["task-2", "implementing", 1],
          ["task-3", "todo", undefined],
          ["task-4", "deferred", undefined],
          ["task-5", "no_action", undefined],
        ]);
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

  it("removes strict-output nulls for optional schema properties before validation", async () => {
    vi.mocked(executeTask).mockResolvedValueOnce(
      createExecutionResult({
        summary: "Stop.",
        response: {
          markdown: JSON.stringify({ decision: "STOP", selectedCandidate: null }),
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
            id: "prompt-json",
            type: "UTILITY",
            title: "Prompt JSON",
            utility: {
              type: "PROMPT_JSON",
              prompt: "Choose or stop.",
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["decision"],
                properties: {
                  decision: { type: "string", enum: ["STOP", "IMPLEMENT"] },
                  selectedCandidate: {
                    type: "object",
                    additionalProperties: false,
                    properties: {},
                  },
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
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "prompt-json"))
      .toMatchObject({
        output: "SUCCESS",
        data: expect.objectContaining({
          output: { decision: "STOP" },
        }),
      });
    expect(vi.mocked(executeTask).mock.calls[0]?.[3]).toMatchObject({
      structuredOutput: { strict: true },
    });
  });

  it("enforces integer, object null, and additionalProperties JSON schema rules", async () => {
    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "validate-properties",
            type: "UTILITY",
            title: "Validate properties",
            utility: {
              type: "VALIDATE_JSON",
              input: JSON.stringify({ count: 1.5, extra: true }),
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { count: { type: "integer" } },
              },
            },
          },
          {
            id: "validate-null",
            type: "UTILITY",
            title: "Validate null",
            utility: {
              type: "VALIDATE_JSON",
              input: "null",
              schema: { type: "object" },
            },
          },
          { id: "success", type: "END", title: "Success" },
        ],
        edges: [
          { id: "start-to-properties", from: "start", fromOutput: "SUCCESS", to: "validate-properties" },
          { id: "properties-to-null", from: "validate-properties", fromOutput: "INVALID", to: "validate-null" },
          { id: "null-to-success", from: "validate-null", fromOutput: "INVALID", to: "success" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 5 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "validate-properties"))
      .toMatchObject({
        output: "INVALID",
        data: {
          input: { count: 1.5, extra: true },
          validation: {
            valid: false,
            errors: expect.arrayContaining([
              expect.stringContaining("expected integer"),
              expect.stringContaining("extra is not allowed"),
            ]),
          },
        },
      });
    expect(result.blockResults.find((entry) => entry.blockId === "validate-null"))
      .toMatchObject({
        output: "INVALID",
        data: {
          input: null,
          validation: {
            valid: false,
            errors: [expect.stringContaining("expected object, got null")],
          },
        },
      });
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
      const expectedVerificationCommand =
        process.platform === "win32"
          ? [
              "pnpm typecheck",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
              "pnpm lint",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
              "pnpm test",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
            ].join("; ")
          : "pnpm typecheck && pnpm lint && pnpm test";
      const expectedFocusedVerificationCommand =
        process.platform === "win32"
          ? [
              "pnpm typecheck",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
            ].join("; ")
          : "pnpm typecheck";
      const expectedStandardVerificationCommand =
        process.platform === "win32"
          ? [
              "pnpm typecheck",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
              "pnpm lint",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
            ].join("; ")
          : "pnpm typecheck && pnpm lint";

      expect(result.status).toBe("completed");
      expect(result.blockResults.find((entry) => entry.blockId === "detect"))
        .toMatchObject({
          output: "SUCCESS",
          data: expect.objectContaining({
            focusedVerificationCommand: expectedFocusedVerificationCommand,
            standardVerificationCommand: expectedStandardVerificationCommand,
            broadVerificationCommand: expectedVerificationCommand,
            verificationCommand: expectedVerificationCommand,
          }),
        });
      await expect(readFile(join(workspace, "state", "project-commands.json"), "utf8"))
        .resolves.toContain("pnpm typecheck");
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects nested package commands from a selected source scope", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-project-scope-commands-"));

    try {
      await mkdir(join(workspace, "apps", "api", "src"), { recursive: true });
      await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
      await writeFile(
        join(workspace, "apps", "api", "package.json"),
        JSON.stringify({
          scripts: {
            typecheck: "tsc --noEmit",
            lint: "eslint src",
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
                rootPath: "apps/api/src",
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
      const expectedVerificationCommand =
        process.platform === "win32"
          ? [
              "pnpm typecheck",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
              "pnpm lint",
              "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
            ].join("; ")
          : "pnpm typecheck && pnpm lint";

      expect(result.status).toBe("completed");
      expect(result.blockResults.find((entry) => entry.blockId === "detect"))
        .toMatchObject({
          output: "SUCCESS",
          data: expect.objectContaining({
            rootPath: join(workspace, "apps", "api"),
            requestedRootPath: join(workspace, "apps", "api", "src"),
            commands: expect.arrayContaining([
              expect.objectContaining({
                kind: "typecheck",
                command: "pnpm typecheck",
              }),
              expect.objectContaining({
                kind: "lint",
                command: "pnpm lint",
              }),
            ]),
            focusedVerificationCommand:
              process.platform === "win32"
                ? [
                    "pnpm typecheck",
                    "if (-not $? -or ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0)) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }",
                  ].join("; ")
                : "pnpm typecheck",
            standardVerificationCommand: expectedVerificationCommand,
            broadVerificationCommand: expectedVerificationCommand,
            verificationCommand: expectedVerificationCommand,
          }),
        });
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
  }, GIT_SCOPE_GUARD_TEST_TIMEOUT_MS);

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
  }, GIT_SCOPE_GUARD_TEST_TIMEOUT_MS);

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
  }, GIT_SCOPE_GUARD_TEST_TIMEOUT_MS);

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
  }, GIT_SCOPE_GUARD_TEST_TIMEOUT_MS);

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
  }, GIT_SCOPE_GUARD_TEST_TIMEOUT_MS);

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
      const blockedCheckpoint = blocked.checkpoint;
      if (!blockedCheckpoint) {
        throw new Error("Expected blocked Ralph run to include a checkpoint.");
      }

      const resumed = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          maxTransitions: 10,
          checkpoint: blockedCheckpoint,
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
  }, GIT_SCOPE_GUARD_TEST_TIMEOUT_MS);

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
                expression:
                  "({ doubled: input.value * 2, readOutput: context.resultsByBlock.get('read')?.output })",
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
            data: expect.objectContaining({
              output: { doubled: 4, readOutput: "SUCCESS" },
            }),
          }),
          expect.objectContaining({
            blockId: "validate-json",
            output: "INVALID",
            status: "error",
          }),
          expect.objectContaining({
            blockId: "search-empty",
            output: "EMPTY",
            status: "completed",
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

  it("reports truncated scope evidence when the configured cap is reached", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-cap-"));
    try {
      await mkdir(join(workspace, "a"), { recursive: true });
      await mkdir(join(workspace, "b"), { recursive: true });
      await writeFile(join(workspace, "package.json"), "{}", "utf8");
      await writeFile(join(workspace, "a", "package.json"), "{}", "utf8");
      await writeFile(join(workspace, "b", "package.json"), "{}", "utf8");
      const result = await runRalphFlow(
        createFlow({
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "scan",
              type: "UTILITY",
              title: "Scan",
              utility: { type: "SCAN_SCOPE_EVIDENCE", rootPath: ".", maxResults: 1 },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-scan", from: "start", fromOutput: "SUCCESS", to: "scan" },
            { id: "scan-success", from: "scan", fromOutput: "SUCCESS", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { maxTransitions: 10 },
      );

      expect(result.blockResults.find((entry) => entry.blockId === "scan")?.data)
        .toMatchObject({ truncated: true, limit: 1, scopes: [expect.any(Object)] });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs legacy RUN_CHECK command chains", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-check-chain-"));

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
                command:
                  "node -e \"process.stdout.write('first')\" && node -e \"process.stdout.write('second')\"",
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
              stdout: "firstsecond",
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

  it("returns UNAVAILABLE when managed UI_ANALYZE has no server command", async () => {
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
                reuseExisting: false,
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
            mode: "managed",
            ready: false,
            started: false,
            reused: false,
            error: expect.stringContaining("requires server.command"),
          }),
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

  it("finalizes full execution history and outcome in a run-scoped report", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-final-report-"));
    const userLogDirectory = await mkdtemp(join(tmpdir(), "ralph-user-log-"));

    try {
      const result = await runRalphFlow(
        createFlow({
          variables: [
            {
              name: "reportPath",
              type: "path",
              default: "{{run:artifactRoot}}/final-report.json",
              required: false,
            },
          ],
          blocks: [
            { id: "start", type: "START", title: "Start" },
            {
              id: "notify",
              type: "UTILITY",
              title: "Notify",
              utility: { type: "NOTIFY", message: "Ready." },
            },
            {
              id: "report",
              type: "UTILITY",
              title: "Final report",
              utility: { type: "FINAL_REPORT", path: "{{reportPath}}" },
            },
            { id: "success", type: "END", title: "Success" },
          ],
          edges: [
            { id: "start-to-notify", from: "start", fromOutput: "SUCCESS", to: "notify" },
            { id: "notify-to-report", from: "notify", fromOutput: "SUCCESS", to: "report" },
            { id: "report-to-success", from: "report", fromOutput: "SUCCESS", to: "success" },
          ],
        }),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          maxTransitions: 10,
          logger: {
            runId: "report-run",
            paths: {
              id: "report-run",
              directory: userLogDirectory,
              recordPath: join(userLogDirectory, "run.json"),
              simpleJsonlPath: join(userLogDirectory, "simple.jsonl"),
              simpleMarkdownPath: join(userLogDirectory, "simple.md"),
              traceJsonlPath: join(userLogDirectory, "trace.jsonl"),
            },
            simple: vi.fn(),
            trace: vi.fn(),
            flush: vi.fn().mockResolvedValue(undefined),
          },
        },
      );
      const reportPath = join(
        workspace,
        ".machdoch",
        "ralph",
        "runs",
        "report-run",
        "final-report.json",
      );
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        outcome: { status: string; summary: string };
        executionHistory: Array<{ blockId: string; sequence: number }>;
        events: Array<{ type: string }>;
      };

      expect(result.status).toBe("completed");
      expect(report.outcome).toMatchObject({
        status: "completed",
        summary: expect.stringContaining("ended at `success`"),
      });
      expect(report.executionHistory.map((entry) => entry.blockId)).toEqual([
        "start",
        "notify",
        "report",
        "success",
      ]);
      expect(report.events.at(-1)).toMatchObject({
        type: "end",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(userLogDirectory, { recursive: true, force: true });
    }
  });

  it("restores and finalizes report descriptors after a crash before END", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-final-report-resume-"));
    try {
      const reportPath = join(workspace, "final-report.json");
      await writeFile(reportPath, JSON.stringify({ outcome: { status: "running" } }), "utf8");
      const flow = createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "report",
            type: "UTILITY",
            title: "Final report",
            utility: { type: "FINAL_REPORT", path: "final-report.json" },
          },
          { id: "success", type: "END", title: "Success", status: "success" },
        ],
        edges: [
          { id: "start-report", from: "start", fromOutput: "SUCCESS", to: "report" },
          { id: "report-success", from: "report", fromOutput: "SUCCESS", to: "success" },
        ],
      });
      const reportResult = {
        blockId: "report",
        operationId: "report-operation",
        output: "SUCCESS",
        status: "completed" as const,
        attempt: 1,
        summary: "Report started.",
      };
      const checkpoint: RalphRunCheckpoint = {
        currentBlockId: "success",
        transitions: 2,
        variables: {},
        resultsByBlock: { report: reportResult },
        runLog: [],
        blockResults: [reportResult],
        events: [],
        errorCounts: {},
        repeatedFailures: {},
        finalReports: [{ blockId: "report", jsonPath: reportPath }],
        operationLedger: {
          "report-operation": {
            id: "report-operation",
            blockId: "report",
            attempt: 1,
            state: "routed",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            routedAt: "2026-01-01T00:00:02.000Z",
            routedToBlockId: "success",
          },
        },
      };

      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { checkpoint, runId: "report-resume" },
      );
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        outcome: { status: string };
      };

      expect(result.status).toBe("completed");
      expect(report.outcome.status).toBe("completed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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

  it("executes a block again when a legitimate graph loop returns to it", async () => {
    vi.mocked(executeTask)
      .mockResolvedValueOnce(createExecutionResult({ summary: "A1" }))
      .mockResolvedValueOnce(createExecutionResult({ summary: "Loop", response: {
        markdown: "RALPH_DECISION: LOOP",
        highlights: [], relatedFiles: [], verification: [], followUps: [],
      } }))
      .mockResolvedValueOnce(createExecutionResult({ summary: "A2" }))
      .mockResolvedValueOnce(createExecutionResult({ summary: "Done", response: {
        markdown: "RALPH_DECISION: DONE",
        highlights: [], relatedFiles: [], verification: [], followUps: [],
      } }));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "a", type: "PROMPT", title: "A", prompt: "Execute A" },
        { id: "route", type: "DECISION", title: "Route", prompt: "Loop?", labels: ["LOOP", "DONE"] },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-a", from: "start", fromOutput: "SUCCESS", to: "a" },
        { id: "a-route", from: "a", fromOutput: "SUCCESS", to: "route" },
        { id: "route-loop", from: "route", fromOutput: "LOOP", to: "a" },
        { id: "route-done", from: "route", fromOutput: "DONE", to: "success" },
      ],
      settings: { maxTransitions: 20 },
    });

    const result = await runRalphFlow(flow, runtimeConfig, customizations);

    expect(result.status).toBe("completed");
    expect(result.blockResults.filter((entry) => entry.blockId === "a")).toHaveLength(2);
    expect(executeTask).toHaveBeenCalledTimes(4);
  });

  it("routes a durably completed operation after resume without replaying its side effect", async () => {
    const completed = {
      blockId: "side-effect",
      operationId: "operation-side-effect-1",
      output: "SUCCESS",
      status: "completed" as const,
      attempt: 1,
      summary: "Side effect completed.",
    };
    const checkpoint: RalphRunCheckpoint = {
      currentBlockId: "side-effect",
      transitions: 1,
      variables: {},
      resultsByBlock: { "side-effect": completed },
      runLog: ["side-effect.SUCCESS: Side effect completed."],
      blockResults: [completed],
      events: [],
      errorCounts: {},
      attemptCounts: { "side-effect": 1 },
      repeatedFailures: {},
      operationLedger: {
        "operation-side-effect-1": {
          id: "operation-side-effect-1",
          blockId: "side-effect",
          attempt: 1,
          state: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          output: "SUCCESS",
          summary: "Side effect completed.",
        },
      },
    };
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "side-effect", type: "PROMPT", title: "Side Effect", prompt: "Do it" },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-side", from: "start", fromOutput: "SUCCESS", to: "side-effect" },
        { id: "side-success", from: "side-effect", fromOutput: "SUCCESS", to: "success" },
      ],
    });

    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      checkpoint,
      runId: "resume-operation",
    });

    expect(result.status).toBe("completed");
    expect(result.blockResults.filter((entry) => entry.blockId === "side-effect"))
      .toHaveLength(1);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("rejects a concurrent resume without mutating or releasing the foreign lease", async () => {
    const lease = {
      ownerId: "other-process",
      generation: 3,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const checkpoint: RalphRunCheckpoint = {
      currentBlockId: "start",
      transitions: 0,
      variables: {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
      runId: "leased-run",
      flowId: "refactor-flow",
      lease,
    };
    const logger = {
      runId: "leased-run",
      simple: vi.fn(),
      trace: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runRalphFlow(
      createFlow(),
      runtimeConfig,
      customizations,
      { checkpoint, runId: "leased-run", logger },
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("leased by other-process");
    expect(result.checkpoint).toEqual(checkpoint);
    expect(result.checkpoint?.lease).not.toHaveProperty("releasedAt");
    expect(logger.simple).not.toHaveBeenCalled();
    expect(logger.trace).not.toHaveBeenCalled();
    expect(logger.flush).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("atomically fences simultaneous durable run acquisition", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-run-acquire-race-"));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "work", type: "PROMPT", title: "Work", prompt: "Do the work." },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-work", from: "start", fromOutput: "SUCCESS", to: "work" },
        { id: "work-success", from: "work", fromOutput: "SUCCESS", to: "success" },
      ],
    });
    let resolveExecution!: (value: ReturnType<typeof createExecutionResult>) => void;
    const execution = new Promise<ReturnType<typeof createExecutionResult>>((resolve) => {
      resolveExecution = resolve;
    });

    try {
      vi.mocked(executeTask).mockImplementation(() => execution);
      const firstLogger = await createRalphRunLogger(workspace, flow, {
        runId: "acquisition-race",
      });
      const secondLogger = await createRalphRunLogger(workspace, flow, {
        runId: "acquisition-race",
        paths: firstLogger.paths!,
        append: true,
      });
      const firstRun = runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          logger: firstLogger,
          runId: firstLogger.runId,
          leaseOwnerId: "acquisition-owner-a",
        },
      );
      const secondRun = runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          logger: secondLogger,
          runId: secondLogger.runId,
          leaseOwnerId: "acquisition-owner-b",
        },
      );
      const executionDeadline = Date.now() + 10_000;
      while (vi.mocked(executeTask).mock.calls.length === 0 && Date.now() < executionDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(executeTask).toHaveBeenCalledTimes(1);
      resolveExecution(createExecutionResult({ summary: "Winner completed." }));

      const results = await Promise.all([firstRun, secondRun]);
      expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            result.status === "crashed" &&
            result.summary.toLowerCase().includes("ownership"),
        ),
      ).toHaveLength(1);
      expect(executeTask).toHaveBeenCalledTimes(1);
      const record = JSON.parse(
        await readFile(firstLogger.paths!.recordPath, "utf8"),
      ) as RalphRunRecord;
      expect(record.status).toBe("completed");
    } finally {
      resolveExecution?.(createExecutionResult({ summary: "Cleanup." }));
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("prevents a stale owner from appending history or finalizing after takeover", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-run-stale-owner-"));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "work", type: "PROMPT", title: "Work", prompt: "Do the work." },
        {
          id: "report",
          type: "UTILITY",
          title: "Report",
          utility: {
            type: "FINAL_REPORT",
            path: "reports/final.json",
            markdownPath: "reports/final.md",
          },
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-work", from: "start", fromOutput: "SUCCESS", to: "work" },
        { id: "work-report", from: "work", fromOutput: "SUCCESS", to: "report" },
        { id: "work-error-report", from: "work", fromOutput: "ERROR", to: "report" },
        { id: "report-success", from: "report", fromOutput: "SUCCESS", to: "success" },
      ],
    });
    let resolveStaleExecution!: (value: ReturnType<typeof createExecutionResult>) => void;
    const staleExecution = new Promise<ReturnType<typeof createExecutionResult>>((resolve) => {
      resolveStaleExecution = resolve;
    });

    try {
      vi.mocked(executeTask).mockImplementation(() => staleExecution);
      const staleLogger = await createRalphRunLogger(workspace, flow, {
        runId: "stale-owner-run",
      });
      const staleRun = runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          logger: staleLogger,
          runId: staleLogger.runId,
          leaseOwnerId: "stale-owner",
          leaseDurationMs: 5_000,
        },
      );

      let takeoverCheckpoint: RalphRunCheckpoint | undefined;
      let lastObservedRecord: RalphRunRecord | undefined;
      let earlyStaleResult: Awaited<ReturnType<typeof runRalphFlow>> | undefined;
      void staleRun.then((result) => {
        earlyStaleResult = result;
      });
      const checkpointDeadline = Date.now() + 10_000;
      while (!takeoverCheckpoint && Date.now() < checkpointDeadline) {
        try {
          const record = JSON.parse(
            await readFile(staleLogger.paths!.recordPath, "utf8"),
          ) as RalphRunRecord;
          lastObservedRecord = record;
          if (
            record.checkpoint?.currentBlockId === "work" &&
            record.checkpoint.lease?.ownerId === "stale-owner" &&
            Object.values(record.checkpoint.operationLedger ?? {}).some(
              (entry) => entry.blockId === "work" && entry.state === "started",
            ) &&
            vi.mocked(executeTask).mock.calls.length === 1
          ) {
            takeoverCheckpoint = record.checkpoint;
          }
        } catch {
          // The first atomic run record may not exist yet.
        }
        if (!takeoverCheckpoint) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(
        takeoverCheckpoint,
        JSON.stringify({ lastObservedRecord, earlyStaleResult }, null, 2),
      ).toBeDefined();
      expect(executeTask).toHaveBeenCalledTimes(1);

      const takeoverLogger = await createRalphRunLogger(workspace, flow, {
        runId: staleLogger.runId,
        paths: staleLogger.paths!,
        append: true,
      });
      const takeoverResult = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          logger: takeoverLogger,
          runId: takeoverLogger.runId,
          checkpoint: takeoverCheckpoint!,
          leaseOwnerId: "takeover-owner",
          forceLeaseTakeover: true,
          leaseDurationMs: 5_000,
        },
      );
      expect(takeoverResult.status).toBe("completed");

      resolveStaleExecution(createExecutionResult({ summary: "Stale work returned late." }));
      const staleResult = await staleRun;
      expect(staleResult.status).toBe("crashed");
      expect(staleResult.summary.toLowerCase()).toContain("ownership");

      const history = await readRalphExecutionHistoryResults(staleLogger.paths);
      expect(history.filter((entry) => entry.blockId === "work")).toEqual([
        expect.objectContaining({ output: "ERROR" }),
      ]);
      const record = JSON.parse(
        await readFile(staleLogger.paths!.recordPath, "utf8"),
      ) as RalphRunRecord;
      expect(record.status).toBe("completed");
      expect(record.summary).toBe(takeoverResult.summary);
      const report = JSON.parse(
        await readFile(join(workspace, "reports", "final.json"), "utf8"),
      ) as { outcome?: { status?: unknown } };
      expect(report.outcome?.status).toBe("completed");
      expect(executeTask).toHaveBeenCalledTimes(1);
    } finally {
      resolveStaleExecution?.(createExecutionResult({ summary: "Cleanup." }));
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("heartbeats a durable lease while a long block is still executing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-heartbeat-"));
    try {
      let resolveExecution!: (value: ReturnType<typeof createExecutionResult>) => void;
      const executionPromise = new Promise<ReturnType<typeof createExecutionResult>>(
        (resolve) => {
          resolveExecution = resolve;
        },
      );
      vi.mocked(executeTask).mockImplementation(() => executionPromise);
      const flow = createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "long", type: "PROMPT", title: "Long", prompt: "Wait" },
          { id: "success", type: "END", title: "Success", status: "success" },
        ],
        edges: [
          { id: "start-long", from: "start", fromOutput: "SUCCESS", to: "long" },
          { id: "long-success", from: "long", fromOutput: "SUCCESS", to: "success" },
        ],
      });
      const logger = await createRalphRunLogger(workspace, flow, {
        runId: "heartbeat-run",
      });
      const runPromise = runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { logger, runId: logger.runId, leaseDurationMs: 1_000 },
      );

      let activeRecord:
        | { checkpoint: { lease: { acquiredAt: string; heartbeatAt: string } } }
        | undefined;
      let inspectionError: unknown;
      const heartbeatDeadline = Date.now() + 10_000;
      while (Date.now() < heartbeatDeadline) {
        try {
          activeRecord = JSON.parse(
            await readFile(logger.paths!.recordPath, "utf8"),
          ) as typeof activeRecord;
          if (
            activeRecord &&
            Date.parse(activeRecord.checkpoint.lease.heartbeatAt) >
              Date.parse(activeRecord.checkpoint.lease.acquiredAt)
          ) {
            break;
          }
        } catch (error) {
          inspectionError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      resolveExecution(createExecutionResult({ summary: "Finished." }));
      const result = await runPromise;
      const diagnostics = [
        `run status: ${result.status}`,
        `summary: ${result.summary}`,
        `durability: ${result.durability?.error ?? "healthy"}`,
        ...(inspectionError
          ? [`last record read error: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`]
          : []),
      ].join("; ");
      expect(activeRecord, diagnostics).toBeDefined();
      expect(
        Date.parse(activeRecord!.checkpoint.lease.heartbeatAt),
        diagnostics,
      ).toBeGreaterThan(Date.parse(activeRecord!.checkpoint.lease.acquiredAt));
      expect(result.status, diagnostics).toBe("completed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  it("releases the retained lease when final durability failure promotes completion to crash", async () => {
    const logger = {
      runId: "flush-failure-run",
      simple: vi.fn(),
      trace: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error("disk unavailable")),
    };
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-success", from: "start", fromOutput: "SUCCESS", to: "success" },
      ],
    });

    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      logger,
      runId: logger.runId,
    });

    expect(result.status).toBe("crashed");
    expect(result.durability).toMatchObject({ status: "degraded" });
    expect(result.checkpoint?.lease?.releasedAt).toEqual(expect.any(String));
  });

  it("routes unresolved strict utility references as an ERROR result", async () => {
    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "write",
            type: "UTILITY",
            title: "Write",
            utility: {
              type: "WRITE_JSON",
              path: "{{data:not-run:path}}",
              input: "{}",
            },
          },
          { id: "handled", type: "END", title: "Handled", status: "success" },
        ],
        edges: [
          { id: "start-write", from: "start", fromOutput: "SUCCESS", to: "write" },
          { id: "write-error", from: "write", fromOutput: "ERROR", to: "handled" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 10 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "write"))
      .toMatchObject({
        output: "ERROR",
        status: "error",
        error: expect.stringContaining("Unresolved Ralph block reference"),
      });
  });

  it("enforces an MCP deadline even when the connector never settles", async () => {
    vi.mocked(mcpClientManager.readResource).mockImplementation(
      () => new Promise(() => undefined),
    );
    const result = await runRalphFlow(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "mcp",
            type: "MCP_RESOURCE",
            title: "MCP",
            serverId: "test",
            uri: "test://resource",
            settings: {
              timeoutSeconds: 0.001,
              mcp: {
                servers: [{
                  id: "test",
                  enabled: true,
                  transport: { type: "streamable-http", url: "https://example.test/mcp" },
                }],
              },
            },
          },
          { id: "handled", type: "END", title: "Handled", status: "success" },
        ],
        edges: [
          { id: "start-mcp", from: "start", fromOutput: "SUCCESS", to: "mcp" },
          { id: "mcp-error", from: "mcp", fromOutput: "ERROR", to: "handled" },
        ],
      }),
      runtimeConfig,
      customizations,
      { maxTransitions: 10 },
    );

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "mcp"))
      .toMatchObject({
        output: "ERROR",
        error: expect.stringContaining("timed out"),
      });
  });

  it("reconciles a partial APPEND_JSONL tail on end-to-end operation resume", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-append-resume-"));
    const path = join(workspace, "events.jsonl");
    const operationId = "append-operation";
    const initial = "{\"seed\":true}\n";
    const intended = "{\"item\":1}\n";
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "append",
          type: "UTILITY",
          title: "Append",
          utility: { type: "APPEND_JSONL", path: "events.jsonl", input: "{\"item\":1}" },
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-append", from: "start", fromOutput: "SUCCESS", to: "append" },
        { id: "append-success", from: "append", fromOutput: "SUCCESS", to: "success" },
      ],
    });
    const checkpoint: RalphRunCheckpoint = {
      currentBlockId: "append",
      transitions: 1,
      variables: {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
      attemptCounts: { append: 1 },
      operationLedger: {
        [operationId]: {
          id: operationId,
          blockId: "append",
          attempt: 1,
          state: "started",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    try {
      await writeFile(path, `${initial}${intended.slice(0, 6)}`, "utf8");
      await writeFile(
        `${path}.ralph-operations.json`,
        JSON.stringify({
          operations: {
            [operationId]: {
              state: "started",
              priorSize: Buffer.byteLength(initial),
              lineLength: Buffer.byteLength(intended),
              startedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
        "utf8",
      );

      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { checkpoint, runId: "append-resume" },
      );

      expect(result.status).toBe("completed");
      await expect(readFile(path, "utf8")).resolves.toBe(`${initial}${intended}`);
      expect(result.blockResults.find((entry) => entry.blockId === "append"))
        .toMatchObject({ operationId, output: "SUCCESS" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails APPEND_JSONL closed on ledger I/O errors without mutating its target", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-append-ledger-error-"));
    const path = join(workspace, "events.jsonl");
    const original = "{\"existing\":true}\n";
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "append",
          type: "UTILITY",
          title: "Append",
          utility: { type: "APPEND_JSONL", path: "events.jsonl", input: "{\"item\":1}" },
        },
        { id: "failed", type: "END", title: "Failed", status: "failed" },
      ],
      edges: [
        { id: "start-append", from: "start", fromOutput: "SUCCESS", to: "append" },
        { id: "append-failed", from: "append", fromOutput: "ERROR", to: "failed" },
      ],
    });

    try {
      await writeFile(path, original, "utf8");
      await mkdir(`${path}.ralph-operations.json`);

      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "append-ledger-error" },
      );

      expect(result.blockResults.find((entry) => entry.blockId === "append"))
        .toMatchObject({ output: "ERROR" });
      await expect(readFile(path, "utf8")).resolves.toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("replays an atomically written FINAL_REPORT pending operation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-report-pending-"));
    const operationId = "pending-report-operation";
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "report",
          type: "UTILITY",
          title: "Report",
          utility: { type: "FINAL_REPORT", path: "report.json" },
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-report", from: "start", fromOutput: "SUCCESS", to: "report" },
        { id: "report-success", from: "report", fromOutput: "SUCCESS", to: "success" },
      ],
    });
    const checkpoint: RalphRunCheckpoint = {
      currentBlockId: "report",
      transitions: 1,
      variables: {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
      attemptCounts: { report: 1 },
      operationLedger: {
        [operationId]: {
          id: operationId,
          blockId: "report",
          attempt: 1,
          state: "started",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    try {
      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { checkpoint, runId: "pending-report" },
      );
      const report = JSON.parse(await readFile(join(workspace, "report.json"), "utf8")) as {
        outcome: { status: string };
      };

      expect(result.status).toBe("completed");
      expect(report.outcome.status).toBe("completed");
      expect(result.blockResults.find((entry) => entry.blockId === "report"))
        .toMatchObject({ operationId, output: "SUCCESS" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not synthesize an unvisited branch-specific FINAL_REPORT", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-report-branch-"));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "report-a",
          type: "UTILITY",
          title: "Report A",
          utility: { type: "FINAL_REPORT", path: "reports/a.json" },
        },
        {
          id: "report-b",
          type: "UTILITY",
          title: "Report B",
          utility: { type: "FINAL_REPORT", path: "{{data:never:path}}" },
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-a", from: "start", fromOutput: "SUCCESS", to: "report-a" },
        { id: "a-success", from: "report-a", fromOutput: "SUCCESS", to: "success" },
      ],
    });

    try {
      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "branch-report" },
      );

      expect(result.status).toBe("completed");
      await expect(readFile(join(workspace, "reports", "a.json"), "utf8"))
        .resolves.toContain('"status": "completed"');
      expect(result.blockResults.some((entry) => entry.blockId === "report-b")).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refuses APPEND_JSONL resume when crash-tail bytes do not match the operation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-append-mismatch-"));
    const path = join(workspace, "events.jsonl");
    const operationId = "append-mismatch-operation";
    const initial = "{\"seed\":true}\n";
    const mismatched = "not-the-intended-entry";
    const checkpoint: RalphRunCheckpoint = {
      currentBlockId: "append",
      transitions: 1,
      variables: {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
      attemptCounts: { append: 1 },
      operationLedger: {
        [operationId]: {
          id: operationId,
          blockId: "append",
          attempt: 1,
          state: "started",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "append",
          type: "UTILITY",
          title: "Append",
          utility: { type: "APPEND_JSONL", path: "events.jsonl", input: "{\"item\":1}" },
        },
        { id: "failed", type: "END", title: "Failed", status: "failed" },
      ],
      edges: [
        { id: "start-append", from: "start", fromOutput: "SUCCESS", to: "append" },
        { id: "append-failed", from: "append", fromOutput: "ERROR", to: "failed" },
      ],
    });

    try {
      await writeFile(path, `${initial}${mismatched}`, "utf8");
      await writeFile(`${path}.ralph-operations.json`, JSON.stringify({
        operations: {
          [operationId]: {
            state: "started",
            priorSize: Buffer.byteLength(initial),
            lineLength: Buffer.byteLength("{\"item\":1}\n"),
          },
        },
      }), "utf8");

      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { checkpoint, runId: "append-mismatch" },
      );

      expect(result.blockResults.find((entry) => entry.blockId === "append"))
        .toMatchObject({
          output: "ERROR",
          data: expect.objectContaining({ reconciliation: "indeterminate" }),
        });
      await expect(readFile(path, "utf8")).resolves.toBe(`${initial}${mismatched}`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("resumes pending SELECT_JSON_TASK and MARK_JSON_TASK operations idempotently", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-task-replay-"));
    const path = join(workspace, "tasks.json");
    const runId = "task-replay-run";
    const selectOperationId = "pending-select";
    const selectFlow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "select",
          type: "UTILITY",
          title: "Select",
          utility: { type: "SELECT_JSON_TASK", path: "tasks.json" },
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-select", from: "start", fromOutput: "SUCCESS", to: "select" },
        { id: "select-success", from: "select", fromOutput: "SELECTED", to: "success" },
      ],
    });
    const createPendingCheckpoint = (
      blockId: string,
      operationId: string,
    ): RalphRunCheckpoint => ({
      currentBlockId: blockId,
      transitions: 1,
      variables: {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
      attemptCounts: { [blockId]: 1 },
      operationLedger: {
        [operationId]: {
          id: operationId,
          blockId,
          attempt: 1,
          state: "started",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    try {
      const now = new Date().toISOString();
      await writeFile(path, JSON.stringify({ tasks: [{
        id: "task-1",
        status: "implementing",
        attempts: 1,
        lease: {
          ownerId: runId,
          generation: 1,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }] }), "utf8");

      const selected = await runRalphFlow(
        selectFlow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          checkpoint: createPendingCheckpoint("select", selectOperationId),
          runId,
        },
      );
      const afterSelect = JSON.parse(await readFile(path, "utf8")) as {
        tasks: Array<{ attempts: number; lease: { generation: number } }>;
      };

      expect(selected.status).toBe("completed");
      expect(afterSelect.tasks[0]).toMatchObject({ attempts: 1, lease: { generation: 1 } });

      const stateHistory = [{ from: "implementing", to: "completed", at: now }];
      await writeFile(path, JSON.stringify({ tasks: [{
        id: "task-1",
        status: "completed",
        stateHistory,
      }] }), "utf8");
      const markFlow = createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "mark",
            type: "UTILITY",
            title: "Mark",
            utility: {
              type: "MARK_JSON_TASK",
              path: "tasks.json",
              taskId: "task-1",
              status: "completed",
              enforce: true,
            },
          },
          { id: "success", type: "END", title: "Success", status: "success" },
        ],
        edges: [
          { id: "start-mark", from: "start", fromOutput: "SUCCESS", to: "mark" },
          { id: "mark-success", from: "mark", fromOutput: "SUCCESS", to: "success" },
        ],
      });
      const marked = await runRalphFlow(
        markFlow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          checkpoint: createPendingCheckpoint("mark", "pending-mark"),
          runId,
        },
      );
      const afterMark = JSON.parse(await readFile(path, "utf8")) as {
        tasks: Array<{ status: string; stateHistory: unknown[] }>;
      };

      expect(marked.status).toBe("completed");
      expect(afterMark.tasks[0]).toMatchObject({ status: "completed" });
      expect(afterMark.tasks[0]?.stateHistory).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("makes deferred JSON tasks eligible after their bounded cooldown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-task-defer-"));
    const path = join(workspace, "tasks.json");
    const selectBlock = {
      id: "select",
      type: "UTILITY" as const,
      title: "Select",
      utility: { type: "SELECT_JSON_TASK" as const, path: "tasks.json" },
    };
    const selectionFlow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        selectBlock,
        { id: "success", type: "END", title: "Success", status: "success" },
        { id: "blocked", type: "END", title: "Blocked", status: "failed" },
      ],
      edges: [
        { id: "start-select", from: "start", fromOutput: "SUCCESS", to: "select" },
        { id: "selected-success", from: "select", fromOutput: "SELECTED", to: "success" },
        { id: "invalid-blocked", from: "select", fromOutput: "INVALID", to: "blocked" },
      ],
    });

    try {
      await writeFile(path, JSON.stringify({ tasks: [{ id: "task-1", status: "planned" }] }), "utf8");
      const deferFlow = createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          selectBlock,
          {
            id: "defer",
            type: "UTILITY",
            title: "Defer",
            utility: {
              type: "MARK_JSON_TASK",
              path: "tasks.json",
              status: "deferred",
              enforce: true,
              delaySeconds: 60,
            },
          },
          { id: "success", type: "END", title: "Success", status: "success" },
        ],
        edges: [
          { id: "start-select", from: "start", fromOutput: "SUCCESS", to: "select" },
          { id: "select-defer", from: "select", fromOutput: "SELECTED", to: "defer" },
          { id: "defer-success", from: "defer", fromOutput: "SUCCESS", to: "success" },
        ],
      });
      const deferred = await runRalphFlow(
        deferFlow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "defer-owner" },
      );
      const deferredJson = JSON.parse(await readFile(path, "utf8")) as {
        tasks: Array<{ status: string; nextEligibleAt?: string }>;
      };
      expect(deferred.status).toBe("completed");
      expect(deferredJson.tasks[0]).toMatchObject({
        status: "deferred",
        nextEligibleAt: expect.any(String),
      });

      const before = await runRalphFlow(
        selectionFlow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "defer-before" },
      );
      expect(before.blockResults.find((entry) => entry.blockId === "select"))
        .toMatchObject({ output: "INVALID" });

      const eligibleJson = JSON.parse(await readFile(path, "utf8")) as {
        tasks: Array<Record<string, unknown>>;
      };
      eligibleJson.tasks[0]!.nextEligibleAt = new Date(Date.now() - 1_000).toISOString();
      await writeFile(path, JSON.stringify(eligibleJson), "utf8");
      const after = await runRalphFlow(
        selectionFlow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "defer-after" },
      );
      const stored = JSON.parse(await readFile(path, "utf8")) as {
        tasks: Array<Record<string, unknown>>;
      };

      expect(after.status).toBe("completed");
      expect(after.blockResults.find((entry) => entry.blockId === "select"))
        .toMatchObject({ output: "SELECTED" });
      expect(stored.tasks[0]).not.toHaveProperty("nextEligibleAt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports structured blockers for missing, cyclic, and deferred JSON task dependencies", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-task-blockers-"));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "select",
          type: "UTILITY",
          title: "Select",
          utility: { type: "SELECT_JSON_TASK", path: "tasks.json" },
        },
        { id: "blocked", type: "END", title: "Blocked", status: "failed" },
      ],
      edges: [
        { id: "start-select", from: "start", fromOutput: "SUCCESS", to: "select" },
        { id: "select-blocked", from: "select", fromOutput: "INVALID", to: "blocked" },
      ],
    });

    try {
      await writeFile(join(workspace, "tasks.json"), JSON.stringify({ tasks: [
        { id: "missing", status: "planned", dependencies: ["absent"] },
        { id: "cycle-a", status: "planned", dependencies: ["cycle-b"] },
        { id: "cycle-b", status: "planned", dependencies: ["cycle-a"] },
        { id: "deferred", status: "deferred", nextEligibleAt: "2099-01-01T00:00:00.000Z" },
        { id: "waits", status: "planned", dependencies: ["deferred"] },
      ] }), "utf8");

      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "dependency-blockers" },
      );
      const selection = result.blockResults.find((entry) => entry.blockId === "select");

      expect(selection).toMatchObject({
        output: "INVALID",
        data: expect.objectContaining({
          blockers: expect.arrayContaining([
            expect.objectContaining({ taskId: "missing", missingDependencyIds: ["absent"] }),
            expect.objectContaining({ taskId: "waits", deferredDependencyIds: ["deferred"] }),
          ]),
          dependencyCycles: expect.arrayContaining([
            expect.arrayContaining(["cycle-a", "cycle-b"]),
          ]),
        }),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("selects random-seeded JSON tasks deterministically for the same run", async () => {
    const firstWorkspace = await mkdtemp(join(tmpdir(), "ralph-seeded-first-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "ralph-seeded-second-"));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "select",
          type: "UTILITY",
          title: "Select",
          utility: {
            type: "SELECT_JSON_TASK",
            path: "tasks.json",
            strategy: "random-seeded",
          },
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-select", from: "start", fromOutput: "SUCCESS", to: "select" },
        { id: "select-success", from: "select", fromOutput: "SELECTED", to: "success" },
      ],
    });
    const tasks = { tasks: [
      { id: "alpha", status: "planned" },
      { id: "beta", status: "planned" },
      { id: "gamma", status: "planned" },
    ] };

    try {
      await Promise.all([
        writeFile(join(firstWorkspace, "tasks.json"), JSON.stringify(tasks), "utf8"),
        writeFile(join(secondWorkspace, "tasks.json"), JSON.stringify(tasks), "utf8"),
      ]);
      const [first, second] = await Promise.all([
        runRalphFlow(
          flow,
          { ...runtimeConfig, workspaceRoot: firstWorkspace },
          customizations,
          { runId: "stable-seed" },
        ),
        runRalphFlow(
          flow,
          { ...runtimeConfig, workspaceRoot: secondWorkspace },
          customizations,
          { runId: "stable-seed" },
        ),
      ]);
      const selectedId = (result: typeof first): unknown => {
        const data = result.blockResults.find((entry) => entry.blockId === "select")?.data;
        return typeof data === "object" && data !== null && "task" in data &&
          typeof data.task === "object" && data.task !== null && "id" in data.task
          ? data.task.id
          : undefined;
      };

      expect(selectedId(first)).toEqual(selectedId(second));
      expect(selectedId(first)).toEqual(expect.any(String));
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });

  it("heartbeats claimed JSON task leases while a long block is running", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-task-heartbeat-"));
    const path = join(workspace, "tasks.json");
    const selectionBlocks = [
      { id: "start", type: "START" as const, title: "Start" },
      {
        id: "select",
        type: "UTILITY" as const,
        title: "Select",
        utility: { type: "SELECT_JSON_TASK" as const, path: "tasks.json" },
      },
      { id: "blocked", type: "END" as const, title: "Blocked", status: "failed" as const },
    ];
    const rivalFlow = createFlow({
      blocks: selectionBlocks,
      edges: [
        { id: "start-select", from: "start", fromOutput: "SUCCESS", to: "select" },
        { id: "select-blocked", from: "select", fromOutput: "INVALID", to: "blocked" },
      ],
    });
    const ownerFlow = createFlow({
      blocks: [
        selectionBlocks[0]!,
        selectionBlocks[1]!,
        { id: "work", type: "PROMPT", title: "Work", prompt: "Work for a while." },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-select", from: "start", fromOutput: "SUCCESS", to: "select" },
        { id: "select-work", from: "select", fromOutput: "SELECTED", to: "work" },
        { id: "work-success", from: "work", fromOutput: "SUCCESS", to: "success" },
      ],
    });
    let rivalResult: Awaited<ReturnType<typeof runRalphFlow>> | undefined;

    try {
      await writeFile(path, JSON.stringify({ tasks: [{ id: "task-1", status: "planned" }] }), "utf8");
      vi.mocked(executeTask).mockImplementationOnce(async () => {
        const json = JSON.parse(await readFile(path, "utf8")) as {
          tasks: Array<{ lease: { heartbeatAt: string; expiresAt: string } }>;
        };
        json.tasks[0]!.lease.heartbeatAt = new Date().toISOString();
        json.tasks[0]!.lease.expiresAt = new Date(Date.now() + 100).toISOString();
        await writeFile(path, JSON.stringify(json), "utf8");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
        rivalResult = await runRalphFlow(
          rivalFlow,
          { ...runtimeConfig, workspaceRoot: workspace },
          customizations,
          { runId: "rival-run", leaseDurationMs: 750 },
        );
        return createExecutionResult({ summary: "Work complete." });
      });

      const ownerResult = await runRalphFlow(
        ownerFlow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "owner-run", leaseDurationMs: 750 },
      );
      const stored = JSON.parse(await readFile(path, "utf8")) as {
        tasks: Array<{ lease: { ownerId: string; expiresAt: string } }>;
      };

      expect(ownerResult.status).toBe("completed");
      expect(rivalResult?.blockResults.find((entry) => entry.blockId === "select")?.output)
        .not.toBe("SELECTED");
      expect(stored.tasks[0]?.lease.ownerId).toBe("owner-run");
      expect(Date.parse(stored.tasks[0]!.lease.expiresAt)).toBeGreaterThan(Date.now());
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not replay a pending non-idempotent HTTP request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const operationId = "pending-post";
    const checkpoint: RalphRunCheckpoint = {
      currentBlockId: "post",
      transitions: 1,
      variables: {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
      attemptCounts: { post: 1 },
      operationLedger: {
        [operationId]: {
          id: operationId,
          blockId: "post",
          attempt: 1,
          state: "started",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "post",
          type: "UTILITY",
          title: "Post",
          utility: {
            type: "HTTP_FETCH",
            url: "https://example.test/mutate",
            method: "POST",
            body: "{}",
          },
        },
        { id: "handled", type: "END", title: "Handled", status: "success" },
      ],
      edges: [
        { id: "start-post", from: "start", fromOutput: "SUCCESS", to: "post" },
        { id: "post-error", from: "post", fromOutput: "ERROR", to: "handled" },
      ],
    });

    const result = await runRalphFlow(flow, runtimeConfig, customizations, {
      checkpoint,
      runId: "pending-post-run",
    });

    expect(result.status).toBe("completed");
    expect(result.blockResults.find((entry) => entry.blockId === "post"))
      .toMatchObject({
        operationId,
        output: "ERROR",
        data: expect.objectContaining({ reconciliation: "indeterminate" }),
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a long block when its heartbeat can no longer prove ownership", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-heartbeat-failure-"));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "work", type: "PROMPT", title: "Work", prompt: "Keep working." },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-work", from: "start", fromOutput: "SUCCESS", to: "work" },
        { id: "work-success", from: "work", fromOutput: "SUCCESS", to: "success" },
      ],
    });

    try {
      const logger = await createRalphRunLogger(workspace, flow, {
        runId: "heartbeat-failure",
      });
      const paths = logger.paths;
      if (!paths) {
        throw new Error("Expected logger paths.");
      }
      let abortObserved = false;
      vi.mocked(executeTask).mockImplementationOnce(async (_task, _config, _customizations, executionOptions) => {
        await rm(paths.recordPath, { force: true });
        await mkdir(paths.recordPath);
        const signal = executionOptions?.signal;
        if (!signal) {
          throw new Error("Expected block abort signal.");
        }
        await new Promise<void>((resolveAbort, rejectAbort) => {
          const timeout = setTimeout(
            () => rejectAbort(new Error("Heartbeat did not abort the block.")),
            3_000,
          );
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            abortObserved = true;
            resolveAbort();
          }, { once: true });
        });
        return createExecutionResult({ summary: "Aborted work." });
      });

      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { logger, runId: logger.runId, leaseDurationMs: 1_000 },
      );

      expect(abortObserved).toBe(true);
      expect(result.status).toBe("crashed");
      expect(result.summary).toContain("ownership lost");
      expect(result.checkpoint).toBeUndefined();
      expect(result.blockResults.some((entry) => entry.blockId === "work")).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 10_000);

  it("writes a generic run-scoped fallback when no branch report executes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-report-fallback-"));
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "stopped", type: "END", title: "Stopped", status: "cancelled" },
        {
          id: "normal-report",
          type: "UTILITY",
          title: "Normal report",
          utility: { type: "FINAL_REPORT", path: "{{data:normal:path}}" },
        },
        {
          id: "retained-report",
          type: "UTILITY",
          title: "Retained report",
          utility: { type: "FINAL_REPORT", path: "{{data:retained:path}}" },
        },
      ],
      edges: [
        { id: "start-stopped", from: "start", fromOutput: "SUCCESS", to: "stopped" },
      ],
    });

    try {
      const result = await runRalphFlow(
        flow,
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        { runId: "fallback-report-run" },
      );
      const fallbackPath = join(
        workspace,
        ".machdoch",
        "ralph",
        "runs",
        "fallback-report-run",
        "final-report.json",
      );
      const report = JSON.parse(await readFile(fallbackPath, "utf8")) as {
        outcome: { status: string };
        fallback: { reason: string };
      };

      expect(result.status).toBe("stopped");
      expect(report.outcome.status).toBe("stopped");
      expect(report.fallback.reason).toContain("No branch-specific");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});


