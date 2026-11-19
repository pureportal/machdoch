import { describe, expect, it } from "vitest";
import {
  createInitialShellState,
  createSession,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type ChatSessionTaskOutcomeStatus,
  type ShellPersistedState,
} from "../../chat-session.model";
import { resolveDesktopActivityState } from "./desktop-activity-indicator";

const finishedSession = (
  id: string,
  status: ChatSessionTaskOutcomeStatus,
  lastReadAt = 0,
): ChatSessionRecord =>
  createSession({
    id,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt,
    messages: [
      { id: `${id}-user`, taskId: id, role: "user", content: id, createdAt: 5 },
      {
        id: `${id}-agent`,
        taskId: id,
        role: "agent",
        content: status,
        createdAt: 10,
        outcome: { status },
      },
    ],
  });

const runningSession = (id: string, questionPending = false): ChatSessionRecord =>
  createSession({
    id,
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: `${id}-user`, taskId: id, role: "user", content: id, createdAt: 5 },
      {
        id: `${id}-thinking`,
        taskId: id,
        role: "agent",
        content: "",
        createdAt: 6,
        source: {
          kind: "thinking",
          thinking: {
            status: "running",
            mode: "machdoch",
            startedAt: 6,
            timelineEvents: [],
            ...(questionPending
              ? {
                  agentLive: {
                    provider: "codex-cli",
                    transport: "app-server",
                    capabilities: ["answer"],
                    question: {
                      id: "question",
                      status: "pending",
                      items: [{ id: "item", question: "Which?", options: [] }],
                    },
                  },
                }
              : {}),
          },
        },
      } as ChatSessionMessage,
    ],
  });

const resolve = (
  sessions: ChatSessionRecord[],
  overrides: Partial<Parameters<typeof resolveDesktopActivityState>[0]> = {},
) => {
  const shellState: ShellPersistedState = {
    ...createInitialShellState(),
    sessions,
  };

  return resolveDesktopActivityState({
    shellState,
    hasHydrated: true,
    promptEnhancementBusy: false,
    chatInterviewBusy: false,
    ...overrides,
  });
};

describe("resolveDesktopActivityState", () => {
  it("stays idle before hydration and without unread results", () => {
    expect(resolve([runningSession("a")], { hasHydrated: false })).toBe("idle");
    expect(resolve([finishedSession("a", "succeeded", 20)])).toBe("idle");
  });

  it("reports running work from sessions and composer helpers", () => {
    expect(resolve([runningSession("a"), finishedSession("b", "succeeded")])).toBe(
      "running",
    );
    expect(resolve([], { promptEnhancementBusy: true })).toBe("running");
    expect(resolve([], { chatInterviewBusy: true })).toBe("running");
  });

  it("prefers a pending question over every other state", () => {
    expect(
      resolve([finishedSession("a", "failed"), runningSession("b", true)]),
    ).toBe("needs-input");
  });

  it.each(["failed", "blocked", "timed-out", "unsupported", "crashed"] as const)(
    "reports an unread %s result as failed even while other work runs",
    (status) => {
      expect(resolve([runningSession("a"), finishedSession("b", status)])).toBe(
        "failed",
      );
    },
  );

  it.each(["succeeded", "cancelled"] as const)(
    "reports an unread %s result as done",
    (status) => {
      expect(resolve([finishedSession("a", status)])).toBe("done");
    },
  );
});
