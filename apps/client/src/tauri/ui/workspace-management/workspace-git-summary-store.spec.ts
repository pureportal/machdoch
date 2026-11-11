import { describe, expect, it, vi } from "vitest";
import type { WorkspaceGitOverview, WorkspaceGitSummary } from "../runtime";
import {
  createWorkspaceGitSummaryStore,
  nextWorkspaceGitSequence,
  workspaceGitSummaryFromOverview,
} from "./workspace-git-summary-store";

vi.mock("../runtime", () => ({
  loadWorkspaceGitSummary: vi.fn(),
  loadWorkspaceGitFingerprint: vi.fn(),
}));

const summary = (branch: string): WorkspaceGitSummary => ({
  branch,
  detached: false,
  ahead: 0,
  behind: 0,
  changes: 1,
  conflicts: 0,
});

const deferred = () => {
  let resolve!: (value: WorkspaceGitSummary | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WorkspaceGitSummary | null>(
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
  const pending = new Map<string, ReturnType<typeof deferred>>();
  const load = vi.fn((root: string) => {
    const request = deferred();
    pending.set(root, request);
    return request.promise;
  });
  const store = createWorkspaceGitSummaryStore({
    load,
    now: () => clock,
    schedule: (task) => tasks.push(task),
    maxConcurrent,
    staleMs: 100,
  });
  const flush = async (): Promise<void> => {
    while (tasks.length > 0) tasks.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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

describe("workspace Git summary store", () => {
  it("limits concurrent background loads and drains the queue", async () => {
    const { store, load, pending, flush } = createHarness(2);
    store.request("C:\\a");
    store.request("C:\\b");
    store.request("C:\\c");
    store.request("C:\\a");
    await flush();
    expect(load.mock.calls.map(([root]) => root)).toEqual(["C:\\a", "C:\\b"]);

    pending.get("C:\\a")!.resolve(summary("main"));
    await flush();
    await flush();
    expect(load.mock.calls.map(([root]) => root)).toEqual([
      "C:\\a",
      "C:\\b",
      "C:\\c",
    ]);
    expect(store.get("c:/a")?.summary?.branch).toBe("main");
  });

  it("serves fresh entries from cache and revalidates stale ones", async () => {
    const { store, load, pending, flush, advance } = createHarness();
    const listener = vi.fn();
    store.subscribe(listener);
    store.request("C:\\a");
    await flush();
    pending.get("C:\\a")!.resolve(summary("main"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);

    store.request("C:\\a");
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    advance(150);
    store.request("C:\\a");
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    pending.get("C:\\a")!.reject(new Error("git failed"));
    await flush();
    expect(store.get("C:\\a")).toMatchObject({
      summary: { branch: "main" },
      error: "git failed",
    });

    store.request("C:\\a", { force: true });
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("reloads after a forced request that arrives during a load", async () => {
    const { store, load, pending, flush } = createHarness();
    store.request("C:\\a");
    await flush();
    store.request("C:\\a", { force: true });
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    pending.get("C:\\a")!.resolve(summary("main"));
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    pending.get("C:\\a")!.resolve(summary("feature"));
    await flush();
    expect(store.get("C:\\a")?.summary?.branch).toBe("feature");
  });

  it("keeps newer published branches over loads that started earlier", async () => {
    const { store, pending, flush } = createHarness();
    store.request("C:\\a");
    await flush();
    store.publish("C:\\a", summary("feature"));
    pending.get("C:\\a")!.resolve(summary("main"));
    await flush();
    expect(store.get("C:\\a")?.summary?.branch).toBe("feature");
  });

  it("ignores published summaries older than the current entry", async () => {
    const { store, pending, flush } = createHarness();
    const staleSequence = nextWorkspaceGitSequence();
    store.request("C:\\a");
    await flush();
    pending.get("C:\\a")!.resolve(summary("feature"));
    await flush();
    store.publish("C:\\a", summary("main"), staleSequence);
    expect(store.get("C:\\a")?.summary?.branch).toBe("feature");
  });

  it("accepts summaries published from a loaded overview", () => {
    const { store, load } = createHarness();
    const overview = {
      branch: "feature",
      detached: false,
      upstream: "origin/feature",
      ahead: 2,
      behind: 1,
      totalChanges: 5,
      conflictedCount: 1,
    } as WorkspaceGitOverview;
    store.publish("C:\\a", workspaceGitSummaryFromOverview(overview));
    store.request("C:\\a");
    expect(load).not.toHaveBeenCalled();
    expect(store.get("C:\\a")?.summary).toEqual({
      branch: "feature",
      detached: false,
      upstream: "origin/feature",
      ahead: 2,
      behind: 1,
      changes: 5,
      conflicts: 1,
    });
  });
});
