// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import { createEmptyMediaGenerationAssetMetadata } from "../../../../core/media/asset-metadata.js";
import type { MediaModelAddonDescriptor } from "../../../../core/media/contracts.js";
import { MediaModelEditDialog } from "./media-model-edit-dialog";
import { MediaCategoryManagerDialog } from "./media-category-manager-dialog";

vi.mock("./media-visual-preview", () => ({ MediaResourcePreview: () => null }));
vi.mock("./media-sample-images-input", () => ({
  MediaSampleImagesInput: () => null,
}));

const catalogModel = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
}).models.find((model) => model.id === "local:flux-2-klein-4b")!;
const props = (
  overrides: Partial<ComponentProps<typeof MediaModelEditDialog>> = {},
): ComponentProps<typeof MediaModelEditDialog> => ({
  resource: {
    ...catalogModel,
    id: "local:user:test",
    displayName: "Portrait model",
    architecture: "stable-diffusion-1",
    userImported: true,
  },
  metadata: {
    ...createEmptyMediaGenerationAssetMetadata(),
    sourceUrl: "https://example.com/model",
    tags: ["portrait"],
  },
  categories: [],
  assets: [],
  onSave: vi.fn(async () => undefined),
  onImportMedia: vi.fn(async () => null),
  onImportSampleUrl: vi.fn(async () => null),
  onManageCategories: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("model edit dialog", () => {
  it("saves with the standard keyboard shortcut", async () => {
    const options = props();
    render(createElement(MediaModelEditDialog, options));
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Keyboard edit" } });
    fireEvent.keyDown(name, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(options.onSave).toHaveBeenCalledOnce());
  });

  it("opens category management over the editor and returns to the draft", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    const options = props();
    const Harness = () => {
      const [managing, setManaging] = useState(false);
      return createElement(
        "div",
        null,
        createElement(MediaModelEditDialog, {
          ...options,
          onManageCategories: () => setManaging(true),
        }),
        managing
          ? createElement(MediaCategoryManagerDialog, {
              categories: [],
              metadata: {},
              onChange: vi.fn(),
              onClose: () => setManaging(false),
            })
          : null,
      );
    };
    render(createElement(Harness));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Still editing" },
    });
    fireEvent.click(
      screen.getByRole("combobox", { name: "Choose categories" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage categories" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Categories" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      await screen.findByRole("dialog", { name: "Edit model" }),
    ).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Still editing",
    );
    expect(options.onSave).not.toHaveBeenCalled();
  });

  it.each(["stable-diffusion-xl", "pony"])(
    "saves a complete %s draft once, including the field still being edited",
    async (architecture) => {
      const options = props();
      render(createElement(MediaModelEditDialog, options));
      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "Renamed model" },
      });
      fireEvent.change(screen.getByLabelText("Model type"), {
        target: { value: architecture },
      });
      fireEvent.change(screen.getByLabelText("Source URL"), {
        target: { value: "" },
      });
      fireEvent.change(screen.getByLabelText("Tags"), {
        target: { value: "portrait, PORTRAIT, lighting" },
      });
      fireEvent.change(screen.getByLabelText("Trigger words"), {
        target: { value: "cinematic, warm" },
      });
      fireEvent.blur(screen.getByLabelText("Trigger words"));
      expect(options.onSave).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
      expect(options.onSave).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          displayName: "Renamed model",
          architecture,
          sourceUrl: null,
          triggerWords: ["cinematic", "warm"],
        }),
        expect.objectContaining({
          tags: ["portrait", "lighting"],
          sourceUrl: null,
          triggerWords: "cinematic, warm",
        }),
      );
    },
  );

  it("cancels without writing changes", () => {
    const options = props();
    render(createElement(MediaModelEditDialog, options));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Discard me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(options.onSave).not.toHaveBeenCalled();
    expect(options.onClose).toHaveBeenCalledOnce();
  });

  it("rejects invalid links and empty names before saving", () => {
    const options = props();
    render(createElement(MediaModelEditDialog, options));
    fireEvent.change(screen.getByLabelText("Source URL"), {
      target: { value: "file:///secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter an HTTPS URL.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter a model name.");
    expect(options.onSave).not.toHaveBeenCalled();
  });

  it("keeps failed saves open with the draft intact and allows retry", async () => {
    const options = props({
      onSave: vi
        .fn()
        .mockRejectedValueOnce(new Error("Storage is full."))
        .mockResolvedValueOnce(undefined),
    });
    render(createElement(MediaModelEditDialog, options));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Keep this name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Storage is full.",
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Keep this name",
    );
    expect(options.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
  });

  it("blocks duplicate saves and closing while saving", async () => {
    let complete!: () => void;
    const options = props({
      onSave: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      ),
    });
    render(createElement(MediaModelEditDialog, options));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New name" },
    });
    const form = screen
      .getByRole("button", { name: "Save changes" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(options.onSave).toHaveBeenCalledOnce();
    expect(options.onClose).not.toHaveBeenCalled();
    complete();
    await waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
  });

  it("keeps provider identity read-only while allowing library metadata edits", async () => {
    const options = props({
      resource: { ...catalogModel, userImported: false },
    });
    render(createElement(MediaModelEditDialog, options));
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect(
      (screen.getByLabelText("Model type") as HTMLSelectElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "favorite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(options.onSave).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ tags: ["favorite"] }),
      ),
    );
  });

  it("validates the embedding token", () => {
    const embedding: MediaModelAddonDescriptor = {
      id: "local-addon:sha256:test",
      kind: "textual-inversion",
      displayName: "Concept",
      architecture: "stable-diffusion-1",
      architectureConfidence: "high",
      format: "safetensors",
      targetComponents: ["text-encoder"],
      embeddingVectors: [],
      loraProfile: null,
      baseModelHint: null,
      triggerWords: [],
      defaultToken: "concept",
      digest: "abc",
      headerDigest: "def",
      byteSize: 100,
      relativePath: "addons/test",
      sourceUrl: null,
      license: catalogModel.license,
      importedAt: "2026-09-19",
    };
    const options = props({ resource: embedding });
    render(createElement(MediaModelEditDialog, options));
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "two words" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter one token without spaces.",
    );
    expect(options.onSave).not.toHaveBeenCalled();
  });
});
