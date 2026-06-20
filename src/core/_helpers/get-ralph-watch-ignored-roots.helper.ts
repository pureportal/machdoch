import { getRalphStorageDirectory } from "../ralph.js";

export const getRalphWatchIgnoredRoots = (workspaceRoot: string): string[] => [
  getRalphStorageDirectory(workspaceRoot, "workspace"),
  getRalphStorageDirectory(workspaceRoot, "user"),
];
