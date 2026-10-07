// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaLocalModelImportInspection } from "../../../../core/media/contracts.js";
import * as mediaPlatform from "../media-platform";
import { MediaAssetImportDialog } from "./media-asset-import-dialog";

const runtimeMocks = vi.hoisted(() => ({
  openDialog: vi.fn(),
  onDragDropEvent: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: runtimeMocks.openDialog,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: runtimeMocks.onDragDropEvent,
  }),
}));

vi.mock("./media-category-picker", () => ({
  MediaCategoryPicker: () => null,
}));

vi.mock("./media-sample-images-input", () => ({
  MediaSampleImagesInput: ({
    onChange,
  }: {
    onChange: (
      assetIds: string[],
      images: Array<{ url: string; width: number; height: number }>,
    ) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          onChange(
            ["asset:sample"],
            [
              {
                url: "https://image.civitai.com/sample.webp",
                width: 768,
                height: 1_024,
              },
            ],
          ),
      },
      "Add sample fixture",
    ),
}));

type Props = ComponentProps<typeof MediaAssetImportDialog>;

const inspection: MediaLocalModelImportInspection = {
  schemaVersion: 1,
  canImport: true,
  blockingReason: null,
  sourcePath: "C:\\models\\moodyKrea2Mix_v50.safetensors",
  sourceFileName: "moodyKrea2Mix_v50.safetensors",
  byteSize: 1_024,
  tensorCount: 20,
  headerDigest: "a".repeat(64),
  duplicate: null,
  reviewToken: "review:model",
  suggestedDisplayName: "Moody Krea 2 Mix v50",
  detectedArchitecture: "krea-2",
  availableArchitectures: [],
  architectureConfidence: "high",
  metadataSummary: [],
  warnings: [],
};

const createProps = (overrides: Partial<Props> = {}): Props => ({
  assets: [],
  categories: [],
  loading: false,
  progress: null,
  modelInspection: null,
  addonInspection: null,
  civitaiInspection: null,
  error: null,
  onInspectModel: vi.fn(),
  onInspectAddon: vi.fn(),
  onInspectCivitai: vi.fn(),
  onImportMedia: vi.fn(async () => null),
  onImportModel: vi.fn(async () => true),
  onImportAddon: vi.fn(async () => true),
  onImportSampleUrl: vi.fn(async () => null),
  onViewResource: vi.fn(),
  onDismissInspection: vi.fn(),
  onManageCategories: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  runtimeMocks.openDialog.mockReset();
  runtimeMocks.onDragDropEvent.mockReset();
  runtimeMocks.onDragDropEvent.mockResolvedValue(() => undefined);
});

describe("MediaAssetImportDialog", () => {
  it("accepts an existing file path on the connected client", async () => {
    const remote = vi
      .spyOn(mediaPlatform, "isRemoteMedia")
      .mockReturnValue(true);
    try {
      const props = createProps();
      render(createElement(MediaAssetImportDialog, props));
      fireEvent.change(
        screen.getByRole("textbox", { name: "Connected client file path" }),
        { target: { value: " C:\\models\\sample.safetensors " } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Use file" }));
      await waitFor(() =>
        expect(props.onInspectModel).toHaveBeenCalledWith(
          "C:\\models\\sample.safetensors",
        ),
      );
    } finally {
      remote.mockRestore();
    }
  });

  it("imports an SDXL checkpoint with the selected Pony base model", async () => {
    const props = createProps();
    runtimeMocks.openDialog.mockResolvedValue(inspection.sourcePath);
    const view = render(createElement(MediaAssetImportDialog, props));
    fireEvent.click(
      screen.getByRole("button", { name: "Drop or select a file" }),
    );
    await waitFor(() => expect(props.onInspectModel).toHaveBeenCalledOnce());
    view.rerender(
      createElement(MediaAssetImportDialog, {
        ...props,
        modelInspection: {
          ...inspection,
          detectedArchitecture: "stable-diffusion-xl",
        },
      }),
    );
    expect(screen.getByRole("option", { name: "Pony (SDXL)" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Base model" }), {
      target: { value: "pony" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import model" }));
    await waitFor(() =>
      expect(props.onImportModel).toHaveBeenCalledWith(
        expect.objectContaining({ architecture: "pony" }),
        expect.anything(),
      ),
    );
  });

  it("prefills filename metadata and imports without license declarations", async () => {
    const onInspectModel = vi.fn();
    const onImportModel = vi.fn(async () => true);
    const onClose = vi.fn();
    const props = createProps({ onInspectModel, onImportModel, onClose });
    runtimeMocks.openDialog.mockResolvedValue(inspection.sourcePath);
    const view = render(createElement(MediaAssetImportDialog, props));

    fireEvent.click(
      screen.getByRole("button", { name: "Drop or select a file" }),
    );

    await waitFor(() =>
      expect(onInspectModel).toHaveBeenCalledWith(inspection.sourcePath),
    );
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value,
    ).toBe("Moody Krea 2 Mix v50");
    expect(
      (
        screen.getByRole("combobox", {
          name: "Base model",
        }) as HTMLSelectElement
      ).value,
    ).toBe("krea-2");
    expect(screen.queryByRole("checkbox")).toBeNull();

    view.rerender(
      createElement(MediaAssetImportDialog, {
        ...props,
        modelInspection: inspection,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add sample fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Import model" }));

    await waitFor(() => expect(onImportModel).toHaveBeenCalledOnce());
    expect(onImportModel).toHaveBeenCalledWith(
      {
        sourcePath: inspection.sourcePath,
        reviewToken: inspection.reviewToken,
        displayName: "Moody Krea 2 Mix v50",
        architecture: "krea-2",
        sourceUrl: null,
        licenseName: null,
        commercialUse: null,
      },
      {
        categoryIds: [],
        tags: [],
        triggerWords: "",
        sourceUrl: null,
        sampleAssetIds: ["asset:sample"],
        sampleImages: [
          {
            url: "https://image.civitai.com/sample.webp",
            width: 768,
            height: 1_024,
          },
        ],
      },
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens an existing model instead of offering a second import", async () => {
    const onInspectModel = vi.fn();
    const onImportModel = vi.fn(async () => true);
    const onViewResource = vi.fn();
    const onClose = vi.fn();
    const props = createProps({
      onInspectModel,
      onImportModel,
      onViewResource,
      onClose,
    });
    runtimeMocks.openDialog.mockResolvedValue(inspection.sourcePath);
    const view = render(createElement(MediaAssetImportDialog, props));

    fireEvent.click(
      screen.getByRole("button", { name: "Drop or select a file" }),
    );
    await waitFor(() =>
      expect(onInspectModel).toHaveBeenCalledWith(inspection.sourcePath),
    );
    view.rerender(
      createElement(MediaAssetImportDialog, {
        ...props,
        modelInspection: {
          ...inspection,
          duplicate: {
            resourceId: "local:user:existing",
            displayName: "Moody Krea 2 Mix v50",
            kind: "model",
          },
        },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "View model" }));

    expect(onViewResource).toHaveBeenCalledWith("local:user:existing");
    expect(onImportModel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

it("inspects a complete model folder selected through the directory picker", async () => {
  const props = createProps();
  runtimeMocks.openDialog.mockResolvedValue("C:\\models\\z-image-turbo");
  render(createElement(MediaAssetImportDialog, props));
  fireEvent.click(screen.getByRole("button", { name: "Model folder" }));
  await waitFor(() =>
    expect(props.onInspectModel).toHaveBeenCalledWith(
      "C:\\models\\z-image-turbo",
    ),
  );
  expect(runtimeMocks.openDialog).toHaveBeenCalledWith(
    expect.objectContaining({ directory: true, multiple: false }),
  );
  expect(screen.getByRole("button", { name: "Import model" })).toBeTruthy();
});

it("guides PDMD setup before picking a folder", () => {
  render(
    createElement(
      MediaAssetImportDialog,
      createProps({ initialArchitecture: "minimax-h3-pdmd-2step" }),
    ),
  );
  expect(
    screen.getByRole("link", { name: "Download student" }).getAttribute("href"),
  ).toContain("/lora_model_0.safetensors");
  expect(
    screen.getByRole("link", { name: "full MiniMax H3 base" }),
  ).toBeTruthy();
  expect(
    screen.getByText("distillation/pdmd_2nfe.safetensors", {
      selector: "code",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Model folder" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Drop or select a file" }),
  ).toBeNull();
  expect(screen.getByText(/128 GB RAM/u)).toBeTruthy();
  expect(screen.getByRole("link", { name: "H3 licence" })).toBeTruthy();
});

it("selects an included SDXL student and imports with its published terms", async () => {
  const sourcePath = "C:\\models\\students";
  const props = createProps({ initialPath: sourcePath });
  const view = render(createElement(MediaAssetImportDialog, props));
  await waitFor(() =>
    expect(props.onInspectModel).toHaveBeenCalledWith(sourcePath),
  );
  view.rerender(
    createElement(MediaAssetImportDialog, {
      ...props,
      modelInspection: {
        ...inspection,
        sourcePath,
        suggestedDisplayName: "SDXL DMAD 4-step",
        detectedArchitecture: "stable-diffusion-xl-dmad-4step",
        availableArchitectures: [
          "stable-diffusion-xl-dmad-4step",
          "stable-diffusion-xl-dmad-1step",
        ],
      },
    }),
  );
  const selector = screen.getByRole("combobox", {
    name: "Base model",
  }) as HTMLSelectElement;
  expect(selector.value).toBe("stable-diffusion-xl-dmad-4step");
  expect(screen.queryByRole("option", { name: "SDXL" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "License" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Commercial use" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Source URL" })).toBeNull();
  fireEvent.change(selector, {
    target: { value: "stable-diffusion-xl-dmad-1step" },
  });
  expect(
    (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value,
  ).toBe("SDXL DMAD 1-step");
  fireEvent.click(screen.getByRole("button", { name: "Import model" }));
  await waitFor(() =>
    expect(props.onImportModel).toHaveBeenCalledWith(
      expect.objectContaining({
        architecture: "stable-diffusion-xl-dmad-1step",
        displayName: "SDXL DMAD 1-step",
        licenseName: "CreativeML Open RAIL++-M",
        commercialUse: "review-required",
        sourceUrl: "https://huggingface.co/ZhengmingYu/DMAD",
      }),
      expect.objectContaining({
        sourceUrl: "https://huggingface.co/ZhengmingYu/DMAD",
      }),
    ),
  );
});

it("retains the variant selected in the model library when a folder contains both students", async () => {
  const sourcePath = "C:\\models\\students";
  const props = createProps({
    initialPath: sourcePath,
    initialArchitecture: "stable-diffusion-xl-dmad-1step",
  });
  const view = render(createElement(MediaAssetImportDialog, props));
  await waitFor(() =>
    expect(props.onInspectModel).toHaveBeenCalledWith(sourcePath),
  );
  view.rerender(
    createElement(MediaAssetImportDialog, {
      ...props,
      modelInspection: {
        ...inspection,
        sourcePath,
        suggestedDisplayName: "SDXL DMAD 4-step",
        detectedArchitecture: "stable-diffusion-xl-dmad-4step",
        availableArchitectures: [
          "stable-diffusion-xl-dmad-4step",
          "stable-diffusion-xl-dmad-1step",
        ],
      },
    }),
  );
  expect(
    (screen.getByRole("combobox", { name: "Base model" }) as HTMLSelectElement)
      .value,
  ).toBe("stable-diffusion-xl-dmad-1step");
  expect(
    (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value,
  ).toBe("SDXL DMAD 1-step");
});

it("accepts a student folder path on a connected client", async () => {
  vi.spyOn(mediaPlatform, "isRemoteMedia").mockReturnValue(true);
  const props = createProps({ initialArchitecture: "minimax-h3-pdmd-4step" });
  render(createElement(MediaAssetImportDialog, props));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Connected client file path" }),
    { target: { value: " C:\\models\\pdmd " } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
  await waitFor(() =>
    expect(props.onInspectModel).toHaveBeenCalledWith("C:\\models\\pdmd"),
  );
  expect(screen.getByRole("button", { name: "Import model" })).toBeTruthy();
});
