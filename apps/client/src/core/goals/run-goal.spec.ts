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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("goal run budgets", () => {
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
