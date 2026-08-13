import { describe, expect, it } from "vitest";
import { createTaskExecutionStory } from "./task-execution-story";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
  type TaskThinkingTrace,
} from "./task-thinking.model";

const createTrace = (): TaskThinkingTrace => ({
  status: "running",
  mode: "machdoch",
  startedAt: 1_000,
  timelineEvents: [
    {
      id: "starting",
      kind: "state",
      phase: "started",
      label: "Starting",
      detail: "Preparing the task.",
      tone: "info",
      timestamp: 1_000,
      elapsedMs: 0,
    },
    {
      id: "model-start",
      kind: "model-call",
      phase: "started",
      label: "Executor model call 1",
      detail: "Choosing an action.",
      tone: "info",
      timestamp: 1_100,
      elapsedMs: 100,
      provider: "openai",
      model: "gpt-test",
      metadata: { executorIteration: 1, modelCall: 1 },
    },
    {
      id: "usage",
      kind: "model-call",
      phase: "usage",
      label: "Token usage",
      detail: "12 total tokens",
      tone: "info",
      timestamp: 1_150,
      elapsedMs: 150,
      tokenUsage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      metadata: { executorIteration: 1, modelCall: 1 },
    },
    {
      id: "model-complete",
      kind: "model-call",
      phase: "completed",
      label: "Executor model call 1",
      detail: "Selected one tool.",
      tone: "success",
      timestamp: 1_200,
      elapsedMs: 200,
      provider: "openai",
      model: "gpt-test",
      metadata: {
        executorIteration: 1,
        modelCall: 1,
        durationMs: 100,
      },
    },
    {
      id: "tool-start",
      kind: "tool-call",
      phase: "started",
      label: "Tool call: Shell",
      detail: "Running checks.",
      tone: "info",
      timestamp: 1_300,
      elapsedMs: 300,
      toolName: "shell",
      callId: "call-1",
      metadata: { argumentsPreview: '{"command":"pnpm test"}' },
    },
    {
      id: "tool-failed",
      kind: "tool-call",
      phase: "failed",
      label: "Tool call: Shell",
      detail: "Checks failed with exit code 1.",
      tone: "danger",
      timestamp: 1_600,
      elapsedMs: 600,
      toolName: "shell",
      callId: "call-1",
      metadata: { durationMs: 300, outputPreview: "1 failed" },
    },
    {
      id: "validator-start",
      kind: "validator",
      phase: "started",
      label: "Validator pass 1",
      detail: "Reviewing the result.",
      tone: "info",
      timestamp: 1_700,
      elapsedMs: 700,
      metadata: { validatorPass: 1 },
    },
    {
      id: "validator-warning",
      kind: "validator",
      phase: "requested-continuation",
      label: "Validator pass 1",
      detail: "Resolve the failure and run checks again.",
      tone: "warning",
      timestamp: 1_800,
      elapsedMs: 800,
      metadata: { validatorPass: 1 },
    },
  ],
  actionOutputLines: [
    {
      id: "stdout-1",
      toolName: "shell",
      stream: "stdout",
      text: "Tests started",
      timestamp: 1_400,
    },
    {
      id: "stderr-1",
      toolName: "shell",
      stream: "stderr",
      text: "warning: assertion failed",
      timestamp: 1_500,
    },
  ],
});

describe("createTaskExecutionStory", () => {
  it("merges lifecycle pairs and attaches terminal activity to its action", () => {
    const story = createTaskExecutionStory(createTrace());

    expect(story.map((item) => item.label)).toEqual([
      "Starting",
      "AI pass 1 finished",
      "Shell failed",
      "More work needed",
    ]);
    expect(story.filter((item) => item.kind === "model-call")).toHaveLength(1);
    expect(story.filter((item) => item.kind === "tool-call")).toHaveLength(1);
    expect(story.filter((item) => item.kind === "validator")).toHaveLength(1);
    expect(story.filter((item) => item.kind === "terminal")).toHaveLength(0);

    const modelCall = story.find((item) => item.kind === "model-call");
    expect(modelCall?.tokenUsage).toEqual({
      inputTokens: 8,
      outputTokens: 4,
      totalTokens: 12,
    });
    expect(modelCall?.durationMs).toBe(100);

    const toolCall = story.find((item) => item.kind === "tool-call");
    expect(toolCall?.outputLines.map((line) => line.text)).toEqual([
      "Tests started",
      "warning: assertion failed",
    ]);
    expect(toolCall?.metadata?.argumentsPreview).toBe(
      '{"command":"pnpm test"}',
    );
    expect(toolCall?.metadata?.outputPreview).toBe("1 failed");
    expect(toolCall?.tone).toBe("danger");

    const validation = story.find((item) => item.kind === "validator");
    expect(validation?.tone).toBe("warning");
    expect(validation?.detail).toBe(
      "Resolve the failure and run checks again.",
    );
  });

  it("groups adjacent standalone terminal lines around meaningful events", () => {
    const story = createTaskExecutionStory({
      status: "running",
      mode: "machdoch",
      startedAt: 1_000,
      timelineEvents: [
        {
          id: "milestone",
          kind: "state",
          phase: "started",
          label: "Verifying",
          detail: "Checking the result.",
          tone: "info",
          timestamp: 1_300,
          elapsedMs: 300,
        },
      ],
      actionOutputLines: [
        {
          id: "line-1",
          toolName: "shell",
          stream: "stdout",
          text: "first",
          timestamp: 1_100,
        },
        {
          id: "line-2",
          toolName: "shell",
          stream: "stderr",
          text: "second",
          timestamp: 1_200,
        },
        {
          id: "line-3",
          toolName: "shell",
          stream: "stdout",
          text: "third",
          timestamp: 1_400,
        },
      ],
    });

    expect(story.map((item) => item.kind)).toEqual([
      "terminal",
      "state",
      "terminal",
    ]);
    expect(story[0]?.detail).toBe("shell · 2 stdout and stderr lines");
    expect(story[0]?.outputLines).toHaveLength(2);
    expect(story[2]?.detail).toBe("shell · 1 stdout line");
  });

  it("keeps a terminal group identity stable as retained output lines roll", () => {
    const trace: TaskThinkingTrace = {
      status: "running",
      mode: "machdoch",
      startedAt: 1_000,
      timelineEvents: [
        {
          id: "started",
          kind: "state",
          phase: "started",
          label: "Started",
          detail: "Running the task.",
          tone: "info",
          timestamp: 1_000,
          elapsedMs: 0,
        },
      ],
      actionOutputLines: [
        {
          id: "line-1",
          toolName: "shell",
          stream: "stderr",
          text: "first retained line",
          timestamp: 1_100,
        },
        {
          id: "line-2",
          toolName: "shell",
          stream: "stderr",
          text: "second retained line",
          timestamp: 1_200,
        },
      ],
    };
    const initialTerminalItem = createTaskExecutionStory(trace).find(
      (item) => item.kind === "terminal",
    );
    const advancedTerminalItem = createTaskExecutionStory({
      ...trace,
      actionOutputLines: [
        trace.actionOutputLines![1]!,
        {
          id: "line-3",
          toolName: "shell",
          stream: "stderr",
          text: "new retained line",
          timestamp: 1_300,
        },
      ],
    }).find((item) => item.kind === "terminal");

    expect(initialTerminalItem?.id).toBe(advancedTerminalItem?.id);
  });
});

describe("appendThinkingProgress terminal output", () => {
  it("keeps raw output out of the meaningful event sequence", () => {
    const trace = appendThinkingProgress(
      createInitialThinkingTrace("machdoch", 1_000),
      {
        task: "Run checks",
        mode: "machdoch",
        state: "executing",
        message: "shell stderr",
        executedTools: [],
        outputSections: [],
        cancellable: true,
        actionOutput: {
          toolName: "shell",
          stream: "stderr",
          chunk: "warning one\nwarning two\n",
        },
        timelineEvent: {
          kind: "output",
          phase: "streaming",
          label: "shell stderr",
          tone: "warning",
          toolName: "shell",
          stream: "stderr",
        },
      },
      1_100,
    );

    expect(trace.timelineEvents.map((event) => event.kind)).toEqual(["state"]);
    expect(trace.actionOutputLines?.map((line) => line.text)).toEqual([
      "warning one",
      "warning two",
    ]);
  });
});
