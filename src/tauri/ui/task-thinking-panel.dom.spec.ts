// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskThinkingPanel } from "./task-thinking-panel";
import type { TaskThinkingTrace } from "./task-thinking.model";

const createOutputLines = (): NonNullable<
  TaskThinkingTrace["actionOutputLines"]
> => {
  return Array.from({ length: 50 }, (_, index) => ({
    id: `output-${index + 1}`,
    toolName: "shell",
    stream: index === 49 ? ("stderr" as const) : ("stdout" as const),
    text:
      index === 0
        ? "pnpm test task-thinking-panel"
        : index === 49
          ? "warning: checking live output"
          : `output line ${index + 1}`,
    timestamp: 1_100 + index,
  }));
};

const createLiveTrace = (): TaskThinkingTrace => ({
  status: "running",
  mode: "machdoch",
  startedAt: 1_000,
  timelineEvents: [
    {
      id: "started",
      kind: "state",
      phase: "started",
      label: "Codex CLI started",
      detail: "Inspecting the workspace.",
      tone: "info",
      timestamp: 1_000,
      elapsedMs: 0,
    },
    {
      id: "shell-started",
      kind: "tool-call",
      phase: "started",
      label: "Tool call: Shell",
      detail: "Running the timeline checks.",
      tone: "info",
      timestamp: 1_010,
      elapsedMs: 10,
      toolName: "shell",
      callId: "shell-1",
      metadata: {
        argumentsPreview: '{"command":"pnpm test task-thinking-panel"}',
      },
    },
    {
      id: "shell-failed",
      kind: "tool-call",
      phase: "failed",
      label: "Tool call: Shell",
      detail: "Command failed with exit code 1.",
      tone: "danger",
      timestamp: 1_050,
      elapsedMs: 50,
      toolName: "shell",
      callId: "shell-1",
      metadata: {
        outputPreview: "1 representative test failed",
      },
    },
  ],
  actionOutputLines: createOutputLines(),
  assistantText: "I am checking the execution timeline.",
});

const getOutputDisclosure = (index = 0): HTMLDetailsElement => {
  const summary = screen.getAllByText("Show output")[index];
  const details = summary?.closest("details");

  if (!(details instanceof HTMLDetailsElement)) {
    throw new TypeError("Expected Show output to belong to a details element.");
  }

  return details;
};

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

describe("TaskThinkingPanel interactions", () => {
  it("keeps terminal output expanded through live appends and completion", async () => {
    const trace = createLiveTrace();
    const view = render(createElement(TaskThinkingPanel, { thinking: trace }));
    const outputDisclosure = getOutputDisclosure();

    fireEvent.click(outputDisclosure.querySelector("summary")!);
    expect(outputDisclosure.open).toBe(true);

    const shiftedOutputLines = [
      ...(trace.actionOutputLines ?? []).slice(1),
      {
        id: "output-51",
        toolName: "shell",
        stream: "stdout" as const,
        text: "output line 51",
        timestamp: 1_250,
      },
    ];

    view.rerender(
      createElement(TaskThinkingPanel, {
        thinking: {
          ...trace,
          actionOutputLines: shiftedOutputLines,
          assistantText: "I appended another terminal update.",
        },
      }),
    );

    expect(getOutputDisclosure().open).toBe(true);

    const updatedTrace: TaskThinkingTrace = {
      ...trace,
      actionOutputLines: [
        ...shiftedOutputLines,
        {
          id: "output-52",
          toolName: "shell",
          stream: "stdout",
          text: "Appended after the warning",
          timestamp: 1_400,
        },
      ],
      assistantText: "I appended another execution update.",
      timelineEvents: [
        ...trace.timelineEvents,
        {
          id: "warning",
          kind: "validator",
          phase: "requested-continuation",
          label: "Validator pass 1",
          detail: "Fix the warning before finishing.",
          tone: "warning",
          timestamp: 1_300,
          elapsedMs: 300,
        },
      ],
    };

    view.rerender(
      createElement(TaskThinkingPanel, {
        thinking: updatedTrace,
      }),
    );

    expect(getOutputDisclosure().open).toBe(true);

    view.rerender(
      createElement(TaskThinkingPanel, {
        thinking: {
          ...updatedTrace,
          status: "complete",
          completedAt: 1_500,
        },
      }),
    );

    const expandButton = await screen.findByRole("button", {
      name: "Expand execution details",
    });
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(getOutputDisclosure().open).toBe(true);
    });
  });

  it("allows timeline text selection without changing disclosure controls", () => {
    render(createElement(TaskThinkingPanel, { thinking: createLiveTrace() }));
    const outputDisclosure = getOutputDisclosure();
    const outputSummary = outputDisclosure.querySelector("summary")!;
    const technicalDisclosure = screen
      .getByText("Command and output")
      .closest("details");

    if (!(technicalDisclosure instanceof HTMLDetailsElement)) {
      throw new TypeError("Expected command details to be expandable.");
    }

    fireEvent.click(outputSummary);
    fireEvent.click(technicalDisclosure.querySelector("summary")!);

    const selection = window.getSelection();
    const selectableText = [
      "I am checking the execution timeline.",
      '{"command":"pnpm test task-thinking-panel"}',
      "pnpm test task-thinking-panel",
      "1 representative test failed",
      "Command failed with exit code 1.",
      "warning: checking live output",
    ];

    for (const text of selectableText) {
      const range = document.createRange();
      range.selectNodeContents(screen.getByText(text));
      selection?.removeAllRanges();
      selection?.addRange(range);

      expect(selection?.toString()).toBe(text);
    }

    expect(outputDisclosure.open).toBe(true);
    expect(technicalDisclosure.open).toBe(true);
  });
});
