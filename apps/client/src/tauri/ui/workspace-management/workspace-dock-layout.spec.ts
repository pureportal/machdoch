import { describe, expect, it } from "vitest";
import {
  clampDockPanelSize,
  DEFAULT_WORKSPACE_DOCK_LAYOUT,
  normalizeWorkspaceDockLayout,
  showFilesView,
  toggleTerminalPanel,
} from "./workspace-dock-layout";

describe("workspace dock layout", () => {
  it("restores saved layouts and ignores invalid values", () => {
    expect(normalizeWorkspaceDockLayout(null)).toEqual(
      DEFAULT_WORKSPACE_DOCK_LAYOUT,
    );
    expect(
      normalizeWorkspaceDockLayout({
        filesOpen: true,
        filesDock: "window",
        filesView: "search",
        filesWidth: 700.4,
        terminalOpen: true,
      }),
    ).toEqual({
      filesOpen: true,
      filesDock: "window",
      filesView: "search",
      filesWidth: 700,
      terminalOpen: true,
    });
    expect(
      normalizeWorkspaceDockLayout({
        filesOpen: "yes",
        filesDock: "floating",
        filesView: "tree",
        filesWidth: 20,
      }),
    ).toEqual(DEFAULT_WORKSPACE_DOCK_LAYOUT);
  });

  it("keeps room for the chat when a panel is resized", () => {
    expect(clampDockPanelSize(900, 1000)).toBe(680);
    expect(clampDockPanelSize(100, 1000)).toBe(220);
    expect(clampDockPanelSize(400, 300)).toBe(220);
  });

  it("switches the files view and closes it when the same view is requested again", () => {
    const search = showFilesView(DEFAULT_WORKSPACE_DOCK_LAYOUT, "search");
    expect(search).toMatchObject({ filesOpen: true, filesView: "search" });
    expect(showFilesView(search, "explorer")).toMatchObject({
      filesOpen: true,
      filesView: "explorer",
    });
    expect(showFilesView(search, "search").filesOpen).toBe(false);
    expect(
      showFilesView({ ...search, filesDock: "window" }, "search").filesOpen,
    ).toBe(true);
  });

  it("toggles the terminal", () => {
    expect(
      toggleTerminalPanel(DEFAULT_WORKSPACE_DOCK_LAYOUT).terminalOpen,
    ).toBe(true);
  });
});
