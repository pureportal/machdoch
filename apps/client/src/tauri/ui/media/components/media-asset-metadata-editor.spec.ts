// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaGenerationAssetMetadata } from "../../../../core/media/contracts.js";
import { MediaAssetMetadataEditor } from "./media-asset-metadata-editor";

vi.mock("./media-category-picker", () => ({
  MediaCategoryPicker: () => null,
}));

const metadata: MediaGenerationAssetMetadata = {
  categoryIds: [],
  tags: [],
  triggerWords: "",
  sourceUrl: null,
  sampleAssetIds: [],
  sampleImages: [],
};

afterEach(cleanup);

describe("MediaAssetMetadataEditor", () => {
  it("keeps model-only metadata out of generated media details", () => {
    const view = render(
      createElement(MediaAssetMetadataEditor, {
        resourceId: "generated-image",
        metadata,
        categories: [],
        showTriggerWords: false,
        showSourceUrl: false,
        onChange: vi.fn(),
        onManageCategories: vi.fn(),
      }),
    );

    expect(screen.queryByLabelText("Source URL")).toBeNull();
    expect(screen.queryByLabelText("Trigger words")).toBeNull();

    view.rerender(
      createElement(MediaAssetMetadataEditor, {
        resourceId: "model-addon",
        metadata,
        categories: [],
        showTriggerWords: true,
        showSourceUrl: true,
        onChange: vi.fn(),
        onManageCategories: vi.fn(),
      }),
    );

    expect(screen.getByLabelText("Source URL")).toBeTruthy();
    expect(screen.getByLabelText("Trigger words")).toBeTruthy();
  });
});
