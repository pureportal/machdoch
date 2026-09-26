// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSettingsPanel } from "./workspace-settings-panel";

afterEach(cleanup);

describe("adaptive controller workspace setting", () => {
  it("offers inheritance and explicit workspace overrides", () => {
    const onAdaptiveControllerOverrideChange = vi.fn();
    render(
      createElement(WorkspaceSettingsPanel, {
        setup: {
          workspaceRoot: "C:/workspace",
          workspaceLabel: "workspace",
          defaultMode: "machdoch",
          effectiveMode: "machdoch",
          defaultReasoning: "default",
          effectiveReasoning: "default",
          defaultReasoningExecutionMode: "standard",
          effectiveReasoningExecutionMode: "standard",
          defaultContextWindow: "default",
          effectiveContextWindow: "default",
          adaptiveControllerOverride: null,
          saving: false,
          message: null,
          onDefaultModeChange: vi.fn(),
          onAdaptiveControllerOverrideChange,
          onReasoningModeChange: vi.fn(),
          onReasoningExecutionModeChange: vi.fn(),
          onContextWindowChange: vi.fn(),
        },
      }),
    );
    const group = screen.getByRole("group", {
      name: "Adaptive context & compute override",
    });
    fireEvent.click(within(group).getByRole("button", { name: "Disabled" }));
    fireEvent.click(within(group).getByRole("button", { name: "Default" }));
    expect(onAdaptiveControllerOverrideChange).toHaveBeenNthCalledWith(
      1,
      false,
    );
    expect(onAdaptiveControllerOverrideChange).toHaveBeenNthCalledWith(2, null);
  });
});
