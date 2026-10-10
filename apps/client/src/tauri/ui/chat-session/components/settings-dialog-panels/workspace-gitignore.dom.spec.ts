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
import type { WorkspaceSettingsControls } from "./types";

afterEach(cleanup);

const createSetup = (
  overrides: Partial<WorkspaceSettingsControls> = {},
): WorkspaceSettingsControls => ({
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
  saving: false,
  message: null,
  onDefaultModeChange: vi.fn(),
  onReasoningModeChange: vi.fn(),
  onReasoningExecutionModeChange: vi.fn(),
  onContextWindowChange: vi.fn(),
  ...overrides,
});

describe("automatic workspace ignore setting", () => {
  it("shows the default and saves enabled and disabled choices", () => {
    const onAutoGitignoreChange = vi.fn();
    const setup = createSetup({ onAutoGitignoreChange });
    const view = render(createElement(WorkspaceSettingsPanel, { setup }));
    const group = screen.getByRole("group", {
      name: "Automatic .gitignore rules",
    });
    expect(
      within(group)
        .getByRole("button", { name: "Enabled" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Disabled" }));
    expect(onAutoGitignoreChange).toHaveBeenCalledWith(false);
    view.rerender(
      createElement(WorkspaceSettingsPanel, {
        setup: { ...setup, autoGitignore: false },
      }),
    );
    expect(
      within(group)
        .getByRole("button", { name: "Disabled" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Enabled" }));
    expect(onAutoGitignoreChange).toHaveBeenLastCalledWith(true);
  });

  it("disables updates while a save is pending", () => {
    const onAutoGitignoreChange = vi.fn();
    render(
      createElement(WorkspaceSettingsPanel, {
        setup: createSetup({ saving: true, onAutoGitignoreChange }),
      }),
    );
    const group = screen.getByRole("group", {
      name: "Automatic .gitignore rules",
    });
    const disabled = within(group).getByRole("button", { name: "Disabled" });
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(disabled);
    expect(onAutoGitignoreChange).not.toHaveBeenCalled();
  });
});
