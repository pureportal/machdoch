// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("rejects invalid embedding aliases before saving and accepts a corrected token", () => {
    const onChange = vi.fn();
    render(
      createElement(MediaAssetMetadataEditor, {
        resourceId: "embedding",
        metadata,
        categories: [],
        showTriggerWords: true,
        triggerWordsLabel: "Token",
        onChange,
        onManageCategories: vi.fn(),
      }),
    );
    const input = screen.getByRole("textbox", { name: "Token" });
    for (const value of ["", "two tokens", "first, second"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(screen.getByRole("alert").textContent).toBe(
        "Enter one token without spaces.",
      );
    }
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "<StyleToken>" } });
    fireEvent.blur(input);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({
      ...metadata,
      triggerWords: "<StyleToken>",
    });
  });

  it("preserves tag input when a refreshed resource has unchanged metadata", () => {
    const onChange = vi.fn();
    const props = {
      resourceId: "model",
      metadata,
      categories: [],
      showTriggerWords: false,
      onChange,
      onManageCategories: vi.fn(),
    };
    const view = render(createElement(MediaAssetMetadataEditor, props));
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "anime, sketch" },
    });
    view.rerender(
      createElement(MediaAssetMetadataEditor, {
        ...props,
        metadata: { ...metadata, tags: [] },
      }),
    );
    fireEvent.blur(screen.getByLabelText("Tags"));
    expect(onChange).toHaveBeenLastCalledWith({
      ...metadata,
      tags: ["anime", "sketch"],
    });
  });

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
