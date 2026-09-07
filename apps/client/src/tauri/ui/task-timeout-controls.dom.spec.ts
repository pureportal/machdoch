// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDesktopTaskTimeout } from "./runtime";
import { TaskTimeoutControls } from "./task-timeout-controls";
import { TaskThinkingPanel } from "./task-thinking-panel";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
} from "./task-thinking.model";

vi.mock("./runtime", () => ({ resetDesktopTaskTimeout: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

afterEach(() => {
  cleanup();
  vi.mocked(resetDesktopTaskTimeout).mockReset();
});

const openControls = (): HTMLInputElement => {
  render(
    createElement(TaskTimeoutControls, {
      taskId: "chat-1",
      idleTimeoutMs: 1_200_000,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Adjust chat timeout" }));
  return screen.getByRole("spinbutton", {
    name: "Inactivity (minutes)",
  }) as HTMLInputElement;
};

describe("chat timeout controls", () => {
  it("refreshes the running progress bar without adding execution log entries", () => {
    const now = Date.now();
    const trace = {
      ...createInitialThinkingTrace("ask", now - 600_000),
      task: "Inspect the workspace",
      timeout: {
        startedAt: now - 600_000,
        lastActivityAt: now - 600_000,
        idleTimeoutMs: 1_200_000,
        absoluteTimeoutMs: null,
      },
    };
    const view = render(
      createElement(TaskThinkingPanel, { taskId: "chat-1", thinking: trace }),
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "50",
    );
    expect(
      screen.getByRole("button", { name: "Adjust chat timeout" }),
    ).toBeTruthy();
    const updated = appendThinkingProgress(
      trace,
      {
        task: "",
        mode: "machdoch",
        state: "executing",
        message: "",
        cancellable: true,
        executedTools: [],
        outputSections: [],
        timeout: {
          ...trace.timeout,
          lastActivityAt: now,
          idleTimeoutMs: 2_400_000,
        },
      },
      now,
    );
    expect(updated.timelineEvents).toEqual(trace.timelineEvents);
    expect(updated.task).toBe(trace.task);
    expect(updated.mode).toBe("ask");
    view.rerender(
      createElement(TaskThinkingPanel, { taskId: "chat-1", thinking: updated }),
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "0",
    );
    view.rerender(
      createElement(TaskThinkingPanel, {
        taskId: "chat-1",
        thinking: { ...updated, status: "complete" },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Adjust chat timeout" }),
    ).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("resets the active timer without applying an edited duration", async () => {
    const input = openControls();
    expect(input.value).toBe("20");
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    await waitFor(() =>
      expect(resetDesktopTaskTimeout).toHaveBeenCalledWith("chat-1", undefined),
    );
    await waitFor(() => expect(screen.queryByRole("spinbutton")).toBeNull());
  });

  it("applies a valid duration to the active run and prevents invalid submissions", async () => {
    const input = openControls();
    const apply = screen.getByRole("button", {
      name: "Apply and reset",
    }) as HTMLButtonElement;
    for (const value of ["", "0", "1.5", "1441"]) {
      fireEvent.change(input, { target: { value } });
      expect(apply.disabled).toBe(true);
    }
    expect(resetDesktopTaskTimeout).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.click(apply);
    await waitFor(() =>
      expect(resetDesktopTaskTimeout).toHaveBeenCalledWith("chat-1", 45),
    );
  });

  it("keeps errors visible and permits retry after the request fails", async () => {
    vi.mocked(resetDesktopTaskTimeout).mockRejectedValueOnce(
      "This chat run has already stopped.",
    );
    openControls();
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This chat run has already stopped.",
    );
    expect(
      (screen.getByRole("button", { name: "Reset timer" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
