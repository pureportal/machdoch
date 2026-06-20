import { normalizeWatchPathPatterns } from "./normalize-watch-path-patterns.helper.js";
import {
  isPathInside,
  normalizeRalphWatchPath,
} from "./normalize-ralph-watch-path.helper.js";
import type { RalphWatchInput, RalphWatchRoot } from "../ralph-watches.js";

const DEFAULT_EXCLUDES = [
  ".git/**",
  ".machdoch/**",
  ".next/**",
  ".turbo/**",
  "build/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "out/**",
  "target/**",
];

export const normalizeRalphWatchRoot = async (
  root: RalphWatchInput["roots"][number],
  allowDangerousRoots: boolean,
): Promise<RalphWatchRoot> => {
  const path = await normalizeRalphWatchPath(
    root.path,
    "watch root",
    allowDangerousRoots,
  );
  const workspaceRoot = root.workspaceRoot
    ? await normalizeRalphWatchPath(root.workspaceRoot, "watch workspace root", true)
    : undefined;

  if (
    workspaceRoot &&
    !isPathInside(workspaceRoot, path) &&
    !isPathInside(path, workspaceRoot)
  ) {
    throw new Error(
      `Watch root ${path} and workspace root ${workspaceRoot} do not overlap.`,
    );
  }

  return {
    path,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    include: normalizeWatchPathPatterns(root.include),
    exclude: Array.from(
      new Set([...DEFAULT_EXCLUDES, ...normalizeWatchPathPatterns(root.exclude)]),
    ),
  };
};
