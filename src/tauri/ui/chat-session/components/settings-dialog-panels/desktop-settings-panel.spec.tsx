import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_DESKTOP_SETTINGS } from "../../../../../core/runtime-contract.generated.js";
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
});
