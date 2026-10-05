import { describe, expect, it } from "vitest";
import { compileMediaFlow } from "./compiler.js";
import { createDefaultMediaNodeConfig, getMediaNodeDefinition, validateMediaFlowDocument } from "./node-registry.js";
import { createMediaAgentNodeContext } from "./flow-agent.js";
import type { MediaFlow, MediaFlowNode } from "./contracts.js";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import { getMediaModelAddonCapabilities } from "./model-addons.js";

const node = (id: string, type: MediaFlowNode["type"], config: Record<string, unknown> = {}): MediaFlowNode => ({
  id, type, version: 1, label: id, layer: getMediaNodeDefinition(type)!.layer,
  config: { ...createDefaultMediaNodeConfig(type), ...config },
});
const flow = (): MediaFlow => ({
  schemaVersion: 1, id: "lip-sync", name: "Song scenes", description: "",
  createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z",
  variables: [], presets: [], variableBindings: {}, activePresetId: null,
  nodes: [
    node("first", "source.video", { assetId: "first" }),
    node("last", "source.video", { assetId: "last" }),
    node("song", "source.audio", { assetId: "song" }),
    node("voice", "source.audio", { assetId: "voice" }),
    node("scenes", "operation.video-sequence"),
    node("lips", "operation.lip-sync", { modelPath: "D:/models/musetalk", audioStartSeconds: 1 }),
    node("save", "output.video", { role: "opaque" }),
  ],
  edges: [
    { id: "first", fromNodeId: "first", fromPortId: "video", toNodeId: "scenes", toPortId: "scene-1" },
    { id: "last", fromNodeId: "last", fromPortId: "video", toNodeId: "scenes", toPortId: "scene-2" },
    { id: "scenes", fromNodeId: "scenes", fromPortId: "video", toNodeId: "lips", toPortId: "video" },
    { id: "song", fromNodeId: "song", fromPortId: "audio", toNodeId: "lips", toPortId: "audio" },
    { id: "voice", fromNodeId: "voice", fromPortId: "audio", toNodeId: "lips", toPortId: "voice" },
    { id: "save", fromNodeId: "lips", fromPortId: "video", toNodeId: "save", toPortId: "video" },
  ],
});

describe("lip sync workflows", () => {
  it("compiles independently generated scenes before one continuous lip sync step", () => {
    const candidate = flow();
    const config = { modelId: "local:cogvideox-2b", numFrames: 9, numInferenceSteps: 20, guidanceScale: 6, fps: 8, width: 512, height: 512 };
    candidate.nodes = candidate.nodes.map((item) => ["first", "last"].includes(item.id) ? node(item.id, "task.generate-video", config) : item);
    candidate.nodes.push(node("prompt", "source.prompt", { prompt: "Close-up singer, fixed camera" }));
    candidate.edges.push(...["first", "last"].map((id) => ({ id: `prompt-${id}`, fromNodeId: "prompt", fromPortId: "prompt", toNodeId: id, toPortId: "prompt" })));
    const base = createMediaModelCatalogSnapshot({ isOpenAiConfigured: false, isLocalFluxInstalled: true }).models.find((model) => model.id === "local:flux-2-klein-4b")!;
    const model = { ...base, id: "local:cogvideox-2b", architecture: "cogvideox-2b" as const, capabilities: ["text-to-video" as const], addonCapabilities: getMediaModelAddonCapabilities("local-diffusers", "cogvideox-2b") };
    const plan = compileMediaFlow({ flow: candidate, models: [model], compiledAt: candidate.updatedAt });
    expect(plan.status).toBe("ready");
    expect(plan.steps.filter((step) => step.kind === "generate-video").map((step) => step.sourceNodeId)).toEqual(["first", "last"]);
    expect(plan.runtimeBindings.map((binding) => binding.nodeId)).toEqual(["first", "last"]);
  });
  it("compiles ordered scenes, song audio, and separate vocals into native lip sync", () => {
    const plan = compileMediaFlow({ flow: flow(), models: [], compiledAt: "2026-10-05T00:00:00Z" });
    expect(plan.status).toBe("ready");
    expect(plan.diagnostics).toEqual([]);
    expect(plan.steps.filter((step) => ["sequence-video", "lip-sync-video"].includes(step.kind)).map((step) => step.kind)).toEqual(["sequence-video", "lip-sync-video"]);
    expect(plan.runtimeBindings).toEqual([]);
  });

  it("requires a model and soundtrack while making separate vocals optional", () => {
    const candidate = flow();
    candidate.edges = candidate.edges.filter((edge) => edge.id !== "voice");
    candidate.nodes = candidate.nodes.filter((item) => item.id !== "voice");
    expect(compileMediaFlow({ flow: candidate, models: [], compiledAt: candidate.updatedAt }).status).toBe("ready");
    candidate.nodes.find((item) => item.id === "lips")!.config.modelPath = "";
    expect(compileMediaFlow({ flow: candidate, models: [], compiledAt: candidate.updatedAt }).diagnostics.some((item) => item.message.includes("Choose a model"))).toBe(true);
    candidate.edges = candidate.edges.filter((edge) => edge.id !== "song");
    expect(compileMediaFlow({ flow: candidate, models: [], compiledAt: candidate.updatedAt }).status).toBe("blocked");
  });

  it("rejects incompatible vocal inputs and invalid inference settings", () => {
    const candidate = flow();
    candidate.edges.find((edge) => edge.id === "voice")!.fromNodeId = "first";
    candidate.edges.find((edge) => edge.id === "voice")!.fromPortId = "video";
    expect(validateMediaFlowDocument(candidate).some((issue) => issue.severity === "error")).toBe(true);
    for (const [setting, value] of [["batchSize", 0], ["batchSize", 1.5], ["cropShift", -65], ["seed", -1], ["audioStartSeconds", -1]] as const) {
      const invalid = flow();
      invalid.nodes.find((item) => item.id === "lips")!.config[setting] = value;
      expect(validateMediaFlowDocument(invalid).some((issue) => issue.severity === "error")).toBe(true);
    }
  });

  it("exposes typed lip sync and vocals to the flow assistant", () => {
    const context = createMediaAgentNodeContext().find((item) => item.type === "operation.lip-sync")!;
    expect(context.inputs.map((port) => [port.id, port.dataType])).toEqual([["video", "video"], ["audio", "audio"], ["voice", "audio"]]);
    expect(context.fields.some((field) => field.id === "modelPath")).toBe(true);
    const videoContext = createMediaAgentNodeContext().find((item) => item.type === "task.generate-video")!;
    const examples = videoContext.fields.find((field) => field.id === "modelAddons")!.selectionExamples!;
    const candidate = flow();
    candidate.nodes = [...candidate.nodes, node("generation", "task.generate-video", { modelAddons: [{ ...examples[0], addonId: "video-lora", modelStrength: 0.15 }] })];
    expect(validateMediaFlowDocument(candidate).filter((issue) => issue.fieldId === "modelAddons")).toEqual([]);
  });
});
