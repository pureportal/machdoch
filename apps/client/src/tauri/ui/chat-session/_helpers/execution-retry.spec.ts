import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS as settings } from "../../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  normalizeShellState,
  recoverInterruptedTasksForLaunch,
  type ChatSessionRecord,
  type ChatSessionTaskOutcomeStatus,
} from "../../chat-session.model";
import { createInitialThinkingTrace } from "../../task-thinking.model";
import { parseGoalCommand } from "../../../../core/goals/goal-command.js";
import {
  createExecutionRetryPrompt,
  getPendingExecutionRetry,
} from "./execution-retry";
import { reconcileRecoveredTaskResults } from "./recovered-task-result";

const activeGoal = {
  id: "report-goal",
  objective: "Build the report",
  mode: "machdoch" as const,
  status: "active" as const,
  turns: 1,
  tokensUsed: 20,
  elapsedMs: 1_000,
  reason: "",
  createdAt: 100,
  updatedAt: 200,
};

const failed = (
  status: ChatSessionTaskOutcomeStatus = "failed",
  retryNumber = 0,
): ChatSessionRecord =>
  createSession({
    id: "session",
    messages: [
      {
        id: "task-user",
        taskId: "task",
        role: "user",
        content: "Build the report",
        createdAt: 100,
        executionAttempt: {
          rootTaskId: "root",
          task: "Build the report with the attached source",
          retryNumber,
          retryLimit: 2,
        },
      },
      {
        id: "task-agent",
        taskId: "task",
        role: "agent",
        content: "Failed",
        createdAt: 200,
        outcome: { status, reason: "Provider returned HTTP 503; request abc" },
      },
    ],
  });

describe("automatic execution retries", () => {
  it.each(["/goal --turns 3 -- Fix auth\nand verify tests", "/goal resume"])(
    "preserves goal commands without adding diagnostics to the objective: %s",
    (task) => {
      const session = failed("crashed");
      session.messages[0].executionAttempt!.task = task;
      const retry = getPendingExecutionRetry(session, settings)!;
      const prompt = createExecutionRetryPrompt(retry.attempt);
      expect(prompt).toBe(task);
      expect(parseGoalCommand(prompt)).toEqual(parseGoalCommand(task));
    },
  );

  it("does not restart historical failures without a recorded attempt", () => {
    const session = failed();
    delete session.messages[0].executionAttempt;
    expect(getPendingExecutionRetry(session, settings)).toBeNull();
  });

  it("counts retries separately from the initial execution", () => {
    expect(
      getPendingExecutionRetry(failed(), { ...settings, retryAttempts: 0 }),
    ).toBeNull();
    expect(
      getPendingExecutionRetry(failed(), { ...settings, retryAttempts: 1 })
        ?.attempt.retryNumber,
    ).toBe(1);
    expect(
      getPendingExecutionRetry(failed("failed", 1), {
        ...settings,
        retryAttempts: 1,
      }),
    ).toBeNull();
    expect(
      getPendingExecutionRetry(failed("failed", 1), settings)?.attempt
        .retryNumber,
    ).toBe(2);
    expect(getPendingExecutionRetry(failed("failed", 2), settings)).toBeNull();
  });

  it("applies settings changes to retries waiting to start", () => {
    expect(
      getPendingExecutionRetry(failed(), {
        ...settings,
        automaticRetries: false,
      }),
    ).toBeNull();
    expect(
      getPendingExecutionRetry(failed("failed", 1), {
        ...settings,
        retryAttempts: 3,
      }),
    ).not.toBeNull();
  });

  it.each(["succeeded", "cancelled", "blocked", "unsupported"] as const)(
    "does not retry %s executions",
    (status) => {
      expect(getPendingExecutionRetry(failed(status), settings)).toBeNull();
    },
  );

  it.each(["failed", "crashed", "timed-out"] as const)(
    "retries %s with diagnostic context and original task",
    (status) => {
      const retry = getPendingExecutionRetry(failed(status), settings)!;
      expect(retry.readyAt).toBe(2200);
      expect(retry.taskId).toBe("root-retry-1");
      const prompt = createExecutionRetryPrompt(retry.attempt);
      expect(prompt).toContain("Build the report with the attached source");
      expect(prompt).toContain("crashed or failed");
      expect(prompt).toContain("HTTP 503; request abc");
      expect(prompt).toContain("verify prior side effects");
    },
  );

  it("does not retry historical failures after a newer task", () => {
    const session = failed();
    session.messages.push({ id: "new", role: "user", content: "Another task" });
    expect(getPendingExecutionRetry(session, settings)).toBeNull();
  });

  it("preserves retry limits and the objective through persistence and restart recovery", () => {
    const state = createInitialShellState();
    const session = failed("failed", 1);
    session.messages.pop();
    session.messages.push({
      id: "thinking",
      taskId: "task",
      role: "agent",
      content: "",
      source: {
        kind: "thinking",
        thinking: createInitialThinkingTrace("machdoch", 100),
      },
    });
    const persisted = normalizeShellState(
      JSON.parse(JSON.stringify({ ...state, sessions: [session] })),
    );
    const recovered = recoverInterruptedTasksForLaunch(
      persisted,
      "restarted",
      300,
      [],
    );
    const retry = getPendingExecutionRetry(recovered.sessions[0], settings)!;
    expect(retry.attempt.retryNumber).toBe(2);
    expect(retry.attempt.failureContext).toContain("restarted");
    expect(retry.attempt.task).toBe(
      "Build the report with the attached source",
    );
    expect(
      getPendingExecutionRetry(recovered.sessions[0], {
        ...settings,
        retryAttempts: 1,
      }),
    ).toBeNull();
    expect(
      getPendingExecutionRetry(
        recoverInterruptedTasksForLaunch(persisted, "same-process", 300, [
          "task",
        ]).sessions[0],
        settings,
      ),
    ).toBeNull();
  });

  it.each([false, true])(
    "recovers goal state while respecting a live desktop runner: %s",
    (running) => {
      const session = failed();
      session.goal = { ...activeGoal };
      session.messages.pop();
      session.messages.push({
        id: "thinking",
        taskId: "task",
        role: "agent",
        content: "",
        source: {
          kind: "thinking",
          thinking: createInitialThinkingTrace("machdoch", 100),
        },
      });
      const recovered = recoverInterruptedTasksForLaunch(
        { ...createInitialShellState(), sessions: [session] },
        "restart",
        300,
        running ? ["task"] : [],
      );
      expect(recovered.sessions[0].goal).toMatchObject({
        ...activeGoal,
        status: running ? "active" : "paused",
        updatedAt: running ? 200 : 300,
        reason: running ? "" : "Execution interrupted. Resume to continue.",
      });
    },
  );

  it.each(["complete", "clear"])(
    "reconciles a completed native result and goal %s before treating a reload as a crash",
    (goalState) => {
      const state = { ...createInitialShellState(), sessions: [failed()] };
      state.sessions[0].goal = { ...activeGoal };
      const completedGoal =
        goalState === "clear" ? null : { ...activeGoal, status: "complete" };
      state.sessions[0].messages.pop();
      const reconciled = reconcileRecoveredTaskResults(state, [
        {
          id: "task",
          kind: "chat-run",
          sessionId: "session",
          workspaceRoot: "",
          arguments: [],
          startedAt: 100,
          finishedAt: 200,
          outcome: {
            status: "succeeded",
            response: {
              execution: {
                task: "Build the report",
                mode: "machdoch",
                status: "executed",
                summary: "Report saved",
                executedTools: [],
                outputSections: [],
                metadata: { goal: completedGoal, goalMode: "machdoch" },
              },
            },
          },
        },
      ]);
      const recovered = recoverInterruptedTasksForLaunch(
        reconciled,
        "reload",
        300,
        [],
      );
      expect(
        getPendingExecutionRetry(recovered.sessions[0], settings),
      ).toBeNull();
      expect(recovered.sessions[0].goal).toEqual(completedGoal);
      expect(recovered.sessions[0].messages.at(-1)?.content).toContain(
        "Report saved",
      );
      expect(
        recovered.sessions[0].messages.some(
          (message) => message.source?.kind === "interrupted-task",
        ),
      ).toBe(false);
    },
  );
});
