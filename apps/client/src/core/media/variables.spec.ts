import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "./catalog.js";
import {
  createMediaFlowDocumentDigest,
  createMediaFlowFingerprint,
} from "./canonicalize.js";
import { compileMediaFlow, createImageRecipeFlow } from "./compiler.js";
import type { MediaFlow, MediaFlowVariable } from "./contracts.js";
import {
  addMediaFlowVariable,
  applyMediaFlowPreset,
  createMediaFlowPreset,
  removeMediaFlowVariable,
  replaceMediaFlowVariable,
  resolveMediaFlowVariables,
  setMediaFlowVariableBinding,
  validateMediaFlowVariableDocument,
} from "./variables.js";

const CREATED_AT = "2026-07-14T12:00:00.000Z";

const createFlow = (): MediaFlow =>
  createImageRecipeFlow({
    id: "flow:variables",
    createdAt: CREATED_AT,
    settings: {
      prompt: "Product image",
      providerPolicy: "auto",
      modelPolicy: "balanced",
      modelId: null,
      aspectRatio: "1:1",
      outputCount: 1,
      outputFormat: "png",
      transparentBackground: false,
      qualityGateEnabled: false,
      referenceImages: [],
      modelAddons: [],
    },
  });

const updatePrompt = (flow: MediaFlow, prompt: string): MediaFlow => ({
  ...flow,
  nodes: flow.nodes.map((node) =>
    node.id === "prompt"
      ? { ...node, config: { ...node.config, prompt } }
      : node,
  ),
});

describe("media flow variables", () => {
  it("resolves embedded tokens and keeps preset metadata out of execution identity", () => {
    const base = createFlow();
    const added = addMediaFlowVariable({
      flow: base,
      type: "text",
      updatedAt: CREATED_AT,
    });
    const sourceVariable = added.flow.variables[0];
    expect(sourceVariable?.id).toBe("variable-1");
    const variable = {
      ...sourceVariable,
      name: "Material",
      defaultValue: "ceramic",
    } as MediaFlowVariable;
    const templated = updatePrompt(
      replaceMediaFlowVariable({ flow: added.flow, variable, updatedAt: CREATED_AT }),
      "Editorial {{variable-1}} lamp",
    );

    expect(
      resolveMediaFlowVariables(templated).flow.nodes.find((node) => node.id === "prompt")
        ?.config.prompt,
    ).toBe("Editorial ceramic lamp");
    const bound = setMediaFlowVariableBinding({
      flow: templated,
      variableId: variable.id,
      value: "glass",
      updatedAt: CREATED_AT,
    });
    expect(createMediaFlowFingerprint(bound)).not.toBe(
      createMediaFlowFingerprint(templated),
    );

    const preset = createMediaFlowPreset({
      flow: bound,
      name: "Glass product",
      updatedAt: CREATED_AT,
    });
    expect(createMediaFlowDocumentDigest(preset.flow)).not.toBe(
      createMediaFlowDocumentDigest(bound),
    );
    expect(createMediaFlowFingerprint(preset.flow)).toBe(
      createMediaFlowFingerprint(bound),
    );

    const changed = setMediaFlowVariableBinding({
      flow: preset.flow,
      variableId: variable.id,
      value: "paper",
      updatedAt: CREATED_AT,
    });
    const restored = applyMediaFlowPreset({
      flow: changed,
      presetId: preset.presetId,
      updatedAt: CREATED_AT,
    });
    expect(restored.variableBindings).toEqual({ "variable-1": "glass" });
    expect(restored.activePresetId).toBe("preset-1");
  });

  it("preserves primitive types for exact tokens and blocks unresolved references", () => {
    const base = createFlow();
    const added = addMediaFlowVariable({
      flow: base,
      type: "number",
      updatedAt: CREATED_AT,
    });
    const bound = setMediaFlowVariableBinding({
      flow: added.flow,
      variableId: added.variableId,
      value: 3,
      updatedAt: CREATED_AT,
    });
    const templated: MediaFlow = {
      ...bound,
      nodes: bound.nodes.map((node) =>
        node.id === "generate"
          ? { ...node, config: { ...node.config, outputCount: "{{variable-1}}" } }
          : node,
      ),
    };
    const plan = compileMediaFlow({
      flow: templated,
      models: createMediaModelCatalog({
        isOpenAiConfigured: false,
        isLocalFluxInstalled: false,
      }),
      compiledAt: CREATED_AT,
    });

    expect(plan.preflight.estimatedOutputs).toBe(3);
    expect(
      plan.diagnostics.some((diagnostic) => diagnostic.code === "NODE_SCHEMA_INVALID"),
    ).toBe(false);

    const unknownPlan = compileMediaFlow({
      flow: updatePrompt(base, "Image of {{missing-variable}}"),
      models: createMediaModelCatalog({
        isOpenAiConfigured: false,
        isLocalFluxInstalled: false,
      }),
      compiledAt: CREATED_AT,
    });
    expect(unknownPlan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "VARIABLE_REFERENCE_UNKNOWN", nodeId: "prompt" }),
    );
    expect(unknownPlan.status).toBe("blocked");
  });

  it("validates declarations and removes bindings plus preset values atomically", () => {
    const added = addMediaFlowVariable({
      flow: createFlow(),
      type: "choice",
      updatedAt: CREATED_AT,
    });
    const malformed: MediaFlow = {
      ...added.flow,
      variables: added.flow.variables.map((variable) => ({
        ...variable,
        constraints: { options: ["Duplicate", "Duplicate"] },
      })) as MediaFlowVariable[],
    };
    expect(validateMediaFlowVariableDocument(malformed)).toContainEqual(
      expect.objectContaining({ code: "VARIABLE_SCHEMA_INVALID" }),
    );

    const preset = createMediaFlowPreset({
      flow: added.flow,
      name: "Choice preset",
      updatedAt: CREATED_AT,
    });
    const removed = removeMediaFlowVariable({
      flow: preset.flow,
      variableId: added.variableId,
      updatedAt: CREATED_AT,
    });
    expect(removed.variables).toEqual([]);
    expect(removed.variableBindings).toEqual({});
    expect(removed.presets[0]?.values).toEqual({});
    expect(removed.activePresetId).toBeNull();
  });

  it("allows unresolved optional declarations until a node actually consumes them", () => {
    const added = addMediaFlowVariable({
      flow: createFlow(),
      type: "text",
      updatedAt: CREATED_AT,
    });
    const optional = replaceMediaFlowVariable({
      flow: added.flow,
      variable: {
        ...added.flow.variables[0],
        required: false,
        defaultValue: null,
      } as MediaFlowVariable,
      updatedAt: CREATED_AT,
    });
    expect(resolveMediaFlowVariables(optional).issues).toEqual([]);
    expect(createMediaFlowPreset({
      flow: optional,
      name: "Optional input",
      updatedAt: CREATED_AT,
    }).flow.presets[0]?.values).toEqual({});

    expect(resolveMediaFlowVariables(
      updatePrompt(optional, "Portrait {{variable-1}}"),
    ).issues).toContainEqual(expect.objectContaining({
      code: "VARIABLE_REQUIRED",
      nodeId: "prompt",
      variableId: "variable-1",
    }));
  });
});
