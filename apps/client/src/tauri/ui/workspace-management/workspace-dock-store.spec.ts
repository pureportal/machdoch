import { describe, expect, it } from "vitest";
import { workspaceDockStore } from "./workspace-dock-store";

describe("workspace dock store", () => {
  it("hands each file and quick-open request to exactly one panel", () => {
    const root = "C:\\Work\\dock-requests";
    workspaceDockStore.openFile(root, "src/main.ts", 4);

    expect(workspaceDockStore.get(root).layout.filesOpen).toBe(true);
    expect(workspaceDockStore.takeFileRequest(root)).toMatchObject({
      path: "src/main.ts",
      line: 4,
    });
    expect(workspaceDockStore.takeFileRequest(root)).toBeNull();

    workspaceDockStore.requestQuickOpen(root);
    expect(workspaceDockStore.takeQuickOpenRequest(root)).toBe(true);
    expect(workspaceDockStore.takeQuickOpenRequest(root)).toBe(false);
  });
});
