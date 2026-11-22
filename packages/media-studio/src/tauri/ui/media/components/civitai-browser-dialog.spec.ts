// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIVITAI_DEFAULT_SEARCH,
  type CivitaiModel,
} from "../../../../core/media/civitai.js";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import { civitaiRuntime } from "../civitai-runtime";
import { mediaImportQueue } from "../media-import-queue";
import { CivitaiBrowserDialog } from "./civitai-browser-dialog";

vi.mock("../civitai-runtime", () => ({
  civitaiRuntime: {
    options: vi.fn(),
    connection: vi.fn(),
    search: vi.fn(),
    getModel: vi.fn(),
    inspect: vi.fn(),
    storage: vi.fn(),
  },
}));
vi.mock("../civitai-preferences", () => ({
  loadCivitaiPreferences: vi.fn(async () => ({ ...CIVITAI_DEFAULT_SEARCH })),
  saveCivitaiPreferences: vi.fn(async () => true),
}));
vi.mock("../civitai-download-queue", () => ({
  enqueueCivitaiDownload: vi.fn(),
}));

const sha256 = "a".repeat(64);
const lora: CivitaiModel = {
  id: 1,
  name: "Ink Wash",
  type: "LORA",
  nsfw: false,
  description: null,
  matchedVersionId: null,
  tags: ["style"],
  creator: { username: "artist" },
  stats: { downloadCount: 1200, thumbsUpCount: 80 },
  modelVersions: [
    {
      id: 10,
      name: "v1",
      baseModel: "Flux.1 D",
      publishedAt: null,
      trainedWords: ["inkwash"],
      images: [],
      files: [
        {
          id: 100,
          name: "ink.safetensors",
          type: "Model",
          sizeKB: 2048,
          primary: true,
          hashes: { SHA256: sha256 },
          metadata: { format: "SafeTensor", fp: "fp16", size: null },
          pickleScanResult: "Success",
          virusScanResult: "Success",
        },
      ],
    },
  ],
};

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const flux1Dev = {
  ...createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
    isLocalFluxInstalled: true,
  }).models.find((model) => model.id === "local:flux-2-klein-4b")!,
  architecture: "flux-1-dev",
};

const renderDialog = (installedModels = [flux1Dev]) =>
  render(
    createElement(CivitaiBrowserDialog, {
      onClose: vi.fn(),
      installedHashes: new Set<string>(),
      installedModels,
      onImportSampleUrl: vi.fn(),
    }),
  );

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(civitaiRuntime.options).mockResolvedValue({
    modelTypes: ["Checkpoint", "LORA", "TextualInversion"],
    baseModels: ["SDXL 1.0", "Flux.1 D", "Qwen 2.1"],
    baseModelsByType: {
      Checkpoint: ["SDXL 1.0", "Qwen 2.1"],
      LORA: ["SDXL 1.0", "Flux.1 D"],
      TextualInversion: ["SDXL 1.0"],
    },
    baseModelArchitectures: {
      "SDXL 1.0": "stable-diffusion-xl",
      "Flux.1 D": "flux-1",
      "Qwen 2.1": "qwen-image-2.1",
    },
  });
  vi.mocked(civitaiRuntime.connection).mockResolvedValue(false);
  vi.mocked(civitaiRuntime.search).mockResolvedValue({
    items: [lora],
    nextCursor: null,
  });
  vi.mocked(civitaiRuntime.getModel).mockResolvedValue(lora);
  vi.mocked(civitaiRuntime.inspect).mockResolvedValue({
    canDownload: true,
    file: { id: 100, byteSize: 2048 * 1024, sha256 },
    versionId: 10,
  } as never);
  vi.mocked(civitaiRuntime.storage).mockResolvedValue({
    freeBytes: 10 * 1024 ** 3,
    requiredBytes: 4 * 1024 ** 2,
    warning: null,
    blockingReason: null,
  });
});

afterEach(() => {
  cleanup();
  for (const job of mediaImportQueue.getSnapshot()) {
    mediaImportQueue.cancel(job.id);
    mediaImportQueue.dismiss(job.id);
  }
  vi.unstubAllGlobals();
});

describe("Civitai browser", () => {
  it("offers only the base models supported for the chosen type", async () => {
    renderDialog();
    await screen.findByRole("button", { name: "View Ink Wash" }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("radio", { name: "Checkpoint" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Base model" }));
    expect(await screen.findByText("Qwen 2.1", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("Flux.1 D")).toBeNull();
    await waitFor(() =>
      expect(civitaiRuntime.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ modelType: "Checkpoint" }),
      ),
    );
  });

  it("opens details, shows inline progress, and returns with Escape", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "View Ink Wash" }, { timeout: 5000 }));
    expect(await screen.findByText("LoRA · Flux.1 D · artist", undefined, { timeout: 5000 })).toBeTruthy();
    const download = await screen.findByRole(
      "button",
      { name: /^Download · 2 MB$/u },
      { timeout: 5000 },
    );
    await waitFor(() =>
      expect((download as HTMLButtonElement).disabled).toBe(false),
    );
    mediaImportQueue.enqueue(
      "Ink Wash · v1",
      ({ update }) => {
        update({ received: 1024 * 1024, total: 2048 * 1024 });
        return new Promise<string>(() => undefined);
      },
      sha256,
    );
    expect(await screen.findByText("1 MB / 2 MB · 50%", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(
      await screen.findByRole("button", { name: "View Ink Wash" }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  it("warns when no installed model can use the add-on", async () => {
    renderDialog([]);
    fireEvent.click(await screen.findByRole("button", { name: "View Ink Wash" }, { timeout: 5000 }));
    expect(
      await screen.findByText("None of your installed models can use this LoRA.", undefined, { timeout: 5000 }),
    ).toBeTruthy();
  });

  it("accepts FLUX.1 LoRAs for an installed FLUX.1 dev model", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "View Ink Wash" }, { timeout: 5000 }));
    await screen.findByText("LoRA · Flux.1 D · artist", undefined, { timeout: 5000 });
    expect(
      screen.queryByText("None of your installed models can use this LoRA."),
    ).toBeNull();
  });
});
