// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { createElement, useState, type JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceDetailNavigation,
  type WorkspaceDetailSection,
  workspaceDetailPanelId,
  workspaceDetailTabId,
} from "./workspace-detail-navigation";

const NavigationHarness = (): JSX.Element => {
  const [section, setSection] = useState<WorkspaceDetailSection>("output");
  return createElement(
    "main",
    null,
    createElement(WorkspaceDetailNavigation, {
      activeSection: section,
      onSectionChange: setSection,
    }),
    createElement("div", {
      id: workspaceDetailPanelId(section),
      role: "tabpanel",
      "aria-labelledby": workspaceDetailTabId(section),
    }),
  );
};

afterEach(() => cleanup());

describe("WorkspaceDetailNavigation", () => {
  it("shows one active section and changes it with pointer and keyboard input", () => {
    render(createElement(NavigationHarness));

    const output = screen.getByRole("tab", { name: "Output" });
    const files = screen.getByRole("tab", { name: "Files" });
    expect(output.getAttribute("aria-selected")).toBe("true");
    expect(files.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(files);
    expect(files.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("tab", { name: "Configuration" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    const memory = screen.getByRole("tab", { name: "Memory" });
    fireEvent.click(memory);
    expect(memory.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(memory, { key: "End" });
    expect(
      screen
        .getByRole("tab", { name: "Settings" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("has no automated accessibility violations", async () => {
    render(createElement(NavigationHarness));
    const accessibility = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });
});
