import { describe, expect, it, vi } from "vitest";
import { createWorkspaceGitChangeMonitor } from "./workspace-git-change-monitor";

vi.mock("../runtime", () => ({ loadWorkspaceGitFingerprint: vi.fn() }));

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

const createHarness = () => {
  const fingerprints = new Map<string, string>();
  const pending: ((value: string) => void)[] = [];
  let deferLoads = false;
  const load = vi.fn((root: string) =>
    deferLoads
      ? new Promise<string>((resolve) => pending.push(resolve))
      : Promise.resolve(fingerprints.get(root) ?? "initial"),
  );
  const stopPolling = vi.fn();
  const startPolling = vi.fn(() => stopPolling);
  const monitor = createWorkspaceGitChangeMonitor({
    load,
    keyOf: (root) => root.toLowerCase(),
    startPolling,
  });
  const changed = vi.fn();
  monitor.subscribe(changed);
  return {
    monitor,
    load,
    fingerprints,
    pending,
    changed,
    startPolling,
    stopPolling,
    deferLoads: (value: boolean) => {
      deferLoads = value;
    },
  };
};

describe("workspace Git change monitor", () => {
  it("reports a workspace only when its Git state changes", async () => {
    const { monitor, fingerprints, changed } = createHarness();
    monitor.watch("C:\\a");
    await flush();
    monitor.check();
    await flush();
    expect(changed).not.toHaveBeenCalled();

    fingerprints.set("C:\\a", "feature");
    monitor.check();
    await flush();
    expect(changed).toHaveBeenCalledExactlyOnceWith("C:\\a");

    monitor.check();
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("adopts the state after local actions without reporting it", async () => {
    const { monitor, fingerprints, changed } = createHarness();
    monitor.watch("C:\\a");
    await flush();
    fingerprints.set("C:\\a", "after-checkout");
    monitor.sync("C:\\a");
    await flush();
    monitor.check();
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });

  it("ignores checks that finish after a newer read", async () => {
    const { monitor, pending, changed, deferLoads } = createHarness();
    monitor.watch("C:\\a");
    await flush();
    deferLoads(true);
    monitor.check();
    monitor.sync("C:\\a");
    pending[1]!("after-checkout");
    await flush();
    pending[0]!("before-checkout");
    await flush();
    deferLoads(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("reports changes made while a workspace was not watched", async () => {
    const { monitor, fingerprints, changed } = createHarness();
    const unwatch = monitor.watch("C:\\a");
    await flush();
    unwatch();
    fingerprints.set("c:\\A", "switched-in-terminal");
    monitor.watch("c:\\A");
    await flush();
    expect(changed).toHaveBeenCalledExactlyOnceWith("c:\\A");
  });

  it("polls only while workspaces are watched", async () => {
    const { monitor, load, startPolling, stopPolling } = createHarness();
    const first = monitor.watch("C:\\a");
    const second = monitor.watch("C:\\b");
    expect(startPolling).toHaveBeenCalledTimes(1);
    await flush();
    first();
    first();
    expect(stopPolling).not.toHaveBeenCalled();
    load.mockClear();
    monitor.check();
    await flush();
    expect(load.mock.calls.map(([root]) => root)).toEqual(["C:\\b"]);
    second();
    expect(stopPolling).toHaveBeenCalledTimes(1);
  });

  it("keeps the last known state when a check fails", async () => {
    const { monitor, load, fingerprints, changed } = createHarness();
    monitor.watch("C:\\a");
    await flush();
    load.mockRejectedValueOnce(new Error("unavailable"));
    monitor.check();
    await flush();
    expect(changed).not.toHaveBeenCalled();
    fingerprints.set("C:\\a", "feature");
    monitor.check();
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
