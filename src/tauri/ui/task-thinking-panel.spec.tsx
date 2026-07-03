import { act, cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TaskThinkingPanel } from "./task-thinking-panel";
import type { TaskThinkingTrace } from "./task-thinking.model";

const createRunningTrace = (
  startedAt: number,
  overrides: Partial<TaskThinkingTrace> = {},
): TaskThinkingTrace => ({
  status: "running",
  mode: "machdoch",
  startedAt,
  entries: [
    {
      id: "entry-1",
      label: "Starting",
      detail: "Submitting the task.",
      tone: "info",
      timestamp: startedAt,
    },
  ],
  ...overrides,
});

describe("TaskThinkingPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("updates the elapsed runtime while no new progress arrives", () => {
    render(<TaskThinkingPanel thinking={createRunningTrace(Date.now())} />);

    expect(screen.getAllByText("0ms").length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    expect(screen.getByText("1m 01s")).toBeDefined();
  });

  it("does not render a timeout progress bar while thinking is running", () => {
    render(<TaskThinkingPanel thinking={createRunningTrace(Date.now())} />);

    expect(
      screen.queryByRole("progressbar", {
        name: "AI chat timeout progress",
      }),
    ).toBeNull();
  });

  it("surfaces the latest provider reasoning stream in the default view", () => {
    render(
      <TaskThinkingPanel
        thinking={createRunningTrace(Date.now(), {
          modelStream: {
            kind: "reasoning",
            label: "Model reasoning",
            content: "Inspecting the workspace before asking a question.",
          },
        })}
      />,
    );

    expect(screen.getByText("Live reasoning")).toBeDefined();
    expect(
      screen.getByText("Inspecting the workspace before asking a question."),
    ).toBeDefined();
  });
});
