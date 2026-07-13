import { beforeEach, describe, expect, it } from "vitest";

describe("browser shell-state CAS", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists the revision with state and rejects a stale writer after reload", async () => {
    const firstModule = await import("./shell-store");
    const initial = await firstModule.loadShellStateSnapshot({ value: "initial" });
    const committed = await firstModule.compareAndSwapShellState(
      initial.revision,
      { value: "first" },
    );

    expect(committed).toMatchObject({
      committed: true,
      revision: 1,
    });
    expect(committed).not.toHaveProperty("state");
    await expect(firstModule.loadShellStateRevision()).resolves.toBe(1);

    const secondModule = await import("./shell-store");
    const reloaded = await secondModule.loadShellStateSnapshot({
      value: "fallback",
    });
    const stale = await secondModule.compareAndSwapShellState(0, {
      value: "stale",
    });

    expect(reloaded).toEqual({ revision: 1, state: { value: "first" } });
    expect(stale).toMatchObject({
      committed: false,
      revision: 1,
      state: { value: "first" },
    });
  });

  it("rebases concurrent marketplace registry updates", async () => {
    const store = await import("./shell-store");

    await Promise.all([
      store.updateMcpMarketplaceStateAtomically((current) => ({
        version: 1,
        registries: [
          ...current.registries,
          {
            id: "one",
            title: "One",
            baseUrl: "https://one.example",
            enabled: true,
          },
        ],
      })),
      store.updateMcpMarketplaceStateAtomically((current) => ({
        version: 1,
        registries: [
          ...current.registries,
          {
            id: "two",
            title: "Two",
            baseUrl: "https://two.example",
            enabled: true,
          },
        ],
      })),
    ]);

    const loaded = await store.loadMcpMarketplaceState();
    expect(loaded.registries.map((registry) => registry.id)).toEqual([
      "one",
      "two",
    ]);
  });
});
