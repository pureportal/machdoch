import { join } from "node:path";

export type WorkspaceLocalStorageCategory = "state" | "cache" | "artifacts";

export const WORKSPACE_STORAGE_LAYOUT_VERSION = 1;

export const getWorkspaceLocalDirectory = (
  workspaceRoot: string,
  category: WorkspaceLocalStorageCategory,
): string => join(workspaceRoot, ".machdoch", "local", category);

export const getWorkspaceStorageMarkerPath = (workspaceRoot: string): string =>
  join(
    getWorkspaceLocalDirectory(workspaceRoot, "state"),
    "storage-layout.json",
  );

export const isWorkspaceLocalPath = (path: string): boolean =>
  /(?:^|\/)\.machdoch\/local(?:\/|$)/u.test(path.replaceAll("\\", "/"));
