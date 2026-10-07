// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Update } from "@tauri-apps/plugin-updater";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateDialog } from "./update-dialog";
import type { useDesktopUpdate } from "./use-desktop-update";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(cleanup);

function updater(
  phase: ReturnType<typeof useDesktopUpdate>["phase"] = "available",
): ReturnType<typeof useDesktopUpdate> {
  return {
    phase,
    open: true,
    release: { currentVersion: "1.0.0", version: "2.0.0" } as Update,
    error: null,
    progress: { downloaded: 50, total: 100 },
    saving: false,
    defer: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    check: vi.fn(() => true),
    close: vi.fn(),
  };
}

describe("update dialog", () => {
  it("lets the user skip one release", () => {
    const state = updater();
    render(
      React.createElement(UpdateDialog, { updater: state, blocked: false }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Remind me" }), {
      target: { value: "release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip this release" }));
    expect(state.defer).toHaveBeenCalledWith("release");
    expect(state.install).not.toHaveBeenCalled();
  });

  it("shows download progress and prevents closing during installation", () => {
    const state = updater("downloading");
    render(
      React.createElement(UpdateDialog, { updater: state, blocked: false }),
    );
    expect(
      screen
        .getByRole("progressbar", { name: "Update download" })
        .getAttribute("value"),
    ).toBe("50");
    expect(
      screen.queryByRole("button", { name: "Update and restart" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(state.close).not.toHaveBeenCalled();
  });

  it("retries a failed check without offering an earlier cached update", () => {
    const state = {
      ...updater("error"),
      error: "Could not check for updates.",
    };
    render(
      React.createElement(UpdateDialog, { updater: state, blocked: false }),
    );
    expect(screen.getByRole("alert").textContent).toBe(state.error);
    expect(
      screen.queryByRole("button", { name: "Update and restart" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.check).toHaveBeenCalledOnce();
  });

  it("offers another restart after installation", () => {
    const state = updater("installed");
    render(
      React.createElement(UpdateDialog, { updater: state, blocked: false }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart Machdoch" }));
    expect(state.restart).toHaveBeenCalledOnce();
    expect(state.install).not.toHaveBeenCalled();
  });
});
