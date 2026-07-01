import { act, cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TASK_EXECUTION_TIMEOUT_MS } from "../../core/_helpers/agent-runtime-types.js";
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

  it("renders a bottom fill bar for progress toward the activity timeout", () => {
    const startedAt = Date.now() - TASK_EXECUTION_TIMEOUT_MS / 2;

    render(<TaskThinkingPanel thinking={createRunningTrace(startedAt)} />);

    const progressbar = screen.getByRole("progressbar", {
      name: "AI chat timeout progress",
    });
    const fill = progressbar.firstElementChild;

    expect(progressbar.getAttribute("aria-valuenow")).toBe("50");
    expect(fill?.getAttribute("style")).toContain("width: 50%");
  });
});
