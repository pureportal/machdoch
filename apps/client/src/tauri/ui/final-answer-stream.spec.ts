import { describe, it, expect } from "vitest";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
} from "./task-thinking.model";
import type {
  FinalAnswerStreamSnapshot,
  TaskExecutionProgress,
} from "../../core/types.js";
import {
  finalAnswerStreamSchema,
  taskThinkingTraceSchema,
} from "@machdoch/fleet-protocol/task-thinking";

describe("final-answer trace snapshots", () => {
  it("preserves full eligible text separately from bounded drafts and rejects stale sequence updates", () => {
    const snapshot: FinalAnswerStreamSnapshot = {
      source: "openai-responses",
      channel: "final_answer",
      responseId: "response",
      answerId: "answer",
      sequence: 2,
      text: "a".repeat(6000),
      status: "streaming",
    };
    const progress: TaskExecutionProgress = {
      task: "Task",
      mode: "machdoch",
      state: "executing",
      message: "Progress",
      executedTools: [],
      outputSections: [],
      cancellable: true,
      finalAnswerStream: snapshot,
    };
    const trace = appendThinkingProgress(
      createInitialThinkingTrace("machdoch", 1000),
      progress,
      1100,
    );
    expect(trace.finalAnswerStream?.text).toHaveLength(6000);
    expect(taskThinkingTraceSchema.parse(trace).finalAnswerStream).toEqual(
      snapshot,
    );
    expect(
      appendThinkingProgress(
        trace,
        {
          ...progress,
          finalAnswerStream: { ...snapshot, sequence: 1, text: "stale" },
        },
        1200,
      ).finalAnswerStream,
    ).toEqual(snapshot);
    expect(
      finalAnswerStreamSchema.safeParse({ ...snapshot, channel: "commentary" })
        .success,
    ).toBe(false);
    expect(finalAnswerStreamSchema.safeParse({...snapshot,text:"界".repeat(400_000)}).success).toBe(false);
  });
});
