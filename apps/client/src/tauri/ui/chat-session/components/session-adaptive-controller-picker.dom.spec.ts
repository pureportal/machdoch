// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { SessionAdaptiveControllerPicker } from "./session-adaptive-controller-picker";

afterEach(cleanup);

describe("adaptive controller session picker", () => {
  it("selects an explicit session override", async () => {
    const onChange = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(SessionAdaptiveControllerPicker, {
          override: null,
          onChange,
        }),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Adaptive context & compute: Default",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Disabled" }),
    );
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
