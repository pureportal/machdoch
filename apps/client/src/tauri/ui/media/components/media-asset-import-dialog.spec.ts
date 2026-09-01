// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaLocalModelImportInspection } from "../../../../core/media/contracts.js";
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
  contentDigest: "b".repeat(64),
  duplicate: null,
  reviewToken: "review:model",
  suggestedDisplayName: "Moody Krea 2 Mix v50",
  detectedArchitecture: "krea-2",
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
        contentDigest: inspection.contentDigest,
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
