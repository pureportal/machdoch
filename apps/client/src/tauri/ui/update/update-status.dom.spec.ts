// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellTitlebar } from "../chat-session/components/shell-titlebar";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import type { useDesktopUpdate } from "./use-desktop-update";
import { UpdateStatus } from "./update-status";

afterEach(cleanup);

function updater(
  phase: ReturnType<typeof useDesktopUpdate>["phase"] = "downloading",
) {
  return {
    phase,
    progress: { downloaded: 50, total: 100 },
    canceling: false,
    show: vi.fn(),
    cancel: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useDesktopUpdate>;
}

describe("title bar update status", () => {
  it("shows progress beside the logo and reopens or cancels the download", () => {
    const state = updater();
    render(
      createElement(ShellTitlebar, {
        updateStatus: createElement(UpdateStatus, { updater: state }),
        providerStatuses: [],
        shutdownWhenIdle: {
          enabled: false,
          available: false,
          changing: false,
          error: null,
          toggle: vi.fn(async () => {}),
        },
        onMinimizeWindow: vi.fn(),
        onToggleMaximizeWindow: vi.fn(),
        onCloseWindow: vi.fn(),
      }),
      { wrapper: TooltipProvider },
    );
    expect(screen.getByText("Machdoch")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Update download" })
        .getAttribute("value"),
    ).toBe("50");
    const show = screen.getByRole("button", { name: "Downloading update 50%" });
    expect(show.closest("[data-tauri-no-drag]")).toBeTruthy();
    fireEvent.click(show);
    expect(state.show).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel update download" }),
    );
    expect(state.cancel).toHaveBeenCalledOnce();
  });

  it("handles unknown sizes and bounds progress at 100 percent", () => {
    const state = updater();
    const view = render(
      createElement(UpdateStatus, {
        updater: { ...state, progress: { downloaded: 50 } },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Downloading update…" }),
    ).toBeTruthy();
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    view.rerender(
      createElement(UpdateStatus, {
        updater: { ...state, progress: { downloaded: 150, total: 100 } },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Downloading update 100%" }),
    ).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("100");
  });

  it("disables cancellation while canceling and removes it while installing", () => {
    const state = updater();
    const view = render(
      createElement(UpdateStatus, { updater: { ...state, canceling: true } }),
    );
    expect(screen.getByRole("status").textContent).toBe("Canceling…");
    expect(
      (
        screen.getByRole("button", {
          name: "Cancel update download",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    view.rerender(
      createElement(UpdateStatus, { updater: updater("installing") }),
    );
    expect(screen.getByRole("status").textContent).toBe("Installing update…");
    expect(
      screen.queryByRole("button", { name: "Cancel update download" }),
    ).toBeNull();
  });

  it.each(["idle", "checking", "current", "available", "error"] as const)(
    "does not add a status when %s",
    (phase) => {
      const view = render(
        createElement(UpdateStatus, { updater: updater(phase) }),
      );
      expect(view.container.childElementCount).toBe(0);
    },
  );
});
