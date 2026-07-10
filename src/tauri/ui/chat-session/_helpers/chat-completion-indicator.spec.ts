import { describe, expect, it } from "vitest";
import type { TaskExecutionResult } from "../../../../core/types.js";
import {
  createInitialShellState,
  createSession,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { isChatCompletionIndicatorActive } from "./chat-completion-indicator";

const createExecution = (
  status: TaskExecutionResult["status"] = "executed",
): TaskExecutionResult => ({
  task: "Inspect the workspace",
  mode: "machdoch",
  status,
  summary: status === "executed" ? "Done." : "Could not complete.",
  executedTools: [],
  outputSections: [],
  ...(status === "blocked" ? { reason: "Blocked by missing input." } : {}),
});

const createSessionWithExecutionStatus = (
  status: TaskExecutionResult["status"],
  options: { lastReadAt?: number } = {},
): ChatSessionRecord => {
  const taskId = `${status}-task`;

  return createSession({
    id: `${status}-session`,
    updatedAt: 2,
    lastReadAt: options.lastReadAt ?? 1,
    messages: [
      {
        id: `${taskId}-user`,
        taskId,
        role: "user",
        content: "Inspect the workspace",
        createdAt: 1,
      },
      {
        id: `${taskId}-agent`,
        taskId,
        role: "agent",
        content: status === "executed" ? "Done." : "Could not complete.",
        createdAt: 2,
        source: {
          kind: "execution",
          execution: createExecution(status),
        },
      },
    ],
  });
};

const createRunningSession = (): ChatSessionRecord =>
  createSession({
    id: "running-session",
    messages: [
      {
        id: "running-task-user",
        taskId: "running-task",
        role: "user",
        content: "Keep working",
        createdAt: 1,
      },
    ],
  });

const createShellState = (
  overrides: Partial<ShellPersistedState> = {},
): ShellPersistedState => ({
  ...createInitialShellState(),
  sessions: [createSessionWithExecutionStatus("executed")],
  queuedSessionMessages: [],
  ...overrides,
});

const isActive = (
  overrides: Partial<Parameters<typeof isChatCompletionIndicatorActive>[0]> = {},
): boolean =>
  isChatCompletionIndicatorActive({
    shellState: createShellState(),
    hasHydrated: true,
    promptEnhancementBusy: false,
    chatInterviewBusy: false,
    ...overrides,
  });

describe("chat completion indicator", () => {
  it("activates for a hydrated shell with an unread completed session and no queued work", () => {
    expect(isActive()).toBe(true);
  });

  it("does not activate after the completed session has been read", () => {
    expect(
      isActive({
        shellState: createShellState({
          sessions: [
            createSessionWithExecutionStatus("executed", { lastReadAt: 2 }),
          ],
        }),
      }),
    ).toBe(false);
  });

  it("does not activate before shell hydration", () => {
    expect(isActive({ hasHydrated: false })).toBe(false);
  });

  it("does not activate while any session is still running", () => {
    expect(
      isActive({
        shellState: createShellState({
          sessions: [
            createSessionWithExecutionStatus("executed"),
            createRunningSession(),
          ],
        }),
      }),
    ).toBe(false);
  });

  it("does not activate while queued work remains", () => {
    const completedSession = createSessionWithExecutionStatus("executed");

    expect(
      isActive({
        shellState: createShellState({
          sessions: [completedSession],
          queuedSessionMessages: [
            {
              id: "queued-message",
              sessionId: completedSession.id,
              task: "Follow up",
              contextAttachments: [],
              contentUpdatedAt: 3,
              attachmentsUpdatedAt: 3,
              attachmentTombstones: {},
              blockerUpdatedAt: 3,
              orderRank: 0,
              orderUpdatedAt: 3,
              createdAt: 3,
              updatedAt: 3,
            },
          ],
        }),
      }),
    ).toBe(false);
  });

  it("does not activate for failed or empty-only shells", () => {
    expect(
      isActive({
        shellState: createShellState({
          sessions: [createSessionWithExecutionStatus("blocked")],
        }),
      }),
    ).toBe(false);

    expect(
      isActive({
        shellState: createShellState({
          sessions: [createSession({ id: "empty-session" })],
        }),
      }),
    ).toBe(false);
  });

  it("does not activate during prompt enhancement or chat interview work", () => {
    expect(isActive({ promptEnhancementBusy: true })).toBe(false);
    expect(isActive({ chatInterviewBusy: true })).toBe(false);
  });
});
