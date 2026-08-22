import { getRalphStorageDirectory } from "./create-ralph-storage-paths.helper.js";

export const getRalphWatchIgnoredRoots = (workspaceRoot: string): string[] => [
  getRalphStorageDirectory(workspaceRoot, "workspace"),
  getRalphStorageDirectory(workspaceRoot, "user"),
];
