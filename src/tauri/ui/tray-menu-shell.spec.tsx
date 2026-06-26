import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrayMenuShell } from "./tray-menu-shell";
import {
  currentWindowMock,
  isTauriMock,
  Window,
  windowFocusChangedListeners,
} from "./test/tauri-test-mocks";

const createMainWindowMock = ({
  visible,
  minimized = false,
}: {
  visible: boolean;
  minimized?: boolean;
}): typeof currentWindowMock => ({
  ...currentWindowMock,
  label: "main",
  isMinimized: vi.fn().mockResolvedValue(minimized),
  isVisible: vi.fn().mockResolvedValue(visible),
});

describe("TrayMenuShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);
    windowFocusChangedListeners.clear();
    Window.getByLabel.mockResolvedValue(
      createMainWindowMock({ visible: true }),
    );
  });

  afterEach(() => {
    cleanup();
    windowFocusChangedListeners.clear();
  });

  it("hides the tray hide action when the main window is not open", async () => {
    Window.getByLabel.mockResolvedValue(
      createMainWindowMock({ visible: false }),
    );

    render(<TrayMenuShell />);

    await waitFor(() => {
      expect(Window.getByLabel).toHaveBeenCalledWith("main");
    });

    expect(
      screen.queryByRole("button", { name: "Hide to tray" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open machdoch" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Quit machdoch" }),
    ).toBeDefined();
  });

  it("shows the tray hide action when the main window is open", async () => {
    render(<TrayMenuShell />);

    expect(
      await screen.findByRole("button", { name: "Hide to tray" }),
    ).toBeDefined();
  });

  it("shows the tray hide action when the main window is minimized", async () => {
    Window.getByLabel.mockResolvedValue(
      createMainWindowMock({ visible: false, minimized: true }),
    );

    render(<TrayMenuShell />);

    expect(
      await screen.findByRole("button", { name: "Hide to tray" }),
    ).toBeDefined();
  });

  it("refreshes the tray hide action when the tray menu is focused", async () => {
    Window.getByLabel.mockResolvedValue(
      createMainWindowMock({ visible: false }),
    );

    render(<TrayMenuShell />);

    await waitFor(() => {
      expect(windowFocusChangedListeners.size).toBe(1);
      expect(Window.getByLabel).toHaveBeenCalledWith("main");
    });

    expect(
      screen.queryByRole("button", { name: "Hide to tray" }),
    ).toBeNull();

    Window.getByLabel.mockResolvedValue(
      createMainWindowMock({ visible: true }),
    );

    await act(async () => {
      for (const listener of windowFocusChangedListeners) {
        listener({ payload: true });
      }
    });

    expect(
      await screen.findByRole("button", { name: "Hide to tray" }),
    ).toBeDefined();
  });
});
