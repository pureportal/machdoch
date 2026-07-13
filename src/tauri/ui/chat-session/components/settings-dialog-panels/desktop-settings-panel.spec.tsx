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

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "clear_machdoch_codex_sessions",
      );
      expect(screen.getByText("Removed 2 files (2.00 KB).")).toBeTruthy();
    });
  });
});
