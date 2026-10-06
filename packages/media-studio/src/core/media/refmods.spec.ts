import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "./catalog.js";
import { compileMediaFlow, createImageToVideoFlow } from "./compiler.js";
import type { MediaRefModSelection } from "./contracts.js";
import { readRefMods, isActiveRefMod } from "./refmods.js";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  normalizeMediaStudioState,
} from "../../tauri/ui/media/media-studio-store";
import { readMediaVideoRecipeSettings } from "../../tauri/ui/media/media-generation-recipe";
import { createBasicMediaVideoFlow } from "../../tauri/ui/media/media-basic-generation";

const selection: MediaRefModSelection = {
  path: "/refs/hero.safetensors",
  enabled: true,
  selection: "all",
  visualStrength: 0.6,
  audioStrength: 0.4,
  copies: 2,
  stepCurve: "middle",
  frameCurve: "increase",
};
const settings = {
  ...DEFAULT_MEDIA_STUDIO_STATE.videoRecipe,
  modelId: "local:minimax-h3-ref2va" as const,
  refMods: [selection],
  refModMaxTokens: 12000,
  fps: 24,
  numFrames: 124,
  numInferenceSteps: 8,
  guidanceScale: 1,
  loopMode: "none" as const,
  transparentBackground: false,
};

describe("H3 RefMods", () => {
  it("restores all settings and preserves them through a basic flow and recipe", () => {
    const state = normalizeMediaStudioState({
      ...DEFAULT_MEDIA_STUDIO_STATE,
      target: "video",
      videoRecipe: settings,
    });
    expect(state.videoRecipe).toMatchObject(settings);
    const flow = createBasicMediaVideoFlow({
      id: "refmods",
      createdAt: "2026-10-06T00:00:00Z",
      imageSettings: {
        ...state.recipe,
        prompt: "The subject in <Picture 1> waves.",
      },
      videoSettings: state.videoRecipe,
    });
    expect(flow.nodes.some((node) => node.type === "task.generate-image")).toBe(
      false,
    );
    expect(flow.edges.some((edge) => edge.toPortId === "first-frame")).toBe(
      false,
    );
    expect(readMediaVideoRecipeSettings(flow)).toMatchObject(settings);
  });

  it("binds RefMod-only H3 generation to the reference model", () => {
    const base = createMediaModelCatalog({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).find((model) => model.id === "local:flux-2-klein-4b")!;
    const model = {
      ...base,
      id: "local:minimax-h3-ref2va",
      architecture: "minimax-h3-ref2va",
      capabilities: ["image-to-video" as const],
      addonCapabilities: [],
    };
    const flow = createImageToVideoFlow({
      id: "h3",
      createdAt: "2026-10-06T00:00:00Z",
      prompt: "The subject waves.",
      settings,
    });
    const plan = compileMediaFlow({
      flow,
      models: [model],
      compiledAt: "2026-10-06T00:00:01Z",
    });
    expect(
      plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ).toEqual([]);
    expect(plan.runtimeBindings[0]?.model.id).toBe(model.id);
    expect(plan.runtimeBindings[0]?.requiredCapabilities).toEqual([
      "image-to-video",
    ]);
  });

  it("rejects malformed references while disabled and zero-strength slots are inactive", () => {
    expect(isActiveRefMod({ ...selection, enabled: false })).toBe(false);
    expect(
      isActiveRefMod({ ...selection, visualStrength: 0, audioStrength: 0 }),
    ).toBe(false);
    expect(() => readRefMods([{ ...selection, copies: 0 }])).toThrow();
    expect(() =>
      readRefMods([{ ...selection, visualStrength: NaN }]),
    ).toThrow();
    expect(() =>
      readRefMods([{ ...selection, stepCurve: "invalid" }]),
    ).toThrow();
  });
});
