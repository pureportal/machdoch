import { describe, expect, it } from "vitest";
import { createImageRecipeFlow } from "./compiler.js";
import type { ImageRecipeSettings, MediaFlow } from "./contracts.js";
import {
  addMediaFlowNode,
  connectMediaFlowPorts,
  copyMediaFlowNode,
  copyMediaFlowNodes,
  disconnectMediaFlowInput,
  getMediaNodeDefinition,
  inspectMediaFlowConnection,
  inspectMediaFlowNodePaste,
  listMediaNodeDefinitions,
  listVisibleMediaNodeFields,
  orderMediaFlowNodes,
  pasteMediaFlowNode,
  pasteMediaFlowNodes,
  removeMediaFlowNode,
  updateMediaFlowNodeConfig,
  validateMediaFlowGraph,
  validateMediaFlowNode,
  validateMediaFlowNodes,
} from "./node-registry.js";
import { DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY } from "./subject-cutout-policy.js";

const SETTINGS = {
  prompt: "A schema-driven media workflow",
  providerPolicy: "auto",
  modelPolicy: "balanced",
  modelId: null,
  aspectRatio: "1:1",
  outputCount: 2,
  outputFormat: "png",
  transparentBackground: true,
  qualityGateEnabled: true,
  referenceImages: [],
  modelAddons: [],
} as const satisfies ImageRecipeSettings;

const createFlow = (): MediaFlow =>
  createImageRecipeFlow({
    id: "flow:node-registry",
    createdAt: "2026-07-14T10:00:00.000Z",
    settings: SETTINGS,
  });

const createSimpleFlow = (): MediaFlow =>
  createImageRecipeFlow({
    id: "flow:topology-edit",
    createdAt: "2026-07-14T11:00:00.000Z",
    settings: {
      ...SETTINGS,
      transparentBackground: false,
      qualityGateEnabled: false,
    },
  });

describe("media node registry", () => {
  it("declares defaults, examples, typed ports, and valid schemas for every recipe node", () => {
    const flow = createFlow();

    expect(validateMediaFlowNodes(flow)).toEqual([]);
    expect(listMediaNodeDefinitions()).toHaveLength(17);
    for (const definition of listMediaNodeDefinitions()) {
      expect(definition.version).toBe(1);
      expect(definition.fields.every((field) => "defaultValue" in field)).toBe(true);
      expect(definition.fields.every((field) => field.examples.length > 0)).toBe(true);
      expect([...definition.inputs, ...definition.outputs].every((port) => port.dataType)).toBe(
        true,
      );
    }
  });

  it("declares immutable image sources and provider-neutral edit tasks", () => {
    expect(getMediaNodeDefinition("source.image")).toMatchObject({
      layer: "source",
      outputs: [expect.objectContaining({ id: "image", dataType: "image" })],
    });
    expect(getMediaNodeDefinition("task.edit-image")).toMatchObject({
      layer: "task",
      inputs: [
        expect.objectContaining({ id: "prompt", dataType: "prompt" }),
        expect.objectContaining({
          id: "image",
          dataType: "image",
          cardinality: "collection",
          maxConnections: 8,
        }),
      ],
      outputs: [expect.objectContaining({ id: "image", dataType: "image" })],
    });
  });

  it("keeps multiple labeled image references connected to an edit collection", () => {
    const source = createSimpleFlow();
    const withoutGenerate = removeMediaFlowNode({
      flow: source,
      nodeId: "generate",
      updatedAt: "2026-07-14T10:01:00.000Z",
    });
    const editResult = addMediaFlowNode({
      flow: withoutGenerate,
      type: "task.edit-image",
      updatedAt: "2026-07-14T10:01:01.000Z",
    });
    const firstSource = addMediaFlowNode({
      flow: editResult.flow,
      type: "source.image",
      updatedAt: "2026-07-14T10:01:02.000Z",
    });
    const secondSource = addMediaFlowNode({
      flow: firstSource.flow,
      type: "source.image",
      updatedAt: "2026-07-14T10:01:03.000Z",
    });
    const withFirst = connectMediaFlowPorts({
      flow: secondSource.flow,
      request: {
        fromNodeId: firstSource.nodeId,
        fromPortId: "image",
        toNodeId: editResult.nodeId,
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:01:04.000Z",
    });
    const withBoth = connectMediaFlowPorts({
      flow: withFirst,
      request: {
        fromNodeId: secondSource.nodeId,
        fromPortId: "image",
        toNodeId: editResult.nodeId,
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:01:05.000Z",
    });

    expect(
      withBoth.edges.filter(
        (edge) => edge.toNodeId === editResult.nodeId && edge.toPortId === "image",
      ),
    ).toHaveLength(2);
  });

  it("keeps format conversion synchronized with the immutable output contract", () => {
    const added = addMediaFlowNode({
      flow: createSimpleFlow(),
      type: "operation.format-convert",
      updatedAt: "2026-07-14T10:00:10.000Z",
    });
    const connectedInput = connectMediaFlowPorts({
      flow: added.flow,
      request: {
        fromNodeId: "generate",
        fromPortId: "image",
        toNodeId: added.nodeId,
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:00:11.000Z",
    });
    const connectedOutput = connectMediaFlowPorts({
      flow: connectedInput,
      request: {
        fromNodeId: added.nodeId,
        fromPortId: "image",
        toNodeId: "asset-output",
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:00:12.000Z",
    });
    const converted = updateMediaFlowNodeConfig({
      flow: connectedOutput,
      nodeId: added.nodeId,
      fieldId: "outputFormat",
      value: "webp",
      updatedAt: "2026-07-14T10:00:13.000Z",
    });

    expect(validateMediaFlowGraph(converted)).toEqual([]);
    expect(
      converted.nodes.find((node) => node.id === "asset-output")?.config,
    ).toMatchObject({ format: "webp", outputCount: 2 });
  });

  it("rejects ambiguous JPEG alpha flattening colors", () => {
    const node = {
      id: "convert",
      type: "operation.format-convert",
      version: 1,
      label: "Convert",
      layer: "operation",
      config: {
        outputFormat: "jpeg",
        quality: 90,
        jpegBackground: "white",
      },
    } as const;

    expect(validateMediaFlowNode(node)).toContainEqual(
      expect.objectContaining({
        code: "INVALID_CONFIG_VALUE",
        fieldId: "jpegBackground",
      }),
    );
  });

  it("collapses generated variants into one contact-sheet output", () => {
    const added = addMediaFlowNode({
      flow: createSimpleFlow(),
      type: "operation.contact-sheet",
      updatedAt: "2026-07-14T10:02:00.000Z",
    });
    const withInput = connectMediaFlowPorts({
      flow: added.flow,
      request: {
        fromNodeId: "generate",
        fromPortId: "image",
        toNodeId: added.nodeId,
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:02:01.000Z",
    });
    const withOutput = connectMediaFlowPorts({
      flow: withInput,
      request: {
        fromNodeId: added.nodeId,
        fromPortId: "image",
        toNodeId: "asset-output",
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:02:02.000Z",
    });

    expect(validateMediaFlowGraph(withOutput)).toEqual([]);
    expect(
      withOutput.nodes.find((node) => node.id === "asset-output")?.config,
    ).toMatchObject({ outputCount: 1 });
  });

  it("reports unknown fields and bounded field failures with actionable field identity", () => {
    const generate = createFlow().nodes.find((node) => node.id === "generate");
    expect(generate).toBeDefined();
    const invalid = {
      ...generate!,
      config: { ...generate!.config, outputCount: 9, providerPolicy: "offline", extra: true },
    };

    expect(validateMediaFlowNode(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_CONFIG_FIELD", fieldId: "extra" }),
        expect.objectContaining({ code: "INVALID_CONFIG_VALUE", fieldId: "outputCount" }),
        expect.objectContaining({ code: "INVALID_CONFIG_VALUE", fieldId: "providerPolicy" }),
      ]),
    );
  });

  it("keeps compound recipe output cardinality, format, and quality profile synchronized", () => {
    const countUpdated = updateMediaFlowNodeConfig({
      flow: createFlow(),
      nodeId: "generate",
      fieldId: "outputCount",
      value: 5,
      updatedAt: "2026-07-14T10:01:00.000Z",
    });
    expect(countUpdated.nodes.find((node) => node.id === "asset-output")?.config).toMatchObject({
      outputCount: 5,
    });

    const formatUpdated = updateMediaFlowNodeConfig({
      flow: countUpdated,
      nodeId: "generate",
      fieldId: "outputFormat",
      value: "webp",
      updatedAt: "2026-07-14T10:02:00.000Z",
    });
    expect(formatUpdated.nodes.find((node) => node.id === "asset-output")?.config).toMatchObject({
      format: "webp",
    });

    const profileUpdated = updateMediaFlowNodeConfig({
      flow: formatUpdated,
      nodeId: "quality-analyze",
      fieldId: "profile",
      value: "quality.product.v2",
      updatedAt: "2026-07-14T10:03:00.000Z",
    });
    expect(profileUpdated.nodes.find((node) => node.id === "quality-gate")?.config).toMatchObject({
      profile: "quality.product.v2",
    });
  });

  it("validates required inputs, typed ports, single cardinality, and acyclic topology", () => {
    const flow = createFlow();
    expect(validateMediaFlowGraph(flow)).toEqual([]);

    const missingInput: MediaFlow = {
      ...flow,
      edges: flow.edges.filter((edge) => edge.id !== "prompt-to-generate"),
    };
    expect(validateMediaFlowGraph(missingInput)).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_INPUT_MISSING",
        nodeId: "generate",
      }),
    );

    const typeMismatch: MediaFlow = {
      ...flow,
      edges: flow.edges.map((edge) =>
        edge.id === "quality-analyze-to-gate"
          ? { ...edge, toPortId: "image" }
          : edge,
      ),
    };
    expect(validateMediaFlowGraph(typeMismatch)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PORT_TYPE_MISMATCH", nodeId: "quality-gate" }),
        expect.objectContaining({
          code: "INPUT_CARDINALITY_EXCEEDED",
          nodeId: "quality-gate",
        }),
      ]),
    );

    const cyclic: MediaFlow = {
      ...flow,
      edges: [
        ...flow.edges,
        {
          id: "gate-remove-cycle",
          fromNodeId: "quality-gate",
          fromPortId: "image",
          toNodeId: "subject-cutout",
          toPortId: "image",
        },
      ],
    };
    expect(validateMediaFlowGraph(cyclic)).toContainEqual(
      expect.objectContaining({ code: "GRAPH_CYCLE" }),
    );
  });

  it("keeps synchronized output fields read-only and exposes progressive groups", () => {
    const flow = createFlow();
    expect(() =>
      updateMediaFlowNodeConfig({
        flow,
        nodeId: "asset-output",
        fieldId: "format",
        value: "jpeg",
        updatedAt: "2026-07-14T10:04:00.000Z",
      }),
    ).toThrow("synchronized and read-only");

    const definition = getMediaNodeDefinition("task.generate-image");
    expect(definition).not.toBeNull();
    const config = flow.nodes.find((node) => node.id === "generate")?.config ?? {};
    expect(listVisibleMediaNodeFields(definition!, config, "Basic").map((field) => field.id)).toEqual([
      "providerPolicy",
      "aspectRatio",
      "outputCount",
      "outputFormat",
    ]);
    expect(listVisibleMediaNodeFields(definition!, config, "Expert").map((field) => field.id)).toEqual([
      "modelId",
      "modelAddons",
    ]);
  });

  it("defines human review as a bounded typed pass-through gate", () => {
    const definition = getMediaNodeDefinition("control.human-review");
    expect(definition).toMatchObject({
      layer: "control",
      category: "Control",
      inputs: [expect.objectContaining({ id: "image", dataType: "image" })],
      outputs: [expect.objectContaining({ id: "image", dataType: "image" })],
    });
    const added = addMediaFlowNode({
      flow: createSimpleFlow(),
      type: "control.human-review",
      updatedAt: "2026-07-14T10:04:30.000Z",
    });
    const review = added.flow.nodes.find((node) => node.id === added.nodeId);
    expect(review?.config).toEqual({
      instructions: "Select the strongest candidate and reject outputs with visible technical defects.",
      maxSelections: 1,
      requireComment: false,
    });
    expect(validateMediaFlowNode({
      ...review!,
      config: { ...review!.config, maxSelections: 9 },
    })).toContainEqual(
      expect.objectContaining({ code: "INVALID_CONFIG_VALUE", fieldId: "maxSelections" }),
    );

    const reviewInput = connectMediaFlowPorts({
      flow: added.flow,
      request: {
        fromNodeId: "generate",
        fromPortId: "image",
        toNodeId: added.nodeId,
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:04:31.000Z",
    });
    const reviewedOutput = connectMediaFlowPorts({
      flow: reviewInput,
      request: {
        fromNodeId: added.nodeId,
        fromPortId: "image",
        toNodeId: "asset-output",
        toPortId: "image",
      },
      updatedAt: "2026-07-14T10:04:32.000Z",
    });
    expect(validateMediaFlowGraph(reviewedOutput)).toEqual([]);
    expect(
      reviewedOutput.nodes.find((node) => node.id === "asset-output")?.config.outputCount,
    ).toBe(1);
    const expandedReview = updateMediaFlowNodeConfig({
      flow: reviewedOutput,
      nodeId: added.nodeId,
      fieldId: "maxSelections",
      value: 2,
      updatedAt: "2026-07-14T10:04:33.000Z",
    });
    expect(
      expandedReview.nodes.find((node) => node.id === "asset-output")?.config.outputCount,
    ).toBe(2);
  });

  it("accepts safe prompt whitespace while rejecting embedded control bytes", () => {
    const prompt = createFlow().nodes.find((node) => node.id === "prompt");
    expect(prompt).toBeDefined();
    expect(
      validateMediaFlowNode({
        ...prompt!,
        config: { prompt: "Subject line\n\tIndented direction" },
      }),
    ).toEqual([]);
    expect(
      validateMediaFlowNode({
        ...prompt!,
        config: { prompt: "A robot girl. Anime style. " },
      }),
    ).toEqual([]);
    expect(
      validateMediaFlowNode({
        ...prompt!,
        config: { prompt: "Unsafe\u0000prompt" },
      }),
    ).toContainEqual(
      expect.objectContaining({ code: "INVALID_CONFIG_VALUE", fieldId: "prompt" }),
    );
  });

  it("adds registry-default nodes, enforces singleton definitions, and removes incident edges", () => {
    const added = addMediaFlowNode({
      flow: createSimpleFlow(),
      type: "operation.subject-cutout",
      updatedAt: "2026-07-14T11:01:00.000Z",
    });

    expect(added.nodeId).toBe("subject-cutout");
    expect(added.flow.nodes.find((node) => node.id === added.nodeId)).toMatchObject({
      label: "Cut out subject",
      layer: "operation",
      config: {
        modelPriority: [...DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY],
        outputMatte: true,
      },
    });
    expect(validateMediaFlowGraph(added.flow)).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_INPUT_MISSING",
        nodeId: added.nodeId,
      }),
    );
    expect(() =>
      addMediaFlowNode({
        flow: added.flow,
        type: "task.generate-image",
        updatedAt: "2026-07-14T11:02:00.000Z",
      }),
    ).toThrow("already present");

    const removed = removeMediaFlowNode({
      flow: createSimpleFlow(),
      nodeId: "generate",
      updatedAt: "2026-07-14T11:03:00.000Z",
    });
    expect(removed.nodes.some((node) => node.id === "generate")).toBe(false);
    expect(
      removed.edges.some(
        (edge) => edge.fromNodeId === "generate" || edge.toNodeId === "generate",
      ),
    ).toBe(false);
  });

  it("validates an ordered, unique subject-cutout model fallback policy", () => {
    const definition = getMediaNodeDefinition("operation.subject-cutout");
    expect(definition?.fields.find((field) => field.id === "modelPriority")).toMatchObject({
      kind: "model-priority",
      defaultValue: [...DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY],
    });
    const baseNode = {
      id: "subject-cutout",
      type: "operation.subject-cutout",
      version: 1,
      label: "Cut out subject",
      layer: "operation",
      config: { outputMatte: true },
    } as const;
    expect(
      validateMediaFlowNode({
        ...baseNode,
        config: { modelPriority: [], outputMatte: true },
      }),
    ).toContainEqual(
      expect.objectContaining({ code: "INVALID_CONFIG_VALUE", fieldId: "modelPriority" }),
    );
    expect(
      validateMediaFlowNode({
        ...baseNode,
        config: {
          modelPriority: ["local:border-matte-v1", "local:border-matte-v1"],
          outputMatte: true,
        },
      }),
    ).toContainEqual(
      expect.objectContaining({ code: "INVALID_CONFIG_VALUE", fieldId: "modelPriority" }),
    );
  });

  it("connects and replaces single typed inputs while blocking mismatches and cycles", () => {
    const firstAdded = addMediaFlowNode({
      flow: createSimpleFlow(),
      type: "operation.subject-cutout",
      updatedAt: "2026-07-14T11:04:00.000Z",
    });
    const withBackgroundInput = connectMediaFlowPorts({
      flow: firstAdded.flow,
      request: {
        fromNodeId: "generate",
        fromPortId: "image",
        toNodeId: firstAdded.nodeId,
        toPortId: "image",
      },
      updatedAt: "2026-07-14T11:05:00.000Z",
    });
    const rewiredOutput = connectMediaFlowPorts({
      flow: withBackgroundInput,
      request: {
        fromNodeId: firstAdded.nodeId,
        fromPortId: "image",
        toNodeId: "asset-output",
        toPortId: "image",
      },
      updatedAt: "2026-07-14T11:06:00.000Z",
    });

    expect(validateMediaFlowGraph(rewiredOutput)).toEqual([]);
    expect(
      rewiredOutput.edges.filter(
        (edge) => edge.toNodeId === "asset-output" && edge.toPortId === "image",
      ),
    ).toEqual([
      expect.objectContaining({
        fromNodeId: firstAdded.nodeId,
        fromPortId: "image",
      }),
    ]);

    const secondAdded = addMediaFlowNode({
      flow: rewiredOutput,
      type: "operation.subject-cutout",
      updatedAt: "2026-07-14T11:07:00.000Z",
    });
    const chain = connectMediaFlowPorts({
      flow: secondAdded.flow,
      request: {
        fromNodeId: firstAdded.nodeId,
        fromPortId: "image",
        toNodeId: secondAdded.nodeId,
        toPortId: "image",
      },
      updatedAt: "2026-07-14T11:08:00.000Z",
    });
    expect(
      inspectMediaFlowConnection(chain, {
        fromNodeId: secondAdded.nodeId,
        fromPortId: "image",
        toNodeId: firstAdded.nodeId,
        toPortId: "image",
      }),
    ).toEqual({ valid: false, reason: "This connection would create a cycle." });
    expect(
      inspectMediaFlowConnection(chain, {
        fromNodeId: "prompt",
        fromPortId: "prompt",
        toNodeId: secondAdded.nodeId,
        toPortId: "image",
      }),
    ).toEqual(
      expect.objectContaining({ valid: false, reason: expect.stringContaining("prompt") }),
    );

    const disconnected = disconnectMediaFlowInput({
      flow: chain,
      nodeId: secondAdded.nodeId,
      portId: "image",
      updatedAt: "2026-07-14T11:09:00.000Z",
    });
    expect(validateMediaFlowGraph(disconnected)).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_INPUT_MISSING",
        nodeId: secondAdded.nodeId,
      }),
    );
  });

  it("copies validated node settings and restores only compatible incoming connections", () => {
    const source = createFlow();
    const clipboard = copyMediaFlowNode(source, "quality-analyze");
    const pasted = pasteMediaFlowNode({
      flow: source,
      payload: clipboard,
      updatedAt: "2026-07-14T11:10:00.000Z",
    });

    expect(pasted.nodeId).toBe("quality-analyze-2");
    expect(pasted.flow.nodes.find((node) => node.id === pasted.nodeId)).toMatchObject({
      type: "operation.quality-analyze",
      label: "Analyze quality copy",
      config: source.nodes.find((node) => node.id === "quality-analyze")?.config,
    });
    expect(
      pasted.flow.edges.filter((edge) => edge.toNodeId === pasted.nodeId),
    ).toEqual([
      expect.objectContaining({
        fromNodeId: "subject-cutout",
        fromPortId: "image",
        toPortId: "image",
      }),
    ]);
    expect(
      pasted.flow.edges.some((edge) => edge.fromNodeId === pasted.nodeId),
    ).toBe(false);
    expect(validateMediaFlowGraph(pasted.flow)).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_OUTPUT_MISSING",
        nodeId: pasted.nodeId,
      }),
    );

    const singleton = copyMediaFlowNode(source, "generate");
    expect(() =>
      pasteMediaFlowNode({
        flow: source,
        payload: singleton,
        updatedAt: "2026-07-14T11:11:00.000Z",
      }),
    ).toThrow("already present");
  });

  it("remaps multi-node clipboard identities while preserving internal typed edges", () => {
    const source = createFlow();
    const clipboard = copyMediaFlowNodes(source, [
      "subject-cutout",
      "quality-analyze",
    ]);
    const pasted = pasteMediaFlowNodes({
      flow: source,
      payload: clipboard,
      updatedAt: "2026-07-14T11:12:00.000Z",
    });

    expect(pasted.idMap).toEqual({
      "subject-cutout": "subject-cutout-2",
      "quality-analyze": "quality-analyze-2",
    });
    expect(pasted.nodeIds).toEqual(["subject-cutout-2", "quality-analyze-2"]);
    expect(pasted.flow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "generate",
          toNodeId: "subject-cutout-2",
          toPortId: "image",
        }),
        expect.objectContaining({
          fromNodeId: "subject-cutout-2",
          toNodeId: "quality-analyze-2",
          toPortId: "image",
        }),
      ]),
    );
    expect(
      pasted.flow.edges.some((edge) => edge.fromNodeId === "quality-analyze-2"),
    ).toBe(false);

    expect(
      inspectMediaFlowNodePaste(source, {
        ...clipboard,
        nodes: [...clipboard.nodes, { ...clipboard.nodes[0]! }],
      }),
    ).toEqual({
      valid: false,
      reason: "Every clipboard node must have a unique bounded source identity.",
    });
    expect(
      inspectMediaFlowNodePaste(
        {
          ...source,
          nodes: Array.from({ length: 64 }, (_, index) => ({
            ...source.nodes[0]!,
            id: `capacity-${index}`,
          })),
        },
        clipboard,
      ),
    ).toEqual({
      valid: false,
      reason: "Pasting would exceed the 64-node flow limit.",
    });
  });

  it("derives stable execution order from topology instead of document array order", () => {
    const flow = createFlow();
    const reordered: MediaFlow = { ...flow, nodes: [...flow.nodes].reverse() };

    expect(orderMediaFlowNodes(reordered).map((node) => node.id)).toEqual([
      "prompt",
      "generate",
      "subject-cutout",
      "quality-analyze",
      "quality-gate",
      "asset-output",
    ]);
  });
});
