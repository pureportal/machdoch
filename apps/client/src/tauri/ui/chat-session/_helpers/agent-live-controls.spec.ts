import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMessage, ChatSessionRecord } from "../../chat-session.model";
import { createConversationHistory } from "./ai-context-window";
import { normalizeRunningTaskMessageAction } from "../../lib/_helpers/shell-store-normalizers.helper";
import { stopDesktopTask } from "./graceful-stop";
import {
  REVIEW_CHANGES_PROMPT,
  expandReviewChangesCommand,
  isReviewChangesTask,
} from "./review-changes";
import {
  answerQuestionWithMessage,
  findPendingAgentQuestion,
  sessionNeedsInput,
} from "./session-needs-input";

const controlMocks = vi.hoisted(() => ({
  getAgentControlEndpoint: vi.fn(),
  sendAgentControl: vi.fn(),
}));
vi.mock("../../agent-control-client", () => controlMocks);

const thinkingMessage = (status: "running" | "complete", questionStatus?: "pending" | "answered") => ({
  id: `thinking-${status}`,
  role: "agent",
  content: "",
  createdAt: 1,
  source: {
    kind: "thinking",
    thinking: {
      status,
      mode: "machdoch",
      startedAt: 1,
      timelineEvents: [],
      ...(questionStatus
        ? {
            agentLive: {
              provider: "codex-cli",
              transport: "app-server",
              capabilities: ["answer"],
              question: { id: "q", status: questionStatus, items: [{ id: "a", question: "Which?", options: [] }] },
            },
          }
        : {}),
    },
  },
});

const sessionWith = (...messages: unknown[]) => ({ messages }) as unknown as ChatSessionRecord;

describe("sessionNeedsInput", () => {
  it("is true only while the latest run waits on a question", () => {
    expect(sessionNeedsInput(sessionWith(thinkingMessage("running", "pending")))).toBe(true);
    expect(sessionNeedsInput(sessionWith(thinkingMessage("running", "answered")))).toBe(false);
    expect(sessionNeedsInput(sessionWith(thinkingMessage("complete", "pending")))).toBe(false);
    expect(sessionNeedsInput(sessionWith(thinkingMessage("running", "pending"), thinkingMessage("running")))).toBe(false);
    expect(sessionNeedsInput(sessionWith())).toBe(false);
  });
});

describe("answering a pending question with a message", () => {
  it("finds the waiting question and answers every part with the message", () => {
    const question = findPendingAgentQuestion(sessionWith(thinkingMessage("running", "pending")));
    expect(question?.id).toBe("q");
    expect(answerQuestionWithMessage(question!, "Postgres")).toEqual({ a: "Postgres" });
    expect(findPendingAgentQuestion(sessionWith(thinkingMessage("complete", "pending")))).toBeUndefined();
  });
});

describe("conversation history", () => {
  it("keeps what the user added while a run was going", () => {
    const answered = {
      id: "agent-1",
      role: "agent",
      content: "Done with Postgres.",
      createdAt: 5,
      source: {
        kind: "thinking",
        thinking: {
          status: "complete",
          mode: "machdoch",
          startedAt: 1,
          timelineEvents: [],
          assistantText: "Done with Postgres.",
          agentLive: {
            provider: "claude-cli",
            transport: "stream-json",
            capabilities: [],
            steering: [
              { id: "s1", text: "Keep it small.", status: "delivered" },
              { id: "s2", text: "Never read.", status: "failed" },
            ],
            question: {
              id: "q",
              status: "answered",
              items: [{ id: "q1", header: "Database", question: "Which database?", options: [] }],
              answers: { q1: "Postgres" },
            },
          },
        },
      },
    } as unknown as ChatSessionMessage;
    const history = createConversationHistory([answered]);
    expect(history[0]).toEqual({
      role: "user",
      content: 'Added while the previous task ran:\n- Keep it small.\n- Answered "Database": Postgres',
      createdAt: 5,
    });
  });
});

describe("review changes command", () => {
  it("expands /review and recognises the review prompt", () => {
    expect(expandReviewChangesCommand(" /Review ")).toBe(REVIEW_CHANGES_PROMPT);
    expect(expandReviewChangesCommand("/reviewer")).toBe("/reviewer");
    expect(isReviewChangesTask(` ${REVIEW_CHANGES_PROMPT}\n`)).toBe(true);
    expect(isReviewChangesTask("Review my code")).toBe(false);
  });
});

describe("running task message action", () => {
  it("keeps the steer preference", () => {
    expect(normalizeRunningTaskMessageAction("steer")).toBe("steer");
    expect(normalizeRunningTaskMessageAction("bogus")).toBe("queue");
  });
});

describe("stopDesktopTask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    controlMocks.getAgentControlEndpoint.mockReset();
    controlMocks.sendAgentControl.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const interruptible = { url: "http://127.0.0.1:1", token: "x".repeat(32), capabilities: ["interrupt"] };

  it("interrupts gracefully and kills only a run that outlives the grace period", async () => {
    controlMocks.getAgentControlEndpoint.mockReturnValue(interruptible);
    controlMocks.sendAgentControl.mockResolvedValue(undefined);
    const hardCancel = vi.fn(async () => undefined);
    let active = true;
    await stopDesktopTask("task-1", { isActive: () => active, hardCancel, graceMs: 1_000 });
    expect(controlMocks.sendAgentControl).toHaveBeenCalledWith("task-1", { type: "interrupt" });
    expect(hardCancel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(hardCancel).toHaveBeenCalledTimes(1);

    hardCancel.mockClear();
    await stopDesktopTask("task-2", { isActive: () => active, hardCancel, graceMs: 1_000 });
    active = false;
    vi.advanceTimersByTime(1_000);
    expect(hardCancel).not.toHaveBeenCalled();
  });

  it("kills at once on a second stop, without an endpoint or when the interrupt fails", async () => {
    const hardCancel = vi.fn(async () => undefined);
    controlMocks.getAgentControlEndpoint.mockReturnValue(interruptible);
    controlMocks.sendAgentControl.mockResolvedValue(undefined);
    await stopDesktopTask("task-3", { isActive: () => true, hardCancel });
    await stopDesktopTask("task-3", { isActive: () => true, hardCancel });
    expect(hardCancel).toHaveBeenCalledTimes(1);

    controlMocks.getAgentControlEndpoint.mockReturnValue(undefined);
    await stopDesktopTask("task-4", { isActive: () => true, hardCancel });
    expect(hardCancel).toHaveBeenCalledTimes(2);

    controlMocks.getAgentControlEndpoint.mockReturnValue(interruptible);
    controlMocks.sendAgentControl.mockRejectedValue(new Error("The run stopped accepting input."));
    await stopDesktopTask("task-5", { isActive: () => true, hardCancel });
    expect(hardCancel).toHaveBeenCalledTimes(3);
  });
});
