import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "./catalog.js";
import { compileMediaFlow } from "./compiler.js";
import {
  createAudioRecipeFlow,
  DEFAULT_AUDIO_RECIPE_SETTINGS,
  readAudioRecipeSettings,
} from "./audio-flow.js";
import { validateMediaFlowDocument } from "./node-registry.js";

const models = createMediaModelCatalog({ isOpenAiConfigured: false }).map(
  (model) =>
    model.id === "local:audioldm2"
      ? {
          ...model,
          installed: true,
          installationStatus: "installed" as const,
          runtimeReadiness: "unverified" as const,
        }
      : model,
);
const flow = () =>
  createAudioRecipeFlow({
    id: "audio-flow",
    createdAt: "2026-10-03T12:00:00Z",
    settings: {
      ...DEFAULT_AUDIO_RECIPE_SETTINGS,
      prompt: "Ocean waves",
      seed: 0,
    },
  });
const compile = (document = flow(), catalog = models) =>
  compileMediaFlow({
    flow: document,
    models: catalog,
    compiledAt: "2026-10-03T12:00:01Z",
  });

describe("audio flows", () => {
  it("normalizes recipe prompts before saving the flow", () => {
    const document = createAudioRecipeFlow({
      id: "audio-flow",
      createdAt: "2026-10-03T12:00:00Z",
      settings: {
        ...DEFAULT_AUDIO_RECIPE_SETTINGS,
        prompt: " Ocean waves\n",
        negativePrompt: "  Music  ",
      },
    });
    expect(document.nodes[0]!.config.prompt).toBe("Ocean waves");
    expect(document.nodes[1]!.config.negativePrompt).toBe("Music");
    expect(compile(document).status).toBe("ready");
  });
  it("binds installed audio models without a manual probe and preserves zero seeds", () => {
    expect(validateMediaFlowDocument(flow())).toEqual([]);
    expect(readAudioRecipeSettings(flow())?.seed).toBe(0);
    const plan = compile();
    expect(plan.status).toBe("ready");
    expect(plan.runtimeBindings[0]).toMatchObject({
      modality: "audio",
      model: { id: "local:audioldm2" },
    });
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "generate-audio",
      "ingest-asset",
    ]);
  });
  it("blocks image models, unavailable packages, and mismatched output ports", () => {
    const document = flow();
    document.nodes[1]!.config.modelId = "local:flux-2-klein-4b";
    expect(
      compile(document).diagnostics.some(
        (issue) => issue.code === "MODEL_CAPABILITY_UNSUPPORTED",
      ),
    ).toBe(true);
    expect(
      compile(
        flow(),
        models.map((model) => ({ ...model, installed: false })),
      ).status,
    ).toBe("blocked");
    const wrongOutput = flow();
    wrongOutput.edges[1]!.fromPortId = "image";
    expect(compile(wrongOutput).status).toBe("blocked");
  });
  it("rejects out-of-range, nonfinite, and fractional integer settings", () => {
    for (const [key, value] of [
      ["durationSeconds", 31],
      ["durationSeconds", NaN],
      ["numInferenceSteps", 0],
      ["numInferenceSteps", 1.5],
      ["guidanceScale", Infinity],
      ["seed", -1],
      ["seed", 0.5],
    ] as const) {
      const document = flow();
      document.nodes[1]!.config[key] = value;
      expect(compile(document).status, `${key}=${value}`).toBe("blocked");
    }
  });
  it("rejects unsupported mixed audio/image graphs instead of dropping stages", () => {
    const document = flow();
    document.nodes.push({
      ...document.nodes[1]!,
      id: "image",
      type: "task.generate-image",
    });
    expect(compile(document).status).toBe("blocked");
    const extraPrompt = flow();
    extraPrompt.nodes.push({ ...extraPrompt.nodes[0]!, id: "unused-prompt" });
    expect(compile(extraPrompt).status).toBe("blocked");
  });
});
