import { describe, expect, it } from "vitest";
import type { ChatSessionMessage } from "../../chat-session.model";
import { getExecutionMessageRenderKey } from "./execution-message";

describe("getExecutionMessageRenderKey", () => {
  it("preserves a task execution row across the live-to-complete handoff", () => {
    const thinkingMessage: ChatSessionMessage = {
      id: "task-1-thinking",
      taskId: "task-1",
      role: "agent",
      content: "",
      source: {
        kind: "thinking",
        thinking: {
          status: "running",
          mode: "machdoch",
          startedAt: 1,
          timelineEvents: [],
        },
      },
    };
    const executionMessage: ChatSessionMessage = {
      id: "task-1-execution",
      taskId: "task-1",
      role: "agent",
      content: "Done",
      source: {
        kind: "execution",
        execution: {
          task: "Run checks",
          mode: "machdoch",
          status: "executed",
          summary: "Done",
          executedTools: [],
          outputSections: [],
        },
      },
    };

    expect(getExecutionMessageRenderKey(thinkingMessage)).toBe(
      getExecutionMessageRenderKey(executionMessage),
    );
  });

  it("keeps unrelated conversation rows keyed by message identity", () => {
    const message: ChatSessionMessage = {
      id: "message-1",
      role: "user",
      content: "Run checks",
    };

    expect(getExecutionMessageRenderKey(message)).toBe("message-1");
  });
});
