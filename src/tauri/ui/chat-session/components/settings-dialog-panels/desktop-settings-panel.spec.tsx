import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_DESKTOP_SETTINGS } from "../../../../../core/runtime-contract.generated.js";
import {
  disableInvokeMock,
  enableInvokeMock,
  invokeMock,
  isTauriMock,
} from "../../../test/tauri-test-mocks";
import { DesktopSettingsPanel } from "./desktop-settings-panel";
import type { DesktopSettingsControls } from "./types";

const createSetup = (
  settings: DesktopSettingsControls["settings"] = {
    ...DEFAULT_USER_DESKTOP_SETTINGS,
  },
): DesktopSettingsControls => ({
  settings,
  saving: false,
  message: null,
  onSave: vi.fn(),
});

describe("DesktopSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);
    enableInvokeMock();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    disableInvokeMock();
    vi.useRealTimers();
  });

  it("disables settings that depend on inactive desktop features", () => {
    const { container } = render(
      <DesktopSettingsPanel setup={createSetup()} />,
    );
    const panels = Array.from(
      container.querySelectorAll<HTMLElement>("[data-setting-panel]"),
    );
    const startupBehavior = panels.find((panel) =>
      panel.textContent?.includes("Startup behavior"),
    );

    expect(
      startupBehavior?.querySelector<HTMLButtonElement>("button"),
    ).toHaveProperty("disabled", true);

    const floatingBubble = panels.find((panel) =>
      panel.textContent?.includes("Floating bubble"),
    );
    fireEvent.click(
      Array.from(floatingBubble?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Disabled",
      ) as HTMLButtonElement,
    );

    const fullscreenApps = panels.find((panel) =>
      panel.textContent?.includes("Fullscreen apps"),
    );
    expect(
      fullscreenApps?.querySelector<HTMLButtonElement>("button"),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByLabelText("Temporary bubble hide duration in seconds"),
    ).toHaveProperty("disabled", true);
  });

  it("does not auto-save an empty global shortcut", async () => {
    vi.useFakeTimers();
    const setup = createSetup();
    render(<DesktopSettingsPanel setup={setup} />);

    fireEvent.change(screen.getByLabelText("Quick Chat global shortcut"), {
      target: { value: " " },
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(screen.getByText("Enter a shortcut before saving.")).toBeTruthy();
    expect(setup.onSave).not.toHaveBeenCalled();
  });

  it("can disable Quick Chat after an invalid shortcut draft", async () => {
    vi.useFakeTimers();
    const setup = createSetup();
    const { container } = render(<DesktopSettingsPanel setup={setup} />);

    fireEvent.change(screen.getByLabelText("Quick Chat global shortcut"), {
      target: { value: " " },
    });
    const quickChatPanel = Array.from(
      container.querySelectorAll<HTMLElement>("[data-setting-panel]"),
    ).find((panel) => panel.textContent?.trim().startsWith("Quick Chat"));
    fireEvent.click(
      Array.from(quickChatPanel?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Disabled",
      ) as HTMLButtonElement,
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(screen.queryByText("Enter a shortcut before saving.")).toBeNull();
    expect(setup.onSave).toHaveBeenCalledWith({
      ...DEFAULT_USER_DESKTOP_SETTINGS,
      quickVoiceEnabled: false,
      quickVoiceShortcut: DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceShortcut,
    });
  });

  it("preserves a dirty shortcut when newer external settings arrive", () => {
    const initialSetup = createSetup();
    const { container, rerender } = render(
      <DesktopSettingsPanel setup={initialSetup} />,
    );
    const shortcutInput = screen.getByDisplayValue(
      DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceShortcut,
    );

    fireEvent.change(shortcutInput, {
      target: { value: "CommandOrControl+Shift+Y" },
    });
    rerender(
      <DesktopSettingsPanel
        setup={createSetup({
          ...DEFAULT_USER_DESKTOP_SETTINGS,
          assistantBubbleEnabled:
            !DEFAULT_USER_DESKTOP_SETTINGS.assistantBubbleEnabled,
        })}
      />,
    );

    expect(
      screen.getByDisplayValue("CommandOrControl+Shift+Y"),
    ).toBe(shortcutInput);
    const floatingBubblePanel = Array.from(
      container.querySelectorAll<HTMLElement>("[data-setting-panel]"),
    ).find((panel) => panel.textContent?.includes("Floating bubble"));
    expect(
      floatingBubblePanel?.querySelector('[aria-pressed="true"]')?.textContent,
    ).toContain("Disabled");
  });

  it("clears native WebView data without changing desktop settings", async () => {
    const setup = createSetup();
    render(<DesktopSettingsPanel setup={setup} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("clear_webview_cache");
      expect(screen.getByText("WebView cache cleared.")).toBeTruthy();
    });
    expect(setup.onSave).not.toHaveBeenCalled();
  });

  it("reports and clears only Machdoch-attributed Codex session data", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_machdoch_codex_session_usage") {
        return Promise.resolve({ files: 2, bytes: 2_048 });
      }

      if (command === "clear_machdoch_codex_sessions") {
        return Promise.resolve({
          deletedFiles: 2,
          deletedBytes: 2_048,
          failedFiles: 0,
          remainingFiles: 0,
          remainingBytes: 0,
        });
      }

      return Promise.resolve(undefined);
    });

    render(<DesktopSettingsPanel setup={createSetup()} />);
    fireEvent.click(screen.getByRole("button", { name: "Check usage" }));

    await screen.findByText("2 files · 2.00 KB");
    fireEvent.click(
      screen.getByRole("button", { name: "Clear Machdoch data" }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "clear_machdoch_codex_sessions",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete files" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "clear_machdoch_codex_sessions",
      );
      expect(screen.getByText("Removed 2 files (2.00 KB).")).toBeTruthy();
    });
  });
});
