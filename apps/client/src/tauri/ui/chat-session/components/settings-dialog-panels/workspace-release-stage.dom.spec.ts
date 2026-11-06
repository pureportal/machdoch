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

const isPressed = (group: HTMLElement, name: string): boolean =>
  within(group).getByRole("button", { name }).getAttribute("aria-pressed") ===
  "true";

describe("workspace release stage setting", () => {
  it("defaults to Unset and saves each stage", () => {
    const onReleaseStageChange = vi.fn();
    const setup = createSetup({ releaseStage: null, onReleaseStageChange });
    const view = render(createElement(WorkspaceSettingsPanel, { setup }));
    const group = screen.getByRole("group", { name: "Release stage" });

    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Unset", "Early Alpha", "Beta", "In Production"]);
    expect(isPressed(group, "Unset")).toBe(true);

    fireEvent.click(within(group).getByRole("button", { name: "Early Alpha" }));
    fireEvent.click(within(group).getByRole("button", { name: "Beta" }));
    fireEvent.click(
      within(group).getByRole("button", { name: "In Production" }),
    );
    expect(onReleaseStageChange.mock.calls).toEqual([
      ["early-alpha"],
      ["beta"],
      ["production"],
    ]);

    view.rerender(
      createElement(WorkspaceSettingsPanel, {
        setup: { ...setup, releaseStage: "production" },
      }),
    );
    expect(isPressed(group, "In Production")).toBe(true);
    fireEvent.click(within(group).getByRole("button", { name: "Unset" }));
    expect(onReleaseStageChange).toHaveBeenLastCalledWith(null);
  });

  it("disables updates while a save is pending", () => {
    const onReleaseStageChange = vi.fn();
    render(
      createElement(WorkspaceSettingsPanel, {
        setup: createSetup({ saving: true, onReleaseStageChange }),
      }),
    );
    const beta = within(
      screen.getByRole("group", { name: "Release stage" }),
    ).getByRole("button", { name: "Beta" });

    expect((beta as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(beta);
    expect(onReleaseStageChange).not.toHaveBeenCalled();
  });
});
