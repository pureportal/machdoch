import { describe, expect, it } from "vitest";
import { createImageRecipeFlow } from "./compiler.js";
import { DEFAULT_IMAGE_RECIPE_SETTINGS } from "../../tauri/ui/media/media-studio-store.js";
import {
  createMediaAgentNodeContext,
  parseMediaAgentGraph,
  validateMediaAgentResources,
  type MediaFlowAgentRequest,
} from "./flow-agent.js";

const base = createImageRecipeFlow({
  id: "flow:agent",
  createdAt: "2026-09-20T00:00:00Z",
  settings: { ...DEFAULT_IMAGE_RECIPE_SETTINGS, prompt: "A forest" },
});
const graph = () =>
  structuredClone({ name: base.name, nodes: base.nodes, edges: base.edges });

describe("Media Studio assistant graph validation", () => {
  it("keeps inherited arrays and flow bindings independent of the source flow", () => {
    const candidate = graph();
    candidate.nodes.find(
      (node) => node.type === "task.generate-image",
    )!.config = { outputCount: 2 };
    const result = parseMediaAgentGraph(JSON.stringify(candidate), base);
    const addons = result.nodes.find(
      (node) => node.type === "task.generate-image",
    )!.config.modelAddons as unknown[];
    addons.push({ addonId: "changed" });
    result.variableBindings.changed = "changed";
    expect(
      base.nodes.find((node) => node.type === "task.generate-image")!.config
        .modelAddons,
    ).toEqual([]);
    expect(base.variableBindings).toEqual({});
  });

  it("gives Codex integer, optional-input, and field visibility constraints", () => {
    const context = createMediaAgentNodeContext();
    const image = context.find((node) => node.type === "task.generate-image")!;
    expect(
      image.fields.find((field) => field.id === "outputCount"),
    ).toMatchObject({ integer: true, min: 1, max: 8 });
    expect(
      image.fields.find((field) => field.id === "svgMode")?.visibleWhen,
    ).toEqual({ fieldId: "outputFormat", equals: "svg" });
    expect(
      context.find((node) => node.type === "source.prompt")!.fields[0],
    ).toMatchObject({ allowEmpty: true });
    expect(
      context
        .find((node) => node.type === "task.generate-video")!
        .inputs.find((port) => port.id === "last-frame")?.required,
    ).toBe(false);
  });

  it("applies a complete graph without changing flow identity or mutating the original", () => {
    const candidate = graph();
    candidate.name = "Forest at sunset";
    candidate.nodes.find(
      (node) => node.type === "source.prompt",
    )!.config.prompt = "A forest at sunset";
    const result = parseMediaAgentGraph(JSON.stringify(candidate), base);
    expect(result.id).toBe(base.id);
    expect(result.createdAt).toBe(base.createdAt);
    expect(result.variables).toEqual(base.variables);
    expect(result.name).toBe(candidate.name);
    expect(
      result.nodes.find((node) => node.type === "source.prompt")!.config.prompt,
    ).toBe("A forest at sunset");
    expect(
      base.nodes.find((node) => node.type === "source.prompt")!.config.prompt,
    ).toBe("A forest");
  });

  it.each([null, {}, { name: "Broken", nodes: [null], edges: [] }])(
    "rejects malformed graph data: %j",
    (candidate) => {
      expect(() =>
        parseMediaAgentGraph(JSON.stringify(candidate), base),
      ).toThrow();
    },
  );

  it("retains existing settings when a node configuration is partial", () => {
    const candidate = graph();
    candidate.nodes.find(
      (node) => node.type === "task.generate-image",
    )!.config = { outputCount: 3 };
    const result = parseMediaAgentGraph(JSON.stringify(candidate), base);
    expect(
      result.nodes.find((node) => node.type === "task.generate-image")!.config,
    ).toEqual({
      ...base.nodes.find((node) => node.type === "task.generate-image")!.config,
      outputCount: 3,
    });
  });

  it("rejects unknown node types, invalid connections and duplicate identities", () => {
    const unknown = graph();
    expect(() =>
      parseMediaAgentGraph(
        JSON.stringify({
          ...unknown,
          nodes: [{ ...unknown.nodes[0], type: "made.up" }],
        }),
        base,
      ),
    ).toThrow("Unknown node type");
    const disconnected = graph();
    disconnected.edges[0]!.toPortId = "missing-port";
    expect(() =>
      parseMediaAgentGraph(JSON.stringify(disconnected), base),
    ).toThrow();
    const duplicate = graph();
    duplicate.nodes.push(duplicate.nodes[0]!);
    expect(() =>
      parseMediaAgentGraph(JSON.stringify(duplicate), base),
    ).toThrow();
  });

  it("rejects invented models while preserving existing selections", () => {
    const candidate = structuredClone(base);
    candidate.nodes.find(
      (node) => node.type === "task.generate-image",
    )!.config.modelId = "invented:model";
    const request: MediaFlowAgentRequest = {
      prompt: "Change the model",
      flow: base,
      messages: [],
      models: [],
      addons: [],
      assets: [],
    };
    expect(() => validateMediaAgentResources(candidate, request)).toThrow(
      "Unknown model",
    );
    expect(() =>
      validateMediaAgentResources(candidate, { ...request, flow: candidate }),
    ).not.toThrow();
  });

  it("rejects video assets used as image sources, including unchanged selections", () => {
    const candidate = structuredClone(base);
    candidate.nodes.push({
      id: "reference",
      type: "source.image",
      version: 1,
      layer: "source",
      label: "Reference",
      config: { assetId: "asset:video", referenceRole: "base", influence: 1 },
    });
    const request: MediaFlowAgentRequest = {
      prompt: "Use this reference",
      flow: base,
      messages: [],
      models: [],
      addons: [],
      assets: [{ id: "asset:video", kind: "video", width: 512, height: 512 }],
    };
    expect(() => validateMediaAgentResources(candidate, request)).toThrow(
      "Choose an image asset",
    );
    expect(() =>
      validateMediaAgentResources(candidate, { ...request, flow: candidate }),
    ).toThrow("Choose an image asset");
    expect(() =>
      validateMediaAgentResources(candidate, {
        ...request,
        assets: [{ ...request.assets[0]!, kind: "image" }],
      }),
    ).not.toThrow();
  });

  it("rejects invented model priorities", () => {
    const candidate = structuredClone(base);
    candidate.nodes.push({
      id: "cutout",
      type: "operation.subject-cutout",
      version: 1,
      layer: "operation",
      label: "Cut out subject",
      config: { modelPriority: ["invented:cutout"], outputMatte: true },
    });
    expect(() =>
      validateMediaAgentResources(candidate, {
        prompt: "Cut out the subject",
        flow: base,
        messages: [],
        models: [],
        addons: [],
        assets: [],
      }),
    ).toThrow("Unknown model: invented:cutout");
  });

  it("rejects a LoRA represented as a textual inversion", () => {
    const candidate = structuredClone(base);
    candidate.nodes.find(
      (node) => node.type === "task.generate-image",
    )!.config.modelAddons = [
      {
        addonId: "addon:forest",
        kind: "textual-inversion",
        token: "forest",
        placement: "positive",
      },
    ];
    expect(() =>
      validateMediaAgentResources(candidate, {
        prompt: "Use the forest addon",
        flow: base,
        messages: [],
        models: [],
        addons: [
          {
            id: "addon:forest",
            displayName: "Forest",
            kind: "lora",
            architecture: "stable-diffusion-xl",
            triggerWords: [],
            defaultToken: null,
          },
        ],
        assets: [],
      }),
    ).toThrow("wrong model addon type");
  });

  it("rejects references to variables that do not exist", () => {
    const candidate = graph();
    candidate.nodes.find(
      (node) => node.type === "source.prompt",
    )!.config.prompt = "{{missing}}";
    expect(() => parseMediaAgentGraph(JSON.stringify(candidate), base)).toThrow(
      "undeclared variable",
    );
  });
});
