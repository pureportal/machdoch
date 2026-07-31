import { createElement, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskThinkingPanel } from "./task-thinking-panel.tsx";
import type { TaskThinkingTrace } from "./task-thinking.model.ts";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const useState = (<State>(
    initialState: State | (() => State),
  ): [State, (value: SetStateAction<State>) => void] => {
    const [value, setValue] = react.useState(initialState);
    const renderedValue =
      value === "timeline" ? "streams" : value === true ? false : value;

    return [renderedValue as State, setValue];
  }) as typeof react.useState;

  return {
    ...react,
    useState,
  };
});

const createThinkingTrace = (
  modelStream: TaskThinkingTrace["modelStream"],
  overrides: Partial<TaskThinkingTrace> = {},
): TaskThinkingTrace => ({
  status: "complete",
  mode: "machdoch",
  startedAt: 1_000,
  completedAt: 1_200,
  timelineEvents: [
    {
      id: "timeline-1",
      kind: "state",
      phase: "completed",
      label: "Executing",
      detail: "Working on the task.",
      tone: "info",
      timestamp: 1_100,
      elapsedMs: 100,
    },
  ],
  modelStream,
  ...overrides,
});

const renderStreamsView = (thinking: TaskThinkingTrace): string => {
  return renderToStaticMarkup(createElement(TaskThinkingPanel, { thinking }));
};

describe("TaskThinkingPanel Streams view", () => {
  it("does not render provider status cards", () => {
    const markup = renderStreamsView(
      createThinkingTrace({
        kind: "status",
        label: "OpenAI response stream completed.",
        content: "response.completed",
        complete: true,
      }),
    );

    expect(markup).toContain("Execution timeline");
    expect(markup).toContain("Streams");
    expect(markup).not.toMatch(/provider status/iu);
    expect(markup).not.toContain("OpenAI response stream completed.");
    expect(markup).not.toContain("response.completed");
    expect(markup).toContain("No stream output yet.");
  });

  it("keeps other stream cards and timeline controls", () => {
    const markup = renderStreamsView(
      createThinkingTrace(
        {
          kind: "tool-result",
          label: "Read workspace file",
          content: "File contents",
          complete: true,
        },
        {
          assistantText: "Finished the requested change.",
          actionOutputLines: [
            {
              id: "output-1",
              toolName: "shell",
              stream: "stdout",
              text: "Focused checks passed.",
              timestamp: 1_150,
            },
          ],
        },
      ),
    );

    expect(markup).toContain("Timeline");
    expect(markup).toContain("Streams");
    expect(markup).toContain("Replay");
    expect(markup).toContain("Tool result");
    expect(markup).toContain("Read workspace file");
    expect(markup).toContain("File contents");
    expect(markup).toContain("Live response");
    expect(markup).toContain("Finished the requested change.");
    expect(markup).toContain("Stdout / stderr");
    expect(markup).toContain("Focused checks passed.");
  });
});
