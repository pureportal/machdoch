import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderModelCatalogStore } from "./provider-model-catalog-store";
import {
  SUPPORTED_PROVIDER_ORDER,
  type RuntimeProvider,
} from "./model-catalog";

const snapshot = (provider: RuntimeProvider, id = "model") => ({
  generatedAt: Date.now(),
  providers: [
    {
      provider,
      available: true,
      models: [
        { id, capabilities: { imageInput: true, reasoningModes: ["high"] } },
      ],
    },
  ],
});

afterEach(() => vi.useRealTimers());

describe("provider model catalog background cache", () => {
  it("prefetches before opening, publishes fast providers independently, and shares in-flight requests", async () => {
    let resolveCodex!: (value: ReturnType<typeof snapshot>) => void;
    const codex = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveCodex = resolve;
    });
    const fetch = vi.fn((provider: RuntimeProvider) =>
      provider === "codex-cli" ? codex : Promise.resolve(snapshot(provider)),
    );
    const store = new ProviderModelCatalogStore(fetch);
    const stop = store.subscribe(vi.fn());
    const loading = store.load();
    await vi.waitFor(() =>
      expect(store.getSnapshot().catalog?.providers).toHaveLength(6),
    );
    expect(store.getSnapshot().loadingProviders.has("codex-cli")).toBe(true);
    expect(
      store.getSnapshot().catalog?.providers[0]?.models[0]?.capabilities
        ?.imageInput,
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(SUPPORTED_PROVIDER_ORDER.length);
    resolveCodex(snapshot("codex-cli"));
    await loading;
    await store.load();
    expect(fetch).toHaveBeenCalledTimes(SUPPORTED_PROVIDER_ORDER.length);
    stop();
  });

  it("refreshes every minute with the picker closed and stops polling after the last subscriber", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (provider: RuntimeProvider) =>
      snapshot(provider),
    );
    const store = new ProviderModelCatalogStore(fetch);
    const stopFirst = store.subscribe(vi.fn());
    const stopSecond = store.subscribe(vi.fn());
    await store.load();
    stopFirst();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(14);
    expect(fetch).toHaveBeenLastCalledWith("copilot-cli", true);
    stopSecond();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(14);
  });

  it("manual retry bypasses fresh failure cache for just the selected provider and deduplicates clicks", async () => {
    const fetch = vi.fn(async (provider: RuntimeProvider) => ({
      generatedAt: 1,
      providers: [
        { provider, available: false, models: [], error: "timed out" },
      ],
    }));
    const store = new ProviderModelCatalogStore(fetch);
    await store.load();
    await store.load();
    expect(fetch).toHaveBeenCalledTimes(7);
    await Promise.all([
      store.refresh("codex-cli", true),
      store.refresh("codex-cli", true),
    ]);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(fetch).toHaveBeenLastCalledWith("codex-cli", true);
  });

  it("keeps models and their features on transport failure, then clears them on rejected credentials", async () => {
    const fetch = vi.fn(async (provider: RuntimeProvider) =>
      snapshot(provider),
    );
    const store = new ProviderModelCatalogStore(fetch);
    await store.load();
    fetch.mockRejectedValueOnce(new Error("Connection timed out"));
    await store.refresh("openai", true);
    const saved = store
      .getSnapshot()
      .catalog?.providers.find((entry) => entry.provider === "openai");
    expect(saved?.available).toBe(true);
    expect(saved?.models[0]?.capabilities?.reasoningModes).toEqual(["high"]);
    expect(saved?.error).toBe("Connection timed out");
    fetch.mockRejectedValueOnce(new Error("HTTP 401"));
    await store.refresh("openai", true);
    const rejected = store
      .getSnapshot()
      .catalog?.providers.find((entry) => entry.provider === "openai");
    expect(rejected?.available).toBe(false);
    expect(rejected?.models).toEqual([]);
  });

  it("discards results invalidated by a credential change", async () => {
    let resolveOld!: (value: ReturnType<typeof snapshot>) => void;
    const old = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveOld = resolve;
    });
    const fetch = vi.fn(async (provider: RuntimeProvider) =>
      snapshot(provider, "new-model"),
    );
    fetch.mockReturnValueOnce(old);
    const store = new ProviderModelCatalogStore(fetch);
    const first = store.refresh("openai");
    await Promise.resolve();
    store.invalidate();
    await store.refresh("openai", true);
    resolveOld(snapshot("openai", "old-model"));
    await first;
    expect(store.getSnapshot().catalog?.providers[0]?.models[0]?.id).toBe(
      "new-model",
    );
  });
});
