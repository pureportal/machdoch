import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { TaskExecutionOptions, TaskExecutionResult } from "../types.js";
import {
  recordExternalAgentModelCall,
  runWithTaskModelUsageRecording,
} from "../model-usage.js";
import { executeWithSessionGoal } from "./goal-execution.js";
import { parseGoalCommand } from "./goal-command.js";
import { getGoalPath, readGoalRecord, updateGoalRecord } from "./goal-store.js";

let directory: string;
let config: RuntimeConfig;
let options: TaskExecutionOptions;

const result = (
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult => ({
  task: "goal work",
  mode: "machdoch",
  status: "executed",
  summary: "Tests passed.",
  executedTools: ["shell"],
  outputSections: [],
  ...overrides,
});
const evaluation = (
  decision: "complete" | "continue" | "blocked",
): TaskExecutionResult =>
  result({
    summary:
      decision === "complete"
        ? "Tests verify all requirements."
        : decision === "blocked"
          ? "A required credential is missing."
          : "Run the remaining tests.",
    control: { kind: "goal-evaluation", decision },
  });
const run = (
  task: string,
  execute = vi.fn(
    async (
      _task: string,
      _config: RuntimeConfig,
      turnOptions: TaskExecutionOptions,
    ) => (turnOptions.resultProtocol ? evaluation("complete") : result()),
  ),
) => executeWithSessionGoal(task, config, options, execute);
const read = async () =>
  readGoalRecord(
    getGoalPath(config.workspaceRoot, options.conversationContext!.sessionId!),
  );

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "machdoch-goal-test-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", directory);
  config = {
    ...(await loadRuntimeConfig(directory)),
    provider: "openai",
    model: "gpt-5.5",
    mode: "machdoch",
  };
  options = { conversationContext: { sessionId: randomUUID(), history: [] } };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("goal commands", () => {
  it("preserves quotes and multiline objectives", () => {
    expect(
      parseGoalCommand(
        '/goal --tokens 100 --turns 5 --minutes 2 Fix "auth"\nand verify tests',
      ),
    ).toEqual({
      kind: "set",
      objective: 'Fix "auth"\nand verify tests',
      tokenBudget: 100,
      turnBudget: 5,
      timeBudgetMs: 120_000,
    });
    expect(parseGoalCommand("/goals something")).toBeUndefined();
    expect(parseGoalCommand("Explain /goal")).toBeUndefined();
  });
  it.each(["clear", "pause", "resume", "mode native", "--tokens 10 Fix auth"])(
    "keeps an explicitly delimited objective literal: %s",
    (objective) => {
      expect(parseGoalCommand(`/goal -- ${objective}`)).toEqual({
        kind: "set",
        objective,
      });
      expect(parseGoalCommand(`/goal --turns 2 -- ${objective}`)).toEqual({
        kind: "set",
        objective,
        turnBudget: 2,
      });
    },
  );
  it.each([
    "/goal --tokens 0 x",
    "/goal --tokens -1 x",
    "/goal --tokens 1 --tokens 2 x",
    "/goal --minutes 999999999999999 x",
    "/goal --unknown 1 x",
    "/goal --turns 1",
    "/goal --",
    "/goal --turns 1 --",
    "/goal mode other",
    `/goal ${"x".repeat(4_001)}`,
  ])("rejects invalid command %s", (task) => {
    expect(() => parseGoalCommand(task)).toThrow();
  });
  it("reads, changes mode, pauses, and clears without a model", async () => {
    const execute = vi.fn(async () => result());
    expect((await run("/goal", execute)).summary).toBe("No goal set.");
    await run("/goal mode machdoch", execute);
    await run("/goal pause", execute);
    await run("/goal clear", execute);
    expect(execute).not.toHaveBeenCalled();
  });
  it("preserves the selected UI mode when reading or clearing an empty goal", async () => {
    config.provider = "claude-cli";
    options.conversationContext!.goalMode = "native";
    expect((await run("/goal")).metadata?.goalMode).toBe("native");
    expect((await run("/goal clear")).metadata?.goalMode).toBe("native");
    expect((await read()).mode).toBe("native");
  });
});

describe("goal lifecycle", () => {
  it("gives the evaluator observed tool failures even when the worker claims success", async () => {
    const execute = vi.fn(
      async (
        task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) => {
        if (turnOptions.resultProtocol) {
          expect(task).toContain("Two tests failed.");
          expect(task).toContain("observedToolResults");
          expect(turnOptions.captureGoalEvidence).toBe(false);
          return evaluation("continue");
        }
        expect(turnOptions.captureGoalEvidence).toBe(true);
        return result({
          summary: "All tests passed.",
          metadata: {
            goalToolEvidence: '{"exit_code":1,"output":"Two tests failed."}',
          },
        });
      },
    );
    await run("/goal --turns 1 All auth tests pass", execute);
    expect((await read()).goal?.status).toBe("budget-limited");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("continues until an independent evaluator verifies the full objective", async () => {
    let passes = 0;
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) =>
        turnOptions.resultProtocol
          ? evaluation(++passes === 2 ? "complete" : "continue")
          : result(),
    );
    const progress: string[] = [];
    options.onStateChange = (event) => {
      progress.push(event.state);
    };
    const completed = await run("/goal Fix auth and verify tests", execute);
    expect(completed.status).toBe("executed");
    expect((await read()).goal).toMatchObject({
      objective: "Fix auth and verify tests",
      status: "complete",
      turns: 2,
    });
    expect(execute).toHaveBeenCalledTimes(4);
    const validatorOptions = execute.mock.calls[1]![2];
    expect(validatorOptions).toMatchObject({
      executionRole: "validator",
      resultProtocol: { kind: "goal-evaluation" },
      conversationContext: {
        parallelAgentMode: "disabled",
        adaptiveControllerOverride: false,
      },
    });
    expect(execute.mock.calls[1]![1].mode).toBe("ask");
    expect(progress.at(-1)).toBe("completed");
    expect(progress.filter((state) => state === "completed")).toHaveLength(1);
  });
  it("honors a turn budget without marking incomplete work complete", async () => {
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) => (turnOptions.resultProtocol ? evaluation("continue") : result()),
    );
    const limited = await run("/goal --turns 2 Fix auth", execute);
    expect(limited.status).toBe("blocked");
    expect((await read()).goal).toMatchObject({
      status: "budget-limited",
      turns: 2,
    });
    await expect(run("/goal resume", execute)).rejects.toThrow("larger limit");
  });
  it("can finish exactly at the turn limit", async () => {
    await run("/goal --turns 1 Fix auth");
    expect((await read()).goal?.status).toBe("complete");
  });
  it("pauses on missing evaluation instead of guessing completion", async () => {
    const execute = vi.fn(async () => result());
    await run("/goal Fix auth", execute);
    expect((await read()).goal?.status).toBe("paused");
    await run("/goal resume");
    expect((await read()).goal).toMatchObject({ status: "complete", turns: 2 });
  });
  it("records an evaluator blocker and can resume after it is resolved", async () => {
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) => (turnOptions.resultProtocol ? evaluation("blocked") : result()),
    );
    await run("/goal Fix auth", execute);
    expect((await read()).goal).toMatchObject({
      status: "blocked",
      reason: "A required credential is missing.",
    });
    await run("/goal resume");
    expect((await read()).goal?.status).toBe("complete");
  });
  it("stops on a provider failure without retrying indefinitely", async () => {
    const execute = vi.fn(async () =>
      result({ status: "failed", reason: "Authentication failed." }),
    );
    await run("/goal Fix auth", execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await read()).goal).toMatchObject({
      status: "blocked",
      reason: "Authentication failed.",
    });
  });
  it("pauses after three turns without tool activity", async () => {
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) =>
        turnOptions.resultProtocol
          ? evaluation("continue")
          : result({ metadata: { goalToolCallCount: 0 } }),
    );
    await run("/goal Fix auth", execute);
    expect((await read()).goal).toMatchObject({ status: "paused", turns: 3 });
  });
  it("does not infer goals from ordinary messages", async () => {
    const execute = vi.fn(async () => result());
    await run("Please fix auth", execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await read()).goal).toBeNull();
  });
  it("runs ordinary messages once while a goal is paused", async () => {
    await run(
      "/goal Fix auth",
      vi.fn(async () => result()),
    );
    const execute = vi.fn(async () => result());
    await run("Explain the failure", execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await read()).goal?.status).toBe("paused");
  });
  it("keeps goals isolated between sessions", async () => {
    await run("/goal Fix auth");
    options.conversationContext!.sessionId = randomUUID();
    expect((await run("/goal")).metadata?.goal).toBeNull();
  });
  it("rejects corrupt goal storage", async () => {
    const path = getGoalPath(
      config.workspaceRoot,
      options.conversationContext!.sessionId!,
    );
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{}");
    await expect(run("/goal")).rejects.toThrow("invalid");
    const execute = vi.fn(async () => result());
    expect((await run("/goal clear", execute)).summary).toBe("Goal cleared.");
    expect((await read()).goal).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("goal interruption and limits", () => {
  const waitForStart = async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) => {
        started();
        await new Promise<void>((resolve) => {
          if (turnOptions.signal?.aborted) resolve();
          else
            turnOptions.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return result({ status: "cancelled" });
      },
    );
    const pending = run("/goal Fix auth", execute);
    await ready;
    return { pending, execute };
  };
  it("pauses an active run and keeps its objective", async () => {
    const { pending } = await waitForStart();
    await run("/goal pause");
    expect((await pending).status).toBe("cancelled");
    expect((await read()).goal).toMatchObject({
      status: "paused",
      objective: "Fix auth",
    });
    await run("/goal resume");
    expect((await read()).goal?.status).toBe("complete");
  });
  it("cannot revive a goal cleared during execution", async () => {
    const { pending } = await waitForStart();
    await run("/goal clear");
    await pending;
    expect((await read()).goal).toBeNull();
  });
  it("rejects a second runner without pausing the first", async () => {
    const { pending } = await waitForStart();
    await expect(run("Continue")).rejects.toThrow();
    expect((await read()).goal?.status).toBe("active");
    await expect(run("/goal Another objective")).rejects.toThrow("active");
    await run("/goal clear");
    await pending;
  });
  it("cannot resume or replace a paused goal until its runner has stopped", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      started();
      await stopped;
      return result({ status: "cancelled" });
    });
    const pending = run("/goal Fix auth", execute);
    await ready;
    try {
      await run("/goal pause");
      const pausedGoal = (await read()).goal;
      await expect(run("/goal resume")).rejects.toThrow("actively owned");
      await expect(run("/goal Replace auth")).rejects.toThrow("actively owned");
      expect((await read()).goal).toEqual(pausedGoal);
    } finally {
      release();
      await pending;
    }
  });

  it("keeps user steering in the first turn after restoring an active goal", async () => {
    await run("/goal Fix auth");
    const path = getGoalPath(
      config.workspaceRoot,
      options.conversationContext!.sessionId!,
    );
    await updateGoalRecord(path, (record) => ({
      ...record,
      goal: { ...record.goal!, status: "active" },
    }));
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) => (turnOptions.resultProtocol ? evaluation("complete") : result()),
    );
    await run("Focus on the password reset tests", execute);
    expect(execute.mock.calls[0]![0]).toContain(
      "Focus on the password reset tests",
    );
    expect(execute.mock.calls[0]![0]).toContain("Fix auth");
  });

  it("keeps token accounting across work and evaluation", async () => {
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) => {
        recordExternalAgentModelCall({
          stage: "external-agent",
          provider: "codex-cli",
          model: "gpt-5.5",
          executionPath: "cli",
          operation: "goal-test",
          status: "completed",
          durationMs: 1,
          requestBytes: 1,
          responseBytes: 1,
          modelCallCount: 1,
          modelCallCountReported: true,
          retryCountReported: true,
          usage: { totalTokens: 20 },
        });
        return turnOptions.resultProtocol ? evaluation("continue") : result();
      },
    );
    await runWithTaskModelUsageRecording(() =>
      run("/goal --tokens 35 Fix auth", execute),
    );
    expect((await read()).goal).toMatchObject({
      status: "budget-limited",
      tokensUsed: 40,
      turns: 1,
    });
  });
  it("does not run another turn when a resumed goal has exhausted its time", async () => {
    await run(
      "/goal --minutes 1 Fix auth",
      vi.fn(async () => result()),
    );
    const path = getGoalPath(
      config.workspaceRoot,
      options.conversationContext!.sessionId!,
    );
    await updateGoalRecord(path, (record) => ({
      ...record,
      goal: { ...record.goal!, elapsedMs: 60_001 },
    }));
    const execute = vi.fn(async () => result());
    await run("/goal resume", execute);
    expect(execute).not.toHaveBeenCalled();
    expect((await read()).goal?.status).toBe("budget-limited");
  });
  it.each(["before", "work", "evaluation"])(
    "checks unreported token usage during %s against the goal's usage baseline",
    async (phase) => {
      const recordCall = (usage?: { totalTokens: number }) =>
        recordExternalAgentModelCall({
          stage: "external-agent",
          provider: "codex-cli",
          model: "gpt-5.5",
          executionPath: "cli",
          operation: "goal-test",
          status: "completed",
          durationMs: 1,
          requestBytes: 1,
          responseBytes: 1,
          ...(usage ? { usage } : {}),
        });
      const execute = vi.fn(
        async (
          _task: string,
          _config: RuntimeConfig,
          turnOptions: TaskExecutionOptions,
        ) => {
          const currentPhase = turnOptions.resultProtocol
            ? "evaluation"
            : "work";
          recordCall(currentPhase === phase ? undefined : { totalTokens: 20 });
          return turnOptions.resultProtocol ? evaluation("complete") : result();
        },
      );
      await runWithTaskModelUsageRecording(() => {
        if (phase === "before") recordCall();
        return run("/goal --tokens 100 Fix auth", execute);
      });
      expect((await read()).goal).toMatchObject({
        status: phase === "before" ? "complete" : "paused",
        tokensUsed: phase === "before" ? 40 : phase === "work" ? 0 : 20,
        turns: 1,
      });
      expect(execute).toHaveBeenCalledTimes(phase === "work" ? 1 : 2);
    },
  );
});

describe("native goals", () => {
  it("preserves a paused native goal when resumed with an incompatible provider", async () => {
    config.provider = "claude-cli";
    options.conversationContext!.goalMode = "native";
    await run(
      "/goal Fix auth",
      vi.fn(async () => result()),
    );
    const pausedGoal = (await read()).goal;
    config.provider = "openai";
    await expect(run("/goal resume")).rejects.toThrow(
      "unavailable native provider",
    );
    expect((await read()).goal).toEqual(pausedGoal);
  });
  it("rejects unsupported native providers without silently choosing Machdoch", async () => {
    options.conversationContext!.goalMode = "native";
    await expect(run("/goal Fix auth")).rejects.toThrow("unavailable");
    await expect(run("/goal mode native")).rejects.toThrow("unavailable");
  });
  it("delegates to Claude once and validates its result independently", async () => {
    config.provider = "claude-cli";
    options.conversationContext!.goalMode = "native";
    const execute = vi.fn(
      async (
        _task: string,
        _config: RuntimeConfig,
        turnOptions: TaskExecutionOptions,
      ) => (turnOptions.resultProtocol ? evaluation("complete") : result()),
    );
    await run("/goal Fix auth", execute);
    expect(execute.mock.calls[0]![2].nativeGoal).toBe("Fix auth");
    expect(execute.mock.calls[1]![2].nativeGoal).toBeUndefined();
    expect((await read()).goal).toMatchObject({
      mode: "native",
      status: "complete",
    });
  });
  it("requires Machdoch mode for token and turn limits", async () => {
    config.provider = "claude-cli";
    options.conversationContext!.goalMode = "native";
    await expect(run("/goal --tokens 100 Fix auth")).rejects.toThrow(
      "Machdoch mode",
    );
    await expect(run("/goal --turns 5 Fix auth")).rejects.toThrow(
      "Machdoch mode",
    );
  });
});
