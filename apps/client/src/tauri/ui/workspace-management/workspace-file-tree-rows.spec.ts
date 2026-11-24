import { describe, expect, it } from "vitest";
import type { WorkspaceDirectoryEntry } from "@machdoch/fleet-protocol/workspace-contract";
import {
  directoriesToReload,
  dropDirectoryFor,
  entryPaths,
  flattenTree,
  isDirectoryEntry,
  visibleRowRange,
} from "./workspace-file-tree-rows";

const entry = (
  path: string,
  kind: WorkspaceDirectoryEntry["kind"] = "file",
): WorkspaceDirectoryEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind,
  targetKind: null,
  size: null,
  modifiedAt: null,
  ignored: false,
});

const directory = (
  entries: WorkspaceDirectoryEntry[],
  nextOffset: number | null = null,
) => ({
  entries,
  nextOffset,
  loading: false,
  error: null,
});

describe("workspace file tree rows", () => {
  it("flattens expanded folders with loading, error and paging rows", () => {
    const rows = flattenTree(
      {
        ".": directory(
          [
            entry("src", "directory"),
            entry("docs", "directory"),
            entry("a.md"),
          ],
          3,
        ),
        src: directory([entry("src/main.ts")]),
        docs: {
          entries: [],
          nextOffset: null,
          loading: false,
          error: "Denied",
        },
      },
      new Set(["src", "docs", "missing"]),
    );
    expect(rows.map((row) => `${row.kind}:${row.level}`)).toEqual([
      "entry:0",
      "entry:1",
      "entry:0",
      "error:1",
      "entry:0",
      "more:0",
    ]);
    expect(entryPaths(rows)).toEqual(["src", "src/main.ts", "docs", "a.md"]);
    expect(flattenTree({}, new Set())).toEqual([
      { kind: "loading", path: ".", level: 0 },
    ]);
  });

  it("renders only the rows inside the viewport plus overscan", () => {
    expect(visibleRowRange(0, 280, 28, 50_000, 5)).toEqual({
      start: 0,
      end: 15,
    });
    expect(visibleRowRange(28_000, 280, 28, 50_000, 5)).toEqual({
      start: 995,
      end: 1015,
    });
    expect(visibleRowRange(28_000, 280, 28, 1_000, 5)).toEqual({
      start: 995,
      end: 1000,
    });
  });

  it("drops into folders or next to files", () => {
    expect(dropDirectoryFor(entry("src", "directory"))).toBe("src");
    expect(dropDirectoryFor(entry("src/main.ts"))).toBe("src");
    expect(dropDirectoryFor(entry("a.md"))).toBe(".");
    expect(dropDirectoryFor(null)).toBe(".");
  });

  it("treats links to folders as folders", () => {
    const link = {
      ...entry("linked", "symlink"),
      targetKind: "directory" as const,
    };
    expect(isDirectoryEntry(link)).toBe(true);
    expect(isDirectoryEntry({ ...link, targetKind: "file" })).toBe(false);
    expect(dropDirectoryFor(link)).toBe("linked");
  });

  it("reloads only loaded folders that changed", () => {
    expect(
      directoriesToReload(["src", "src", "dist", "."], new Set([".", "src"])),
    ).toEqual(["src", "."]);
  });
});
