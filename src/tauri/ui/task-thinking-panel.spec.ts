import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskThinkingPanel } from "./task-thinking-panel.tsx";
import type { TaskThinkingTrace } from "./task-thinking.model.ts";

const createRepresentativeTrace = (): TaskThinkingTrace => ({
  status: "running",
  mode: "machdoch",
  startedAt: 1_000,
  timelineEvents: [
    {
      id: "starting",
      kind: "state",
      phase: "started",
      label: "Starting",
      detail: "Inspecting the workspace.",
      tone: "info",
      timestamp: 1_000,
      elapsedMs: 0,
    },
    {
      id: "model-start",
      kind: "model-call",
      phase: "started",
      label: "Executor model call 1",
      detail: "Choosing the next action.",
      tone: "info",
      timestamp: 1_100,
      elapsedMs: 100,
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
      detail: "Running the focused verification.",
      tone: "info",
      timestamp: 1_300,
      elapsedMs: 300,
      toolName: "shell",
      callId: "shell-1",
      metadata: {
        argumentsPreview: '{"command":"pnpm test --filter execution"}',
      },
    },
    {
      id: "tool-failed",
      kind: "tool-call",
      phase: "failed",
      label: "Tool call: Shell",
      detail: "The focused verification failed with exit code 1.",
      tone: "danger",
      timestamp: 1_600,
      elapsedMs: 600,
      toolName: "shell",
      callId: "shell-1",
      metadata: {
        durationMs: 300,
        outputPreview: "1 test failed",
      },
    },
    {
      id: "validator-start",
      kind: "validator",
      phase: "started",
      label: "Validator pass 1",
      detail: "Checking the result.",
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
      detail: "Fix the failed assertion before finishing.",
      tone: "warning",
      timestamp: 1_800,
      elapsedMs: 800,
      metadata: { validatorPass: 1 },
    },
  ],
  actionOutputLines: [
    {
      id: "output-1",
      toolName: "shell",
      stream: "stdout",
      text: "Running execution tests",
      timestamp: 1_400,
    },
    {
      id: "output-2",
      toolName: "shell",
      stream: "stderr",
      text: "warning: representative assertion failed",
      timestamp: 1_500,
    },
  ],
  assistantText: "I found the failing assertion and am correcting it.",
});

const renderPanel = (thinking: TaskThinkingTrace): string => {
  return renderToStaticMarkup(createElement(TaskThinkingPanel, { thinking }));
};

describe("TaskThinkingPanel", () => {
  it("renders mixed execution activity as one readable story", () => {
    const markup = renderPanel(createRepresentativeTrace());

    expect(markup).toContain(">Execution<");
    expect(markup).toContain("AI pass 1 finished");
    expect(markup).toContain("Shell failed");
    expect(markup).toContain("More work needed");
    expect(markup).toContain("Command and output");
    expect(markup).toContain("Drafting response");
    expect(markup).toContain(
      "I found the failing assertion and am correcting it.",
    );
    expect(markup).not.toContain(">Timeline<");
    expect(markup).not.toContain(">Streams<");
    expect(markup).not.toContain(">Replay<");
    expect(markup).not.toContain("Stdout / stderr");
  });

  it("keeps raw terminal lines available without promoting each line to an event", () => {
    const markup = renderPanel(createRepresentativeTrace());

    expect(markup).toContain("<details");
    expect(markup.match(/Running execution tests/gu)).toHaveLength(1);
    expect(
      markup.match(/warning: representative assertion failed/gu),
    ).toHaveLength(1);
    expect(markup.match(/Shell failed/gu)).toHaveLength(1);
    expect(markup).not.toContain("shell stderr");
  });

  it("does not surface provider stream status noise", () => {
    const trace = createRepresentativeTrace();
    const markup = renderPanel({
      ...trace,
      modelStream: {
        kind: "status",
        label: "OpenAI response stream completed.",
        content: "response.completed",
        complete: true,
      },
    });

    expect(markup).not.toContain("OpenAI response stream completed.");
    expect(markup).not.toContain("response.completed");
  });
});
