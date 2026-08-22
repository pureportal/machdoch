import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RalphWatchRoot } from "../ralph-watches.js";

const isPathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const globToRegExp = (glob: string): RegExp => {
  const normalized = glob.replace(/\\/gu, "/");
  let pattern = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += char?.replace(/[.+^${}()|[\]\\]/gu, "\\$&") ?? "";
  }

  return new RegExp(`^${pattern}$`, "iu");
};

const pathMatchesAnyGlob = (path: string, globs: string[]): boolean => {
  return globs.some((glob) => globToRegExp(glob).test(path));
};

export const watchRootMatchesPath = (
  root: RalphWatchRoot,
  absolutePath: string,
): boolean => {
  const resolvedPath = resolve(absolutePath);

  if (!isPathInside(root.path, resolvedPath)) {
    return false;
  }

  const relativePath = relative(root.path, resolvedPath).split(sep).join("/");

  if (root.include.length > 0 && !pathMatchesAnyGlob(relativePath, root.include)) {
    return false;
  }

  if (pathMatchesAnyGlob(relativePath, root.exclude)) {
    return false;
  }

  return true;
};

export const watchRootCanTraversePath = (
  root: RalphWatchRoot,
  absolutePath: string,
): boolean => {
  const resolvedPath = resolve(absolutePath);

  if (!isPathInside(root.path, resolvedPath)) {
    return false;
  }

  const relativePath = relative(root.path, resolvedPath).split(sep).join("/");

  if (!relativePath) {
    return true;
  }

  return (
    !pathMatchesAnyGlob(relativePath, root.exclude) &&
    !pathMatchesAnyGlob(`${relativePath}/__machdoch_watch_probe__`, root.exclude)
  );
};
