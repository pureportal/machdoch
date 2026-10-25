// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSettingsPanel } from "./workspace-settings-panel";
import type { WorkspaceSettingsControls } from "./types";

afterEach(cleanup);

it.each(["openai", "codex-cli", null] as const)(
  "shows workspace context presets for %s",
  (provider) => {
    const onContextWindowChange = vi.fn();
    const setup: WorkspaceSettingsControls = {
      workspaceRoot: "C:/workspace",
      workspaceLabel: "workspace",
      reasoningProvider: provider ?? undefined,
      defaultMode: "machdoch",
      effectiveMode: "machdoch",
      defaultReasoning: "default",
      effectiveReasoning: "default",
      defaultReasoningExecutionMode: "standard",
      effectiveReasoningExecutionMode: "standard",
      defaultContextWindow: "highest",
      effectiveContextWindow: "highest",
      saving: false,
      message: null,
      onDefaultModeChange: vi.fn(),
      onReasoningModeChange: vi.fn(),
      onReasoningExecutionModeChange: vi.fn(),
      onContextWindowChange,
    };
    render(createElement(WorkspaceSettingsPanel, { setup }));
    const group = within(
      screen.getByRole("group", { name: "Default workspace context size" }),
    );
    expect(
      group.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Lowest", "Provider Default", "Highest"]);
    expect(
      group
        .getByRole("button", { name: "Highest" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(group.getByRole("button", { name: "Lowest" }));
    expect(onContextWindowChange).toHaveBeenCalledWith("lowest");
    expect(screen.queryByRole("spinbutton")).toBeNull();
  },
);
