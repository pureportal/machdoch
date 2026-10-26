import { describe, expect, it, vi } from "vitest";
import {
  createEnrollmentInventory,
  type AvailableGrant,
} from "./enrollment-inventory";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function grant(grantId: string): AvailableGrant {
  return { grantId, createdAt: 1, expiresAt: 100 };
}

function inventoryHarness() {
  const controller = new AbortController();
  const reads: ReturnType<typeof deferred<AvailableGrant[]>>[] = [];
  const onInventory = vi.fn<(grants: AvailableGrant[]) => void>();
  const onError = vi.fn<(message: string) => void>();
  const onLoading = vi.fn<(loading: boolean) => void>();
  const read = vi.fn((signal: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    const request = deferred<AvailableGrant[]>();
    reads.push(request);
    return request.promise;
  });
  const inventory = createEnrollmentInventory({
    signal: controller.signal,
    read,
    onInventory,
    onError,
    onLoading,
  });
  return {
    controller,
    reads,
    read,
    inventory,
    onInventory,
    onError,
    onLoading,
  };
}

describe("enrollment inventory", () => {
  it("coalesces polling, visibility, and manual refreshes into one active read", async () => {
    const harness = inventoryHarness();
    const first = harness.inventory.refresh();
    const repeated = Array.from({ length: 20 }, () =>
      harness.inventory.refresh(),
    );

    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(repeated.every((request) => request === first)).toBe(true);
    harness.reads[0]!.resolve([grant("slow")]);
    await Promise.all([first, ...repeated]);

    expect(harness.onInventory).toHaveBeenCalledExactlyOnceWith([
      grant("slow"),
    ]);
    expect(harness.onError).toHaveBeenCalledExactlyOnceWith("");
    expect(harness.onLoading.mock.calls).toEqual([[true], [false]]);
    expect(harness.read).toHaveBeenCalledTimes(1);
  });

  it("accepts a slow response even while later refresh triggers keep arriving", async () => {
    const harness = inventoryHarness();
    const first = harness.inventory.refresh();
    void harness.inventory.refresh();
    void harness.inventory.refresh();
    harness.reads[0]!.resolve([grant("slow")]);
    await first;

    expect(harness.onInventory).toHaveBeenCalledWith([grant("slow")]);
    expect(harness.onLoading).toHaveBeenLastCalledWith(false);
  });

  it.each([
    [new Error("Read failed"), "Read failed"],
    ["failure", "Keys could not be loaded."],
  ])(
    "reports an eligible failure and allows retry (%s)",
    async (reason, message) => {
      const harness = inventoryHarness();
      const failed = harness.inventory.refresh();
      harness.reads[0]!.reject(reason);
      await failed;

      expect(harness.onError).toHaveBeenLastCalledWith(message);
      expect(harness.onLoading).toHaveBeenLastCalledWith(false);
      expect(harness.onInventory).not.toHaveBeenCalled();

      const retry = harness.inventory.refresh();
      harness.reads[1]!.resolve([grant("retry")]);
      await retry;
      expect(harness.onInventory).toHaveBeenLastCalledWith([grant("retry")]);
      expect(harness.onError).toHaveBeenLastCalledWith("");
      expect(harness.onLoading.mock.calls).toEqual([
        [true],
        [false],
        [true],
        [false],
      ]);
    },
  );

  it.each(["creation", "revocation"])(
    "invalidates a pending read and serializes the fresh read after %s",
    async (operation) => {
      const harness = inventoryHarness();
      let visible = [grant("existing")];
      harness.onInventory.mockImplementation((grants) => {
        visible = grants;
      });
      const oldRead = harness.inventory.refresh();
      const mutation = deferred<void>();
      expect(harness.inventory.beginMutation()).toBe(true);
      expect(harness.inventory.beginMutation()).toBe(false);
      const completedMutation = mutation.promise.then(() => {
        visible =
          operation === "creation" ? [...visible, grant("created")] : [];
        harness.inventory.finishMutation();
      });
      void harness.inventory.refresh();
      mutation.resolve();
      await completedMutation;

      expect(harness.read).toHaveBeenCalledTimes(1);
      harness.reads[0]!.resolve([grant("existing")]);
      await oldRead;
      expect(harness.onInventory).not.toHaveBeenCalled();
      expect(visible).toEqual(
        operation === "creation" ? [grant("existing"), grant("created")] : [],
      );
      expect(harness.onLoading.mock.calls.flat()).not.toContain(false);
      expect(harness.read).toHaveBeenCalledTimes(2);

      const fresh = harness.inventory.refresh();
      const expected =
        operation === "creation" ? [grant("existing"), grant("created")] : [];
      harness.reads[1]!.resolve(expected);
      await fresh;
      expect(visible).toEqual(expected);
      expect(harness.onInventory).toHaveBeenCalledExactlyOnceWith(expected);
      expect(harness.onLoading).toHaveBeenLastCalledWith(false);
    },
  );

  it.each(["success", "failure"])(
    "ignores an old read's %s during a mutation and reads again on completion",
    async (outcome) => {
      const harness = inventoryHarness();
      const oldRead = harness.inventory.refresh();
      harness.inventory.beginMutation();
      if (outcome === "success") harness.reads[0]!.resolve([grant("old")]);
      else harness.reads[0]!.reject(new Error("Stale failure"));
      await oldRead;

      expect(harness.onInventory).not.toHaveBeenCalled();
      expect(harness.onError).not.toHaveBeenCalled();
      expect(harness.onLoading.mock.calls).toEqual([[true]]);
      void harness.inventory.refresh();
      expect(harness.read).toHaveBeenCalledTimes(1);

      harness.inventory.finishMutation();
      harness.inventory.finishMutation();
      const fresh = harness.inventory.refresh();
      expect(harness.read).toHaveBeenCalledTimes(2);
      harness.reads[1]!.resolve([grant("fresh")]);
      await fresh;
      expect(harness.onInventory).toHaveBeenCalledExactlyOnceWith([
        grant("fresh"),
      ]);
      expect(harness.onLoading).toHaveBeenLastCalledWith(false);
    },
  );

  it("ignores a stale failure after mutation completion and retries the fresh read on failure", async () => {
    const harness = inventoryHarness();
    const oldRead = harness.inventory.refresh();
    harness.inventory.beginMutation();
    harness.inventory.finishMutation();
    harness.reads[0]!.reject(new Error("Stale failure"));
    await oldRead;
    expect(harness.onError).not.toHaveBeenCalled();

    const fresh = harness.inventory.refresh();
    harness.reads[1]!.reject(new Error("Fresh failure"));
    await fresh;
    expect(harness.onError).toHaveBeenCalledExactlyOnceWith("Fresh failure");
    expect(harness.onLoading).toHaveBeenLastCalledWith(false);

    const retry = harness.inventory.refresh();
    harness.reads[2]!.resolve([]);
    await retry;
    expect(harness.onInventory).toHaveBeenCalledExactlyOnceWith([]);
    expect(harness.onError).toHaveBeenLastCalledWith("");
  });

  it("refreshes after mutation completion when there was no active read", async () => {
    const harness = inventoryHarness();
    harness.inventory.beginMutation();
    void harness.inventory.refresh();
    expect(harness.read).not.toHaveBeenCalled();
    harness.inventory.finishMutation();
    const fresh = harness.inventory.refresh();
    expect(harness.read).toHaveBeenCalledTimes(1);
    harness.reads[0]!.resolve([]);
    await fresh;
    expect(harness.onLoading.mock.calls).toEqual([[true], [false]]);
  });

  it.each(["success", "failure"])(
    "isolates an aborted lifecycle's late %s from a replacement lifecycle",
    async (outcome) => {
      const old = inventoryHarness();
      const oldRead = old.inventory.refresh();
      old.inventory.beginMutation();
      old.controller.abort();

      const replacement = inventoryHarness();
      const currentRead = replacement.inventory.refresh();
      expect(replacement.read).toHaveBeenCalledTimes(1);
      old.inventory.finishMutation();
      await old.inventory.refresh();
      expect(old.inventory.beginMutation()).toBe(false);
      if (outcome === "success") old.reads[0]!.resolve([grant("old")]);
      else old.reads[0]!.reject(new Error("Aborted failure"));
      await oldRead;

      expect(old.read).toHaveBeenCalledTimes(1);
      expect(old.onInventory).not.toHaveBeenCalled();
      expect(old.onError).not.toHaveBeenCalled();
      expect(old.onLoading.mock.calls).toEqual([[true]]);
      expect(replacement.onLoading.mock.calls).toEqual([[true]]);
      const repeated = replacement.inventory.refresh();
      expect(replacement.read).toHaveBeenCalledTimes(1);
      replacement.reads[0]!.resolve([grant("replacement")]);
      await Promise.all([currentRead, repeated]);
      expect(replacement.onInventory).toHaveBeenCalledExactlyOnceWith([
        grant("replacement"),
      ]);
      expect(replacement.onLoading).toHaveBeenLastCalledWith(false);
    },
  );

  it("ignores an aborted read resolving after the replacement inventory", async () => {
    const old = inventoryHarness();
    const oldRead = old.inventory.refresh();
    old.controller.abort();
    const replacement = inventoryHarness();
    const fresh = replacement.inventory.refresh();
    replacement.reads[0]!.resolve([grant("fresh")]);
    await fresh;
    old.reads[0]!.resolve([grant("old")]);
    await oldRead;
    expect(old.onInventory).not.toHaveBeenCalled();
    expect(old.onLoading.mock.calls).toEqual([[true]]);
    expect(replacement.onInventory).toHaveBeenCalledExactlyOnceWith([
      grant("fresh"),
    ]);
  });

  it("does not start work for an already aborted lifecycle", async () => {
    const harness = inventoryHarness();
    harness.controller.abort();
    await harness.inventory.refresh();
    expect(harness.inventory.beginMutation()).toBe(false);
    harness.inventory.finishMutation();
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.onLoading).not.toHaveBeenCalled();
  });

  it("recovers from a synchronous reader failure", async () => {
    const harness = inventoryHarness();
    harness.read.mockImplementationOnce(() => {
      throw new Error("Synchronous failure");
    });
    await harness.inventory.refresh();
    expect(harness.onError).toHaveBeenLastCalledWith("Synchronous failure");
    const retry = harness.inventory.refresh();
    harness.reads[0]!.resolve([]);
    await retry;
    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(harness.onInventory).toHaveBeenCalledExactlyOnceWith([]);
  });
});
