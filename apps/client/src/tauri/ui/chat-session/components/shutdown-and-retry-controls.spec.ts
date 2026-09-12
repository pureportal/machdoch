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
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS } from "../../../../core/runtime-contract.generated.js";
import { ShellTitlebar, type ShellTitlebarProps } from "./shell-titlebar";
import { AgentLimitsSettingsPanel } from "./settings-dialog-panels/agent-limits-settings-panel";
import type { AgentLimitsSettingsControls } from "./settings-dialog-panels/types";
import { TooltipProvider } from "../../components/ui/tooltip";

vi.mock("../../runtime", () => ({
  loadProviderModelCatalog: vi.fn(async () => ({
    providers: [],
    generatedAt: 0,
  })),
}));
afterEach(cleanup);

describe("shutdown and retry controls", () => {
  it("places an accessible shutdown toggle alongside the window controls with an active state", () => {
    const props: ShellTitlebarProps = {
      providerStatuses: [],
      onMinimizeWindow: vi.fn(),
      onToggleMaximizeWindow: vi.fn(),
      onCloseWindow: vi.fn(),
      shutdownWhenIdle: {
        enabled: false,
        available: true,
        changing: false,
        error: null,
        toggle: vi.fn(async () => undefined),
      },
    };
    const view = render(createElement(ShellTitlebar, props), {
      wrapper: TooltipProvider,
    });
    const toggle = screen.getByRole("button", {
      name: "Shut down PC when work finishes",
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Shut down PC when work finishes",
      "Minimize window",
      "Maximize or restore window",
      "Close window",
    ]);
    fireEvent.click(toggle);
    expect(props.shutdownWhenIdle.toggle).toHaveBeenCalledTimes(1);
    view.rerender(
      createElement(ShellTitlebar, {
        ...props,
        shutdownWhenIdle: { ...props.shutdownWhenIdle, enabled: true },
      }),
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.className).toContain("amber");
  });

  it("saves a global retry count separately from the initial execution and hides it when disabled", async () => {
    const setup: AgentLimitsSettingsControls = {
      settings: { ...DEFAULT_USER_AGENT_LIMITS_SETTINGS },
      reviewModelSettings: { mode: "base" },
      providerAvailability: [],
      saving: false,
      message: null,
      onSave: vi.fn(async () => undefined),
      onReviewModelSave: vi.fn(),
    };
    render(createElement(AgentLimitsSettingsPanel, { setup }));
    expect(screen.getByText("After the initial execution.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Retry attempts"), {
      target: { value: "3" },
    });
    fireEvent.blur(screen.getByLabelText("Retry attempts"));
    await waitFor(
      () =>
        expect(setup.onSave).toHaveBeenCalledWith(
          expect.objectContaining({ automaticRetries: true, retryAttempts: 3 }),
        ),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(screen.queryByLabelText("Retry attempts")).toBeNull();
    await waitFor(
      () =>
        expect(setup.onSave).toHaveBeenCalledWith(
          expect.objectContaining({ automaticRetries: false }),
        ),
      { timeout: 3000 },
    );
  });
});
