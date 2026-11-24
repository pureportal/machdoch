import type { WorkspaceDirectoryEntry } from "@machdoch/fleet-protocol/workspace-contract";

export interface TreeDirectory {
  entries: readonly WorkspaceDirectoryEntry[];
  nextOffset: number | null;
  loading: boolean;
  error: string | null;
}

export const isDirectoryEntry = (
  entry: Pick<WorkspaceDirectoryEntry, "kind" | "targetKind">,
): boolean =>
  entry.kind === "directory" ||
  (entry.kind === "symlink" && entry.targetKind === "directory");

export type TreeRow =
  | {
      kind: "entry";
      entry: WorkspaceDirectoryEntry;
      level: number;
      parentPath: string;
    }
  | { kind: "loading"; path: string; level: number }
  | { kind: "error"; path: string; level: number; message: string }
  | {
      kind: "more";
      path: string;
      level: number;
      offset: number;
      loading: boolean;
    };

export const flattenTree = (
  directories: Readonly<Record<string, TreeDirectory | undefined>>,
  expanded: ReadonlySet<string>,
): TreeRow[] => {
  const rows: TreeRow[] = [];
  const visit = (path: string, level: number): void => {
    const directory = directories[path];
    if (!directory || (directory.loading && directory.entries.length === 0)) {
      rows.push({ kind: "loading", path, level });
      return;
    }
    if (directory.error && directory.entries.length === 0) {
      rows.push({ kind: "error", path, level, message: directory.error });
      return;
    }
    for (const entry of directory.entries) {
      rows.push({ kind: "entry", entry, level, parentPath: path });
      if (isDirectoryEntry(entry) && expanded.has(entry.path)) {
        visit(entry.path, level + 1);
      }
    }
    if (directory.nextOffset !== null) {
      rows.push({
        kind: "more",
        path,
        level,
        offset: directory.nextOffset,
        loading: directory.loading,
      });
    }
  };
  visit(".", 0);
  return rows;
};

export const visibleRowRange = (
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 8,
): { start: number; end: number } => {
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(rowCount, first + visible + overscan),
  };
};

export const parentDirectory = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "." : path.slice(0, separator);
};

export const dropDirectoryFor = (
  entry: Pick<WorkspaceDirectoryEntry, "path" | "kind" | "targetKind"> | null,
): string =>
  entry === null
    ? "."
    : isDirectoryEntry(entry)
      ? entry.path
      : parentDirectory(entry.path);

export const entryPaths = (rows: readonly TreeRow[]): string[] =>
  rows.flatMap((row) => (row.kind === "entry" ? [row.entry.path] : []));

export const directoriesToReload = (
  changedDirectories: readonly string[],
  loaded: ReadonlySet<string>,
): string[] =>
  [...new Set(changedDirectories)].filter((directory) => loaded.has(directory));
