import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CivitaiInspection } from "../../../core/media/civitai.js";
import { enqueueCivitaiDownload } from "./civitai-download-queue";
import { mediaImportQueue } from "./media-import-queue";
import { civitaiRuntime } from "./civitai-runtime";
import { importMediaLocalModel, importMediaModelAddon } from "./media-runtime";
import { saveImportedMediaMetadata } from "./media-studio-store";

vi.mock("./civitai-runtime", () => ({
  civitaiRuntime: {
    storage: vi.fn(),
    download: vi.fn(),
    cancel: vi.fn(),
    progress: vi.fn(),
  },
}));
vi.mock("./media-runtime", () => ({
  importMediaLocalModel: vi.fn(),
  importMediaModelAddon: vi.fn(),
}));
vi.mock("./media-studio-store", () => ({ saveImportedMediaMetadata: vi.fn() }));

const inspection = {
  canDownload: true,
  reviewToken: "review",
  versionName: "v1",
  tags: ["landscape"],
  trainedWords: ["soft light"],
  sourceUrl: "https://civitai.com/models/1",
  file: { id: 1, byteSize: 1000, sha256: "hash" },
  suggestedArchitecture: "stable-diffusion-xl",
} as CivitaiInspection;
const enqueue = (hash = "hash") =>
  enqueueCivitaiDownload({
    label: hash,
    source: inspection.sourceUrl,
    images: [],
    inspection: { ...inspection, file: { ...inspection.file!, sha256: hash } },
  });
const local = {
  canImport: true,
  sourcePath: "model.safetensors",
  reviewToken: "local",
  detectedArchitecture: "stable-diffusion-xl",
};

beforeEach(() => {
  vi.mocked(civitaiRuntime.storage).mockResolvedValue({
    freeBytes: 10000,
    requiredBytes: 2100,
    warning: null,
    blockingReason: null,
  });
  vi.mocked(civitaiRuntime.progress).mockResolvedValue(vi.fn());
  vi.mocked(civitaiRuntime.cancel).mockResolvedValue();
  vi.mocked(civitaiRuntime.download).mockResolvedValue({
    model: local,
    addon: null,
    metadata: inspection,
  } as never);
  vi.mocked(importMediaLocalModel).mockResolvedValue({
    modelId: "imported",
  } as never);
  vi.mocked(saveImportedMediaMetadata).mockResolvedValue();
});
afterEach(() => {
  for (const job of mediaImportQueue.getSnapshot())
    mediaImportQueue.dismiss(job.id);
  vi.resetAllMocks();
});

describe("Civitai background downloads", () => {
  it("rechecks storage for each file and blocks the next transfer if space is exhausted", async () => {
    vi.mocked(civitaiRuntime.storage)
      .mockResolvedValueOnce({
        freeBytes: 10000,
        requiredBytes: 2100,
        warning: "Low disk space",
        blockingReason: null,
      })
      .mockResolvedValueOnce({
        freeBytes: 100,
        requiredBytes: 2100,
        warning: null,
        blockingReason: "Free up space",
      });
    enqueue();
    enqueue("second");
    await vi.waitFor(() =>
      expect(mediaImportQueue.getSnapshot()[1]?.status).toBe("failed"),
    );
    expect(civitaiRuntime.download).toHaveBeenCalledOnce();
    expect(importMediaLocalModel).toHaveBeenCalledOnce();
    expect(mediaImportQueue.getSnapshot()[0]?.warning).toBe("Low disk space");
    expect(mediaImportQueue.getSnapshot()[1]?.error).toBe("Free up space");
  });

  it("waits for import and metadata to finish before the next download", async () => {
    let finish!: () => void;
    vi.mocked(saveImportedMediaMetadata).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    enqueue();
    enqueue("second");
    await vi.waitFor(() =>
      expect(saveImportedMediaMetadata).toHaveBeenCalledOnce(),
    );
    expect(civitaiRuntime.download).toHaveBeenCalledOnce();
    expect(mediaImportQueue.getSnapshot()[0]?.status).toBe("importing");
    finish();
    await vi.waitFor(() =>
      expect(mediaImportQueue.hasPendingWork()).toBe(false),
    );
    expect(civitaiRuntime.download).toHaveBeenCalledTimes(2);
  });

  it("retries metadata persistence without downloading or importing twice", async () => {
    vi.mocked(saveImportedMediaMetadata).mockRejectedValueOnce(
      new Error("Save failed"),
    );
    enqueue();
    await vi.waitFor(() =>
      expect(mediaImportQueue.getSnapshot()[0]?.status).toBe("failed"),
    );
    mediaImportQueue.retry(mediaImportQueue.getSnapshot()[0]!.id);
    await vi.waitFor(() =>
      expect(mediaImportQueue.hasPendingWork()).toBe(false),
    );
    expect(civitaiRuntime.download).toHaveBeenCalledOnce();
    expect(importMediaLocalModel).toHaveBeenCalledOnce();
    expect(saveImportedMediaMetadata).toHaveBeenCalledTimes(2);
  });

  it("cancels a transfer and never imports its returned file", async () => {
    let finish!: (value: never) => void;
    vi.mocked(civitaiRuntime.download).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    enqueue();
    await vi.waitFor(() =>
      expect(civitaiRuntime.download).toHaveBeenCalledOnce(),
    );
    mediaImportQueue.cancel(mediaImportQueue.getSnapshot()[0]!.id);
    expect(civitaiRuntime.cancel).toHaveBeenCalledOnce();
    finish({ model: local, addon: null, metadata: inspection } as never);
    await vi.waitFor(() =>
      expect(mediaImportQueue.getSnapshot()[0]?.status).toBe("cancelled"),
    );
    expect(importMediaLocalModel).not.toHaveBeenCalled();
    expect(importMediaModelAddon).not.toHaveBeenCalled();
  });
});
