import { describe, expect, it } from "vitest";
import type { ChatSessionMessage } from "../../chat-session.model";
import { getExecutionMessageRenderKey, getFinalSpeechAnswer } from "./execution-message";

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

describe("final answer speech boundary", () => {
  const message: ChatSessionMessage = {
    id:"answer",taskId:"task",role:"agent",content:"Progress should never be used",
    source:{kind:"execution",execution:{task:"Task",mode:"machdoch",status:"executed",summary:"Internal summary",executedTools:[],outputSections:[],response:{markdown:"Final user answer",highlights:[],relatedFiles:[],verification:[],followUps:[]}}},
  };
  it("uses only the completed user response and rejects errors and thinking", () => {
    expect(getFinalSpeechAnswer(message,"session")?.markdown).toBe("Final user answer");
    if(message.source?.kind!=="execution")throw new Error("Invalid fixture");
    for(const status of ["failed","blocked","cancelled"] as const)expect(getFinalSpeechAnswer({...message,source:{kind:"execution",execution:{...message.source.execution,status}}},"session")).toBeNull();
    expect(getFinalSpeechAnswer({...message,source:undefined},"session")).toBeNull();
    expect(getFinalSpeechAnswer({...message,role:"user"},"session")).toBeNull();
    expect(getFinalSpeechAnswer({...message,source:{kind:"execution",execution:{...message.source.execution,response:undefined}}},"session")).toBeNull();
  });
});
