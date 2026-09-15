import { beforeEach, expect, it, vi } from "vitest";
import type { MediaGenerationAssetMetadata } from "../../../core/media/contracts.js";

const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("../lib/_helpers/shell-store-storage.helper", () => ({
  loadStoredValue: storage.load,
  saveStoredValue: storage.save,
}));
beforeEach(() => {
  vi.resetModules();
  storage.load.mockReset();
  storage.save.mockReset().mockResolvedValue(true);
});
const metadata: MediaGenerationAssetMetadata = {
  categoryIds: [],
  tags: ["portrait"],
  triggerWords: "",
  sourceUrl: null,
  sampleAssetIds: [],
  sampleImages: [],
};

it("persists an import after navigation without replacing the latest draft", async () => {
  const store = await import("./media-studio-store");
  await store.saveMediaStudioState({
    ...store.DEFAULT_MEDIA_STUDIO_STATE,
    recipe: {
      ...store.DEFAULT_MEDIA_STUDIO_STATE.recipe,
      prompt: "Keep this draft",
    },
  });
  const listener = vi.fn();
  const unsubscribe = store.subscribeImportedMediaMetadata(listener);
  unsubscribe();
  await store.saveImportedMediaMetadata("model:portrait", metadata);
  const saved = await store.loadMediaStudioState();
  expect(saved.recipe.prompt).toBe("Keep this draft");
  expect(saved.assetMetadata["model:portrait"]).toEqual(metadata);
  expect(listener).not.toHaveBeenCalled();
  expect(storage.save.mock.lastCall?.[0].value).toEqual(saved);
});

it("serializes an import and later edits, and surfaces failed persistence", async () => {
  const store = await import("./media-studio-store");
  await store.saveMediaStudioState(store.DEFAULT_MEDIA_STUDIO_STATE);
  let release!: (value: boolean) => void;
  storage.save.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const first = store.saveImportedMediaMetadata("model:portrait", metadata);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const current = await store.loadMediaStudioState();
  const second = store.saveMediaStudioState({
    ...current,
    recipe: { ...current.recipe, prompt: "An edit during import" },
  });
  expect(storage.save).toHaveBeenCalledTimes(2);
  release(true);
  await Promise.all([first, second]);
  expect(storage.save.mock.lastCall?.[0].value.recipe.prompt).toBe(
    "An edit during import",
  );
  storage.save.mockResolvedValueOnce(false);
  await expect(
    store.saveImportedMediaMetadata("model:another", metadata),
  ).rejects.toThrow("could not be persisted");
  await expect(
    store.saveImportedMediaMetadata("model:another", metadata),
  ).resolves.toBeUndefined();
});
