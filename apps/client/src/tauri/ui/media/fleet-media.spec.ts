import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "@machdoch/media-studio/core/media/catalog.js";
import type { MediaModelDescriptor } from "@machdoch/media-studio/core/media/contracts.js";
import type { FleetControlCommandEvent } from "../runtime";
import { DEFAULT_MEDIA_STUDIO_STATE } from "@machdoch/media-studio/tauri/ui/media/media-studio-store.js";
import {
  executeFleetMediaCommand,
  loadFleetMediaSnapshot,
  unavailableFleetMediaSnapshot,
} from "./fleet-media";

const runtime = vi.hoisted(() => ({
  initializeMediaRuntime: vi.fn(),
  getMediaModelCatalog: vi.fn(),
  listMediaAssets: vi.fn(),
  listMediaRuns: vi.fn(),
  readMediaAssetPreview: vi.fn(),
  saveMediaFlowRevision: vi.fn(),
  generateMediaImages: vi.fn(),
  generateMediaSvg: vi.fn(),
  cancelMediaRun: vi.fn(),
}));
const storage = vi.hoisted(() => ({
  loadMediaStudioState: vi.fn(),
  saveMediaStudioState: vi.fn(),
}));

vi.mock("@machdoch/media-studio/tauri/ui/media/media-runtime.js", () => runtime);
vi.mock("@machdoch/media-studio/tauri/ui/media/media-studio-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@machdoch/media-studio/tauri/ui/media/media-studio-store.js")>()),
  ...storage,
}));

function catalogModel(): MediaModelDescriptor {
  return {
    ...createMediaModelCatalogSnapshot({ isOpenAiConfigured: true }).models[0]!,
    lifecycleCheckedAt: new Date().toISOString(),
  };
}

function setModels(
  models: MediaModelDescriptor[],
  runnableIds = models.map((model) => model.id),
) {
  runtime.getMediaModelCatalog.mockResolvedValue({
    ...createMediaModelCatalogSnapshot({ isOpenAiConfigured: true }),
    models,
  });
  runtime.initializeMediaRuntime.mockResolvedValue({
    mode: "native",
    directGenerationModelIds: runnableIds,
  });
}

function generationCommand(): FleetControlCommandEvent {
  return {
    commandId: "fleet-generation",
    kind: "generate-media",
    createdAt: Date.now(),
    prompt: "A ceramic cup",
    modelId: catalogModel().id,
    target: "image",
    aspectRatio: "1:1",
    outputCount: 1,
    outputFormat: "png",
    transparentBackground: false,
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  storage.loadMediaStudioState.mockResolvedValue(
    structuredClone(DEFAULT_MEDIA_STUDIO_STATE),
  );
  runtime.listMediaAssets.mockResolvedValue([]);
  runtime.listMediaRuns.mockResolvedValue([]);
  runtime.saveMediaFlowRevision.mockResolvedValue({
    revision: { revisionId: "revision-1" },
  });
  runtime.generateMediaImages.mockResolvedValue({ id: "fleet-generation" });
  runtime.generateMediaSvg.mockResolvedValue({ id: "fleet-generation" });
  setModels([catalogModel()]);
  await executeFleetMediaCommand(
    {
      commandId: "clear-error",
      kind: "cancel-media-run",
      runId: "previous-run",
      createdAt: Date.now(),
    },
    [],
  );
  runtime.cancelMediaRun.mockClear();
});

describe("Fleet desktop media bridge", () => {
  it("refreshes imported and removed models after the first snapshot", async () => {
    const imported = {
      ...catalogModel(),
      id: "imported-checkpoint",
      target: "local" as const,
    };
    setModels([imported], []);
    expect((await loadFleetMediaSnapshot([])).models).toEqual([]);
    setModels([imported]);
    expect(
      (await loadFleetMediaSnapshot([])).models.map((model) => model.id),
    ).toEqual([imported.id]);
    setModels([imported], []);
    expect((await loadFleetMediaSnapshot([])).generation.available).toBe(false);
  });

  it.each([
    { configured: false },
    { lifecycle: "removed" as const },
    { target: "local" as const, installed: false },
    { target: "local" as const, runtimeReadiness: "unverified" as const },
    { target: "local" as const, runtimeReadiness: "failed" as const },
    {
      target: "local" as const,
      runtimeReadiness: "runtime-unavailable" as const,
    },
  ])(
    "excludes unavailable models and rejects their generation commands: %j",
    async (changes) => {
      setModels([{ ...catalogModel(), ...changes }]);
      const snapshot = await loadFleetMediaSnapshot([]);
      expect(snapshot.models).toEqual([]);
      expect(snapshot.generation.available).toBe(false);
      await expect(
        executeFleetMediaCommand(generationCommand(), []),
      ).rejects.toThrow("not ready");
      expect(runtime.saveMediaFlowRevision).not.toHaveBeenCalled();
      expect(runtime.generateMediaImages).not.toHaveBeenCalled();
    },
  );

  it("shares concurrent runtime reads but refreshes after they settle", async () => {
    let finish!: (value: unknown) => void;
    runtime.initializeMediaRuntime.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = loadFleetMediaSnapshot([]);
    const second = loadFleetMediaSnapshot([]);
    expect(runtime.initializeMediaRuntime).toHaveBeenCalledTimes(1);
    finish({ mode: "native", directGenerationModelIds: [catalogModel().id] });
    await Promise.all([first, second]);
    await loadFleetMediaSnapshot([]);
    expect(runtime.initializeMediaRuntime).toHaveBeenCalledTimes(2);
  });

  it("retries runtime initialization after failure", async () => {
    runtime.initializeMediaRuntime.mockRejectedValueOnce(
      new Error("Runtime unavailable"),
    );
    await expect(loadFleetMediaSnapshot([])).rejects.toThrow(
      "Runtime unavailable",
    );
    expect((await loadFleetMediaSnapshot([])).generation.available).toBe(true);
  });

  it.each(["image", "svg"] as const)(
    "compiles and submits a %s recipe through the native adapter",
    async (target) => {
      const model = catalogModel();
      if (target === "svg") {
        model.id = "quiver:arrow-1.1";
        model.providerId = "quiver";
        model.capabilities = ["text-to-svg"];
      }
      setModels([model]);
      await executeFleetMediaCommand(
        {
          ...generationCommand(),
          target,
          modelId: model.id,
          outputFormat: target === "svg" ? "svg" : "webp",
          prompt: "  A ceramic cup\r\nwith a blue handle  ",
        },
        [model.providerId],
      );
      const generate =
        target === "svg"
          ? runtime.generateMediaSvg
          : runtime.generateMediaImages;
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "fleet-generation",
          flowRevisionId: "revision-1",
          modelId: model.id,
          prompt: "A ceramic cup\nwith a blue handle",
          outputCount: 1,
        }),
      );
      expect(storage.saveMediaStudioState).toHaveBeenCalledWith(
        expect.objectContaining({
          target,
          activeSection: "runs",
        }),
      );
    },
  );

  it("surfaces asynchronous generation failures and allows a subsequent submission", async () => {
    runtime.generateMediaImages.mockRejectedValueOnce(
      new Error("Provider refused generation"),
    );
    await executeFleetMediaCommand(generationCommand(), ["openai"]);
    expect((await loadFleetMediaSnapshot(["openai"])).error).toBe(
      "Provider refused generation",
    );
    await executeFleetMediaCommand(generationCommand(), ["openai"]);
    expect((await loadFleetMediaSnapshot(["openai"])).error).toBeUndefined();
  });

  it("forwards cancellation and preserves a snapshot when refreshing fails", async () => {
    await executeFleetMediaCommand(
      {
        commandId: "cancel-command",
        kind: "cancel-media-run",
        runId: "active-run",
        createdAt: Date.now(),
      },
      [],
    );
    expect(runtime.cancelMediaRun).toHaveBeenCalledWith("active-run");
    const snapshot = await loadFleetMediaSnapshot([]);
    expect(
      unavailableFleetMediaSnapshot(new Error("Disconnected"), snapshot),
    ).toMatchObject({
      models: snapshot.models,
      loading: false,
      error: "Disconnected",
    });
  });
});
