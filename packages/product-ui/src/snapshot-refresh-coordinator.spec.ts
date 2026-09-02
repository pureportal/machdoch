import { describe, expect, it } from "vitest";
import { SnapshotRefreshCoordinator } from "./snapshot-refresh-coordinator";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

const createDeferred = <Value>(): Deferred<Value> => {
  let resolve: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("SnapshotRefreshCoordinator", () => {
  it("runs one retained refresh after an active refresh", async () => {
    const requests = [createDeferred<string>(), createDeferred<string>()];
    const snapshots: string[] = [];
    let requestCount = 0;
    const coordinator = new SnapshotRefreshCoordinator({
      fetchSnapshot: () => requests[requestCount++]!.promise,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: () => undefined,
    });

    const first = coordinator.request();
    const second = coordinator.request();
    const third = coordinator.request();

    expect(requestCount).toBe(1);
    requests[0]!.resolve("stale");
    await flush();

    expect(requestCount).toBe(2);
    expect(snapshots).toEqual([]);
    requests[1]!.resolve("current");
    await Promise.all([first, second, third]);

    expect(snapshots).toEqual(["current"]);
  });

  it("shares completion while a refresh remains unresolved", () => {
    const refresh = createDeferred<string>();
    const coordinator = new SnapshotRefreshCoordinator({
      fetchSnapshot: () => refresh.promise,
      onSnapshot: () => undefined,
      onError: () => undefined,
    });

    const first = coordinator.request();
    const second = coordinator.request();
    const third = coordinator.request();

    expect(second).toBe(first);
    expect(third).toBe(first);
    coordinator.dispose();
  });

  it("does not report a superseded refresh failure", async () => {
    let rejectFirst: (reason?: unknown) => void;
    const firstRequest = new Promise<string>((_, reject) => {
      rejectFirst = reject;
    });
    const secondRequest = createDeferred<string>();
    const errors: unknown[] = [];
    let requestCount = 0;
    const coordinator = new SnapshotRefreshCoordinator({
      fetchSnapshot: () =>
        requestCount++ === 0 ? firstRequest : secondRequest.promise,
      onSnapshot: () => undefined,
      onError: (reason) => errors.push(reason),
    });

    const first = coordinator.request();
    const second = coordinator.request();
    rejectFirst!(new Error("obsolete"));
    await flush();

    expect(errors).toEqual([]);
    secondRequest.resolve("current");
    await Promise.all([first, second]);
    expect(errors).toEqual([]);
  });
});
