import { describe, expect, it } from "vitest";
import {
  closeEditorTab,
  dirtyEditorTabs,
  diskChangeResolution,
  editorTabNeedsCloseConfirmation,
  EMPTY_EDITOR_TABS,
  openEditorTab,
  parseGoToLine,
  renameEditorTab,
  toggleEditorSplit,
  updateEditorTab,
} from "./workspace-editor-tabs";

describe("editor tabs", () => {
  it("opens tabs, reuses one preview tab and pins edited files", () => {
    let state = openEditorTab(EMPTY_EDITOR_TABS, "a.ts");
    state = openEditorTab(state, "b.ts", { pinned: false });
    state = openEditorTab(state, "c.ts", { pinned: false });
    expect(state.tabs.map((tab) => tab.path)).toEqual(["a.ts", "c.ts"]);
    expect(state.active.primary).toBe("c.ts");
    state = updateEditorTab(state, "c.ts", { dirty: true });
    state = openEditorTab(state, "d.ts", { pinned: false });
    expect(state.tabs.map((tab) => tab.path)).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(dirtyEditorTabs(state)).toEqual(["c.ts"]);
  });

  it("guards dirty tabs and picks a neighbour after closing", () => {
    let state = openEditorTab(EMPTY_EDITOR_TABS, "a.ts");
    state = openEditorTab(state, "b.ts");
    state = openEditorTab(state, "c.ts");
    state = updateEditorTab(state, "b.ts", { dirty: true });
    expect(editorTabNeedsCloseConfirmation(state, "b.ts")).toBe(true);
    expect(editorTabNeedsCloseConfirmation(state, "a.ts")).toBe(false);
    state = closeEditorTab(state, "c.ts");
    expect(state.active.primary).toBe("b.ts");
  });

  it("splits into two panes and collapses when the second pane empties", () => {
    let state = openEditorTab(EMPTY_EDITOR_TABS, "a.ts");
    state = toggleEditorSplit(state);
    expect(state.split).toBe(true);
    expect(state.active).toEqual({ primary: "a.ts", secondary: "a.ts" });
    state = openEditorTab(state, "b.ts", { pane: "secondary" });
    expect(state.active).toEqual({ primary: "a.ts", secondary: "b.ts" });
    state = closeEditorTab(state, "b.ts");
    expect(state.active.secondary).toBe("a.ts");
    state = closeEditorTab(state, "a.ts");
    expect(state.split).toBe(false);
  });

  it("follows renamed files and folders", () => {
    let state = openEditorTab(EMPTY_EDITOR_TABS, "src/a.ts");
    state = openEditorTab(state, "README.md");
    state = renameEditorTab(state, "src", "lib");
    expect(state.tabs.map((tab) => tab.path)).toEqual([
      "lib/a.ts",
      "README.md",
    ]);
  });

  it("decides between reload and merge when a file changes on disk", () => {
    const state = updateEditorTab(
      openEditorTab(EMPTY_EDITOR_TABS, "a.ts"),
      "a.ts",
      {
        revision: "r1",
        diskRevision: "r2",
      },
    );
    expect(diskChangeResolution(state.tabs[0]!)).toBe("reload");
    expect(
      diskChangeResolution(
        updateEditorTab(state, "a.ts", { dirty: true }).tabs[0]!,
      ),
    ).toBe("conflict");
    expect(
      diskChangeResolution(
        updateEditorTab(state, "a.ts", { diskRevision: "r1" }).tabs[0]!,
      ),
    ).toBe("none");
  });

  it("parses go-to-line input", () => {
    expect(parseGoToLine("12", 100)).toEqual({ line: 12, column: 1 });
    expect(parseGoToLine(":40:7", 100)).toEqual({ line: 40, column: 7 });
    expect(parseGoToLine("500", 100)).toEqual({ line: 100, column: 1 });
    expect(parseGoToLine("abc", 100)).toBeNull();
  });
});
