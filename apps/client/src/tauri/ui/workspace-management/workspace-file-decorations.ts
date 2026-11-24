import type { WorkspaceGitChange } from "@machdoch/fleet-protocol/workspace-contract";

export type FileDecoration =
  | "conflicted"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored";

const PRIORITY: Record<FileDecoration, number> = {
  conflicted: 6,
  modified: 5,
  deleted: 4,
  renamed: 3,
  added: 2,
  untracked: 1,
  ignored: 0,
};

export const decorationForChange = (
  change: Pick<WorkspaceGitChange, "status" | "untracked" | "conflicted">,
): FileDecoration => {
  if (change.conflicted) return "conflicted";
  if (change.untracked) return "untracked";
  if (change.status === "!!") return "ignored";
  const codes = change.status.replaceAll(" ", "").replaceAll(".", "");
  if (codes.includes("R") || codes.includes("C")) return "renamed";
  if (codes.includes("D")) return "deleted";
  if (codes.includes("A")) return "added";
  return "modified";
};

const stronger = (
  left: FileDecoration | undefined,
  right: FileDecoration,
): FileDecoration =>
  left === undefined || PRIORITY[right] > PRIORITY[left] ? right : left;

export interface FileDecorationIndex {
  files: ReadonlyMap<string, FileDecoration>;
  folders: ReadonlyMap<string, FileDecoration>;
}

const joinPath = (prefix: string, path: string): string =>
  prefix === "" || prefix === "." ? path : `${prefix}/${path}`;

export const buildFileDecorations = (
  repositories: readonly {
    relativePath: string;
    changes: readonly Pick<
      WorkspaceGitChange,
      "status" | "path" | "untracked" | "conflicted"
    >[];
  }[],
): FileDecorationIndex => {
  const files = new Map<string, FileDecoration>();
  const folders = new Map<string, FileDecoration>();
  for (const repository of repositories) {
    for (const change of repository.changes) {
      const decoration = decorationForChange(change);
      const path = joinPath(
        repository.relativePath,
        change.path.replace(/\/$/u, ""),
      );
      if (change.path.endsWith("/")) {
        folders.set(path, stronger(folders.get(path), decoration));
      } else {
        files.set(path, stronger(files.get(path), decoration));
      }
      if (decoration === "ignored") continue;
      const parts = path.split("/");
      for (let length = parts.length - 1; length > 0; length -= 1) {
        const folder = parts.slice(0, length).join("/");
        folders.set(folder, stronger(folders.get(folder), decoration));
      }
    }
  }
  return { files, folders };
};

export const decorationForPath = (
  index: FileDecorationIndex,
  path: string,
  kind: "file" | "directory",
): FileDecoration | undefined => {
  const normalized = path.replace(/^\.\//u, "");
  if (kind === "directory") return index.folders.get(normalized);
  const exact = index.files.get(normalized);
  if (exact) return exact;
  const parts = normalized.split("/");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const folder = index.folders.get(parts.slice(0, length).join("/"));
    if (folder === "untracked" || folder === "ignored") return folder;
  }
  return undefined;
};
