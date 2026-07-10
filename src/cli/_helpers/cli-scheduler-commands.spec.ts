import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import type { ScheduledTaskExecutionRequest } from "../../core/scheduler.ts";

const mocks = vi.hoisted(() => ({
  createRalphRunLogger: vi.fn(),
  createRalphFlowFingerprint: vi.fn(() => "flow-fingerprint"),
  discoverCustomizations: vi.fn(),
  loadRuntimeConfig: vi.fn(),
  readRalphFlow: vi.fn(),
  readRalphRunRecord: vi.fn(),
  runRalphFlow: vi.fn(),
  writeRalphRunRecord: vi.fn(),
}));

vi.mock("../../core/config.js", () => ({
  loadRuntimeConfig: mocks.loadRuntimeConfig,
}));

vi.mock("../../core/customizations.js", () => ({
  discoverCustomizations: mocks.discoverCustomizations,
}));

vi.mock("../../core/ralph.js", () => ({
  createRalphFlowFingerprint: mocks.createRalphFlowFingerprint,
  createRalphRunLogger: mocks.createRalphRunLogger,
  readRalphFlow: mocks.readRalphFlow,
  readRalphRunRecord: mocks.readRalphRunRecord,
  runRalphFlow: mocks.runRalphFlow,
  writeRalphRunRecord: mocks.writeRalphRunRecord,
}));

import {
  createSchedulerExecutor,
  readSchedulerPromptFile,
} from "./cli-scheduler-commands.ts";

const createWorkspaceFixture = async (): Promise<{
  root: string;
  workspaceRoot: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-scheduler-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);

  return { root, workspaceRoot };
};

describe("readSchedulerPromptFile", () => {
  it("reads prompt files inside the workspace", async () => {
    const { root, workspaceRoot } = await createWorkspaceFixture();

    try {
      await writeFile(join(workspaceRoot, "prompt.txt"), "  Inspect logs.  \n");

      await expect(
        readSchedulerPromptFile(workspaceRoot, "prompt.txt"),
      ).resolves.toBe("Inspect logs.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute prompt files outside the workspace", async () => {
    const { root, workspaceRoot } = await createWorkspaceFixture();

    try {
      const outsidePrompt = join(root, "secret.txt");
      await writeFile(outsidePrompt, "private prompt");

      await expect(
        readSchedulerPromptFile(workspaceRoot, outsidePrompt),
      ).rejects.toThrow(/outside the workspace/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal prompt files outside the workspace", async () => {
    const { root, workspaceRoot } = await createWorkspaceFixture();

    try {
      await writeFile(join(root, "secret.txt"), "private prompt");

      await expect(
        readSchedulerPromptFile(workspaceRoot, join("..", "secret.txt")),
      ).rejects.toThrow(/outside the workspace/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const createRequest = (
  workspaceRoot: string,
  options: {
    attempt: number;
    parentRunId?: string;
    previousStatus?: "failed" | "timed_out";
  },
): ScheduledTaskExecutionRequest => {
  return {
    targetType: "ralph-flow",
    task: "Run Ralph flow.",
    workspaceRoot,
    contextPaths: [],
    imagePaths: [],
    ralphFlow: {
      id: "autonomous-improvement",
      scope: "workspace",
      params: {},
      executionProfile: "unattended",
      resumePolicy: "recoverable",
      permissions: {
        allowedRoots: [workspaceRoot],
        allowCommands: true,
        allowWrites: true,
        allowNetwork: true,
        allowMcpTools: true,
      },
    },
    job: {
      id: "job-1",
      name: "Autonomous improvements",
    },
    run: {
      id: "run-1",
      attempt: options.attempt,
      attemptHistory:
        options.attempt > 1
          ? [
              {
                attempt: options.attempt - 1,
                startedAt: 1,
                finishedAt: 2,
                status: options.previousStatus ?? "failed",
              },
            ]
          : [],
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    },
  } as unknown as ScheduledTaskExecutionRequest;
};

describe("createSchedulerExecutor scheduled RALPH recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRuntimeConfig.mockResolvedValue({
      compatibility: { discoverGithubCustomizations: false },
      mode: "machdoch",
      provider: "openai",
      model: "gpt-test",
    });
    mocks.discoverCustomizations.mockResolvedValue({});
    mocks.readRalphFlow.mockResolvedValue({
      schemaVersion: 1,
      id: "autonomous-improvement",
      name: "Autonomous improvement",
      variables: [
        { name: "goal", type: "string", required: false },
      ],
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "done", type: "END", title: "Done", status: "success" },
      ],
      edges: [
        {
          id: "start-done",
          from: "start",
          fromOutput: "SUCCESS",
          to: "done",
        },
      ],
    });
  });

  it("fails loudly instead of replaying a corrupt durable run record", async () => {
    const workspaceRoot = resolve("C:/workspace");
    const runId = "scheduled-run-1-autonomous-improvement";
    mocks.readRalphRunRecord.mockRejectedValue(
      new Error(`Ralph run \`${runId}\` is not a valid run record.`),
    );

    await expect(
      createSchedulerExecutor().execute(
        createRequest(workspaceRoot, { attempt: 2 }),
        {},
      ),
    ).rejects.toThrow("Refusing to restart scheduled Ralph run");
    expect(mocks.createRalphRunLogger).not.toHaveBeenCalled();
    expect(mocks.runRalphFlow).not.toHaveBeenCalled();
    expect(mocks.loadRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.discoverCustomizations).not.toHaveBeenCalled();
  });

  it("refuses a durable recovery record with mismatched identity", async () => {
    const workspaceRoot = resolve("C:/workspace");
    const runId = "scheduled-run-1-autonomous-improvement";
    mocks.readRalphRunRecord.mockResolvedValue({
      path: resolve(`C:/workspace/.machdoch/ralph/runs/${runId}/run.json`),
      record: {
        id: "scheduled-different-run-autonomous-improvement",
        flowId: "different-flow",
        status: "completed",
      },
    });

    await expect(
      createSchedulerExecutor().execute(
        createRequest(workspaceRoot, { attempt: 2 }),
        {},
      ),
    ).rejects.toThrow("Ralph recovery record identity mismatch");
    expect(mocks.createRalphRunLogger).not.toHaveBeenCalled();
    expect(mocks.runRalphFlow).not.toHaveBeenCalled();
  });

  it("resumes a recoverable checkpoint on an automatic scheduler retry", async () => {
    const workspaceRoot = resolve("C:/workspace");
    const runId = "scheduled-run-1-autonomous-improvement";
    const checkpoint = {
      currentBlockId: "implement",
      transitions: 4,
      variables: { goal: "Improve recovery" },
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
    };
    const paths = {
      id: runId,
      directory: resolve(`C:/workspace/.machdoch/ralph/runs/${runId}`),
      recordPath: resolve(`C:/workspace/.machdoch/ralph/runs/${runId}/run.json`),
      simpleJsonlPath: resolve(
        `C:/workspace/.machdoch/ralph/runs/${runId}/simple.jsonl`,
      ),
      simpleMarkdownPath: resolve(
        `C:/workspace/.machdoch/ralph/runs/${runId}/simple.md`,
      ),
      traceJsonlPath: resolve(
        `C:/workspace/.machdoch/ralph/runs/${runId}/trace.jsonl`,
      ),
    };
    const record = {
      id: runId,
      flowId: "autonomous-improvement",
      flowName: "Autonomous improvement",
      status: "blocked",
      variableValues: checkpoint.variables,
      checkpoint,
      logPaths: paths,
    };
    const logger = {
      runId,
      paths,
      simple: vi.fn(),
      trace: vi.fn(),
      flush: vi.fn(),
    };
    const runResult = {
      runId,
      flow: "autonomous-improvement",
      status: "completed",
      summary: "Recovered and completed.",
      events: [],
      blockResults: [],
      missingVariables: [],
      unknownVariables: [],
      validation: { valid: true, errors: [], warnings: [] },
    };
    mocks.readRalphRunRecord.mockResolvedValue({
      path: paths.recordPath,
      record,
    });
    mocks.createRalphRunLogger.mockResolvedValue(logger);
    mocks.runRalphFlow.mockResolvedValue(runResult);
    mocks.writeRalphRunRecord.mockResolvedValue({});

    const result = await createSchedulerExecutor().execute(
      createRequest(workspaceRoot, { attempt: 2 }),
      {},
    );

    expect(mocks.readRalphRunRecord).toHaveBeenCalledWith(
      workspaceRoot,
      runId,
      { scope: "workspace" },
    );
    expect(mocks.createRalphRunLogger).toHaveBeenCalledWith(
      workspaceRoot,
      expect.objectContaining({ id: "autonomous-improvement" }),
      expect.objectContaining({
        append: true,
        paths,
        runId,
        variableValues: checkpoint.variables,
      }),
    );
    expect(mocks.runRalphFlow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "autonomous-improvement" }),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ autonomy: true, checkpoint, runId }),
    );
    expect(result.status).toBe("executed");
    expect(result.metadata).toMatchObject({
      ralphFlow: {
        schedulerAttempt: 2,
        resumedFromCheckpoint: true,
        resumedFromRunId: runId,
      },
    });
  });

  it("reconciles a completed durable run on an automatic scheduler retry", async () => {
    const workspaceRoot = resolve("C:/workspace");
    const runId = "scheduled-run-1-autonomous-improvement";
    mocks.readRalphRunRecord.mockResolvedValue({
      path: resolve(`C:/workspace/.machdoch/ralph/runs/${runId}/run.json`),
      record: {
        schemaVersion: 1,
        id: runId,
        createdAt: "2026-07-10T10:00:00.000Z",
        finishedAt: "2026-07-10T10:01:00.000Z",
        flowId: "autonomous-improvement",
        flowName: "Autonomous improvement",
        status: "completed",
        summary: "The durable run already completed.",
        variableValues: {},
        events: [],
        blockResults: [],
        validation: { valid: true, errors: [], warnings: [] },
      },
    });

    const result = await createSchedulerExecutor().execute(
      createRequest(workspaceRoot, { attempt: 2 }),
      {},
    );

    expect(mocks.createRalphRunLogger).not.toHaveBeenCalled();
    expect(mocks.runRalphFlow).not.toHaveBeenCalled();
    expect(mocks.loadRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.discoverCustomizations).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "executed",
      summary: "The durable run already completed.",
      metadata: {
        ralphFlow: {
          schedulerAttempt: 2,
          resumedFromCheckpoint: false,
          reconciledDurableRun: true,
          reconciledFromRunId: runId,
        },
      },
    });
  });

  it("resumes a stopped checkpoint after a timed-out scheduler attempt", async () => {
    const workspaceRoot = resolve("C:/workspace");
    const runId = "scheduled-run-1-autonomous-improvement";
    const directory = resolve(
      `C:/workspace/.machdoch/ralph/runs/${runId}`,
    );
    const checkpoint = {
      currentBlockId: "verify",
      transitions: 9,
      variables: { goal: "Finish after timeout" },
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
    };
    mocks.readRalphRunRecord.mockResolvedValue({
      path: resolve(`${directory}/run.json`),
      record: {
        schemaVersion: 1,
        id: runId,
        createdAt: "2026-07-10T10:00:00.000Z",
        finishedAt: "2026-07-10T10:01:00.000Z",
        flowId: "autonomous-improvement",
        flowName: "Autonomous improvement",
        status: "stopped",
        summary: "The durable run was stopped.",
        variableValues: checkpoint.variables,
        events: [],
        blockResults: [],
        checkpoint,
        validation: { valid: true, errors: [], warnings: [] },
      },
    });
    mocks.createRalphRunLogger.mockResolvedValue({
      runId,
      simple: vi.fn(),
      trace: vi.fn(),
      flush: vi.fn(),
    });
    mocks.runRalphFlow.mockResolvedValue({
      runId,
      flow: "autonomous-improvement",
      status: "completed",
      summary: "Resumed after the timeout.",
      events: [],
      blockResults: [],
      missingVariables: [],
      unknownVariables: [],
      validation: { valid: true, errors: [], warnings: [] },
    });

    const result = await createSchedulerExecutor().execute(
      createRequest(workspaceRoot, {
        attempt: 2,
        previousStatus: "timed_out",
      }),
      {},
    );

    expect(mocks.createRalphRunLogger).toHaveBeenCalledWith(
      workspaceRoot,
      expect.anything(),
      expect.objectContaining({
        append: true,
        runId,
        variableValues: checkpoint.variables,
      }),
    );
    expect(mocks.runRalphFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ checkpoint, runId }),
    );
    expect(result).toMatchObject({
      status: "executed",
      metadata: {
        ralphFlow: {
          resumedFromCheckpoint: true,
          resumedFromRunId: runId,
          reconciledDurableRun: false,
        },
      },
    });
  });

  it("uses the parent scheduler run checkpoint for a manual retry", async () => {
    const workspaceRoot = resolve("C:/workspace");
    const parentRalphRunId = "scheduled-parent-run-autonomous-improvement";
    const checkpoint = {
      currentBlockId: "verify",
      transitions: 8,
      variables: {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
    };
    const directory = resolve(
      `C:/workspace/.machdoch/ralph/runs/${parentRalphRunId}`,
    );
    mocks.readRalphRunRecord.mockResolvedValue({
      path: resolve(`${directory}/run.json`),
      record: {
        id: parentRalphRunId,
        flowId: "autonomous-improvement",
        status: "crashed",
        variableValues: {},
        checkpoint,
      },
    });
    mocks.createRalphRunLogger.mockResolvedValue({
      runId: parentRalphRunId,
      simple: vi.fn(),
      trace: vi.fn(),
      flush: vi.fn(),
    });
    mocks.runRalphFlow.mockResolvedValue({
      runId: parentRalphRunId,
      flow: "autonomous-improvement",
      status: "completed",
      summary: "Recovered and completed.",
      events: [],
      blockResults: [],
      missingVariables: [],
      unknownVariables: [],
      validation: { valid: true, errors: [], warnings: [] },
    });
    mocks.writeRalphRunRecord.mockResolvedValue({});

    await createSchedulerExecutor().execute(
      createRequest(workspaceRoot, {
        attempt: 1,
        parentRunId: "parent-run",
      }),
      {},
    );

    expect(mocks.readRalphRunRecord).toHaveBeenCalledWith(
      workspaceRoot,
      parentRalphRunId,
      { scope: "workspace" },
    );
    expect(mocks.runRalphFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ checkpoint }),
    );
  });

  it("starts a new run when a manual retry has a terminal parent", async () => {
    const workspaceRoot = resolve("C:/workspace");
    const parentRalphRunId = "scheduled-parent-run-autonomous-improvement";
    const childRalphRunId = "scheduled-run-1-autonomous-improvement";
    mocks.readRalphRunRecord.mockResolvedValue({
      path: resolve(
        `C:/workspace/.machdoch/ralph/runs/${parentRalphRunId}/run.json`,
      ),
      record: {
        schemaVersion: 1,
        id: parentRalphRunId,
        createdAt: "2026-07-10T10:00:00.000Z",
        finishedAt: "2026-07-10T10:01:00.000Z",
        flowId: "autonomous-improvement",
        flowName: "Autonomous improvement",
        status: "completed",
        summary: "The parent run completed.",
        variableValues: {},
        events: [],
        blockResults: [],
        validation: { valid: true, errors: [], warnings: [] },
      },
    });
    mocks.createRalphRunLogger.mockResolvedValue({
      runId: childRalphRunId,
      simple: vi.fn(),
      trace: vi.fn(),
      flush: vi.fn(),
    });
    mocks.runRalphFlow.mockResolvedValue({
      runId: childRalphRunId,
      flow: "autonomous-improvement",
      status: "completed",
      summary: "The intentional retry completed.",
      events: [],
      blockResults: [],
      missingVariables: [],
      unknownVariables: [],
      validation: { valid: true, errors: [], warnings: [] },
    });

    const result = await createSchedulerExecutor().execute(
      createRequest(workspaceRoot, {
        attempt: 1,
        parentRunId: "parent-run",
      }),
      {},
    );

    expect(mocks.createRalphRunLogger).toHaveBeenCalledWith(
      workspaceRoot,
      expect.anything(),
      expect.objectContaining({ runId: childRalphRunId }),
    );
    expect(mocks.runRalphFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ checkpoint: expect.anything() }),
    );
    expect(result).toMatchObject({
      status: "executed",
      metadata: {
        ralphFlow: {
          schedulerAttempt: 1,
          resumedFromCheckpoint: false,
          reconciledDurableRun: false,
          runId: childRalphRunId,
        },
      },
    });
  });
});
