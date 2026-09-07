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
import { DEFAULT_USER_DESKTOP_SETTINGS } from "../../../../../core/runtime-contract.generated.js";
import { DesktopSettingsPanel } from "./desktop-settings-panel";

afterEach(cleanup);

describe("desktop chat timeout settings", () => {
  it("saves the default inactivity limit with the session settings", async () => {
    const onSave = vi.fn();
    render(
      createElement(DesktopSettingsPanel, {
        setup: {
          settings: { ...DEFAULT_USER_DESKTOP_SETTINGS },
          saving: false,
          message: null,
          onSave,
        },
      }),
    );
    const input = screen.getByRole("spinbutton", {
      name: "Chat inactivity timeout in minutes",
    }) as HTMLInputElement;
    expect(input.value).toBe("20");
    fireEvent.change(input, { target: { value: "35" } });
    fireEvent.blur(input);
    await waitFor(
      () =>
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ chatIdleTimeoutMinutes: 35 }),
        ),
      { timeout: 2_000 },
    );
  });
});
