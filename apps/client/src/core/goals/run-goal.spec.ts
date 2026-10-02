import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import {
  observeAgentModelCall,
  recordExternalAgentModelCall,
  runWithTaskModelUsageRecording,
} from "../model-usage.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  TaskExecutionOptions,
  TaskExecutionResult,
  TaskModelUsageReport,
} from "../types.js";
import { executeWithSessionGoal } from "./goal-execution.js";
import { getGoalPath, readGoalRecord } from "./goal-store.js";
import type { GoalTurnExecutor } from "./run-goal.js";
import * as goalEvaluation from "./goal-evaluation.js";

let directory: string;
let config: RuntimeConfig;
let options: TaskExecutionOptions;

const result = (evaluating = false): TaskExecutionResult => ({
  task: "goal work",
  mode: "machdoch",
  status: "executed",
  summary: "Tests passed.",
  executedTools: ["shell"],
  outputSections: [],
  ...(evaluating
    ? { control: { kind: "goal-evaluation", decision: "complete" } }
    : {}),
});

const recordUsage = (usage: { totalTokens?: number; inputTokens?: number }) =>
  recordExternalAgentModelCall({
    stage: "external-agent",
    provider: "codex-cli",
    model: "gpt-5.5",
    operation: "goal-test",
    status: "completed",
    durationMs: 1,
    responseBytes: 1,
    usage,
  });

const run = (task: string, execute: GoalTurnExecutor) =>
  executeWithSessionGoal(task, config, options, execute);

const read = () =>
  readGoalRecord(
    getGoalPath(directory, options.conversationContext!.sessionId!),
  );

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "machdoch-goal-run-test-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", directory);
  config = { ...(await loadRuntimeConfig(directory)), provider: "openai" };
  options = { conversationContext: { sessionId: randomUUID(), history: [] } };
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("goal run budgets", () => {
  it("checkpoints elapsed time and observed usage before the worker finishes", async () => {
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol) return result(true);
        const startedAt = Date.now();
        for (const turn of [1, 2]) {
          recordUsage({ totalTokens: 20 });
          vi.spyOn(Date, "now").mockReturnValue(startedAt + turn * 5_001);
          await vi.waitFor(
            async () => {
              const savedGoal = (await read()).goal!;
              expect(savedGoal).toMatchObject({
                status: "active",
                turns: 1,
                tokensUsed: turn * 20,
              });
              expect(savedGoal.elapsedMs).toBeGreaterThanOrEqual(turn * 5_001);
            },
            { timeout: 3_000 },
          );
        }
        return result();
      },
    );
    await runWithTaskModelUsageRecording(() => {
      recordUsage({ totalTokens: 100 });
      return run("/goal Verify auth", execute);
    });
    expect((await read()).goal).toMatchObject({
      status: "complete",
      tokensUsed: 40,
    });
  });

  it.each(["work", "evaluation"])(
    "stops when the deadline expires during %s without a polling tick",
    async (phase) => {
      const execute = vi.fn<GoalTurnExecutor>(
        async (_task, _config, turnOptions) => {
          const currentPhase = turnOptions.resultProtocol
            ? "evaluation"
            : "work";
          if (currentPhase === phase) {
            vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
          }
          return result(Boolean(turnOptions.resultProtocol));
        },
      );
      const completed = await run("/goal --minutes 1 Verify auth", execute);
      expect(completed.status).toBe("blocked");
      expect((await read()).goal).toMatchObject({
        status: "budget-limited",
        turns: 1,
        reason: "Time limit reached.",
      });
      expect(execute).toHaveBeenCalledTimes(phase === "work" ? 1 : 2);
    },
  );

  it("enforces the token limit when verification returns without progress events", async () => {
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        recordUsage({ totalTokens: 20 });
        return result(Boolean(turnOptions.resultProtocol));
      },
    );
    const completed = await runWithTaskModelUsageRecording(() =>
      run("/goal --tokens 40 Verify auth", execute),
    );
    expect(completed.status).toBe("blocked");
    expect((await read()).goal).toMatchObject({
      status: "budget-limited",
      tokensUsed: 40,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("preserves usage for model calls emitting progress while in flight", async () => {
    const execute = vi.fn<GoalTurnExecutor>(
      async (task, turnConfig, turnOptions) => {
        await observeAgentModelCall(
          {
            stage: turnOptions.resultProtocol ? "validator" : "executor",
            provider: "openai",
            model: "gpt-5.5",
            operation: "goal-stream-test",
          },
          async () => {
            await turnOptions.onStateChange?.({
              task,
              mode: turnConfig.mode,
              state: "executing",
              message: "Working.",
              cancellable: true,
              executedTools: [],
              outputSections: [],
            });
            return { text: "done", toolCalls: [], usage: { totalTokens: 20 } };
          },
        );
        return result(Boolean(turnOptions.resultProtocol));
      },
    );
    const completed = await runWithTaskModelUsageRecording(() =>
      run("/goal --tokens 100 Verify auth", execute),
    );
    expect((await read()).goal).toMatchObject({
      status: "complete",
      tokensUsed: 40,
    });
    const report = completed.metadata?.modelUsage as TaskModelUsageReport;
    expect(report.totals).toMatchObject({
      callCount: 2,
      failedCallCount: 0,
      usageUnavailableCallCount: 0,
      totalTokens: 40,
    });
  });

  it("pauses a token-limited goal when only partial usage is reported", async () => {
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        recordUsage({ inputTokens: 20 });
        return result(Boolean(turnOptions.resultProtocol));
      },
    );
    await runWithTaskModelUsageRecording(() =>
      run("/goal --tokens 100 Verify auth", execute),
    );
    expect((await read()).goal?.status).toBe("paused");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("goal run cancellation", () => {
  it("releases the runner when an evaluator never settles and permits resume", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let evaluationStarted!: () => void;
    const evaluating = new Promise<void>((resolve) => {
      evaluationStarted = resolve;
    });
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        if (!turnOptions.resultProtocol) return result();
        evaluationStarted();
        return new Promise<TaskExecutionResult>(() => {});
      },
    );
    const pending = run("/goal Verify auth", execute);
    await evaluating;
    await vi.advanceTimersByTimeAsync(
      goalEvaluation.GOAL_EVALUATION_TIMEOUT_MS,
    );
    expect((await pending).status).toBe("cancelled");
    expect((await read()).goal?.status).toBe("paused");
    vi.useRealTimers();
    await run("/goal resume", async (_task, _config, turnOptions) =>
      result(Boolean(turnOptions.resultProtocol)),
    );
    expect((await read()).goal).toMatchObject({ status: "complete", turns: 2 });
  });

  it.each(["deadline", "user"])(
    "settles verification after %s cancellation when the executor ignores its signal",
    async (cause) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const progress = vi.fn();
      const activity = vi.fn();
      let rejectExecutor!: (error: Error) => void;
      const execute = vi.fn<GoalTurnExecutor>(
        () =>
          new Promise((_resolve, reject) => {
            rejectExecutor = reject;
          }),
      );
      const pending = goalEvaluation.evaluateGoal(
        {
          id: "goal",
          objective: "Verify auth",
          mode: "machdoch",
          status: "active",
          turns: 1,
          elapsedMs: 0,
          tokensUsed: 0,
          reason: "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        [],
        result(),
        config,
        {
          ...options,
          signal: controller.signal,
          onStateChange: progress,
          onStreamActivity: activity,
        },
        execute,
      );
      const settled = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(0);
      if (cause === "deadline") {
        await vi.advanceTimersByTimeAsync(
          goalEvaluation.GOAL_EVALUATION_TIMEOUT_MS,
        );
        expect(await settled).toMatchObject({
          value: {
            status: "cancelled",
            summary: "Goal verification timed out. Resume to try again.",
          },
        });
      } else {
        controller.abort(new Error("Stopped by user."));
        expect(await settled).toMatchObject({
          error: new Error("Stopped by user."),
        });
      }
      const turnOptions = execute.mock.calls[0]![2];
      expect(turnOptions.signal?.aborted).toBe(true);
      expect(turnOptions.maxDurationMs).toBe(
        goalEvaluation.GOAL_EVALUATION_TIMEOUT_MS,
      );
      await turnOptions.onStateChange?.({
        task: "Late evaluator event",
        mode: config.mode,
        state: "executing",
        message: "Late evaluator event",
        executedTools: [],
        outputSections: [],
        cancellable: true,
      });
      turnOptions.onStreamActivity?.();
      expect(progress).not.toHaveBeenCalled();
      expect(activity).not.toHaveBeenCalled();
      rejectExecutor(new Error("Late evaluator failure."));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("pauses when verification times out and releases the runner for resume", async () => {
    vi.spyOn(goalEvaluation, "evaluateGoal").mockResolvedValueOnce({
      ...result(),
      status: "cancelled",
      summary: "Goal verification timed out. Resume to try again.",
    });
    expect((await run("/goal Verify auth", async () => result())).status).toBe(
      "cancelled",
    );
    expect((await read()).goal).toMatchObject({
      status: "paused",
      reason:
        "Goal verification failed: Goal verification timed out. Resume to try again.",
    });
    await run("/goal resume", async (_task, _config, turnOptions) =>
      result(Boolean(turnOptions.resultProtocol)),
    );
    expect((await read()).goal?.status).toBe("complete");
  });

  it("aborts verification at its deadline even when the provider keeps emitting activity", async () => {
    vi.useFakeTimers();
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        const activity = setInterval(
          () => turnOptions.onStreamActivity?.(),
          1_000,
        );
        try {
          await new Promise<void>((resolve) => {
            turnOptions.signal!.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          turnOptions.signal!.throwIfAborted();
          return result(true);
        } finally {
          clearInterval(activity);
        }
      },
    );
    const pending = goalEvaluation.evaluateGoal(
      {
        id: "goal",
        objective: "Verify auth",
        mode: "machdoch",
        status: "active",
        turns: 1,
        elapsedMs: 0,
        tokensUsed: 0,
        reason: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      [],
      result(),
      config,
      { ...options, onStreamActivity: vi.fn() },
      execute,
    );
    await vi.advanceTimersByTimeAsync(
      goalEvaluation.GOAL_EVALUATION_TIMEOUT_MS,
    );
    expect(await pending).toMatchObject({
      status: "cancelled",
      summary: "Goal verification timed out. Resume to try again.",
    });
    expect(execute.mock.calls[0]![2].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps evaluator output out of the worker's response and progress", async () => {
    const onActionOutput = vi.fn();
    const progress = vi.fn();
    options.onActionOutput = onActionOutput;
    options.onStateChange = progress;
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, turnConfig, turnOptions) => {
        if (turnOptions.resultProtocol) {
          expect(turnOptions.onActionOutput).toBeUndefined();
          await turnOptions.onStateChange?.({
            task: "Private evaluation prompt",
            mode: turnConfig.mode,
            state: "completed",
            message: "Private evaluation answer",
            assistantText: "Private evaluation answer",
            cancellable: false,
            executedTools: [],
            outputSections: [],
          });
        }
        return result(Boolean(turnOptions.resultProtocol));
      },
    );
    await run("/goal Verify auth", execute);
    expect(JSON.stringify(progress.mock.calls)).not.toContain(
      "Private evaluation",
    );
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      state: "completed",
      cancellable: false,
    });
  });

  it.each(["user", "time", "tokens"])(
    "records %s cancellation when the provider throws",
    async (cause) => {
      const controller = new AbortController();
      options.signal = controller.signal;
      const execute = vi.fn<GoalTurnExecutor>(
        async (task, turnConfig, turnOptions) => {
          if (cause === "user") controller.abort("Stopped by user.");
          if (cause === "time") {
            vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
          }
          if (cause === "tokens") recordUsage({ totalTokens: 100 });
          await turnOptions.onStateChange?.({
            task,
            mode: turnConfig.mode,
            state: "executing",
            message: "Working.",
            cancellable: true,
            executedTools: [],
            outputSections: [],
          });
          turnOptions.signal?.throwIfAborted();
          throw new Error("Provider did not receive cancellation.");
        },
      );
      const command = cause === "tokens" ? "--tokens 100" : "--minutes 1";
      const completed = await runWithTaskModelUsageRecording(() =>
        run(`/goal ${command} Verify auth`, execute),
      );
      expect(completed.status).toBe(cause === "user" ? "cancelled" : "blocked");
      expect((await read()).goal).toMatchObject({
        status: cause === "user" ? "paused" : "budget-limited",
        turns: 1,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("records a started turn and preserves unexpected provider errors", async () => {
    const execute = vi.fn<GoalTurnExecutor>(async () => {
      throw new Error("Connection failed.");
    });
    await expect(run("/goal Verify auth", execute)).rejects.toThrow(
      "Connection failed.",
    );
    expect((await read()).goal).toMatchObject({
      status: "paused",
      turns: 1,
      reason: "Connection failed.",
    });
  });
});
