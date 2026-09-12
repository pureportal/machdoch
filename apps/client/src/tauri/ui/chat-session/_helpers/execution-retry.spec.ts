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
import {
  createExecutionRetryPrompt,
  getPendingExecutionRetry,
} from "./execution-retry";
import { reconcileRecoveredTaskResults } from "./recovered-task-result";

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

  it("reconciles a completed native result before treating a reload as a crash", () => {
    const state = { ...createInitialShellState(), sessions: [failed()] };
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
    expect(recovered.sessions[0].messages.at(-1)?.content).toContain(
      "Report saved",
    );
    expect(
      recovered.sessions[0].messages.some(
        (message) => message.source?.kind === "interrupted-task",
      ),
    ).toBe(false);
  });
});
