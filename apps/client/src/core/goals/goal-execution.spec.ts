import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { GoalTurnExecutor } from "./run-goal.js";
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
  it.each([
    "All auth tests pass",
    "clear",
    "mode native",
    "--tokens 10 Fix auth",
  ])(
    "starts the submitted task under the literal goal %s",
    async (objective) => {
      options.conversationContext!.goalObjective = objective;
      const onStateChange = vi.fn();
      options.onStateChange = onStateChange;
      const execute = vi.fn<GoalTurnExecutor>(
        async (task, _config, turnOptions) => {
          expect(turnOptions.conversationContext).not.toHaveProperty(
            "goalObjective",
          );
          if (turnOptions.resultProtocol) return evaluation("complete");
          expect(task).toContain("Fix the login handler");
          expect(task).toContain(JSON.stringify(objective));
          return result();
        },
      );
      await run("Fix the login handler", execute);
      expect(execute).toHaveBeenCalledTimes(2);
      expect((await read()).goal).toMatchObject({
        objective,
        status: "complete",
        turns: 1,
      });
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ objective, status: "active" }),
        }),
      );
    },
  );

  it("resumes the submitted objective with its existing identity and consumed budget", async () => {
    await run(
      "/goal --turns 5 All auth tests pass",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) =>
        turnOptions.resultProtocol ? evaluation("blocked") : result(),
      ),
    );
    const before = (await read()).goal!;
    options.conversationContext!.goalObjective = before.objective;
    await run("Fix the remaining failure");
    expect((await read()).goal).toMatchObject({
      id: before.id,
      objective: before.objective,
      turnBudget: 5,
      turns: before.turns + 1,
      status: "complete",
    });
  });

  it("does not reset an exhausted budget when the same objective is submitted again", async () => {
    await run(
      "/goal --turns 1 All auth tests pass",
      vi.fn<GoalTurnExecutor>(async (_task, _config, turnOptions) =>
        turnOptions.resultProtocol ? evaluation("continue") : result(),
      ),
    );
    const before = (await read()).goal!;
    options.conversationContext!.goalObjective = before.objective;
    await expect(run("Try again")).rejects.toThrow(
      "This goal reached its limit.",
    );
    expect((await read()).goal).toEqual(before);
  });

  it("does not restart a completed goal from a repeated submission", async () => {
    await run("/goal All auth tests pass");
    const before = (await read()).goal!;
    options.conversationContext!.goalObjective = before.objective;
    const execute = vi.fn<GoalTurnExecutor>(async () => result());
    await run("Review the fix", execute);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "Review the fix",
      config,
      expect.anything(),
    );
    expect((await read()).goal).toEqual(before);
  });

  it("honors an explicit goal command instead of the drafted objective", async () => {
    options.conversationContext!.goalObjective = "All auth tests pass";
    const execute = vi.fn<GoalTurnExecutor>(async () => result());
    await run("/goal clear", execute);
    expect(execute).not.toHaveBeenCalled();
    expect((await read()).goal).toBeNull();
  });

  it("retains old chat messages across goal turns while bounding the prompt history", async () => {
    options.conversationContext!.history = [
      {
        role: "assistant",
        content: "Original recommendations: read and search the chat.",
      },
      ...Array.from({ length: 50 }, (_, index) => ({
        role: "user" as const,
        content: `Later message ${index}`,
      })),
    ];
    options.conversationContext!.promptHistoryMessageLimit = 2;
    let workTurns = 0;
    let evaluations = 0;
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol)
          return evaluation(++evaluations === 2 ? "complete" : "continue");
        expect(turnOptions.conversationContext!.history[0]?.content).toContain(
          "Original recommendations",
        );
        expect(turnOptions.conversationContext!.history).toHaveLength(
          51 + workTurns * 2,
        );
        expect(turnOptions.conversationContext!.promptHistoryMessageLimit).toBe(
          2,
        );
        workTurns += 1;
        return result();
      },
    );
    await run("/goal --turns 2 Apply the original recommendations", execute);
    expect(workTurns).toBe(2);
    expect((await read()).goal?.status).toBe("complete");
  });

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
  it("pauses repeated work even when the evaluator keeps changing its next step", async () => {
    let evaluations = 0;
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) =>
        turnOptions.resultProtocol
          ? {
              ...evaluation("continue"),
              summary: `Try another check ${++evaluations}.`,
            }
          : result(),
    );
    await run("/goal Fix auth", execute);
    expect((await read()).goal).toMatchObject({ status: "paused", turns: 4 });
    expect(execute).toHaveBeenCalledTimes(8);
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
      turns: 3,
      reason: "A required credential is missing.",
    });
    expect(execute).toHaveBeenCalledTimes(6);
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
  it("continues after a partial blocker and completes independent requirements", async () => {
    let workTurns = 0;
    const execute = vi.fn<GoalTurnExecutor>(
      async (task, _config, turnOptions) => {
        if (turnOptions.resultProtocol)
          return evaluation(workTurns === 1 ? "blocked" : "complete");
        workTurns += 1;
        if (workTurns === 2) {
          expect(task).toContain("Audit it against current evidence");
          expect(task).toContain(
            "finish all work that can proceed independently",
          );
          expect(turnOptions.conversationContext?.history).toHaveLength(2);
        }
        return result({ summary: `Verified requirement ${workTurns}.` });
      },
    );
    expect(
      (
        await run(
          "/goal Implement and verify every intake requirement",
          execute,
        )
      ).status,
    ).toBe("executed");
    expect((await read()).goal).toMatchObject({ status: "complete", turns: 2 });
  });
  it("resets blocker confirmation when useful work remains", async () => {
    const decisions = [
      "blocked",
      "continue",
      "blocked",
      "blocked",
      "blocked",
    ] as const;
    let workTurns = 0;
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol)
          return evaluation(decisions[workTurns - 1]!);
        workTurns += 1;
        return result({ summary: `Audited requirement ${workTurns}.` });
      },
    );
    await run("/goal Finish all requirements", execute);
    expect((await read()).goal).toMatchObject({ status: "blocked", turns: 5 });
  });
  it("audits a blocked work result instead of immediately stopping the goal", async () => {
    let workTurns = 0;
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) => {
        if (turnOptions.resultProtocol)
          return evaluation(workTurns === 1 ? "continue" : "complete");
        workTurns += 1;
        return result({ status: workTurns === 1 ? "blocked" : "executed" });
      },
    );
    expect((await run("/goal Finish all requirements", execute)).status).toBe(
      "executed",
    );
    expect((await read()).goal?.turns).toBe(2);
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
  it("pauses an interrupted goal when its status is read after restart", async () => {
    await run("/goal Fix auth");
    const path = getGoalPath(
      directory,
      options.conversationContext!.sessionId!,
    );
    await updateGoalRecord(path, (record) => ({
      ...record,
      goal: { ...record.goal!, status: "active" },
    }));
    const execute = vi.fn(async () => result());
    expect((await run("/goal", execute)).metadata?.goal).toMatchObject({
      status: "paused",
      objective: "Fix auth",
      turns: 1,
    });
    expect((await read()).goal?.status).toBe("paused");
    expect(execute).not.toHaveBeenCalled();
    await run("/goal resume");
    expect((await read()).goal).toMatchObject({ status: "complete", turns: 2 });
  });
  it("recovers an orphaned run lock and retries the same goal without resetting its budget", async () => {
    await run("/goal --turns 2 Fix auth");
    const path = getGoalPath(
      directory,
      options.conversationContext!.sessionId!,
    );
    await updateGoalRecord(path, (record) => ({
      ...record,
      goal: { ...record.goal!, status: "active" },
    }));
    const savedGoal = (await read()).goal!;
    const ownerDirectory = join(`${path}.run.machdoch.lock`, "owner.dead-run");
    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(
      join(ownerDirectory, "owner.json"),
      JSON.stringify({ token: "dead-run", pid: 2_000_000_000 }),
    );
    await run("/goal --turns 2 Fix auth");
    expect((await read()).goal).toMatchObject({
      id: savedGoal.id,
      status: "complete",
      turnBudget: 2,
      turns: 2,
    });
  });
  it("replaces an interrupted goal when setting a different objective", async () => {
    await run("/goal Fix auth");
    const path = getGoalPath(
      directory,
      options.conversationContext!.sessionId!,
    );
    await updateGoalRecord(path, (record) => ({
      ...record,
      goal: { ...record.goal!, status: "active" },
    }));
    const savedGoal = (await read()).goal!;
    await run("/goal Fix search");
    expect((await read()).goal).toMatchObject({
      objective: "Fix search",
      status: "complete",
      turns: 1,
    });
    expect((await read()).goal?.id).not.toBe(savedGoal.id);
  });
  it("pauses repeated outcomes even when the worker keeps calling tools", async () => {
    const execute = vi.fn<GoalTurnExecutor>(
      async (_task, _config, turnOptions) =>
        turnOptions.resultProtocol ? evaluation("continue") : result(),
    );
    await run("/goal Fix auth", execute);
    expect((await read()).goal).toMatchObject({ status: "paused", turns: 4 });
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
    expect((await run("/goal")).metadata?.goal).toMatchObject({
      status: "active",
      turns: 1,
    });
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

  it("does not activate a goal when the request was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Stopped by user."));
    options.signal = controller.signal;
    const execute = vi.fn(async () => result());
    await expect(run("/goal Fix auth", execute)).rejects.toThrow(
      "Stopped by user.",
    );
    expect((await read()).goal).toBeNull();
    expect(execute).not.toHaveBeenCalled();
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
  it.each([
    ["claude-cli", "command"],
    ["claude-cli", "submission"],
    ["codex-cli", "command"],
    ["codex-cli", "submission"],
  ] as const)(
    "delegates a native %s goal from a %s and validates its result independently",
    async (provider, source) => {
      config.provider = provider;
      options.conversationContext!.goalMode = "native";
      const execute = vi.fn(
        async (
          _task: string,
          _config: RuntimeConfig,
          turnOptions: TaskExecutionOptions,
        ) => (turnOptions.resultProtocol ? evaluation("complete") : result()),
      );
      if (source === "submission")
        options.conversationContext!.goalObjective = "Fix auth";
      await run(
        source === "submission" ? "Fix the login handler" : "/goal Fix auth",
        execute,
      );
      expect(execute.mock.calls[0]![2].nativeGoal).toBe("Fix auth");
      expect(execute.mock.calls[1]![2].nativeGoal).toBeUndefined();
      expect((await read()).goal).toMatchObject({
        mode: "native",
        status: "complete",
      });
    },
  );
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
