import { describe, expect, it } from "vitest";
import { parseWorkspaceToolWindowRoute } from "./workspace-tool-window-route";

describe("workspace tool window route", () => {
  it("opens Files or Terminal for a workspace and ignores anything else", () => {
    expect(
      parseWorkspaceToolWindowRoute(
        "?tool=terminal&workspace=C%3A%5Cwork%5Capp",
      ),
    ).toEqual({ tool: "terminal", workspaceRoot: "C:\\work\\app" });
    expect(
      parseWorkspaceToolWindowRoute("?instance=1&tool=files&workspace=%2Frepo"),
    ).toEqual({
      tool: "files",
      workspaceRoot: "/repo",
    });
    expect(
      parseWorkspaceToolWindowRoute("?tool=git&workspace=%2Frepo"),
    ).toBeNull();
    expect(
      parseWorkspaceToolWindowRoute("?tool=files&workspace=%20"),
    ).toBeNull();
    expect(parseWorkspaceToolWindowRoute("")).toBeNull();
  });
});
