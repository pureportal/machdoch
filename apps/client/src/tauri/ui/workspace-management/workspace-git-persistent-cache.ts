import type {
  WorkspaceGitGraph,
  WorkspaceGitOverview,
  WorkspaceGitSummary,
} from "@machdoch/fleet-protocol/workspace-contract";

export interface PersistedRepositoryGit {
  savedAt: number;
  summary?: WorkspaceGitSummary;
  overview?: WorkspaceGitOverview;
  graph?: WorkspaceGitGraph;
}

type PersistedField = Exclude<keyof PersistedRepositoryGit, "savedAt">;

interface CacheStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface PersistentGitCacheOptions {
  storage: CacheStorage | null;
  storageKey: string;
  maxRepositories: number;
  maxBytes: number;
  now: () => number;
  schedule: (flush: () => void) => void;
}

export interface PersistentGitCache {
  read: (repositoryKey: string) => PersistedRepositoryGit | undefined;
  write: <K extends PersistedField>(
    repositoryKey: string,
    field: K,
    value: NonNullable<PersistedRepositoryGit[K]>,
  ) => void;
  forget: (repositoryKey: string) => void;
  flush: () => void;
}

const CACHE_VERSION = 1;

interface StoredCache {
  version: number;
  repositories: [string, PersistedRepositoryGit][];
}

const parse = (raw: string | null): Map<string, PersistedRepositoryGit> => {
  if (!raw) return new Map();
  try {
    const stored = JSON.parse(raw) as StoredCache;
    if (stored.version !== CACHE_VERSION || !Array.isArray(stored.repositories))
      return new Map();
    return new Map(stored.repositories);
  } catch {
    return new Map();
  }
};

export const createPersistentGitCache = ({
  storage,
  storageKey,
  maxRepositories,
  maxBytes,
  now,
  schedule,
}: PersistentGitCacheOptions): PersistentGitCache => {
  let entries: Map<string, PersistedRepositoryGit> | null = null;
  let flushScheduled = false;

  const load = (): Map<string, PersistedRepositoryGit> => {
    if (!entries) {
      try {
        entries = parse(storage?.getItem(storageKey) ?? null);
      } catch {
        entries = new Map();
      }
    }
    return entries;
  };

  const serialize = (
    repositories: [string, PersistedRepositoryGit][],
  ): string => JSON.stringify({ version: CACHE_VERSION, repositories });

  const flush = (): void => {
    flushScheduled = false;
    if (!storage || !entries) return;
    const ordered = [...entries].sort(
      ([, left], [, right]) => right.savedAt - left.savedAt,
    );
    let kept = ordered.slice(0, maxRepositories);
    let text = serialize(kept);
    while (text.length > maxBytes && kept.length > 0) {
      kept = kept.slice(0, -1);
      text = serialize(kept);
    }
    entries = new Map(kept);
    try {
      storage.setItem(storageKey, text);
    } catch (error) {
      console.error("Could not persist the Git cache", error);
    }
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(flush);
  };

  return {
    read: (repositoryKey) => load().get(repositoryKey),
    write: (repositoryKey, field, value) => {
      const cache = load();
      const current = cache.get(repositoryKey);
      cache.delete(repositoryKey);
      cache.set(repositoryKey, {
        ...current,
        [field]: value,
        savedAt: now(),
      });
      scheduleFlush();
    },
    forget: (repositoryKey) => {
      if (load().delete(repositoryKey)) scheduleFlush();
    },
    flush,
  };
};

const browserStorage = (): CacheStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const workspaceGitPersistentCache = createPersistentGitCache({
  storage: browserStorage(),
  storageKey: "machdoch.workspace-git-cache",
  maxRepositories: 32,
  maxBytes: 3_000_000,
  now: () => Date.now(),
  schedule: (flush) => {
    setTimeout(flush, 750);
  },
});
