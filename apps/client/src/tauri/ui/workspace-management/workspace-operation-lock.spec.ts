import { describe, expect, it, vi } from "vitest";
import {
  startExclusiveWorkspaceOperation,
  type WorkspaceOperationLock,
} from "./workspace-operation-lock";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe("workspace operation lock", () => {
  it("rejects overlapping operations and releases after completion", async () => {
    const lock: WorkspaceOperationLock = { pending: false };
    const first = deferred<string>();
    const firstOperation = startExclusiveWorkspaceOperation(
      lock,
      () => first.promise,
    );
    const overlapping = vi.fn();

    expect(lock.pending).toBe(true);
    expect(startExclusiveWorkspaceOperation(lock, overlapping)).toBeNull();
    expect(overlapping).not.toHaveBeenCalled();

    first.resolve("saved");
    await expect(firstOperation).resolves.toBe("saved");
    expect(lock.pending).toBe(false);

    await expect(
      startExclusiveWorkspaceOperation(lock, () => "next"),
    ).resolves.toBe("next");
  });

  it("releases after asynchronous and synchronous failures", async () => {
    const lock: WorkspaceOperationLock = { pending: false };
    const failure = deferred<never>();
    const rejected = startExclusiveWorkspaceOperation(
      lock,
      () => failure.promise,
    );
    failure.reject(new Error("write failed"));
    await expect(rejected).rejects.toThrow("write failed");
    expect(lock.pending).toBe(false);

    expect(() =>
      startExclusiveWorkspaceOperation(lock, () => {
        throw new Error("setup failed");
      }),
    ).toThrow("setup failed");
    expect(lock.pending).toBe(false);
  });
});
