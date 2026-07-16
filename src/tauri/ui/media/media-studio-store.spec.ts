import { describe, expect, it } from "vitest";
import { createImageRecipeFlow } from "../../../core/media/compiler.js";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  normalizeImageRecipeSettings,
  normalizeMediaStudioState,
} from "./media-studio-store";

describe("Media Studio state", () => {
  it("uses the quality preset for new image recipes", () => {
    expect(DEFAULT_MEDIA_STUDIO_STATE.recipe.modelPolicy).toBe("quality");
    expect(normalizeImageRecipeSettings({}).modelPolicy).toBe("quality");
  });

  it("normalizes unsafe recipe values into bounded settings", () => {
    expect(
      normalizeImageRecipeSettings({
        prompt: "Create a poster",
        providerPolicy: "unsupported",
        modelPolicy: "quality",
        aspectRatio: "4:5",
        outputCount: 100,
        outputFormat: "png",
        transparentBackground: true,
        qualityGateEnabled: false,
      }),
    ).toMatchObject({
      prompt: "Create a poster",
      providerPolicy: "auto",
      modelPolicy: "quality",
      aspectRatio: "4:5",
      outputCount: 8,
      transparentBackground: true,
      qualityGateEnabled: false,
      referenceImages: [],
    });
  });

  it("normalizes reference images into one base and bounded provider-neutral roles", () => {
    const recipe = normalizeImageRecipeSettings({
      referenceImages: [
        { assetId: "", role: "base", influence: 1 },
        { assetId: " asset:base ", role: "style", influence: 4 },
        { assetId: "asset:style", role: "palette", influence: 0.45 },
        { assetId: "asset:style", role: "detail", influence: 0.2 },
        { assetId: "asset:unknown", role: "unsupported", influence: -1 },
      ],
    });

    expect(recipe.referenceImages).toEqual([
      { assetId: "asset:base", role: "base", influence: 1 },
      { assetId: "asset:style", role: "palette", influence: 0.45 },
      { assetId: "asset:unknown", role: "subject", influence: 0 },
    ]);
  });

  it("normalizes persisted LoRA and textual-inversion controls", () => {
    const recipe = normalizeImageRecipeSettings({
      modelAddons: [
        {
          kind: "lora",
          addonId: " addon:lora:detail ",
          enabled: true,
          modelStrength: 999,
          textEncoderStrength: -999,
          denoisingSchedule: { start: -0.5, end: 0.75 },
        },
        {
          kind: "textual-inversion",
          addonId: "addon:embedding:concept",
          enabled: false,
          token: " <concept> ",
          placement: "negative",
        },
        { kind: "unknown", addonId: "addon:bad" },
      ],
    });

    expect(recipe.modelAddons).toEqual([
      {
        kind: "lora",
        addonId: "addon:lora:detail",
        enabled: true,
        modelStrength: 100,
        textEncoderStrength: -100,
        denoisingSchedule: { start: 0, end: 0.75 },
      },
      {
        kind: "textual-inversion",
        addonId: "addon:embedding:concept",
        enabled: false,
        token: "<concept>",
        placement: "negative",
      },
    ]);
  });

  it("drops malformed run records while preserving valid drafts", () => {
    const state = normalizeMediaStudioState({
      version: 99,
      activeSection: "runs",
      recipe: DEFAULT_MEDIA_STUDIO_STATE.recipe,
      runs: [
        { id: "missing-fields" },
        {
          id: "run-1",
          flowId: "flow-1",
          flowName: "Create image",
          planId: "plan-1",
          status: "blocked",
          createdAt: "2026-07-14T00:00:00.000Z",
          prompt: "A glass sculpture",
          modelLabel: "GPT Image 2",
          target: "remote",
          outputCount: 4,
          diagnosticCount: 1,
        },
      ],
    });

    expect(state.version).toBe(3);
    expect(state.activeSection).toBe("runs");
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ id: "run-1", status: "blocked" });
  });

  it("persists a bounded semantic flow with variables and rejects malformed overrides", () => {
    const flow = createImageRecipeFlow({
      id: "media-image-recipe-draft",
      createdAt: "2026-07-14T00:00:00.000Z",
      settings: { ...DEFAULT_MEDIA_STUDIO_STATE.recipe, prompt: "A {{style}} portrait" },
    });
    flow.variables = [{
      id: "style",
      name: "Style",
      description: "",
      type: "choice",
      required: true,
      defaultValue: "Editorial",
      constraints: { options: ["Editorial", "Cinematic"] },
    }];
    flow.variableBindings = { style: "Cinematic" };

    const state = normalizeMediaStudioState({
      ...DEFAULT_MEDIA_STUDIO_STATE,
      flow,
    });
    expect(state.flow).toEqual(flow);

    expect(normalizeMediaStudioState({
      ...DEFAULT_MEDIA_STUDIO_STATE,
      flow: { ...flow, variables: [{ ...flow.variables[0], constraints: { options: [] } }] },
    }).flow).toBeNull();
  });

  it("migrates and bounds the separate flow layout document", () => {
    const state = normalizeMediaStudioState({
      version: 1,
      activeSection: "flow",
      recipe: DEFAULT_MEDIA_STUDIO_STATE.recipe,
      flowLayout: {
        schemaVersion: 99,
        flowId: " media-image-recipe-draft ",
        nodes: [
          { nodeId: " generate ", x: 150_000, y: -150_000 },
          { nodeId: "prompt", x: 10, y: 20 },
          { nodeId: "invalid", x: Number.NaN, y: 4 },
        ],
        groups: [
          {
            id: " generation ",
            label: " Generation ",
            color: "violet",
            collapsed: true,
            nodeIds: ["generate", "prompt", "missing"],
          },
        ],
        comments: [
          {
            id: " review-note ",
            body: " Check the glass edge ",
            color: "amber",
            x: 2_000_000,
            y: -2_000_000,
            width: 900,
            height: 40,
          },
        ],
      },
      runs: [],
    });

    expect(state.flowLayout).toEqual({
      schemaVersion: 1,
      flowId: "media-image-recipe-draft",
      nodes: [
        { nodeId: "generate", x: 100_000, y: -100_000 },
        { nodeId: "prompt", x: 10, y: 20 },
      ],
      groups: [
        {
          id: "generation",
          label: "Generation",
          color: "violet",
          collapsed: true,
          nodeIds: ["generate", "prompt"],
        },
      ],
      comments: [
        {
          id: "review-note",
          body: "Check the glass edge",
          color: "amber",
          x: 1_000_000,
          y: -1_000_000,
          width: 600,
          height: 80,
        },
      ],
    });
  });
});
