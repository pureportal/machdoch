import {
  createImageRecipeFlow,
  createMediaFlowLayout,
} from "./compiler.js";
import {
  createMediaFlowDocumentDigest,
  createMediaFlowFingerprint,
  createMediaFlowLayoutDigest,
} from "./canonicalize.js";
import type { MediaFlow, MediaFlowLayout, MediaFlowRevision } from "./contracts.js";
import { createMediaFlowRevisionDiff } from "./revision-diff.js";

const createRevision = ({
  revisionId,
  revisionNumber,
  flow,
  layout,
}: {
  revisionId: string;
  revisionNumber: number;
  flow: MediaFlow;
  layout: MediaFlowLayout;
}): MediaFlowRevision => ({
  schemaVersion: 1,
  revisionId,
  flowId: flow.id,
  revisionNumber,
  parentRevisionId: revisionNumber === 1 ? null : "revision-1",
  createdAt: flow.updatedAt,
  changeSummary: `Revision ${revisionNumber}`,
  documentDigest: createMediaFlowDocumentDigest(flow),
  executionDigest: createMediaFlowFingerprint(flow),
  layoutDigest: createMediaFlowLayoutDigest(layout),
  nodeCount: flow.nodes.length,
  edgeCount: flow.edges.length,
  isHead: revisionNumber === 2,
  flow,
  layout,
});

describe("createMediaFlowRevisionDiff", () => {
  it("separates execution, document metadata, and layout changes", () => {
    const baseFlow = createImageRecipeFlow({
      id: "flow:diff",
      createdAt: "2026-07-14T08:00:00.000Z",
      settings: {
        prompt: "Original prompt",
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
    const targetFlow: MediaFlow = {
      ...structuredClone(baseFlow),
      name: "Renamed flow",
      variables: [{
        id: "style",
        name: "Style",
        description: "Reusable art direction",
        type: "text",
        required: true,
        defaultValue: "editorial",
        constraints: { maxLength: 80 },
      }],
      variableBindings: { style: "cinematic" },
      presets: [{ id: "preset-1", name: "Cinema", description: "", values: { style: "cinematic" } }],
      activePresetId: "preset-1",
      nodes: baseFlow.nodes.map((node) =>
        node.id === "prompt"
          ? { ...node, config: { ...node.config, prompt: "Revised prompt" } }
          : node,
      ),
    };
    const baseLayout = createMediaFlowLayout(baseFlow);
    const targetLayout: MediaFlowLayout = {
      ...structuredClone(baseLayout),
      nodes: baseLayout.nodes.map((node) =>
        node.nodeId === "prompt" ? { ...node, x: node.x + 80 } : node,
      ),
    };

    const diff = createMediaFlowRevisionDiff(
      createRevision({
        revisionId: "revision-1",
        revisionNumber: 1,
        flow: baseFlow,
        layout: baseLayout,
      }),
      createRevision({
        revisionId: "revision-2",
        revisionNumber: 2,
        flow: targetFlow,
        layout: targetLayout,
      }),
    );

    expect(diff).toMatchObject({
      schemaVersion: 1,
      documentChanged: true,
      executionChanged: true,
      layoutChanged: true,
      metadataFieldsChanged: ["name"],
    });
    expect(diff.nodeChanges).toEqual([
      {
        nodeId: "prompt",
        nodeLabel: "Creative brief",
        kind: "modified",
        changedFields: ["config.prompt"],
        executionAffecting: true,
      },
    ]);
    expect(diff.edgeChanges).toEqual([]);
    expect(diff.variableChanges).toEqual([{
      variableId: "style",
      variableName: "Style",
      kind: "added",
      changedFields: ["variable"],
      executionAffecting: true,
    }]);
    expect(diff.presetChanges).toEqual([{
      presetId: "preset-1",
      presetName: "Cinema",
      kind: "added",
      changedFields: ["preset"],
    }]);
    expect(diff.layoutChanges).toEqual([
      {
        nodeId: "prompt",
        kind: "modified",
        before: { x: 52, y: 80 },
        after: { x: 132, y: 80 },
      },
    ]);
  });

  it("rejects comparisons across different flow identities", () => {
    const flow = createImageRecipeFlow({
      id: "flow:one",
      createdAt: "2026-07-14T08:00:00.000Z",
      settings: {
        prompt: "One",
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
    const other = { ...flow, id: "flow:two" };

    expect(() =>
      createMediaFlowRevisionDiff(
        createRevision({
          revisionId: "revision-1",
          revisionNumber: 1,
          flow,
          layout: createMediaFlowLayout(flow),
        }),
        createRevision({
          revisionId: "revision-2",
          revisionNumber: 2,
          flow: other,
          layout: createMediaFlowLayout(other),
        }),
      ),
    ).toThrow("within one flow identity");
  });
});
