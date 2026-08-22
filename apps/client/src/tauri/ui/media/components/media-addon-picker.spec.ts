// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import type { MediaModelAddonDescriptor } from "../../../../core/media/contracts.js";
import { getMediaModelAddonCapabilities } from "../../../../core/media/model-addons.js";
import { MediaAddonBrowser } from "./media-addon-picker";

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

afterEach(cleanup);

describe("MediaAddonBrowser", () => {
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
    fireEvent.change(screen.getByLabelText("Add-on category"), {
      target: { value: "style" },
    });
    expect(screen.getByText("Ceramic Token")).toBeTruthy();
    expect(screen.queryByText("Portrait Detail")).toBeNull();

    fireEvent.change(screen.getByLabelText("Add-on category"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("Add-on tag"), {
      target: { value: "warm" },
    });
    expect(screen.getByText("Portrait Detail")).toBeTruthy();
    expect(screen.queryByText("Ceramic Token")).toBeNull();

    fireEvent.change(screen.getByLabelText("Add-on tag"), {
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
