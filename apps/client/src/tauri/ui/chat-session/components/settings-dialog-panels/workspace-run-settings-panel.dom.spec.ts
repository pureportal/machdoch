// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_WORKSPACE_RUN_SETTINGS } from "../../../../../core/runtime-contract.generated.js";
import { WorkspaceRunSettingsPanel } from "./workspace-run-settings-panel";

afterEach(() => {
  cleanup();
});

describe("Workspace Run settings panel UI", () => {
  it("shows and edits every global timeout setting", () => {
    render(
      createElement(WorkspaceRunSettingsPanel, {
        setup: {
          settings: { ...DEFAULT_USER_WORKSPACE_RUN_SETTINGS },
          saving: false,
          message: null,
          onSave: () => undefined,
        },
      }),
    );

    const inputs = [
      "Startup delay in milliseconds",
      "Health check interval in milliseconds",
      "Health check timeout in milliseconds",
      "Health check failure threshold",
      "Sequential readiness timeout in milliseconds",
    ].map((label) => screen.getByRole("spinbutton", { name: label }));

    expect(inputs).toHaveLength(5);
    fireEvent.change(inputs[1], { target: { value: "7000" } });
    expect((inputs[1] as HTMLInputElement).value).toBe("7000");
  });
});
