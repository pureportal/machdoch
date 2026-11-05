// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MediaModelAddonDescriptor,
  MediaModelCatalogSnapshot,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import type { CivitaiModel } from "../../../core/media/civitai.js";
import { appControl } from "../app-control/app-control-registry";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  normalizeMediaStudioState,
} from "./media-studio-store";

const runtime = vi.hoisted(() => ({
  search: vi.fn(),
  getModel: vi.fn(),
  inspect: vi.fn(),
  enqueue: vi.fn(() => "job-1"),
  waitFor: vi.fn(async (_id: string, _signal?: AbortSignal) => "addon-tomb"),
  cancel: vi.fn(),
}));

vi.mock("./civitai-runtime", () => ({
  civitaiRuntime: {
    options: async () => ({
      modelTypes: ["LORA"],
      baseModels: ["SDXL 1.0", "Illustrious", "Flux.1 D"],
      baseModelsByType: { LORA: ["SDXL 1.0", "Illustrious", "Flux.1 D"] },
      baseModelArchitectures: {
        "SDXL 1.0": "stable-diffusion-xl",
        Illustrious: "stable-diffusion-xl",
        "Flux.1 D": "flux-1",
      },
    }),
    search: runtime.search,
    getModel: runtime.getModel,
    inspect: runtime.inspect,
  },
}));
vi.mock("./civitai-preferences", () => ({
  loadCivitaiPreferences: async () => ({ contentMode: "normal" }),
}));
vi.mock("./civitai-download-queue", () => ({
  enqueueCivitaiDownload: runtime.enqueue,
}));
vi.mock("./media-import-queue", () => ({
  mediaImportQueue: {
    waitFor: runtime.waitFor,
    cancel: runtime.cancel,
    getSnapshot: () => [],
  },
}));

const { useMediaAppControl } = await import("./use-media-app-control");

afterEach(cleanup);

const baseCatalog = createMediaModelCatalogSnapshot({
  isLocalFluxInstalled: true,
  isOpenAiConfigured: false,
});
const model = baseCatalog.models.find(
  ({ architecture }) => architecture === "illustrious-xl",
)!;
const tombLora: MediaModelAddonDescriptor = {
  id: "addon-tomb",
  kind: "lora",
  displayName: "Tomb Raider XL",
  architecture: "stable-diffusion-xl",
  architectureConfidence: "high",
  format: "safetensors",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "lora",
    dialect: "kohya",
    rankMinimum: 16,
    rankMaximum: 16,
    heterogeneousRanks: false,
    targetModuleCount: 10,
    convolutionTargetCount: 0,
    magnitudeVectorCount: 0,
    networkAlphaCount: 10,
  },
  baseModelHint: "SDXL 1.0",
  triggerWords: ["lara croft"],
  defaultToken: null,
  digest: "c".repeat(64),
  headerDigest: "d".repeat(64),
  byteSize: 1,
  relativePath: "tomb.safetensors",
  sourceUrl: null,
  license: {
    name: "Unknown",
    spdxId: null,
    sourceUrl: null,
    commercialUse: "review-required",
    requiresAcceptance: false,
  },
  importedAt: "2026-11-05T00:00:00.000Z",
};
const civitaiModel = (id: number, downloads: number): CivitaiModel => ({
  id,
  name: `Tomb Raider ${id}`,
  type: "LORA",
  nsfw: false,
  tags: ["character"],
  description: null,
  matchedVersionId: null,
  creator: { username: "maker" },
  stats: { downloadCount: downloads, thumbsUpCount: 10 },
  modelVersions: [
    {
      id: id * 10,
      name: "v1",
      baseModel: "SDXL 1.0",
      publishedAt: null,
      trainedWords: ["lara croft"],
      images: [],
      files: [
        {
          id: id * 100,
          name: "tomb.safetensors",
          type: "Model",
          sizeKB: 2048,
          primary: true,
          hashes: { SHA256: "C".repeat(64) },
          metadata: null,
          pickleScanResult: "Success",
          virusScanResult: "Success",
        },
      ],
    },
  ],
});

const renderMedia = (staleRefreshes = 0) => {
  const initial = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);
  let refreshes = 0;
  const refreshCatalog = vi.fn(
    async (): Promise<MediaModelCatalogSnapshot | null> =>
      refreshes++ < staleRefreshes
        ? null
        : { ...baseCatalog, addons: [tombLora] },
  );
  const hook = renderHook(() => {
    const [state, setState] = useState<MediaStudioState>({
      ...initial,
      activeSection: "generate",
      target: "image",
      recipe: {
        ...initial.recipe,
        modelId: model.id,
        prompt: "explorer in a jungle temple",
        modelAddons: [],
      },
    });
    const [catalog, setCatalog] =
      useState<MediaModelCatalogSnapshot>(baseCatalog);
    useMediaAppControl({
      enabled: true,
      state,
      setState,
      catalog,
      runnableImageModelIds: null,
      generationJobs: [],
      refreshCatalog: async () => {
        const next = await refreshCatalog();
        if (next) setCatalog(next);
        return next;
      },
      onSelectSection: vi.fn(),
      onSelectTarget: vi.fn(),
      onUseModel: vi.fn(),
    });
    return state;
  });
  return { hook, refreshCatalog };
};

describe("Media Studio app control", () => {
  it("describes Basic with the selected model and searches compatible base models", async () => {
    runtime.search.mockImplementation(async ({ baseModel }) => ({
      items:
        baseModel === "SDXL 1.0"
          ? [civitaiModel(1, 50), civitaiModel(2, 900)]
          : [civitaiModel(2, 900)],
      nextCursor: null,
    }));
    renderMedia();
    const snapshot = appControl.snapshot();
    expect(snapshot.location).toEqual(["Basic", "Image"]);
    expect(snapshot.state.media).toMatchObject({
      model: { id: model.id, architecture: "illustrious-xl" },
      loras: [],
    });

    const result = (await appControl.run(
      "media.search_civitai",
      { query: "tomb raider" },
      { mode: "ask" },
    )) as {
      baseModels: string[];
      results: { modelId: number; versions: { compatible: boolean }[] }[];
    };
    expect(result.baseModels).toEqual(["Illustrious", "SDXL 1.0"]);
    expect(runtime.search).toHaveBeenCalledTimes(2);
    expect(result.results.map(({ modelId }) => modelId)).toEqual([2, 1]);
    expect(result.results[0]?.versions[0]?.compatible).toBe(true);
  });

  it("installs a LoRA, adds it to the list, and inserts its trigger word", async () => {
    runtime.getModel.mockResolvedValue(civitaiModel(2, 900));
    runtime.inspect.mockResolvedValue({ canDownload: true, file: { id: 200 } });
    const { hook } = renderMedia();

    let outcome: unknown;
    await act(async () => {
      outcome = await appControl.run(
        "media.install_civitai",
        { modelId: 2, strength: 0.7 },
        { mode: "machdoch" },
      );
    });

    expect(runtime.getModel).toHaveBeenCalledWith("2", false);
    expect(runtime.inspect).toHaveBeenCalledWith(
      "https://civitai.com/models/2?modelVersionId=20",
      200,
    );
    expect(runtime.waitFor).toHaveBeenCalledWith("job-1", expect.anything());
    expect(outcome).toMatchObject({
      installed: { resourceId: "addon-tomb", name: "Tomb Raider XL" },
      added: true,
      insertedTrigger: "lara croft",
    });
    expect(hook.result.current.recipe.prompt).toBe(
      "explorer in a jungle temple, lara croft",
    );
    expect(hook.result.current.recipe.modelAddons).toEqual([
      expect.objectContaining({
        addonId: "addon-tomb",
        enabled: true,
        modelStrength: 0.7,
      }),
    ]);
  });

  it("rejects changes in ask mode", async () => {
    renderMedia();
    await expect(
      appControl.run("media.set_prompt", { prompt: "x" }, { mode: "ask" }),
    ).rejects.toThrow("needs Machdoch mode");
  });

  it("keeps refreshing until a new LoRA appears in the catalog", async () => {
    runtime.getModel.mockResolvedValue(civitaiModel(2, 900));
    runtime.inspect.mockResolvedValue({ canDownload: true, file: { id: 200 } });
    const { hook, refreshCatalog } = renderMedia(2);
    let outcome: unknown;
    await act(async () => {
      outcome = await appControl.run(
        "media.install_civitai",
        { modelId: 2 },
        { mode: "machdoch" },
      );
    });
    expect(refreshCatalog).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({ added: true });
    expect(hook.result.current.recipe.modelAddons).toHaveLength(1);
  });

  it("cancels its own download when the request is cancelled", async () => {
    runtime.getModel.mockResolvedValue(civitaiModel(2, 900));
    runtime.inspect.mockResolvedValue({ canDownload: true, file: { id: 200 } });
    runtime.cancel.mockClear();
    runtime.enqueue.mockClear();
    runtime.waitFor.mockImplementationOnce(
      (_id, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("stopped"))),
        ),
    );
    renderMedia();
    const controller = new AbortController();
    const running = appControl.run(
      "media.install_civitai",
      { modelId: 2 },
      { mode: "machdoch", signal: controller.signal },
    );
    await vi.waitFor(() => expect(runtime.enqueue).toHaveBeenCalled());
    controller.abort();
    await expect(running).rejects.toThrow("cancelled");
    expect(runtime.cancel).toHaveBeenCalledWith("job-1");
  });

  it("changes image options and reports partial Civitai failures", async () => {
    const { hook } = renderMedia();
    await act(async () => {
      await appControl.run(
        "media.set_image_options",
        { aspectRatio: "16:9", outputCount: 2, seed: -1 },
        { mode: "machdoch" },
      );
    });
    expect(hook.result.current.recipe).toMatchObject({
      aspectRatio: "16:9",
      outputCount: 2,
      seed: null,
    });

    runtime.search.mockImplementation(async ({ baseModel }) => {
      if (baseModel === "SDXL 1.0") throw new Error("Civitai is down");
      return { items: [civitaiModel(3, 5)], nextCursor: null };
    });
    const result = (await appControl.run(
      "media.search_civitai",
      { query: "tomb" },
      { mode: "ask" },
    )) as { partial?: string; results: unknown[] };
    expect(result.partial).toBe("1 of 2 searches failed.");
    expect(result.results).toHaveLength(1);
  });

  it("reports when Media Studio closes before a downloaded LoRA can be added", async () => {
    runtime.getModel.mockResolvedValue(civitaiModel(2, 900));
    runtime.inspect.mockResolvedValue({ canDownload: true, file: { id: 200 } });
    runtime.waitFor.mockClear();
    let finishDownload = (): void => undefined;
    runtime.waitFor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDownload = () => resolve("addon-tomb");
        }),
    );
    const { hook } = renderMedia();
    const running = appControl.run(
      "media.install_civitai",
      { modelId: 2 },
      { mode: "machdoch" },
    );
    await vi.waitFor(() => expect(runtime.waitFor).toHaveBeenCalled());
    hook.unmount();
    finishDownload();
    await expect(running).resolves.toMatchObject({
      added: false,
      reason: expect.stringContaining("Media Studio closed"),
    });
  });
});
