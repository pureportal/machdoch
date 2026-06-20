import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RalphWatchRoot } from "../ralph-watches.js";
import {
  watchRootCanTraversePath,
  watchRootMatchesPath,
} from "./watch-root-matches-path.helper.js";

export interface RalphWatchFileSnapshot {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

const getFileSnapshot = async (
  path: string,
): Promise<RalphWatchFileSnapshot | undefined> => {
  try {
    const metadata = await stat(path);

    return {
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      isDirectory: metadata.isDirectory(),
    };
  } catch {
    return undefined;
  }
};

export const waitForStableRalphWatchFile = async (
  path: string,
  stabilityMs: number,
): Promise<RalphWatchFileSnapshot | undefined> => {
  let previous = await getFileSnapshot(path);

  if (!previous || previous.isDirectory) {
    return previous;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, stabilityMs);
    });

    const current = await getFileSnapshot(path);

    if (
      current &&
      previous &&
      current.size === previous.size &&
      current.mtimeMs === previous.mtimeMs
    ) {
      return current;
    }

    previous = current;
  }

  return previous;
};

export const scanRalphWatchFiles = async (
  root: RalphWatchRoot,
  directory = root.path,
  snapshots = new Map<string, RalphWatchFileSnapshot>(),
): Promise<Map<string, RalphWatchFileSnapshot>> => {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return snapshots;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (!watchRootCanTraversePath(root, path)) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      const snapshot = await getFileSnapshot(path);

      if (snapshot && watchRootMatchesPath(root, path)) {
        snapshots.set(path, snapshot);
      }

      await scanRalphWatchFiles(root, path, snapshots);
      continue;
    }

    if (entry.isFile()) {
      const snapshot = await getFileSnapshot(path);

      if (snapshot && watchRootMatchesPath(root, path)) {
        snapshots.set(path, snapshot);
      }
    }
  }

  return snapshots;
};
