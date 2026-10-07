import { getRalphStorageDirectory } from "./create-ralph-storage-paths.helper.js";
import { join } from "node:path";

export const getRalphWatchIgnoredRoots = (workspaceRoot: string): string[] => [
  join(workspaceRoot, ".machdoch", "local"),
  getRalphStorageDirectory(workspaceRoot, "user"),
];
