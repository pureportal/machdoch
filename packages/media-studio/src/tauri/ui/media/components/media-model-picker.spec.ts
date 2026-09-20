// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import { createEmptyMediaGenerationAssetMetadata } from "../../../../core/media/asset-metadata.js";
import { MediaModelPicker } from "./media-model-picker";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Element.prototype.scrollIntoView = vi.fn();
vi.mock("./media-visual-preview", () => ({ MediaResourcePreview: () => null }));
afterEach(cleanup);

describe("MediaModelPicker", () => {
  it("searches organisation metadata without changing or reselecting the current model", () => {
    const model = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).models.find((candidate) => candidate.id === "local:flux-2-klein-4b")!;
    const onChange = vi.fn();
    render(
      createElement(MediaModelPicker, {
        models: [model],
        value: model.id,
        assets: [],
        categories: [{ id: "category:style", name: "Illustration" }],
        metadata: {
          [model.id]: {
            ...createEmptyMediaGenerationAssetMetadata(),
            categoryIds: ["category:style"],
            tags: ["anime"],
          },
        },
        onChange,
      }),
    );
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByLabelText("Search models"), {
      target: { value: "anime illustration" },
    });
    fireEvent.change(screen.getByLabelText("Sort models"), {
      target: { value: "name-desc" },
    });
    fireEvent.click(screen.getByRole("option", { name: /FLUX.2 klein 4B/u }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox").textContent).toContain(
      model.displayName,
    );
  });
});
