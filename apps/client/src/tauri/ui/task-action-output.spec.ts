import { describe, expect, it } from "vitest";
import { createTaskExecutionStory } from "@machdoch/client-ui/conversation/task-execution-story";
import { retainTaskActionOutput } from "@machdoch/client-ui/conversation/task-action-output";
import { taskThinkingTraceSchema } from "@machdoch/fleet-protocol/task-thinking";
import type { TaskExecutionProgress } from "../../core/types.js";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
  type TaskThinkingTrace,
} from "./task-thinking.model";
import {
  createInitialShellState,
  normalizeShellState,
} from "./chat-session.model";

const appendOutput = (
  trace: TaskThinkingTrace,
  lineCount: number,
  stream: "stdout" | "stderr",
  timestamp: number,
  toolName = "shell",
): TaskThinkingTrace =>
  appendThinkingProgress(
    trace,
    {
      task: "Run checks",
      mode: "machdoch",
      state: "executing",
      message: `${toolName} ${stream}`,
      executedTools: [],
      outputSections: [],
      cancellable: true,
      actionOutput: {
        toolName,
        stream,
        chunk: Array.from(
          { length: lineCount },
          (_, index) => `${stream} ${timestamp} line ${index + 1}`,
        ).join("\n"),
      },
    },
    timestamp,
  );

const appendEvent = (
  trace: TaskThinkingTrace,
  timelineEvent: NonNullable<TaskExecutionProgress["timelineEvent"]>,
  timestamp: number,
): TaskThinkingTrace =>
  appendThinkingProgress(
    trace,
    {
      task: "Run checks",
      mode: "machdoch",
      state: "executing",
      message: timelineEvent.label,
      executedTools: [],
      outputSections: [],
      cancellable: true,
      timelineEvent,
    },
    timestamp,
  );

describe("task terminal output retention", () => {
  it("counts all output across batches while retaining only the latest 50 lines", () => {
    let trace = createInitialThinkingTrace("machdoch", 1_000);
    trace = appendOutput(trace, 70, "stdout", 1_100);
    const initialTerminal = createTaskExecutionStory(trace).find(
      (item) => item.kind === "terminal",
    );
    trace = appendOutput(trace, 60, "stderr", 1_200);
    trace = appendOutput(trace, 10, "stderr", 1_300);
    const terminal = createTaskExecutionStory(trace).find(
      (item) => item.kind === "terminal",
    );

    expect(trace.actionOutputLines).toHaveLength(50);
    expect(trace.actionOutputLines?.[0]?.text).toBe("stderr 1200 line 21");
    expect(trace.actionOutputSummaries).toHaveLength(1);
    expect(terminal?.detail).toBe("shell · 140 stdout and stderr lines");
    expect(terminal?.stdoutLineCount).toBe(70);
    expect(terminal?.stderrLineCount).toBe(70);
    expect(terminal?.outputLines).toHaveLength(50);
    expect(terminal?.id).toBe(initialTerminal?.id);
    expect(terminal?.timestamp).toBe(1_100);
    expect(taskThinkingTraceSchema.parse(trace)).toEqual(trace);
  });

  it("keeps counts for earlier terminal groups after all their text is removed", () => {
    let trace = createInitialThinkingTrace("machdoch", 1_000);
    trace = appendOutput(trace, 5, "stdout", 1_100);
    trace = appendEvent(
      trace,
      { kind: "state", phase: "started", label: "Verifying" },
      1_200,
    );
    trace = appendOutput(trace, 60, "stderr", 1_300);
    trace = appendOutput(trace, 10, "stdout", 1_400, "other-tool");
    const terminals = createTaskExecutionStory(trace).filter(
      (item) => item.kind === "terminal",
    );

    expect(terminals.map((item) => item.detail)).toEqual([
      "shell · 5 stdout lines",
      "shell · 60 stderr lines",
      "other-tool · 10 stdout lines",
    ]);
    expect(terminals.map((item) => item.outputLines.length)).toEqual([
      0, 40, 10,
    ]);
  });

  it("keeps output counts attached to their tool calls", () => {
    let trace = createInitialThinkingTrace("machdoch", 1_000);
    for (let index = 1; index <= 2; index += 1) {
      trace = appendEvent(
        trace,
        {
          kind: "tool-call",
          phase: "started",
          label: "Tool call: Shell",
          toolName: "shell",
          callId: `shell-${index}`,
        },
        1_000 + index * 100,
      );
      trace = appendOutput(trace, 70, "stdout", 1_010 + index * 100);
      trace = appendEvent(
        trace,
        {
          kind: "tool-call",
          phase: "completed",
          label: "Tool call: Shell",
          toolName: "shell",
          callId: `shell-${index}`,
        },
        1_020 + index * 100,
      );
    }
    const tools = createTaskExecutionStory(trace).filter(
      (item) => item.kind === "tool-call",
    );

    expect(tools.map((item) => item.stdoutLineCount)).toEqual([70, 70]);
    expect(tools.map((item) => item.outputLines.length)).toEqual([0, 50]);
    expect(
      createTaskExecutionStory(trace).some((item) => item.kind === "terminal"),
    ).toBe(false);
  });

  it("preserves output order when different tools share a timestamp", () => {
    let trace = createInitialThinkingTrace("machdoch", 1_000);
    trace = appendOutput(trace, 10, "stdout", 1_100);
    trace = appendOutput(trace, 10, "stderr", 1_100, "other-tool");
    trace = appendOutput(trace, 60, "stdout", 1_100);
    const terminals = createTaskExecutionStory(trace).filter(
      (item) => item.kind === "terminal",
    );

    expect(terminals.map((item) => item.detail)).toEqual([
      "shell · 10 stdout lines",
      "other-tool · 10 stderr lines",
      "shell · 60 stdout lines",
    ]);
    expect(terminals.map((item) => item.outputLines.length)).toEqual([
      0, 0, 50,
    ]);
  });

  it("preserves counts through completion, persisted trimming, and repeated restoration", () => {
    const running = appendOutput(
      createInitialThinkingTrace("machdoch", 1_000),
      125,
      "stdout",
      1_100,
    );
    const completed: TaskThinkingTrace = {
      ...running,
      status: "complete",
      completedAt: 1_200,
    };
    const state = normalizeShellState({
      ...createInitialShellState(),
      activeSessionId: "output-session",
      sessions: [
        {
          id: "output-session",
          provider: "openai",
          workspace: null,
          createdAt: 1_000,
          updatedAt: 1_200,
          messages: [
            {
              id: "output-message",
              role: "agent",
              content: "",
              source: { kind: "thinking", thinking: completed },
            },
          ],
        },
      ],
    });
    const restoredState = normalizeShellState(
      JSON.parse(JSON.stringify(state)),
    );
    const source = restoredState.sessions[0]?.messages[0]?.source;
    expect(source?.kind).toBe("thinking");
    if (source?.kind !== "thinking") {
      throw new Error("Expected the saved terminal trace.");
    }

    expect(source.thinking.actionOutputLines).toHaveLength(20);
    expect(source.thinking.actionOutputSummaries).toHaveLength(1);
    expect(
      createTaskExecutionStory(source.thinking).find(
        (item) => item.kind === "terminal",
      )?.detail,
    ).toBe("shell · 125 stdout lines");
    expect(taskThinkingTraceSchema.parse(source.thinking)).toEqual(
      source.thinking,
    );
  });

  it("can remove all output text while retaining exact counts", () => {
    const trace = appendOutput(
      createInitialThinkingTrace("machdoch", 1_000),
      80,
      "stderr",
      1_100,
    );
    const compacted = { ...trace, ...retainTaskActionOutput(trace, 0) };
    const terminal = createTaskExecutionStory(compacted).find(
      (item) => item.kind === "terminal",
    );

    expect(terminal?.detail).toBe("shell · 80 stderr lines");
    expect(terminal?.outputLines).toEqual([]);
    expect(retainTaskActionOutput(compacted, 0)).toEqual(
      retainTaskActionOutput(trace, 0),
    );
  });
});
