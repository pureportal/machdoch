// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaModelDescriptor } from "../../../../core/media/contracts.js";
import type {
  MediaTrainingArchitecture,
  MediaTrainingJob,
  MediaTrainingRequest,
  MediaTrainingStatus,
} from "../media-training";
import { MediaTrainView } from "./media-train-view";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isRemoteMedia: vi.fn(),
  open: vi.fn(),
  inspectImages: vi.fn(),
  submitTraining: vi.fn(),
  getTrainingStatus: vi.fn(),
  cancelTraining: vi.fn(),
  resumeTraining: vi.fn(),
  finishTraining: vi.fn(),
  inspectAddon: vi.fn(),
  importAddon: vi.fn(),
}));

vi.mock("../media-platform", () => ({
  invoke: mocks.invoke,
  hasMediaHost: () => true,
  isRemoteMedia: mocks.isRemoteMedia,
  open: mocks.open,
  openUrl: vi.fn(),
}));

vi.mock("../media-training", () => ({
  submitTraining: mocks.submitTraining,
  inspectTrainingImages: mocks.inspectImages,
  getTrainingStatus: mocks.getTrainingStatus,
  cancelTraining: mocks.cancelTraining,
  resumeTraining: mocks.resumeTraining,
  finishTraining: mocks.finishTraining,
}));

vi.mock("../media-runtime", () => ({
  importMediaModelAddon: mocks.importAddon,
  inspectMediaModelAddon: mocks.inspectAddon,
}));

const paths = [
  "C:\\images\\one.png",
  "C:\\images\\two.png",
  "C:\\images\\three.png",
];
const jobKey = "media:local-training-job";
const startingStatus: MediaTrainingStatus = {
  state: "starting",
  message: null,
  outputPath: null,
  canResume: false,
  completedSteps: null,
  totalSteps: 1000,
};

const sdxlModel = (
  id: string,
  overrides: Partial<MediaModelDescriptor> = {},
): MediaModelDescriptor => ({
  id,
  providerId: "local-diffusers",
  displayName: id,
  family: "SDXL",
  target: "local",
  lifecycle: "active",
  lifecycleCheckedAt: "2026-10-04T00:00:00Z",
  lifecycleStaleAfterSeconds: 86400,
  catalogRevision: "test",
  capabilities: ["text-to-image"],
  configured: true,
  installed: true,
  bundled: false,
  installationStatus: "installed",
  packageType: "safetensors",
  management: { acquisition: "file-import" },
  architecture: "stable-diffusion-xl",
  addonCapabilities: [
    {
      kind: "lora",
      targetComponents: ["denoiser"],
      maxActive: 4,
      supportsSeparateComponentStrengths: false,
      supportsDenoisingSchedules: false,
    },
  ],
  license: {
    name: "Test license",
    spdxId: null,
    sourceUrl: "https://example.com/license",
    commercialUse: "unknown",
    requiresAcceptance: false,
  },
  recommended: false,
  speedScore: 3,
  qualityScore: 4,
  privacySummary: "Local",
  userImported: true,
  ...overrides,
});

const trainingRequest: MediaTrainingRequest = {
  name: "Test LoRA",
  concept: "style",
  triggerPhrase: "test-style",
  images: paths.map((path) => ({ path, caption: "" })),
  architecture: "stable-diffusion-xl",
  modelId: "sdxl-base",
  modelPath: "",
  steps: 1000,
  learningRate: 0.0003,
  resolution: 768,
  rank: 32,
  attentionOnly: true,
  fourBit: false,
  seed: 0,
};

const savedJob = (
  architecture: MediaTrainingArchitecture,
): MediaTrainingJob => ({
  id: "training-job",
  name: "Test LoRA",
  concept: "style",
  triggerPhrase: "test-style",
  architecture,
});

const renderTraining = (
  overrides: Partial<ComponentProps<typeof MediaTrainView>> = {},
) => {
  const props: ComponentProps<typeof MediaTrainView> = {
    models: [sdxlModel("sdxl-base"), sdxlModel("sdxl-custom")],
    onImported: vi.fn().mockResolvedValue(undefined),
    onUseAddon: vi.fn(),
    canUseAddon: vi.fn().mockReturnValue(false),
    onFindModel: vi.fn(),
    ...overrides,
  };
  return { ...render(createElement(MediaTrainView, props)), props };
};

const fillTraining = async (): Promise<void> => {
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Test LoRA" },
  });
  fireEvent.change(screen.getByLabelText("Trigger phrase"), {
    target: { value: "test-style" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add images" }));
  await waitFor(() => expect(screen.getByText("Images (3)")).toBeTruthy());
};

const prepareCompletedJob = (architecture: MediaTrainingArchitecture): void => {
  localStorage.setItem(jobKey, JSON.stringify(savedJob(architecture)));
  mocks.getTrainingStatus.mockResolvedValue({
    ...startingStatus,
    state: "completed",
    outputPath: "D:\\Models\\machdoch\\trained.safetensors",
    completedSteps: 1000,
  });
  mocks.inspectAddon.mockResolvedValue({
    canImport: true,
    detectedArchitecture: architecture,
    reviewToken: "review",
    blockingReason: null,
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  mocks.isRemoteMedia.mockReturnValue(false);
  mocks.open.mockResolvedValue(paths);
  mocks.inspectImages.mockResolvedValue(
    paths.map((path) => ({ path, width: 1024, height: 1024 })),
  );
  mocks.submitTraining.mockImplementation(
    async (request: MediaTrainingRequest): Promise<MediaTrainingJob> => ({
      id: "training-job",
      name: request.name,
      concept: request.concept,
      triggerPhrase: request.triggerPhrase,
      architecture: request.architecture,
    }),
  );
  mocks.getTrainingStatus.mockResolvedValue(startingStatus);
  mocks.cancelTraining.mockResolvedValue(undefined);
  mocks.resumeTraining.mockResolvedValue(undefined);
  mocks.finishTraining.mockResolvedValue(undefined);
  mocks.importAddon.mockResolvedValue({ addonId: "trained-lora" });
});

afterEach(cleanup);

describe("MediaTrainView", () => {
  it("shows dataset and resolution warnings for inspected images", async () => {
    mocks.inspectImages.mockResolvedValue(
      paths.map((path) => ({ path, width: 512, height: 512 })),
    );
    renderTraining();

    fireEvent.click(screen.getByRole("button", { name: "Add images" }));
    await waitFor(() => expect(screen.getByText("Images (3)")).toBeTruthy());
    expect(
      screen.getByText(
        "Only 3 images. Add varied examples for more reliable results.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "3 images are smaller than the 768px training size. Use larger originals.",
      ),
    ).toBeTruthy();
    expect(mocks.inspectImages).toHaveBeenCalledWith(paths);

    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.change(screen.getByLabelText("Resolution"), {
      target: { value: "512" },
    });
    expect(screen.queryByText(/images are smaller/u)).toBeNull();
  });

  it("keeps undecodable images out of the dataset", async () => {
    mocks.open.mockResolvedValue(["C:\\images\\broken.png"]);
    mocks.inspectImages.mockRejectedValue(
      new Error("broken.png could not be decoded. Choose another image."),
    );
    renderTraining();

    fireEvent.click(screen.getByRole("button", { name: "Add images" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not be decoded",
      ),
    );
    expect(screen.getByText("Images (0)")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Train locally",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("submits an installed SDXL model with the default settings", async () => {
    renderTraining();
    await fillTraining();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect((screen.getByLabelText("Steps") as HTMLInputElement).value).toBe(
      "1000",
    );
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("0");
    expect(screen.queryByLabelText("4-bit model weights")).toBeNull();
    expect(screen.queryByLabelText("Attention layers only")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose folder" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Train locally" }));
    await waitFor(() =>
      expect(mocks.submitTraining).toHaveBeenCalledWith(trainingRequest),
    );
    await waitFor(() =>
      expect(mocks.getTrainingStatus).toHaveBeenCalledWith("training-job"),
    );
    expect(JSON.parse(localStorage.getItem(jobKey) ?? "null")).toEqual(
      savedJob("stable-diffusion-xl"),
    );
  });

  it.each([4, 8] as const)(
    "submits the selected SDXL model with rank %s and one training step",
    async (rank) => {
      renderTraining();
      await fillTraining();
      fireEvent.change(screen.getByLabelText("Base model"), {
        target: { value: "sdxl-custom" },
      });
      fireEvent.change(screen.getByLabelText("Type"), {
        target: { value: "character" },
      });
      fireEvent.change(screen.getByLabelText("Caption for one.png"), {
        target: { value: "test-style portrait" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Advanced settings" }),
      );
      const stepsInput = screen.getByLabelText("Steps") as HTMLInputElement;
      expect(stepsInput.min).toBe("1");
      expect(stepsInput.step).toBe("1");
      fireEvent.change(stepsInput, { target: { value: "1" } });
      fireEvent.change(screen.getByLabelText("Rank"), {
        target: { value: String(rank) },
      });
      fireEvent.change(screen.getByLabelText("Seed"), {
        target: { value: "4294967295" },
      });
      fireEvent.change(screen.getByLabelText("Learning rate"), {
        target: { value: "0.00001" },
      });
      fireEvent.change(screen.getByLabelText("Resolution"), {
        target: { value: "1024" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Train locally" }));
      await waitFor(() =>
        expect(mocks.submitTraining).toHaveBeenCalledWith({
          ...trainingRequest,
          modelId: "sdxl-custom",
          concept: "character",
          steps: 1,
          rank,
          seed: 4294967295,
          learningRate: 0.00001,
          resolution: 1024,
          images: [
            { path: paths[0], caption: "test-style portrait" },
            ...paths.slice(1).map((path) => ({ path, caption: "" })),
          ],
        }),
      );
    },
  );

  it("lists only installed local SDXL models and disables a removed selection", async () => {
    const view = renderTraining({
      models: [
        sdxlModel("sdxl-base"),
        sdxlModel("sdxl-custom"),
        sdxlModel("not-installed", {
          installed: false,
          installationStatus: "not-installed",
        }),
        sdxlModel("krea", { architecture: "krea-2" }),
        sdxlModel("remote", { target: "remote" }),
      ],
    });
    expect(screen.queryByRole("option", { name: "not-installed" })).toBeNull();
    expect(screen.queryByRole("option", { name: "krea" })).toBeNull();
    expect(screen.queryByRole("option", { name: "remote" })).toBeNull();
    await fillTraining();
    fireEvent.change(screen.getByLabelText("Base model"), {
      target: { value: "sdxl-custom" },
    });
    view.rerender(
      createElement(MediaTrainView, {
        ...view.props,
        models: [sdxlModel("sdxl-base")],
      }),
    );

    expect(
      (screen.getByLabelText("Base model") as HTMLSelectElement).value,
    ).toBe("");
    const trainButton = screen.getByRole("button", {
      name: "Train locally",
    }) as HTMLButtonElement;
    expect(trainButton.disabled).toBe(true);
    fireEvent.click(trainButton);
    expect(mocks.submitTraining).not.toHaveBeenCalled();
  });

  it("finds SDXL models when none are installed", async () => {
    const view = renderTraining({
      models: [
        sdxlModel("not-installed", {
          installed: false,
          installationStatus: "not-installed",
        }),
      ],
    });
    fireEvent.change(screen.getByLabelText("Architecture"), {
      target: { value: "stable-diffusion-xl" },
    });
    await fillTraining();
    expect(
      (screen.getByLabelText("Base model") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Train locally",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Find SDXL model" }));
    expect(view.props.onFindModel).toHaveBeenCalledWith("stable-diffusion-xl");
  });

  it.each([
    { field: "Steps", invalid: ["0", "1.5", "10001"], valid: "10000" },
    {
      field: "Seed",
      invalid: ["-1", "1.5", "4294967296"],
      valid: "4294967295",
    },
    { field: "Learning rate", invalid: ["0.000001", "0.0011"], valid: "0.001" },
  ])(
    "blocks invalid $field values before submitting",
    async ({ field, invalid, valid }) => {
      renderTraining();
      await fillTraining();
      fireEvent.click(
        screen.getByRole("button", { name: "Advanced settings" }),
      );
      for (const value of invalid) {
        fireEvent.change(screen.getByLabelText(field), { target: { value } });
        const trainButton = screen.getByRole("button", {
          name: "Train locally",
        }) as HTMLButtonElement;
        expect(trainButton.disabled).toBe(true);
        fireEvent.click(trainButton);
      }
      expect(mocks.submitTraining).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(field), {
        target: { value: valid },
      });
      expect(
        (
          screen.getByRole("button", {
            name: "Train locally",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    },
  );

  it("submits Krea RAW with a folder and its own advanced controls", async () => {
    renderTraining({ models: [] });
    mocks.open.mockResolvedValueOnce("D:\\Models\\machdoch\\Krea-2-Raw");
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() =>
      expect(screen.getByText("D:\\Models\\machdoch\\Krea-2-Raw")).toBeTruthy(),
    );
    await fillTraining();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.getByLabelText("4-bit model weights")).toBeTruthy();
    expect(screen.getByLabelText("Attention layers only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Train locally" }));

    await waitFor(() =>
      expect(mocks.submitTraining).toHaveBeenCalledWith({
        ...trainingRequest,
        architecture: "krea-2",
        modelId: null,
        modelPath: "D:\\Models\\machdoch\\Krea-2-Raw",
        attentionOnly: false,
        fourBit: true,
      }),
    );
  });

  it("omits the Krea folder and forces SDXL settings after switching architectures", async () => {
    renderTraining();
    fireEvent.change(screen.getByLabelText("Architecture"), {
      target: { value: "krea-2" },
    });
    mocks.open.mockResolvedValueOnce("D:\\Models\\machdoch\\Krea-2-Raw");
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() =>
      expect(screen.getByText("D:\\Models\\machdoch\\Krea-2-Raw")).toBeTruthy(),
    );
    await fillTraining();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.change(screen.getByLabelText("Architecture"), {
      target: { value: "stable-diffusion-xl" },
    });
    expect(screen.queryByLabelText("4-bit model weights")).toBeNull();
    expect(screen.queryByLabelText("Attention layers only")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Train locally" }));

    await waitFor(() =>
      expect(mocks.submitTraining).toHaveBeenCalledWith(trainingRequest),
    );
  });

  it.each(["stable-diffusion-xl", "krea-2"] as const)(
    "imports a saved %s job using its architecture",
    async (architecture) => {
      prepareCompletedJob(architecture);
      const view = renderTraining();
      await waitFor(() => expect(screen.getByText("LoRA ready")).toBeTruthy());
      expect(mocks.inspectAddon).toHaveBeenCalledWith(
        "D:\\Models\\machdoch\\trained.safetensors",
      );
      expect(mocks.importAddon).toHaveBeenCalledWith({
        sourcePath: "D:\\Models\\machdoch\\trained.safetensors",
        reviewToken: "review",
        displayName: "Test LoRA",
        kind: "lora",
        architecture,
        triggerWords: ["test-style"],
        token: null,
        sourceUrl: null,
        licenseName: null,
        commercialUse: null,
      });
      expect(view.props.onImported).toHaveBeenCalledOnce();
      expect(mocks.finishTraining).toHaveBeenCalledWith("training-job");
      expect(localStorage.getItem(jobKey)).toBeNull();
      expect(view.props.canUseAddon).toHaveBeenCalledWith(architecture);
      fireEvent.click(
        screen.getByRole("button", {
          name:
            architecture === "stable-diffusion-xl"
              ? "Find SDXL model"
              : "Find KREA 2 model",
        }),
      );
      expect(view.props.onFindModel).toHaveBeenCalledWith(architecture);
    },
  );

  it("uses the imported SDXL LoRA in Basic when a matching model can generate", async () => {
    prepareCompletedJob("stable-diffusion-xl");
    const view = renderTraining({
      canUseAddon: vi.fn(
        (architecture: MediaTrainingArchitecture) =>
          architecture === "stable-diffusion-xl",
      ),
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Use in Basic" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use in Basic" }));
    expect(view.props.onUseAddon).toHaveBeenCalledWith("trained-lora");
    expect(
      screen.queryByRole("button", { name: "Find KREA 2 model" }),
    ).toBeNull();
  });

  it("retains a completed job on an architecture mismatch and allows retry", async () => {
    prepareCompletedJob("stable-diffusion-xl");
    mocks.inspectAddon.mockResolvedValueOnce({
      canImport: true,
      detectedArchitecture: "krea-2",
      reviewToken: "review",
      blockingReason: null,
    });
    renderTraining();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("does not match"),
    );
    expect(mocks.importAddon).not.toHaveBeenCalled();
    expect(mocks.finishTraining).not.toHaveBeenCalled();
    expect(localStorage.getItem(jobKey)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry import" }));
    await waitFor(() => expect(screen.getByText("LoRA ready")).toBeTruthy());
    expect(mocks.importAddon).toHaveBeenCalledOnce();
  });

  it("keeps the imported LoRA usable when training file cleanup fails", async () => {
    prepareCompletedJob("stable-diffusion-xl");
    mocks.finishTraining.mockRejectedValueOnce(
      new Error("Files are in use. Close the process and try again."),
    );
    renderTraining();
    await waitFor(() => expect(screen.getByText("LoRA ready")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("Files are in use");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove training files" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove training files" }),
      ).toBeNull(),
    );
    expect(mocks.importAddon).toHaveBeenCalledOnce();
    expect(mocks.finishTraining).toHaveBeenCalledTimes(2);
  });

  it("stops and resumes a saved training job", async () => {
    localStorage.setItem(jobKey, JSON.stringify(savedJob("krea-2")));
    mocks.getTrainingStatus
      .mockResolvedValueOnce({
        ...startingStatus,
        state: "running",
        completedSteps: 10,
      })
      .mockResolvedValue({
        ...startingStatus,
        state: "cancelled",
        canResume: true,
        completedSteps: 10,
      });
    renderTraining();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop training" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop training" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy(),
    );
    expect(mocks.cancelTraining).toHaveBeenCalledWith("training-job");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(mocks.resumeTraining).toHaveBeenCalledWith("training-job"),
    );
    expect(localStorage.getItem(jobKey)).not.toBeNull();
  });

  it("ignores the previous storage key and jobs without an architecture", () => {
    localStorage.setItem(
      "media:local-krea-training-job",
      JSON.stringify(savedJob("krea-2")),
    );
    localStorage.setItem(
      jobKey,
      JSON.stringify({
        id: "training-job",
        name: "Test LoRA",
        concept: "style",
        triggerPhrase: "test-style",
      }),
    );
    renderTraining();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(mocks.getTrainingStatus).not.toHaveBeenCalled();
  });
});

describe("media-training API", () => {
  it("invokes the canonical training commands and camelCase arguments", async () => {
    const training =
      await vi.importActual<typeof import("../media-training")>(
        "../media-training",
      );
    await training.submitTraining(trainingRequest);
    await training.inspectTrainingImages(paths);
    await training.getTrainingStatus("training-job");
    await training.cancelTraining("training-job");
    await training.resumeTraining("training-job");
    await training.finishTraining("training-job");

    expect(mocks.invoke.mock.calls).toEqual([
      ["media_submit_training", { request: trainingRequest }],
      ["media_inspect_training_images", { paths }],
      ["media_get_training_status", { requestId: "training-job" }],
      ["media_cancel_training", { requestId: "training-job" }],
      ["media_resume_training", { requestId: "training-job" }],
      ["media_finish_training", { requestId: "training-job" }],
    ]);
  });

  it("blocks training on a remote media host", async () => {
    const training =
      await vi.importActual<typeof import("../media-training")>(
        "../media-training",
      );
    mocks.isRemoteMedia.mockReturnValue(true);
    expect(() => training.submitTraining(trainingRequest)).toThrow(
      "Open Media Studio on this computer to train locally.",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
