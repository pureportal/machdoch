import type { WorkspaceDirectoryEntry } from "../runtime";

export const workspacePathParent = (path: string): string => {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "." : normalized.slice(0, separator) || ".";
};

export const isWorkspaceDirectory = (entry: WorkspaceDirectoryEntry): boolean =>
  entry.kind === "directory";

export const isWorkspaceFile = (entry: WorkspaceDirectoryEntry): boolean =>
  entry.kind === "file" ||
  (entry.kind === "symlink" && entry.targetKind === "file");

export const reconcileWorkspaceTreeFocus = (
  visiblePaths: readonly string[],
  focusedPath: string | null,
  selectedPath: string | null,
): string | null => {
  if (visiblePaths.length === 0) return null;
  if (focusedPath && visiblePaths.includes(focusedPath)) return focusedPath;
  if (selectedPath && visiblePaths.includes(selectedPath)) return selectedPath;
  return visiblePaths[0] ?? null;
};

export const formatWorkspaceFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
};

export const resolveWorkspaceMarkdownPath = (
  documentPath: string,
  target: string,
): string | null => {
  const trimmed = target.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/iu.test(trimmed)
  ) {
    return null;
  }
  const withoutFragment = trimmed.split(/[?#]/u, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment).replaceAll("\\", "/");
  } catch {
    return null;
  }
  const base = decoded.startsWith("/")
    ? []
    : workspacePathParent(documentPath)
        .split("/")
        .filter((part) => part !== "." && part !== "");
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (base.length === 0) return null;
      base.pop();
    } else {
      base.push(part);
    }
  }
  return base.length > 0 ? base.join("/") : null;
};
