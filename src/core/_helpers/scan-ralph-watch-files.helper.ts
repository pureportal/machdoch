import type { Dirent } from "node:fs";
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

const DIRECTORY_READ_CONCURRENCY = 16;
const FILE_STAT_CONCURRENCY = 32;

interface RalphWatchDirectoryEntries {
  directory: string;
  entries: Dirent[];
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

const readDirectoryEntries = async (
  directory: string,
): Promise<RalphWatchDirectoryEntries> => {
  try {
    return {
      directory,
      entries: await readdir(directory, { withFileTypes: true }),
    };
  } catch {
    return { directory, entries: [] };
  }
};

const collectFileSnapshots = async (
  paths: readonly string[],
  snapshots: Map<string, RalphWatchFileSnapshot>,
): Promise<void> => {
  for (let index = 0; index < paths.length; index += FILE_STAT_CONCURRENCY) {
    const batch = paths.slice(index, index + FILE_STAT_CONCURRENCY);
    const entries = await Promise.all(
      batch.map(async (path) => ({
        path,
        snapshot: await getFileSnapshot(path),
      })),
    );

    for (const entry of entries) {
      if (entry.snapshot) {
        snapshots.set(entry.path, entry.snapshot);
      }
    }
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
  const pendingDirectories = [directory];
  let cursor = 0;

  while (cursor < pendingDirectories.length) {
    const directoryBatch = pendingDirectories.slice(
      cursor,
      cursor + DIRECTORY_READ_CONCURRENCY,
    );
    cursor += directoryBatch.length;
    const directoryEntries = await Promise.all(
      directoryBatch.map(readDirectoryEntries),
    );
    const pathsToSnapshot: string[] = [];

    for (const { directory: parentDirectory, entries } of directoryEntries) {
      for (const entry of entries) {
        const path = join(parentDirectory, entry.name);

        if (
          entry.isSymbolicLink() ||
          !watchRootCanTraversePath(root, path)
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          pendingDirectories.push(path);
        }

        if (
          (entry.isDirectory() || entry.isFile()) &&
          watchRootMatchesPath(root, path)
        ) {
          pathsToSnapshot.push(path);
        }
      }
    }

    await collectFileSnapshots(pathsToSnapshot, snapshots);
  }

  return snapshots;
};
