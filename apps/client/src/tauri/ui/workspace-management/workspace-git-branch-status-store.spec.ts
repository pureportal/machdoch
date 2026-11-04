import { describe, expect, it, vi } from "vitest";
import type { WorkspaceGitBranchStatus } from "../runtime";
import { createWorkspaceGitBranchStatusStore } from "./workspace-git-branch-status-store";

vi.mock("../runtime", () => ({ loadWorkspaceGitBranchStatus: vi.fn() }));

const branchStatus = (
  workspaceRoot: string,
  currentBranch: string,
): WorkspaceGitBranchStatus => ({
  workspaceRoot,
  repositories: [
    {
      repositoryRoot: workspaceRoot,
      relativePath: ".",
      currentBranch,
      defaultBranch: "main",
      branchLocal: false,
      changes: 0,
      conflicts: 0,
    },
  ],
  branches: [],
  scanLimited: false,
  issues: [],
});

const deferred = () => {
  let resolve!: (value: WorkspaceGitBranchStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WorkspaceGitBranchStatus>(
    (onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    },
  );
  return { promise, resolve, reject };
};

const createHarness = (maxConcurrent = 2) => {
  let clock = 1_000;
  const tasks: (() => void)[] = [];
  const pending: ReturnType<typeof deferred>[] = [];
  const load = vi.fn(
    (_root: string, _branch: string | null, _fetch: boolean) => {
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
  );
  const store = createWorkspaceGitBranchStatusStore({
    load,
    now: () => clock,
    schedule: (task) => tasks.push(task),
    maxConcurrent,
    staleMs: 100,
  });
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      while (tasks.length > 0) tasks.shift()!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return {
    store,
    load,
    pending,
    flush,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("workspace Git branch status store", () => {
  it("keys entries by workspace and branch and reuses fresh results", async () => {
    const { store, load, pending, flush, advance } = createHarness();
    store.request("C:\\work", "feature/a");
    store.request("c:/work/", "feature/a");
    store.request("C:\\work", "feature/b");
    await flush();
    expect(load.mock.calls).toEqual([
      ["C:\\work", "feature/a", false],
      ["C:\\work", "feature/b", false],
    ]);

    pending[0]!.resolve(branchStatus("C:\\work", "feature/a"));
    await flush();
    expect(store.get("c:/work", "feature/a")).toMatchObject({
      loading: false,
      error: null,
      status: { repositories: [{ currentBranch: "feature/a" }] },
    });
    expect(store.get("C:\\work", "feature/b")?.loading).toBe(true);

    store.request("C:\\work", "feature/a");
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    advance(150);
    store.request("C:\\work", "feature/a");
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("runs a fetch after the queued local load instead of delaying it", async () => {
    const { store, load, pending, flush } = createHarness();
    store.request("C:\\work", "feature/a", { force: true });
    store.request("C:\\work", "feature/a", { fetch: true });
    await flush();
    expect(load.mock.calls).toEqual([["C:\\work", "feature/a", false]]);

    pending[0]!.resolve(branchStatus("C:\\work", "main"));
    await flush();
    expect(load.mock.calls.at(-1)).toEqual(["C:\\work", "feature/a", true]);
    expect(store.get("C:\\work", "feature/a")).toMatchObject({
      loading: true,
      fetching: true,
      status: { repositories: [{ currentBranch: "main" }] },
    });

    pending[1]!.reject(new Error("offline"));
    await flush();
    expect(store.get("C:\\work", "feature/a")).toMatchObject({
      loading: false,
      fetching: false,
      error: "offline",
      status: { repositories: [{ currentBranch: "main" }] },
    });
  });

  it("reloads watched entries and drops unwatched ones on invalidation", async () => {
    const { store, load, pending, flush } = createHarness();
    const unwatch = store.watch("C:\\work", "feature/a");
    store.request("C:\\work", "feature/b");
    store.request("C:\\other", "feature/a");
    await flush();
    for (const request of pending.splice(0)) {
      request.resolve(branchStatus("C:\\work", "main"));
    }
    await flush();
    expect(load).toHaveBeenCalledTimes(3);

    store.invalidate("c:/work");
    await flush();
    expect(load).toHaveBeenCalledTimes(4);
    expect(load.mock.calls.at(-1)).toEqual(["C:\\work", "feature/a", false]);
    expect(store.get("C:\\work", "feature/b")).toBeUndefined();
    expect(store.get("C:\\other", "feature/a")).toBeDefined();

    unwatch();
    for (const request of pending.splice(0)) {
      request.resolve(branchStatus("C:\\work", "feature/a"));
    }
    await flush();
    store.invalidate("C:\\work");
    await flush();
    expect(load).toHaveBeenCalledTimes(4);
    expect(store.get("C:\\work", "feature/a")).toBeUndefined();
  });

  it("reloads after a load that was running during invalidation", async () => {
    const { store, load, pending, flush } = createHarness();
    store.request("C:\\work", "feature/a");
    await flush();
    store.invalidate("C:\\work");
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    pending[0]!.resolve(branchStatus("C:\\work", "main"));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("tracks branch switches per workspace", () => {
    const { store } = createHarness();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSwitching("C:\\work", true);
    store.setSwitching("c:/work", true);
    expect(store.isSwitching("c:/work/")).toBe(true);
    expect(store.isSwitching("C:\\other")).toBe(false);
    store.setSwitching("C:\\work", false);
    expect(store.isSwitching("C:\\work")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
