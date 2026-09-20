// @vitest-environment jsdom

import { createElement, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import type {
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
} from "../../../../core/media/contracts.js";
import { getMediaModelAddonCapabilities } from "../../../../core/media/model-addons.js";
import { MediaAddonBrowser } from "./media-addon-picker";
import { MediaAddonDialog } from "./media-addon-dialog";
import { MediaNodeAddonField } from "./media-node-addon-field";
import {
  discoverMediaResources,
  matchesMediaResourceQuery,
} from "../../../../core/media/resource-discovery.js";

vi.mock("./media-visual-preview", () => ({
  MediaResourcePreview: () => null,
}));

const fluxModel = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
}).models.find((candidate) => candidate.id === "local:flux-2-klein-4b")!;
const model = {
  ...fluxModel,
  architecture: "stable-diffusion-xl" as const,
  addonCapabilities: getMediaModelAddonCapabilities(
    "local-diffusers",
    "stable-diffusion-xl",
  ),
};

const lora: MediaModelAddonDescriptor = {
  id: "addon:portrait-detail",
  kind: "lora",
  displayName: "Portrait Detail",
  architecture: "stable-diffusion-xl",
  architectureConfidence: "high",
  format: "safetensors",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "lora",
    dialect: "diffusers-peft",
    rankMinimum: 16,
    rankMaximum: 16,
    heterogeneousRanks: false,
    targetModuleCount: 64,
    convolutionTargetCount: 0,
    magnitudeVectorCount: 0,
    networkAlphaCount: 64,
  },
  baseModelHint: "FLUX.2",
  triggerWords: ["portrait detail"],
  defaultToken: null,
  digest: "a".repeat(64),
  headerDigest: "b".repeat(64),
  byteSize: 1_000,
  relativePath: "portrait.safetensors",
  sourceUrl: null,
  license: {
    name: "Test",
    spdxId: null,
    sourceUrl: "https://example.test/license",
    commercialUse: "allowed",
    requiresAcceptance: false,
  },
  importedAt: "2026-08-20T10:00:00.000Z",
};

const embedding: MediaModelAddonDescriptor = {
  ...lora,
  id: "addon:ceramic-token",
  kind: "textual-inversion",
  displayName: "Ceramic Token",
  targetComponents: ["text-encoder"],
  embeddingVectors: [
    {
      component: "text-encoder",
      tensorKey: "clip_l",
      vectorCount: 1,
      dimension: 768,
    },
  ],
  loraProfile: null,
  triggerWords: ["<ceramic>"],
  defaultToken: "<ceramic>",
  digest: "c".repeat(64),
  headerDigest: "d".repeat(64),
  relativePath: "ceramic.safetensors",
};

const props = {
  model,
  addons: [lora, embedding],
  selections: [],
  assets: [],
  metadata: {
    [lora.id]: {
      categoryIds: ["portrait"],
      tags: ["warm"],
      triggerWords: "",
      sourceUrl: null,
      sampleAssetIds: [],
      sampleImages: [],
    },
    [embedding.id]: {
      categoryIds: ["style"],
      tags: ["cool"],
      triggerWords: "",
      sourceUrl: null,
      sampleAssetIds: [],
      sampleImages: [],
    },
  },
  categories: [
    { id: "portrait", name: "Portrait" },
    { id: "style", name: "Style" },
  ],
  onToggle: vi.fn(),
  onChangeSelection: vi.fn(),
  onClear: vi.fn(),
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("MediaAddonBrowser", () => {
  it("matches words across names, tags, category names, and trigger words", () => {
    expect(
      matchesMediaResourceQuery(
        lora,
        { ...props.metadata[lora.id]!, tags: ["anime"] },
        [{ id: "portrait", name: "Illustration" }],
        "ANIME illustration detail",
      ),
    ).toBe(true);
    expect(
      matchesMediaResourceQuery(
        lora,
        props.metadata[lora.id],
        props.categories,
        "warm ceramic",
      ),
    ).toBe(false);
  });

  it("sorts add-ons without mutating their source order and combines filters", () => {
    const resources = [lora, embedding];
    const filters = {
      query: "",
      categoryId: "all",
      tag: "all",
      sort: "name" as const,
    };
    expect(
      discoverMediaResources(
        resources,
        props.metadata,
        props.categories,
        filters,
      ).map((item) => item.id),
    ).toEqual([embedding.id, lora.id]);
    expect(resources.map((item) => item.id)).toEqual([lora.id, embedding.id]);
    expect(
      discoverMediaResources(resources, props.metadata, props.categories, {
        ...filters,
        tag: "warm",
        categoryId: "style",
      }),
    ).toEqual([]);
  });

  it.each(["Basics", "Advanced"])(
    "keeps multiple selections and strengths through discovery and reopening in %s",
    (mode) => {
      const second = {
        ...lora,
        id: "addon:second",
        displayName: "Linework",
        digest: "f".repeat(64),
        importedAt: "2026-09-01T00:00:00Z",
      };
      let current: MediaModelAddonSelection[] = [];
      const Harness = () => {
        const [selections, setSelections] = useState<
          MediaModelAddonSelection[]
        >([]);
        const shared = {
          ...props,
          addons: [lora, second, embedding],
          onChange: (next: MediaModelAddonSelection[]) => {
            current = next;
            setSelections(next);
          },
        };
        return mode === "Basics"
          ? createElement(MediaAddonDialog, { ...shared, selections })
          : createElement(MediaNodeAddonField, {
              ...shared,
              value: selections,
              controlId: "addons",
              describedBy: "",
              disabled: false,
            });
      };
      render(createElement(Harness));
      fireEvent.click(
        screen.getByRole("button", { name: "Choose LoRAs and embeddings" }),
      );
      let dialog = screen.getByRole("dialog", { name: "LoRAs and embeddings" });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Portrait Detail" }),
      );
      fireEvent.change(
        within(dialog).getByLabelText("Portrait Detail strength value"),
        { target: { value: "0.65" } },
      );
      fireEvent.change(within(dialog).getByLabelText("Search add-ons"), {
        target: { value: "linework" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Linework" }));
      fireEvent.change(within(dialog).getByLabelText("Search add-ons"), {
        target: { value: "missing" },
      });
      expect(within(dialog).getByText("2 selected")).toBeTruthy();
      expect(
        within(dialog).queryByRole("button", { name: "Portrait Detail" }),
      ).toBeNull();
      fireEvent.change(within(dialog).getByLabelText("Search add-ons"), {
        target: { value: "" },
      });
      fireEvent.change(within(dialog).getByLabelText("Sort add-ons"), {
        target: { value: "newest" },
      });
      fireEvent.change(within(dialog).getByLabelText("add-ons category"), {
        target: { value: "style" },
      });
      fireEvent.click(within(dialog).getByLabelText("Selected only"));
      expect(within(dialog).getByText("No matching add-ons")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
      expect(current.map((selection) => selection.addonId)).toEqual([
        lora.id,
        second.id,
      ]);
      fireEvent.click(
        screen.getByRole("button", { name: "Choose LoRAs and embeddings" }),
      );
      dialog = screen.getByRole("dialog", { name: "LoRAs and embeddings" });
      expect(
        (within(dialog).getByLabelText("add-ons category") as HTMLSelectElement)
          .value,
      ).toBe("style");
      expect(
        (within(dialog).getByLabelText("Selected only") as HTMLInputElement)
          .checked,
      ).toBe(true);
      fireEvent.change(within(dialog).getByLabelText("add-ons category"), {
        target: { value: "all" },
      });
      fireEvent.click(within(dialog).getByLabelText("Selected only"));
      expect(
        within(dialog)
          .getByRole("button", { name: "Portrait Detail" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        (
          within(dialog).getByLabelText(
            "Portrait Detail strength value",
          ) as HTMLInputElement
        ).value,
      ).toBe("0.65");
      expect(
        within(dialog)
          .getByRole("button", { name: "Linework" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Ceramic Token" }),
      );
      fireEvent.change(
        within(dialog).getByLabelText("Ceramic Token placement"),
        { target: { value: "negative" } },
      );
      fireEvent.change(within(dialog).getByLabelText("Ceramic Token token"), {
        target: { value: "ceramic_alias" },
      });
      expect(current[2]).toMatchObject({
        kind: "textual-inversion",
        token: "ceramic_alias",
        placement: "negative",
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Remove Linework" }),
      );
      expect(current.map((selection) => selection.addonId)).toEqual([
        lora.id,
        embedding.id,
      ]);
      expect(current[0]).toMatchObject({ modelStrength: 0.65 });
    },
  );

  it("omits add-ons without tensor-verified compatibility", () => {
    render(
      createElement(MediaAddonBrowser, {
        ...props,
        addons: [
          ...props.addons,
          {
            ...lora,
            id: "addon:unknown-architecture",
            displayName: "Unknown weights",
            architectureConfidence: "unknown" as const,
          },
          {
            ...lora,
            id: "addon:unverified-architecture",
            displayName: "Unverified weights",
            architectureConfidence: "medium" as const,
          },
          {
            ...lora,
            id: "addon:wrong-architecture",
            displayName: "Wrong architecture",
            architecture: "flux-2" as const,
          },
        ],
      }),
    );

    expect(screen.getByText("Portrait Detail")).toBeTruthy();
    expect(screen.getByText("Ceramic Token")).toBeTruthy();
    expect(screen.queryByText("Unknown weights")).toBeNull();
    expect(screen.queryByText("Unverified weights")).toBeNull();
    expect(screen.queryByText("Wrong architecture")).toBeNull();
  });

  it("filters by search, category, tag, and type", () => {
    render(createElement(MediaAddonBrowser, props));

    fireEvent.change(screen.getByLabelText("Search add-ons"), {
      target: { value: "portrait" },
    });
    expect(screen.getByText("Portrait Detail")).toBeTruthy();
    expect(screen.queryByText("Ceramic Token")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search add-ons"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("add-ons category"), {
      target: { value: "style" },
    });
    expect(screen.getByText("Ceramic Token")).toBeTruthy();
    expect(screen.queryByText("Portrait Detail")).toBeNull();

    fireEvent.change(screen.getByLabelText("add-ons category"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("add-ons tag"), {
      target: { value: "warm" },
    });
    expect(screen.getByText("Portrait Detail")).toBeTruthy();
    expect(screen.queryByText("Ceramic Token")).toBeNull();

    fireEvent.change(screen.getByLabelText("add-ons tag"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("Add-on type"), {
      target: { value: "textual-inversion" },
    });
    expect(screen.getByText("Ceramic Token")).toBeTruthy();
    expect(screen.queryByText("Portrait Detail")).toBeNull();
  });

  it("shows selection state and clears the current selection", () => {
    const onClear = vi.fn();
    render(
      createElement(MediaAddonBrowser, {
        ...props,
        selections: [
          {
            kind: "lora" as const,
            addonId: lora.id,
            enabled: true,
            modelStrength: 1,
            textEncoderStrength: null,
            denoisingSchedule: null,
          },
        ],
        onClear,
      }),
    );

    expect(
      screen
        .getByRole("button", { name: "Portrait Detail" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Clear/u }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("does not surface stale incompatible selections", () => {
    const incompatible = {
      ...lora,
      id: "addon:unverified",
      displayName: "Unverified weights",
      architectureConfidence: "medium" as const,
      digest: "f".repeat(64),
    };
    render(
      createElement(MediaAddonBrowser, {
        ...props,
        addons: [...props.addons, incompatible],
        selections: [
          {
            kind: "lora" as const,
            addonId: incompatible.id,
            enabled: true,
            modelStrength: 1,
            textEncoderStrength: null,
            denoisingSchedule: null,
          },
        ],
      }),
    );

    expect(screen.queryByText("1 selected")).toBeNull();
    expect(screen.queryByLabelText(/model strength/iu)).toBeNull();
  });

  it("edits LoRA strength and denoising range", () => {
    const onChangeSelection = vi.fn();
    const selection = {
      kind: "lora" as const,
      addonId: lora.id,
      enabled: true,
      modelStrength: 1,
      textEncoderStrength: null,
      denoisingSchedule: null,
    };
    render(
      createElement(MediaAddonBrowser, {
        ...props,
        selections: [selection],
        onChangeSelection,
      }),
    );

    fireEvent.change(screen.getByLabelText(/model strength/iu), {
      target: { value: "0.65" },
    });
    expect(onChangeSelection).toHaveBeenLastCalledWith({
      ...selection,
      modelStrength: 0.65,
    });
    fireEvent.change(screen.getByLabelText("Portrait Detail strength value"), {
      target: { value: "1.25" },
    });
    expect(onChangeSelection).toHaveBeenLastCalledWith({
      ...selection,
      modelStrength: 1.25,
    });

    fireEvent.click(screen.getByLabelText("Adjust Portrait Detail"));
    fireEvent.click(screen.getByLabelText("Denoising window"));
    expect(onChangeSelection).toHaveBeenLastCalledWith({
      ...selection,
      denoisingSchedule: { start: 0, end: 1 },
    });
  });

  it("keeps multiple strength controls inside their selected cards", () => {
    const secondLora = {
      ...lora,
      id: "addon:portrait-light",
      displayName: "Portrait Light",
      digest: "e".repeat(64),
    };
    render(
      createElement(MediaAddonBrowser, {
        ...props,
        addons: [lora, secondLora],
        selections: [lora, secondLora].map((candidate, index) => ({
          kind: "lora" as const,
          addonId: candidate.id,
          enabled: true,
          modelStrength: index === 0 ? 0.4 : 1.25,
          textEncoderStrength: null,
          denoisingSchedule: null,
        })),
      }),
    );

    const strengthControls = screen.getAllByLabelText(/model strength/iu);
    expect(strengthControls).toHaveLength(2);
    expect(
      strengthControls.every((control) => control.closest("article")),
    ).toBe(true);
    expect(screen.getByText("2 selected")).toBeTruthy();
  });
});
