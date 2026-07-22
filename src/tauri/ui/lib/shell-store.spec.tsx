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

  it("rebases a queued RALPH edit over newly imported preferences", async () => {
    const store = await import("./shell-store");
    const initial = {
      ...store.DEFAULT_RALPH_SETTINGS,
      workspaceRoot: "C:/old-workspace",
      flowLibraryMode: "workspace" as const,
      generationProvider: "openai" as const,
      generationModel: "old-generation",
      runProvider: "openai" as const,
      runModel: "old-run",
    };
    await store.saveRalphSettings(initial);
    const staleBase = await store.loadRalphSettings();

    await store.saveRalphSettings({
      ...staleBase,
      flowLibraryMode: "all",
      generationProvider: "anthropic",
      generationModel: "imported-generation",
      runProvider: "codex-cli",
      runModel: "imported-run",
    });
    const committed = await store.saveRalphSettings(
      { ...staleBase, workspaceRoot: "C:/new-workspace" },
      staleBase,
    );

    expect(committed).toMatchObject({
      workspaceRoot: "C:/new-workspace",
      flowLibraryMode: "all",
      generationProvider: "anthropic",
      generationModel: "imported-generation",
      runProvider: "codex-cli",
      runModel: "imported-run",
    });
    await expect(store.loadRalphSettings()).resolves.toEqual(committed);
  });

  it("drops a running-action save queued before an import revision", async () => {
    const store = await import("./shell-store");
    const operations = await import("./cross-window-operation");
    const operationId =
      "machdoch:store-write:machdoch.desktop.running-task-message-action";
    const lease = await operations.beginCrossWindowOperation(operationId);
    expect(lease).not.toBeNull();
    if (!lease) {
      throw new Error("Expected the running-action write lease.");
    }
    window.localStorage.setItem(
      "machdoch.desktop.running-task-message-action",
      "queue",
    );

    const queuedSave = store.saveRunningTaskMessageAction("steer");
    await Promise.resolve();
    window.localStorage.setItem(
      "machdoch.desktop.running-task-message-action-import-revision",
      "1",
    );
    await operations.releaseCrossWindowOperation(lease);
    await queuedSave;

    await expect(store.loadRunningTaskMessageAction()).resolves.toBe("queue");
  });
});
