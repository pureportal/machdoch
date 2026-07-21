import { act, cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  TASK_EXECUTION_IDLE_TIMEOUT_MS,
} from "../../core/_helpers/task-execution-timeouts.js";
import { TaskThinkingPanel } from "./task-thinking-panel";
import type { TaskThinkingTrace } from "./task-thinking.model";

const CONFIGURED_TASK_TIMEOUT_MS = 5 * 60 * 1_000;

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

  it("does not show a timeout bar before the execution watchdog starts", () => {
    render(<TaskThinkingPanel thinking={createRunningTrace(Date.now())} />);

    expect(
      screen.queryByRole("progressbar", { name: "AI chat timeout progress" }),
    ).toBeNull();
  });

  it("renders and resets progress toward the inactivity timeout", () => {
    const now = Date.now();
    const startedAt = now - TASK_EXECUTION_IDLE_TIMEOUT_MS * 0.9;
    const { rerender } = render(
      <TaskThinkingPanel
        thinking={createRunningTrace(startedAt, {
          lastActivityAt: startedAt,
          timeout: {
            startedAt,
            lastActivityAt: startedAt,
            idleTimeoutMs: TASK_EXECUTION_IDLE_TIMEOUT_MS,
            absoluteTimeoutMs: null,
          },
        })}
      />,
    );

    const progressbar = screen.getByRole("progressbar", {
      name: "AI chat timeout progress",
    });
    const fill = progressbar.firstElementChild;

    expect(progressbar.getAttribute("aria-valuenow")).toBe("90");
    expect(fill?.getAttribute("class")).toContain("bg-rose-300/70");

    rerender(
      <TaskThinkingPanel
        thinking={createRunningTrace(startedAt, {
          lastActivityAt: now,
          timeout: {
            startedAt,
            lastActivityAt: now,
            idleTimeoutMs: TASK_EXECUTION_IDLE_TIMEOUT_MS,
            absoluteTimeoutMs: null,
          },
          modelStream: {
            kind: "assistant",
            label: "Assistant draft",
            content: "Streaming a response.",
          },
        })}
      />,
    );

    expect(progressbar.getAttribute("aria-valuenow")).toBe("0");
    expect(fill?.getAttribute("style")).toContain("width: 0%");
  });

  it("uses the twenty-minute inactivity window", () => {
    const now = Date.now();
    const startedAt = now - 2 * 60 * 1_000;

    render(
      <TaskThinkingPanel
        thinking={createRunningTrace(startedAt, {
          lastActivityAt: startedAt,
          timeout: {
            startedAt,
            lastActivityAt: startedAt,
            idleTimeoutMs: TASK_EXECUTION_IDLE_TIMEOUT_MS,
            absoluteTimeoutMs: null,
          },
        })}
      />,
    );

    const progressbar = screen.getByRole("progressbar", {
      name: "AI chat timeout progress",
    });

    expect(progressbar.getAttribute("aria-valuenow")).toBe("10");
  });

  it("shows the absolute execution deadline when it is closer", () => {
    const now = Date.now();
    const startedAt = now - CONFIGURED_TASK_TIMEOUT_MS * 0.95;

    render(
      <TaskThinkingPanel
        thinking={createRunningTrace(startedAt, {
          lastActivityAt: now,
          timeout: {
            startedAt,
            lastActivityAt: now,
            idleTimeoutMs: TASK_EXECUTION_IDLE_TIMEOUT_MS,
            absoluteTimeoutMs: CONFIGURED_TASK_TIMEOUT_MS,
          },
        })}
      />,
    );

    const progressbar = screen.getByRole("progressbar", {
      name: "AI chat timeout progress",
    });

    expect(progressbar.getAttribute("aria-valuenow")).toBe("95");
    expect(progressbar.getAttribute("aria-valuetext")).toContain(
      "absolute execution timeout",
    );
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
