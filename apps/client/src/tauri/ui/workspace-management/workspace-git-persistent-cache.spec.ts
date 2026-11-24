import { describe, expect, it } from "vitest";
import { createPersistentGitCache } from "./workspace-git-persistent-cache";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

const summary = (branch: string) => ({
  branch,
  detached: false,
  ahead: 0,
  behind: 0,
  changes: 1,
  conflicts: 0,
});

describe("persistent Git cache", () => {
  it("restores the last known repository state after a restart", () => {
    const storage = memoryStorage();
    const pending: (() => void)[] = [];
    let clock = 1;
    const options = {
      storage,
      storageKey: "git",
      maxRepositories: 4,
      maxBytes: 100_000,
      now: () => clock++,
      schedule: (flush: () => void) => void pending.push(flush),
    };
    const first = createPersistentGitCache(options);
    first.write("repo-a", "summary", summary("main"));
    first.write("repo-a", "graph", {
      repositoryRoot: "C:/a",
      commits: [],
      truncated: false,
    });
    expect(pending).toHaveLength(1);
    pending.shift()!();

    const restarted = createPersistentGitCache(options);
    expect(restarted.read("repo-a")?.summary?.branch).toBe("main");
    expect(restarted.read("repo-a")?.graph?.repositoryRoot).toBe("C:/a");
  });

  it("keeps the most recently used repositories within the count and size limits", () => {
    const storage = memoryStorage();
    let clock = 1;
    const cache = createPersistentGitCache({
      storage,
      storageKey: "git",
      maxRepositories: 2,
      maxBytes: 400,
      now: () => clock++,
      schedule: () => {},
    });
    cache.write("repo-a", "summary", summary("a"));
    cache.write("repo-b", "summary", summary("b"));
    cache.write("repo-c", "summary", summary("c".repeat(150)));
    cache.flush();
    const stored = JSON.parse(storage.values.get("git")!) as {
      repositories: [string][];
    };
    expect(stored.repositories.map(([key]) => key)).toEqual(["repo-c"]);
    expect(cache.read("repo-a")).toBeUndefined();
  });

  it("ignores corrupt or outdated stored data", () => {
    const storage = memoryStorage();
    storage.values.set("git", "{not json");
    const options = {
      storage,
      storageKey: "git",
      maxRepositories: 2,
      maxBytes: 1000,
      now: () => 1,
      schedule: () => {},
    };
    expect(createPersistentGitCache(options).read("repo-a")).toBeUndefined();
    storage.values.set("git", JSON.stringify({ version: 0, repositories: [] }));
    expect(createPersistentGitCache(options).read("repo-a")).toBeUndefined();
  });
});
