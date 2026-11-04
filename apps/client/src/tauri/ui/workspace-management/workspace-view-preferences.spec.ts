import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_VIEW_PREFERENCES,
  parseWorkspaceViewPreferences,
  reconcileWorkspaceSelection,
  withRememberedRepository,
  type WorkspaceViewPreferences,
} from "./workspace-view-preferences";

const preferences = (
  overrides: Partial<WorkspaceViewPreferences>,
): WorkspaceViewPreferences => ({
  ...DEFAULT_WORKSPACE_VIEW_PREFERENCES,
  ...overrides,
});

describe("workspace view preferences", () => {
  it("defaults to the Git section for missing or malformed storage", () => {
    expect(parseWorkspaceViewPreferences(null)).toEqual(
      DEFAULT_WORKSPACE_VIEW_PREFERENCES,
    );
    expect(parseWorkspaceViewPreferences("{")).toEqual(
      DEFAULT_WORKSPACE_VIEW_PREFERENCES,
    );
    expect(parseWorkspaceViewPreferences("[]").section).toBe("git");
    expect(
      parseWorkspaceViewPreferences(
        JSON.stringify({
          section: "output",
          gitSection: "status",
          selectedWorkspaceKey: 4,
          repositoryRoots: { a: "C:\\a", b: 3, c: "" },
        }),
      ),
    ).toEqual({
      ...DEFAULT_WORKSPACE_VIEW_PREFERENCES,
      repositoryRoots: { a: "C:\\a" },
    });
  });

  it("restores valid sections and selections", () => {
    expect(
      parseWorkspaceViewPreferences(
        JSON.stringify({
          section: "files",
          gitSection: "branches",
          selectedWorkspaceKey: "c:/work",
          activeWorkspaceKey: "c:/chat",
        }),
      ),
    ).toEqual({
      section: "files",
      gitSection: "branches",
      selectedWorkspaceKey: "c:/work",
      activeWorkspaceKey: "c:/chat",
      repositoryRoots: {},
    });
  });

  it("remembers a bounded set of repository selections", () => {
    let current = DEFAULT_WORKSPACE_VIEW_PREFERENCES;
    for (let index = 0; index < 70; index += 1) {
      current = withRememberedRepository(
        current,
        `w${index}`,
        `C:\\repo${index}`,
      );
    }
    expect(Object.keys(current.repositoryRoots)).toHaveLength(64);
    expect(current.repositoryRoots.w0).toBeUndefined();
    expect(current.repositoryRoots.w69).toBe("C:\\repo69");
    expect(withRememberedRepository(current, "w69", "C:\\repo69")).toBe(
      current,
    );
    current = withRememberedRepository(current, "w10", "C:\\other");
    expect(Object.keys(current.repositoryRoots).at(-1)).toBe("w10");
  });

  it("keeps the browsed workspace until the chat switches workspaces", () => {
    const stored = preferences({
      selectedWorkspaceKey: "b",
      activeWorkspaceKey: "a",
    });
    expect(reconcileWorkspaceSelection(stored, null, "a", ["a", "b"])).toEqual({
      selection: "b",
      preferences: stored,
    });
    expect(
      reconcileWorkspaceSelection(stored, "b", "c", ["a", "b", "c"]),
    ).toEqual({
      selection: "c",
      preferences: {
        ...stored,
        selectedWorkspaceKey: "c",
        activeWorkspaceKey: "c",
      },
    });
    expect(reconcileWorkspaceSelection(stored, null, null, ["x"])).toEqual({
      selection: "x",
      preferences: stored,
    });
    expect(reconcileWorkspaceSelection(stored, "b", "a", [])).toEqual({
      selection: null,
      preferences: stored,
    });
  });

  it("does not replace the remembered workspace while the list is loading", () => {
    const stored = preferences({
      selectedWorkspaceKey: "b",
      activeWorkspaceKey: "a",
    });
    const partial = reconcileWorkspaceSelection(stored, null, null, ["a"]);
    expect(partial).toEqual({ selection: "a", preferences: stored });
    expect(
      reconcileWorkspaceSelection(partial.preferences, partial.selection, "a", [
        "a",
        "b",
      ]),
    ).toEqual({ selection: "b", preferences: stored });
  });

  it("defers a chat workspace change until that workspace is listed", () => {
    const stored = preferences({
      selectedWorkspaceKey: "b",
      activeWorkspaceKey: "a",
    });
    const pending = reconcileWorkspaceSelection(stored, "b", "c", ["a", "b"]);
    expect(pending).toEqual({ selection: "b", preferences: stored });
    expect(
      reconcileWorkspaceSelection(pending.preferences, "b", "c", [
        "a",
        "b",
        "c",
      ]).selection,
    ).toBe("c");
  });
});
