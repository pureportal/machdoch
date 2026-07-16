import { createMediaFlowFingerprint } from "./canonicalize.js";
import {
  orderMediaFlowNodes,
  validateMediaFlowDocument,
} from "./node-registry.js";
import { resolveMediaFlowVariables } from "./variables.js";
import { inspectMediaModelAddonCompatibility } from "./model-addons.js";
import {
  DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY,
  readSubjectCutoutModelPriority,
  subjectCutoutModelLabel,
} from "./subject-cutout-policy.js";
import type {
  ImageRecipeSettings,
  MediaImageTransformRequest,
  MediaCompiledPlan,
  MediaCapability,
  MediaCompilerDiagnostic,
  MediaExecutionStep,
  MediaFlow,
  MediaFlowEdge,
  MediaFlowGroupColor,
  MediaFlowLayout,
  MediaFlowLayoutComment,
  MediaFlowLayoutGroup,
  MediaFlowNode,
  MediaModelDescriptor,
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
  MediaResolvedModelAddon,
  MediaImageReferenceRole,
  MediaProviderPolicy,
} from "./contracts.js";

interface CreateImageFlowInputBase {
  id: string;
  createdAt: string;
  settings: ImageRecipeSettings;
}

interface CreateImageRecipeFlowInput extends CreateImageFlowInputBase {
  review?: {
    instructions: string;
    maxSelections: number;
    requireComment: boolean;
  };
}

interface CreateImageEditFlowInput extends CreateImageFlowInputBase {
  sourceAssetId: string;
  editStrength?: number;
  referenceAssets?: readonly {
    assetId: string;
    role: Exclude<MediaImageReferenceRole, "base">;
    influence?: number;
  }[];
}

interface CompileMediaFlowInput {
  flow: MediaFlow;
  models: readonly MediaModelDescriptor[];
  addons?: readonly MediaModelAddonDescriptor[];
  compiledAt: string;
}

const createNode = (
  id: string,
  type: MediaFlowNode["type"],
  label: string,
  layer: MediaFlowNode["layer"],
  config: Record<string, unknown>,
): MediaFlowNode => ({ id, type, version: 1, label, layer, config });

const createEdge = (
  id: string,
  fromNodeId: string,
  fromPortId: string,
  toNodeId: string,
  toPortId: string,
): MediaFlowEdge => ({
  id,
  fromNodeId,
  fromPortId,
  toNodeId,
  toPortId,
});

export const createImageRecipeFlow = ({
  id,
  createdAt,
  settings,
  review,
}: CreateImageRecipeFlowInput): MediaFlow => {
  const isSvgVectorization =
    settings.outputFormat === "svg" && settings.svgMode === "vectorize";
  const prompt = createNode("prompt", "source.prompt", "Creative brief", "source", {
    prompt: settings.prompt,
  });
  const generate = createNode(
    "generate",
    "task.generate-image",
    settings.outputFormat === "svg" ? "Generate SVG" : "Generate image",
    "task",
    {
      providerPolicy: settings.providerPolicy,
      modelPolicy: settings.modelPolicy,
      modelId: settings.modelId,
      modelAddons: settings.modelAddons,
      aspectRatio: settings.aspectRatio,
      outputCount: settings.outputCount,
      outputFormat: settings.outputFormat,
      transparentBackground: settings.transparentBackground,
      svgMode: settings.svgMode ?? "generate",
      svgAutoCrop: settings.svgAutoCrop !== false,
      svgTargetSize: settings.svgTargetSize ?? 1024,
      svgStyle: settings.svgStyle ?? "illustration",
      svgTextPolicy: settings.svgTextPolicy ?? "avoid",
      svgCandidateCount: settings.svgCandidateCount ?? settings.outputCount,
      svgCriticEnabled: settings.svgCriticEnabled === true,
    },
  );
  const nodes: MediaFlowNode[] = isSvgVectorization
    ? [generate]
    : [prompt, generate];
  const edges: MediaFlowEdge[] = isSvgVectorization
    ? []
    : [createEdge("prompt-to-generate", "prompt", "prompt", "generate", "prompt")];
  const generationReferences = settings.outputFormat === "svg"
    ? settings.referenceImages
    : [];
  generationReferences.forEach((reference, index) => {
    const source = createNode(
      `reference-${index + 1}`,
      "source.image",
      `Reference ${index + 1}`,
      "source",
      {
        assetId: reference.assetId,
        referenceRole: reference.role,
        influence: reference.influence,
      },
    );
    nodes.push(source);
    edges.push(
      createEdge(
        `reference-${index + 1}-to-generate`,
        source.id,
        "image",
        generate.id,
        "image",
      ),
    );
  });
  let previousNodeId = generate.id;

  if (settings.transparentBackground && settings.outputFormat !== "svg") {
    const subjectCutout = createNode(
      "subject-cutout",
      "operation.subject-cutout",
      "Cut out subject",
      "operation",
      {
        modelPriority: [...DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY],
        outputMatte: true,
      },
    );
    nodes.push(subjectCutout);
    edges.push(
      createEdge(
        "generate-to-subject-cutout",
        previousNodeId,
        "image",
        subjectCutout.id,
        "image",
      ),
    );
    previousNodeId = subjectCutout.id;
  }

  if (settings.qualityGateEnabled) {
    const analyze = createNode(
      "quality-analyze",
      "operation.quality-analyze",
      "Analyze quality",
      "operation",
      { profile: "image-technical-v1" },
    );
    const gate = createNode(
      "quality-gate",
      "control.quality-gate",
      "Quality gate",
      "control",
      { onUnknown: "human-review", profile: "image-technical-v1" },
    );
    nodes.push(analyze, gate);
    edges.push(
      createEdge(
        "image-to-quality-analyze",
        previousNodeId,
        "image",
        analyze.id,
        "image",
      ),
      createEdge(
        "quality-analyze-to-gate",
        analyze.id,
        "report",
        gate.id,
        "report",
      ),
      createEdge(
        "image-to-quality-gate",
        previousNodeId,
        "image",
        gate.id,
        "image",
      ),
    );
    previousNodeId = gate.id;
  }

  if (review) {
    const humanReview = createNode(
      "human-review",
      "control.human-review",
      "Choose final images",
      "control",
      {
        instructions: review.instructions,
        maxSelections: review.maxSelections,
        requireComment: review.requireComment,
      },
    );
    nodes.push(humanReview);
    edges.push(
      createEdge(
        "image-to-human-review",
        previousNodeId,
        "image",
        humanReview.id,
        "image",
      ),
    );
    previousNodeId = humanReview.id;
  }

  const output = createNode("asset-output", "output.asset", "Save assets", "output", {
    format: settings.outputFormat,
    outputCount: review
      ? Math.min(settings.outputCount, review.maxSelections)
      : settings.outputCount,
  });
  nodes.push(output);
  edges.push(
    createEdge(
      "result-to-output",
      previousNodeId,
      "image",
      output.id,
      "image",
    ),
  );

  return {
    schemaVersion: 1,
    id,
    name: "Create image",
    description: "Prompt-to-image recipe with explicit quality and output steps.",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes,
    edges,
  };
};

export const createImageEditFlow = ({
  id,
  createdAt,
  settings,
  sourceAssetId,
  editStrength = 0.65,
  referenceAssets = [],
}: CreateImageEditFlowInput): MediaFlow => {
  if (referenceAssets.length > 7) {
    throw new Error("Image edits support at most eight references including the base image.");
  }
  const prompt = createNode("prompt", "source.prompt", "Edit instructions", "source", {
    prompt: settings.prompt,
  });
  const source = createNode("source-image", "source.image", "Source image", "source", {
    assetId: sourceAssetId,
    referenceRole: "base",
    influence: 1,
  });
  const additionalSources = referenceAssets.map((reference, index) =>
    createNode(
      `reference-image-${index + 1}`,
      "source.image",
      `${reference.role[0]?.toUpperCase() ?? ""}${reference.role.slice(1)} reference`,
      "source",
      {
        assetId: reference.assetId,
        referenceRole: reference.role,
        influence: reference.influence ?? 1,
      },
    ),
  );
  const edit = createNode("edit", "task.edit-image", "Edit image", "task", {
    providerPolicy: settings.providerPolicy,
    modelPolicy: settings.modelPolicy,
    modelId: settings.modelId,
    modelAddons: settings.modelAddons,
    aspectRatio: settings.aspectRatio,
    outputCount: settings.outputCount,
    outputFormat: settings.outputFormat,
    editStrength,
  });
  const nodes: MediaFlowNode[] = [prompt, source, ...additionalSources, edit];
  const edges: MediaFlowEdge[] = [
    createEdge("prompt-to-edit", "prompt", "prompt", "edit", "prompt"),
    createEdge("source-to-edit", "source-image", "image", "edit", "image"),
    ...additionalSources.map((reference, index) =>
      createEdge(
        `reference-${index + 1}-to-edit`,
        reference.id,
        "image",
        "edit",
        "image",
      ),
    ),
  ];
  let previousNodeId = edit.id;

  if (settings.transparentBackground) {
    const subjectCutout = createNode(
      "subject-cutout",
      "operation.subject-cutout",
      "Cut out subject",
      "operation",
      {
        modelPriority: [...DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY],
        outputMatte: true,
      },
    );
    nodes.push(subjectCutout);
    edges.push(
      createEdge(
        "edit-to-subject-cutout",
        previousNodeId,
        "image",
        subjectCutout.id,
        "image",
      ),
    );
    previousNodeId = subjectCutout.id;
  }

  if (settings.qualityGateEnabled) {
    const analyze = createNode(
      "quality-analyze",
      "operation.quality-analyze",
      "Analyze quality",
      "operation",
      { profile: "image-technical-v1" },
    );
    const gate = createNode(
      "quality-gate",
      "control.quality-gate",
      "Quality gate",
      "control",
      { onUnknown: "human-review", profile: "image-technical-v1" },
    );
    nodes.push(analyze, gate);
    edges.push(
      createEdge(
        "edited-image-to-quality-analyze",
        previousNodeId,
        "image",
        analyze.id,
        "image",
      ),
      createEdge(
        "quality-analyze-to-gate",
        analyze.id,
        "report",
        gate.id,
        "report",
      ),
      createEdge(
        "edited-image-to-quality-gate",
        previousNodeId,
        "image",
        gate.id,
        "image",
      ),
    );
    previousNodeId = gate.id;
  }

  const output = createNode("asset-output", "output.asset", "Save assets", "output", {
    format: settings.outputFormat,
    outputCount: settings.outputCount,
  });
  nodes.push(output);
  edges.push(
    createEdge(
      "result-to-output",
      previousNodeId,
      "image",
      output.id,
      "image",
    ),
  );

  return {
    schemaVersion: 1,
    id,
    name: "Edit image",
    description: "Text-guided image edit with an explicit immutable source and output lineage.",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes,
    edges,
  };
};

export const createImageTransformFlow = ({
  id,
  createdAt,
  request,
}: {
  id: string;
  createdAt: string;
  request: MediaImageTransformRequest;
}): MediaFlow => {
  const source = createNode(
    "source-image",
    "source.image",
    "Source image",
    "source",
    {
      assetId: request.sourceAssetId,
      referenceRole: "base",
      influence: 1,
    },
  );
  const transform =
    request.operation.kind === "crop"
      ? createNode("crop", "operation.crop", "Crop image", "operation", {
          x: request.operation.x,
          y: request.operation.y,
          width: request.operation.width,
          height: request.operation.height,
        })
      : request.operation.kind === "resize"
        ? createNode(
            "resize",
            "operation.resize",
            "Resize image",
            "operation",
            {
              width: request.operation.width,
              height: request.operation.height,
              fit: request.operation.fit,
            },
          )
        : null;
  const convert = createNode(
    "format-convert",
    "operation.format-convert",
    "Convert image format",
    "operation",
    {
      outputFormat: request.outputFormat,
      quality: request.quality ?? 90,
      jpegBackground: request.jpegBackground ?? "#ffffff",
    },
  );
  const output = createNode(
    "asset-output",
    "output.asset",
    "Save derived asset",
    "output",
    { format: request.outputFormat, outputCount: 1 },
  );
  const nodes = [source, ...(transform ? [transform] : []), convert, output];
  const edges = transform
    ? [
        createEdge(
          "source-to-transform",
          source.id,
          "image",
          transform.id,
          "image",
        ),
        createEdge(
          "transform-to-convert",
          transform.id,
          "image",
          convert.id,
          "image",
        ),
        createEdge(
          "convert-to-output",
          convert.id,
          "image",
          output.id,
          "image",
        ),
      ]
    : [
        createEdge(
          "source-to-convert",
          source.id,
          "image",
          convert.id,
          "image",
        ),
        createEdge(
          "convert-to-output",
          convert.id,
          "image",
          output.id,
          "image",
        ),
      ];

  return {
    schemaVersion: 1,
    id,
    name: "Transform image",
    description:
      "Model-free local image transformation with explicit encoding and immutable lineage.",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes,
    edges,
  };
};

export const createSubjectCutoutFlow = ({
  id,
  createdAt,
  sourceAssetId,
  outputMatte = true,
  modelPriority = DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY,
}: {
  id: string;
  createdAt: string;
  sourceAssetId: string;
  outputMatte?: boolean;
  modelPriority?: readonly string[];
}): MediaFlow => {
  const source = createNode(
    "source-image",
    "source.image",
    "Source image",
    "source",
    {
      assetId: sourceAssetId,
      referenceRole: "base",
      influence: 1,
    },
  );
  const subjectCutout = createNode(
    "subject-cutout",
    "operation.subject-cutout",
    "Cut out subject",
    "operation",
    { modelPriority: [...modelPriority], outputMatte },
  );
  const autoTag = createNode(
    "auto-tag",
    "operation.auto-tag",
    "Tag technical output",
    "operation",
    { profile: "technical-metadata-v1" },
  );
  const output = createNode(
    "asset-output",
    "output.asset",
    "Save transparent cutout",
    "output",
    { format: "png", outputCount: 1 },
  );

  return {
    schemaVersion: 1,
    id,
    name: "Cut out image subject",
    description:
      "Local subject matting with an explicit priority/fallback policy and optional immutable alpha-matte asset.",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes: [source, subjectCutout, autoTag, output],
    edges: [
      createEdge(
        "source-to-subject-cutout",
        source.id,
        "image",
        subjectCutout.id,
        "image",
      ),
      createEdge(
        "subject-cutout-to-auto-tag",
        subjectCutout.id,
        "image",
        autoTag.id,
        "image",
      ),
      createEdge(
        "auto-tag-to-output",
        autoTag.id,
        "image",
        output.id,
        "image",
      ),
    ],
  };
};

export const createAlphaMatteFlow = ({
  id,
  createdAt,
  sourceAssetId,
  invert = false,
}: {
  id: string;
  createdAt: string;
  sourceAssetId: string;
  invert?: boolean;
}): MediaFlow => {
  const source = createNode(
    "source-image",
    "source.image",
    "Source image",
    "source",
    { assetId: sourceAssetId, referenceRole: "base", influence: 1 },
  );
  const extract = createNode(
    "extract-alpha-matte",
    "operation.alpha-matte",
    "Extract alpha matte",
    "operation",
    { invert },
  );
  const autoTag = createNode(
    "auto-tag",
    "operation.auto-tag",
    "Tag technical output",
    "operation",
    { profile: "technical-metadata-v1" },
  );
  const output = createNode(
    "asset-output",
    "output.asset",
    "Save exact alpha matte",
    "output",
    { format: "png", outputCount: 1 },
  );

  return {
    schemaVersion: 1,
    id,
    name: "Extract image alpha matte",
    description:
      "Model-free extraction of the exact 8-bit image alpha channel as an immutable grayscale matte.",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes: [source, extract, autoTag, output],
    edges: [
      createEdge(
        "source-to-alpha-matte",
        source.id,
        "image",
        extract.id,
        "image",
      ),
      createEdge(
        "alpha-matte-to-auto-tag",
        extract.id,
        "image",
        autoTag.id,
        "image",
      ),
      createEdge(
        "auto-tag-to-output",
        autoTag.id,
        "image",
        output.id,
        "image",
      ),
    ],
  };
};

export const createImageCompositeFlow = ({
  id,
  createdAt,
  foregroundAssetId,
  backgroundAssetId,
  fit = "contain",
  opacityPercent = 100,
}: {
  id: string;
  createdAt: string;
  foregroundAssetId: string;
  backgroundAssetId: string;
  fit?: "contain" | "cover" | "stretch";
  opacityPercent?: number;
}): MediaFlow => {
  const foreground = createNode(
    "foreground-image",
    "source.image",
    "Foreground image",
    "source",
    { assetId: foregroundAssetId, referenceRole: "base", influence: 1 },
  );
  const background = createNode(
    "background-image",
    "source.image",
    "Background image",
    "source",
    { assetId: backgroundAssetId, referenceRole: "style", influence: 1 },
  );
  const composite = createNode(
    "composite",
    "operation.composite",
    "Composite images",
    "operation",
    { fit, opacityPercent },
  );
  const autoTag = createNode(
    "auto-tag",
    "operation.auto-tag",
    "Tag technical output",
    "operation",
    { profile: "technical-metadata-v1" },
  );
  const output = createNode(
    "asset-output",
    "output.asset",
    "Save composite",
    "output",
    { format: "png", outputCount: 1 },
  );

  return {
    schemaVersion: 1,
    id,
    name: "Composite image over background",
    description:
      "Local alpha-aware foreground-over-background composition with explicit fit, opacity, and source lineage.",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes: [foreground, background, composite, autoTag, output],
    edges: [
      createEdge(
        "foreground-to-composite",
        foreground.id,
        "image",
        composite.id,
        "foreground",
      ),
      createEdge(
        "background-to-composite",
        background.id,
        "image",
        composite.id,
        "background",
      ),
      createEdge(
        "composite-to-auto-tag",
        composite.id,
        "image",
        autoTag.id,
        "image",
      ),
      createEdge(
        "auto-tag-to-output",
        autoTag.id,
        "image",
        output.id,
        "image",
      ),
    ],
  };
};

export const createImageContactSheetFlow = ({
  id,
  createdAt,
  sourceAssetIds,
  columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(sourceAssetIds.length)))),
  cellWidth = 512,
  cellHeight = 512,
  gap = 16,
  background = "#0f172a",
  labelMode = "index",
}: {
  id: string;
  createdAt: string;
  sourceAssetIds: readonly string[];
  columns?: number;
  cellWidth?: number;
  cellHeight?: number;
  gap?: number;
  background?: string;
  labelMode?: "index" | "none";
}): MediaFlow => {
  if (
    sourceAssetIds.length < 2 ||
    sourceAssetIds.length > 8 ||
    sourceAssetIds.some((assetId) => assetId.trim().length === 0) ||
    new Set(sourceAssetIds).size !== sourceAssetIds.length
  ) {
    throw new Error("Contact sheet flows require between two and eight unique image assets.");
  }
  const sources = sourceAssetIds.map((assetId, index) =>
    createNode(
      `contact-image-${index + 1}`,
      "source.image",
      `Image ${index + 1}`,
      "source",
      { assetId, referenceRole: "base", influence: 1 },
    ),
  );
  const contactSheet = createNode(
    "contact-sheet",
    "operation.contact-sheet",
    "Compose comparison sheet",
    "operation",
    { columns, cellWidth, cellHeight, gap, background, labelMode },
  );
  const autoTag = createNode(
    "auto-tag",
    "operation.auto-tag",
    "Tag technical output",
    "operation",
    { profile: "technical-metadata-v1" },
  );
  const output = createNode(
    "asset-output",
    "output.asset",
    "Save contact sheet",
    "output",
    { format: "png", outputCount: 1 },
  );

  return {
    schemaVersion: 1,
    id,
    name: "Comparison contact sheet",
    description:
      "Local bounded comparison sheet with stable source ordering, optional index labels, and editable layout settings.",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes: [...sources, contactSheet, autoTag, output],
    edges: [
      ...sources.map((source, index) =>
        createEdge(
          `contact-image-${index + 1}-to-sheet`,
          source.id,
          "image",
          contactSheet.id,
          "image",
        ),
      ),
      createEdge(
        "contact-sheet-to-auto-tag",
        contactSheet.id,
        "image",
        autoTag.id,
        "image",
      ),
      createEdge(
        "auto-tag-to-output",
        autoTag.id,
        "image",
        output.id,
        "image",
      ),
    ],
  };
};

export const createMediaFlowLayout = (flow: MediaFlow): MediaFlowLayout => {
  const layerColumns: Record<MediaFlowNode["layer"], number> = {
    source: 0,
    task: 1,
    operation: 2,
    control: 3,
    output: 4,
    runtime: 2,
  };
  const rowsByColumn = new Map<number, number>();

  return {
    schemaVersion: 1,
    flowId: flow.id,
    groups: [],
    comments: [],
    nodes: flow.nodes.map((node) => {
      const column = layerColumns[node.layer];
      const row = rowsByColumn.get(column) ?? 0;
      rowsByColumn.set(column, row + 1);

      return {
        nodeId: node.id,
        x: 52 + column * 250,
        y: 80 + row * 150,
      };
    }),
  };
};

export const reconcileMediaFlowLayout = (
  flow: MediaFlow,
  storedLayout: MediaFlowLayout | null,
): MediaFlowLayout => {
  const generatedLayout = createMediaFlowLayout(flow);
  if (!storedLayout || storedLayout.flowId !== flow.id) {
    return generatedLayout;
  }

  const storedPositions = new Map(
    storedLayout.nodes.map((entry) => [entry.nodeId, entry]),
  );

  return {
    ...generatedLayout,
    comments: storedLayout.comments,
    groups: storedLayout.groups.flatMap((group) => {
      const nodeIds = group.nodeIds.filter((nodeId) =>
        flow.nodes.some((node) => node.id === nodeId),
      );
      return nodeIds.length >= 2 ? [{ ...group, nodeIds }] : [];
    }),
    nodes: generatedLayout.nodes.map((entry) => {
      const stored = storedPositions.get(entry.nodeId);
      return stored
        ? { nodeId: entry.nodeId, x: stored.x, y: stored.y }
        : entry;
    }),
  };
};

export interface AddMediaFlowLayoutGroupResult {
  layout: MediaFlowLayout;
  groupId: string;
}

const createLayoutGroupId = (groups: readonly MediaFlowLayoutGroup[]): string => {
  const existingIds = new Set(groups.map((group) => group.id));
  let index = 1;
  while (existingIds.has(`group-${index}`)) index += 1;
  return `group-${index}`;
};

export const addMediaFlowLayoutGroup = ({
  layout,
  nodeIds,
  label,
}: {
  layout: MediaFlowLayout;
  nodeIds: readonly string[];
  label?: string;
}): AddMediaFlowLayoutGroupResult => {
  const knownNodeIds = new Set(layout.nodes.map((node) => node.nodeId));
  const normalizedNodeIds = [...new Set(nodeIds)].filter((nodeId) =>
    knownNodeIds.has(nodeId),
  );
  if (normalizedNodeIds.length < 2) {
    throw new Error("Select at least two flow nodes to create a visual group.");
  }
  const groupedNodeIds = new Set(layout.groups.flatMap((group) => group.nodeIds));
  const alreadyGrouped = normalizedNodeIds.find((nodeId) => groupedNodeIds.has(nodeId));
  if (alreadyGrouped) {
    throw new Error(`Media node ${alreadyGrouped} already belongs to a visual group.`);
  }
  const groupId = createLayoutGroupId(layout.groups);
  return {
    groupId,
    layout: {
      ...layout,
      groups: [
        ...layout.groups,
        {
          id: groupId,
          label: (label?.trim() || `Group ${layout.groups.length + 1}`).slice(0, 80),
          color: "cyan",
          collapsed: false,
          nodeIds: normalizedNodeIds,
        },
      ],
    },
  };
};

export const updateMediaFlowLayoutGroup = ({
  layout,
  groupId,
  label,
  color,
  collapsed,
}: {
  layout: MediaFlowLayout;
  groupId: string;
  label?: string;
  color?: MediaFlowGroupColor;
  collapsed?: boolean;
}): MediaFlowLayout => {
  const group = layout.groups.find((entry) => entry.id === groupId);
  if (!group) throw new Error(`Media flow group ${groupId} was not found.`);
  const nextLabel = label === undefined ? group.label : label.trim().slice(0, 80);
  if (!nextLabel) throw new Error("Visual group labels cannot be empty.");
  return {
    ...layout,
    groups: layout.groups.map((entry) =>
      entry.id === groupId
        ? {
            ...entry,
            label: nextLabel,
            color: color ?? entry.color,
            collapsed: collapsed ?? entry.collapsed,
          }
        : entry,
    ),
  };
};

export const removeMediaFlowLayoutGroup = (
  layout: MediaFlowLayout,
  groupId: string,
): MediaFlowLayout => ({
  ...layout,
  groups: layout.groups.filter((group) => group.id !== groupId),
});

export interface AddMediaFlowLayoutCommentResult {
  layout: MediaFlowLayout;
  commentId: string;
}

const clampCommentDimension = (value: number, minimum: number): number =>
  Math.max(minimum, Math.min(600, Math.round(value)));

const createLayoutCommentId = (
  comments: readonly MediaFlowLayoutComment[],
): string => {
  const existingIds = new Set(comments.map((comment) => comment.id));
  let index = 1;
  while (existingIds.has(`comment-${index}`)) index += 1;
  return `comment-${index}`;
};

export const addMediaFlowLayoutComment = ({
  layout,
  body = "Workflow note",
  x,
  y,
}: {
  layout: MediaFlowLayout;
  body?: string;
  x?: number;
  y?: number;
}): AddMediaFlowLayoutCommentResult => {
  if (layout.comments.length >= 64) {
    throw new Error("Media flow layouts support at most 64 comments.");
  }
  const normalizedBody = body.trim().slice(0, 1_000);
  if (!normalizedBody) throw new Error("Canvas comments cannot be empty.");
  const automaticX = layout.nodes.length > 0
    ? Math.min(...layout.nodes.map((node) => node.x))
    : 80;
  const automaticY = layout.nodes.length > 0
    ? Math.max(...layout.nodes.map((node) => node.y)) + 220 + layout.comments.length * 36
    : 80;
  const nextX = x ?? automaticX;
  const nextY = y ?? automaticY;
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
    throw new Error("Canvas comments require finite positions.");
  }
  const commentId = createLayoutCommentId(layout.comments);
  return {
    commentId,
    layout: {
      ...layout,
      comments: [
        ...layout.comments,
        {
          id: commentId,
          body: normalizedBody,
          color: "amber",
          x: Math.max(-1_000_000, Math.min(1_000_000, nextX)),
          y: Math.max(-1_000_000, Math.min(1_000_000, nextY)),
          width: 240,
          height: 120,
        },
      ],
    },
  };
};

export const updateMediaFlowLayoutComment = ({
  layout,
  commentId,
  body,
  color,
  x,
  y,
  width,
  height,
}: {
  layout: MediaFlowLayout;
  commentId: string;
  body?: string;
  color?: MediaFlowGroupColor;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): MediaFlowLayout => {
  const comment = layout.comments.find((entry) => entry.id === commentId);
  if (!comment) throw new Error(`Media flow comment ${commentId} was not found.`);
  const nextBody = body === undefined ? comment.body : body.trim().slice(0, 1_000);
  if (!nextBody) throw new Error("Canvas comments cannot be empty.");
  const nextX = x ?? comment.x;
  const nextY = y ?? comment.y;
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
    throw new Error("Canvas comments require finite positions.");
  }
  return {
    ...layout,
    comments: layout.comments.map((entry) =>
      entry.id === commentId
        ? {
            ...entry,
            body: nextBody,
            color: color ?? entry.color,
            x: Math.max(-1_000_000, Math.min(1_000_000, nextX)),
            y: Math.max(-1_000_000, Math.min(1_000_000, nextY)),
            width: clampCommentDimension(width ?? entry.width, 180),
            height: clampCommentDimension(height ?? entry.height, 80),
          }
        : entry,
    ),
  };
};

export const removeMediaFlowLayoutComment = (
  layout: MediaFlowLayout,
  commentId: string,
): MediaFlowLayout => ({
  ...layout,
  comments: layout.comments.filter((comment) => comment.id !== commentId),
});

const isModelReady = (model: MediaModelDescriptor): boolean => {
  if (model.target === "remote") return model.configured;
  if (model.providerId === "local-diffusers") {
    return model.installed && model.runtimeReadiness === "ready";
  }
  return model.installed;
};

const matchesProviderPolicy = (
  model: MediaModelDescriptor,
  policy: MediaProviderPolicy,
): boolean => {
  return policy === "auto" || model.target === policy;
};

const scoreModel = (
  model: MediaModelDescriptor,
  settings: ImageRecipeSettings,
): number => {
  const policyScore =
    settings.modelPolicy === "quality"
      ? model.qualityScore
      : settings.modelPolicy === "fast"
        ? model.speedScore
        : (model.qualityScore + model.speedScore) / 2;
  const readinessBonus = isModelReady(model) ? 1_000 : 0;
  const recommendedBonus = model.recommended ? 20 : 0;

  return readinessBonus + recommendedBonus + policyScore;
};

const selectImageModel = (
  settings: ImageRecipeSettings,
  models: readonly MediaModelDescriptor[],
  requiredCapability: MediaCapability = "text-to-image",
): MediaModelDescriptor | null => {
  if (settings.modelId) {
    return models.find((model) => model.id === settings.modelId) ?? null;
  }

  const candidates = models
    .filter((model) => model.capabilities.includes(requiredCapability))
    .filter((model) => matchesProviderPolicy(model, settings.providerPolicy))
    .filter((model) => model.lifecycle !== "removed")
    .sort((left, right) => scoreModel(right, settings) - scoreModel(left, settings));

  return candidates[0] ?? null;
};

interface MediaImageTaskSettings {
  settings: ImageRecipeSettings;
  taskType: "generate" | "edit";
  requiredCapability:
    | "text-to-image"
    | "text-to-svg"
    | "image-to-svg"
    | "guided-svg-generation"
    | "image-to-image"
    | "multi-reference-edit";
  taskNode: MediaFlowNode;
  sourceAssets: readonly {
    nodeId: string;
    assetId: string;
    role: string;
  }[];
}

const listUpstreamImageSources = (
  flow: MediaFlow,
  taskNodeId: string,
): readonly MediaFlowNode[] => {
  const incomingByTarget = new Map<string, string[]>();
  for (const edge of flow.edges) {
    if (edge.toNodeId === taskNodeId && edge.toPortId !== "image") continue;
    incomingByTarget.set(edge.toNodeId, [
      ...(incomingByTarget.get(edge.toNodeId) ?? []),
      edge.fromNodeId,
    ]);
  }
  const pending = [...(incomingByTarget.get(taskNodeId) ?? [])];
  const upstreamNodeIds = new Set<string>();
  while (pending.length > 0 && upstreamNodeIds.size <= 64) {
    const nodeId = pending.pop();
    if (!nodeId || upstreamNodeIds.has(nodeId)) continue;
    upstreamNodeIds.add(nodeId);
    pending.push(...(incomingByTarget.get(nodeId) ?? []));
  }
  return flow.nodes.filter(
    (node) => node.type === "source.image" && upstreamNodeIds.has(node.id),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readModelAddonSelections = (
  value: unknown,
): MediaModelAddonSelection[] | null => {
  if (!Array.isArray(value) || value.length > 24) return null;
  const selections: MediaModelAddonSelection[] = [];
  const seenAddonIds = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.addonId !== "string" ||
      entry.addonId.trim() !== entry.addonId ||
      entry.addonId.length === 0 ||
      entry.addonId.length > 160 ||
      typeof entry.enabled !== "boolean" ||
      seenAddonIds.has(entry.addonId)
    ) {
      return null;
    }
    seenAddonIds.add(entry.addonId);
    if (entry.kind === "lora") {
      const denoisingSchedule =
        entry.denoisingSchedule === undefined ||
        entry.denoisingSchedule === null
          ? null
          : isRecord(entry.denoisingSchedule) &&
              Object.keys(entry.denoisingSchedule).every((key) =>
                ["start", "end"].includes(key),
              ) &&
              typeof entry.denoisingSchedule.start === "number" &&
              Number.isFinite(entry.denoisingSchedule.start) &&
              typeof entry.denoisingSchedule.end === "number" &&
              Number.isFinite(entry.denoisingSchedule.end) &&
              entry.denoisingSchedule.start >= 0 &&
              entry.denoisingSchedule.start < entry.denoisingSchedule.end &&
              entry.denoisingSchedule.end <= 1
            ? {
                start: entry.denoisingSchedule.start,
                end: entry.denoisingSchedule.end,
              }
            : undefined;
      if (
        typeof entry.modelStrength !== "number" ||
        !Number.isFinite(entry.modelStrength) ||
        entry.modelStrength < -100 ||
        entry.modelStrength > 100 ||
        !(
          entry.textEncoderStrength === null ||
          (typeof entry.textEncoderStrength === "number" &&
            Number.isFinite(entry.textEncoderStrength) &&
            entry.textEncoderStrength >= -100 &&
            entry.textEncoderStrength <= 100)
        ) ||
        denoisingSchedule === undefined
      ) {
        return null;
      }
      selections.push({
        kind: "lora",
        addonId: entry.addonId,
        enabled: entry.enabled,
        modelStrength: entry.modelStrength,
        textEncoderStrength: entry.textEncoderStrength,
        denoisingSchedule,
      });
      continue;
    }
    if (
      entry.kind !== "textual-inversion" ||
      typeof entry.token !== "string" ||
      entry.token.trim() !== entry.token ||
      entry.token.length === 0 ||
      [...entry.token].length > 128 ||
      !["positive", "negative", "both"].includes(String(entry.placement)) ||
      [...entry.token].some(
        (character) =>
          !["\n", "\r", "\t"].includes(character) && /\p{Cc}/u.test(character),
      )
    ) {
      return null;
    }
    selections.push({
      kind: "textual-inversion",
      addonId: entry.addonId,
      enabled: entry.enabled,
      token: entry.token,
      placement: entry.placement as "positive" | "negative" | "both",
    });
  }
  return selections;
};

const readImageTaskNodeSettings = (
  flow: MediaFlow,
  taskNode: MediaFlowNode,
): ImageRecipeSettings | null => {
  const promptNode = flow.nodes.find((node) => node.type === "source.prompt");
  const providerPolicy = taskNode.config.providerPolicy;
  const modelPolicy = taskNode.config.modelPolicy;
  const aspectRatio = taskNode.config.aspectRatio;
  const outputCount = taskNode.config.outputCount;
  const outputFormat = taskNode.config.outputFormat;
  const svgMode = taskNode.config.svgMode;
  const isSvgVectorization =
    outputFormat === "svg" && svgMode === "vectorize";
  const prompt = promptNode?.config.prompt;
  const modelId = taskNode.config.modelId;
  const modelAddons = taskNode.config.modelAddons === undefined
    ? []
    : readModelAddonSelections(taskNode.config.modelAddons);

  if (
    (typeof prompt !== "string" && !isSvgVectorization) ||
    !["auto", "local", "remote"].includes(String(providerPolicy)) ||
    !["balanced", "fast", "quality"].includes(String(modelPolicy)) ||
    !["1:1", "4:5", "16:9", "9:16"].includes(String(aspectRatio)) ||
    typeof outputCount !== "number" ||
    !["png", "jpeg", "webp", "svg"].includes(String(outputFormat)) ||
    modelAddons === null
  ) {
    return null;
  }

  return {
    prompt: typeof prompt === "string" ? prompt : "",
    providerPolicy: providerPolicy as ImageRecipeSettings["providerPolicy"],
    modelPolicy: modelPolicy as ImageRecipeSettings["modelPolicy"],
    modelId: typeof modelId === "string" ? modelId : null,
    modelAddons,
    aspectRatio: aspectRatio as ImageRecipeSettings["aspectRatio"],
    outputCount,
    outputFormat: outputFormat as ImageRecipeSettings["outputFormat"],
    transparentBackground:
      outputFormat === "svg"
        ? taskNode.config.transparentBackground === true
        : flow.nodes.some((node) => node.type === "operation.subject-cutout"),
    qualityGateEnabled: flow.nodes.some(
      (node) => node.type === "control.quality-gate",
    ),
    referenceImages: [],
    svgMode: ["generate", "vectorize"].includes(String(taskNode.config.svgMode))
      ? taskNode.config.svgMode as NonNullable<ImageRecipeSettings["svgMode"]>
      : "generate",
    svgAutoCrop: taskNode.config.svgAutoCrop !== false,
    svgTargetSize:
      typeof taskNode.config.svgTargetSize === "number"
        ? taskNode.config.svgTargetSize
        : 1024,
    svgStyle: ["illustration", "icon", "logo", "diagram", "technical"].includes(
      String(taskNode.config.svgStyle),
    )
      ? taskNode.config.svgStyle as NonNullable<ImageRecipeSettings["svgStyle"]>
      : "illustration",
    svgTextPolicy: ["avoid", "editable", "outlines"].includes(
      String(taskNode.config.svgTextPolicy),
    )
      ? taskNode.config.svgTextPolicy as NonNullable<ImageRecipeSettings["svgTextPolicy"]>
      : "avoid",
    svgCandidateCount:
      typeof taskNode.config.svgCandidateCount === "number"
        ? taskNode.config.svgCandidateCount
        : outputCount,
    svgCriticEnabled: taskNode.config.svgCriticEnabled === true,
  };
};

const readMediaImageTaskSettings = (
  flow: MediaFlow,
): MediaImageTaskSettings | null => {
  const taskNodes = flow.nodes.filter(
    (node) =>
      node.type === "task.generate-image" || node.type === "task.edit-image",
  );
  const taskNode = taskNodes.length === 1 ? taskNodes[0] : undefined;
  if (!taskNode) return null;
  const settings = readImageTaskNodeSettings(flow, taskNode);
  if (!settings) return null;
  const taskType = taskNode.type === "task.edit-image" ? "edit" : "generate";
  const sourceAssets = listUpstreamImageSources(flow, taskNode.id).map((node) => ({
        nodeId: node.id,
        assetId:
          typeof node.config.assetId === "string" ? node.config.assetId : "",
        role:
          typeof node.config.referenceRole === "string"
            ? node.config.referenceRole
            : "base",
      }));
  return {
    settings,
    taskType,
    requiredCapability:
      taskType === "generate"
        ? settings.outputFormat === "svg"
          ? settings.svgMode === "vectorize"
            ? "image-to-svg"
            : sourceAssets.length > 0
              ? "guided-svg-generation"
              : "text-to-svg"
          : "text-to-image"
        : sourceAssets.length > 1
          ? "multi-reference-edit"
          : "image-to-image",
    taskNode,
    sourceAssets,
  };
};

export const readImageRecipeSettings = (
  flow: MediaFlow,
): ImageRecipeSettings | null => {
  const taskNode = flow.nodes.find(
    (node) =>
      node.type === "task.generate-image" || node.type === "task.edit-image",
  );
  if (!taskNode) return null;
  const settings = readImageTaskNodeSettings(flow, taskNode);
  if (!settings) return settings;

  const references = listUpstreamImageSources(flow, taskNode.id)
    .flatMap((node) => {
      const assetId = node.config.assetId;
      const role = node.config.referenceRole;
      if (
        typeof assetId !== "string" ||
        !["base", "subject", "style", "composition", "palette", "detail"].includes(
          String(role),
        )
      ) {
        return [];
      }
      return [{
        assetId,
        role: role as MediaImageReferenceRole,
        influence:
          typeof node.config.influence === "number" ? node.config.influence : 1,
      }];
    })
    .sort((left, right) =>
      left.role === "base" ? -1 : right.role === "base" ? 1 : 0,
    );
  return { ...settings, referenceImages: references };
};

export interface MediaFlowCardinalityStage {
  nodeId: string;
  nodeType: MediaFlowNode["type"];
  inputBound: number | null;
  outputBound: number | null;
}

export interface MediaFlowCardinalityAnalysis {
  generatedCandidates: number;
  maxPublishedOutputs: number;
  requiresHumanReview: boolean;
  stages: readonly MediaFlowCardinalityStage[];
}

const readBoundedCardinality = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8
    ? value
    : null;

export const analyzeMediaFlowCardinality = (
  flow: MediaFlow,
): MediaFlowCardinalityAnalysis => {
  const effectiveFlow = resolveMediaFlowVariables(flow).flow;
  const outputBounds = new Map<string, number | null>();
  const stages: MediaFlowCardinalityStage[] = [];
  let generatedCandidates = 0;
  let requiresHumanReview = false;

  for (const node of orderMediaFlowNodes(effectiveFlow)) {
    const incomingImageBounds = effectiveFlow.edges
      .filter((edge) => edge.toNodeId === node.id && edge.toPortId === "image")
      .map((edge) => outputBounds.get(edge.fromNodeId) ?? null)
      .filter((bound): bound is number => bound !== null);
    const inputBound = incomingImageBounds.length > 0
      ? Math.max(...incomingImageBounds)
      : null;
    let outputBound = inputBound;

    if (node.type === "source.image") {
      outputBound = 1;
    } else if (node.type === "operation.contact-sheet") {
      outputBound = inputBound === null ? null : 1;
    } else if (
      node.type === "task.generate-image" ||
      node.type === "task.edit-image"
    ) {
      outputBound = readBoundedCardinality(node.config.outputCount);
      generatedCandidates = Math.max(generatedCandidates, outputBound ?? 0);
    } else if (node.type === "control.human-review") {
      requiresHumanReview = true;
      const selectionBound = readBoundedCardinality(node.config.maxSelections);
      outputBound = inputBound === null || selectionBound === null
        ? null
        : Math.min(inputBound, selectionBound);
    }

    outputBounds.set(node.id, outputBound);
    stages.push({
      nodeId: node.id,
      nodeType: node.type,
      inputBound,
      outputBound,
    });
  }

  const publishedBounds = effectiveFlow.nodes
    .filter((node) => node.type === "output.asset")
    .map((node) => outputBounds.get(node.id) ?? null)
    .filter((bound): bound is number => bound !== null);

  return {
    generatedCandidates,
    maxPublishedOutputs: publishedBounds.length > 0
      ? Math.max(...publishedBounds)
      : generatedCandidates,
    requiresHumanReview,
    stages,
  };
};

const createModelDiagnostics = (
  model: MediaModelDescriptor | null,
  settings: ImageRecipeSettings,
  compiledAt: string,
  nodeId: string,
  requiredCapability:
    | "text-to-image"
    | "text-to-svg"
    | "image-to-svg"
    | "guided-svg-generation"
    | "image-to-image"
    | "multi-reference-edit",
): MediaCompilerDiagnostic[] => {
  if (!model) {
    return [
      {
        code: settings.modelId ? "MODEL_NOT_FOUND" : "PROVIDER_POLICY_UNSATISFIED",
        severity: "error",
        message: settings.modelId
          ? "The selected model is not present in the current media catalog."
          : `No ${requiredCapability} model satisfies the ${settings.providerPolicy} execution policy.`,
        nodeId,
        action: "Choose another model or execution policy.",
      },
    ];
  }

  if (model.lifecycle === "removed") {
    return [
      {
        code: "MODEL_REMOVED",
        severity: "error",
        message: `${model.displayName} is no longer runnable.`,
        nodeId,
        action: "Select a supported replacement explicitly.",
      },
    ];
  }

  const diagnostics: MediaCompilerDiagnostic[] = [];
  if (!model.capabilities.includes(requiredCapability)) {
    diagnostics.push({
      code: "MODEL_CAPABILITY_UNSUPPORTED",
      severity: "error",
      message: `${model.displayName} cannot execute ${requiredCapability} tasks.`,
      nodeId,
      action: `Choose a model that declares the ${requiredCapability} capability.`,
    });
  }

  if (!matchesProviderPolicy(model, settings.providerPolicy)) {
    diagnostics.push({
      code: "PROVIDER_POLICY_UNSATISFIED",
      severity: "error",
      message: `${model.displayName} is pinned to ${model.target} execution, which conflicts with the ${settings.providerPolicy} execution boundary.`,
      nodeId,
      action:
        "Change the execution boundary or explicitly choose a compatible model. The pin was preserved for review.",
    });
  }

  if (
    model.lifecycle === "scheduled-shutdown" ||
    model.lifecycle === "deprecated"
  ) {
    diagnostics.push({
      code: "MODEL_LIFECYCLE_REVIEW_REQUIRED",
      severity: "warning",
      message: `${model.displayName} is marked ${model.lifecycle.replaceAll("-", " ")} in catalog ${model.catalogRevision}.`,
      nodeId,
      action:
        "Review the lifecycle source and explicitly confirm this model before enqueueing a paid or long-running job.",
    });
  }

  const compiledTimestamp = Date.parse(compiledAt);
  const checkedTimestamp = Date.parse(model.lifecycleCheckedAt);
  if (
    Number.isFinite(compiledTimestamp) &&
    Number.isFinite(checkedTimestamp) &&
    compiledTimestamp - checkedTimestamp >
      model.lifecycleStaleAfterSeconds * 1_000
  ) {
    diagnostics.push({
      code: "MODEL_LIFECYCLE_STALE",
      severity: "warning",
      message: `${model.displayName} lifecycle data is older than the catalog freshness window.`,
      nodeId,
      action: "Refresh provider capabilities before enqueueing a remote run.",
    });
  }

  if (!isModelReady(model)) {
    const localDiffusersNeedsVerification =
      model.providerId === "local-diffusers" && model.installed;
    diagnostics.push({
      code: "MODEL_NOT_READY",
      severity: "error",
      message:
        model.target === "remote"
          ? `${model.displayName} requires a configured provider credential.`
          : localDiffusersNeedsVerification
            ? `${model.displayName} has not passed a clean offline runtime verification on this device.`
            : `${model.displayName} is not installed on this device.`,
      nodeId,
      action:
        model.target === "remote"
          ? "Configure the provider in Settings."
          : localDiffusersNeedsVerification
            ? "Open Models and run Verify model."
            : "Review the model license, disk estimate, and install plan.",
    });
  }

  return diagnostics;
};

interface ResolvedModelAddons {
  addons: MediaResolvedModelAddon[];
  diagnostics: MediaCompilerDiagnostic[];
}

const resolveModelAddons = (
  selections: readonly MediaModelAddonSelection[],
  descriptors: readonly MediaModelAddonDescriptor[],
  model: MediaModelDescriptor | null,
  nodeId: string,
): ResolvedModelAddons => {
  const enabledSelections = selections.filter((selection) => selection.enabled);
  if (enabledSelections.length === 0) return { addons: [], diagnostics: [] };

  const diagnostics: MediaCompilerDiagnostic[] = [];
  const resolved: MediaResolvedModelAddon[] = [];
  const seenAddonIds = new Set<string>();

  for (const kind of ["lora", "textual-inversion"] as const) {
    const count = enabledSelections.filter((selection) => selection.kind === kind).length;
    const limit = model?.addonCapabilities.find(
      (capability) => capability.kind === kind,
    )?.maxActive;
    if (limit !== undefined && count > limit) {
      diagnostics.push({
        code: "ADDON_LIMIT_EXCEEDED",
        severity: "error",
        message: `${model?.displayName ?? "The selected model"} supports at most ${limit} active ${kind === "lora" ? "LoRA adapters" : "textual-inversion embeddings"}; this flow enables ${count}.`,
        nodeId,
        action: "Disable add-ons until the model's active-adapter limit is satisfied.",
      });
    }
  }

  for (const selection of enabledSelections) {
    if (seenAddonIds.has(selection.addonId)) {
      diagnostics.push({
        code: "ADDON_CONFIG_INVALID",
        severity: "error",
        message: `Model add-on ${selection.addonId} is selected more than once.`,
        nodeId,
        action: "Keep one selection per imported add-on.",
      });
      continue;
    }
    seenAddonIds.add(selection.addonId);
    const descriptor = descriptors.find(
      (candidate) => candidate.id === selection.addonId,
    );
    if (!descriptor) {
      diagnostics.push({
        code: "ADDON_NOT_FOUND",
        severity: "error",
        message: `The selected ${selection.kind === "lora" ? "LoRA" : "embedding"} (${selection.addonId}) is not present in the local add-on library.`,
        nodeId,
        action: "Import the original safetensors file again or remove it from this flow.",
      });
      continue;
    }
    if (descriptor.kind !== selection.kind) {
      diagnostics.push({
        code: "ADDON_KIND_MISMATCH",
        severity: "error",
        message: `${descriptor.displayName} is stored as ${descriptor.kind}, but the flow expects ${selection.kind}.`,
        nodeId,
        action: "Remove the stale selection and add the library item again.",
      });
      continue;
    }
    if (!model) continue;
    const capability = model.addonCapabilities.find(
      (candidate) => candidate.kind === descriptor.kind,
    );
    if (!capability) {
      diagnostics.push({
        code: "ADDON_PROVIDER_UNSUPPORTED",
        severity: "error",
        message: `${model.displayName} does not accept ${descriptor.kind === "lora" ? "LoRA adapters" : "textual-inversion embeddings"}.`,
        nodeId,
        action:
          model.providerId === "openai"
            ? "Choose a compatible local Stable Diffusion or FLUX model, or disable the add-on."
            : "Choose a model whose catalog entry advertises this add-on capability.",
      });
      continue;
    }
    if (
      selection.kind === "lora" &&
      selection.textEncoderStrength !== null &&
      !capability.supportsSeparateComponentStrengths
    ) {
      diagnostics.push({
        code: "ADDON_CONFIG_INVALID",
        severity: "error",
        message: `${model.displayName} does not expose a separate text-encoder strength for ${descriptor.displayName}.`,
        nodeId,
        action: "Use the model strength for all supported components.",
      });
      continue;
    }
    if (
      selection.kind === "lora" &&
      selection.denoisingSchedule !== null &&
      !capability.supportsDenoisingSchedules
    ) {
      diagnostics.push({
        code: "ADDON_CONFIG_INVALID",
        severity: "error",
        message: `${model.displayName} cannot change LoRA strength during denoising.`,
        nodeId,
        action: "Disable the denoising window or choose a compatible local model.",
      });
      continue;
    }
    if (
      selection.kind === "lora" &&
      selection.denoisingSchedule !== null &&
      (descriptor.targetComponents.length !== 1 ||
        descriptor.targetComponents[0] !== "denoiser")
    ) {
      diagnostics.push({
        code: "ADDON_CONFIG_INVALID",
        severity: "error",
        message: `${descriptor.displayName} cannot use a denoising window because it also targets text encoders.`,
        nodeId,
        action: "Use a denoiser-only LoRA or disable its denoising window.",
      });
      continue;
    }
    if (
      selection.kind === "lora" &&
      selection.textEncoderStrength !== null &&
      !descriptor.targetComponents.some(
        (component) => component === "text-encoder" || component === "text-encoder-2",
      )
    ) {
      diagnostics.push({
        code: "ADDON_CONFIG_INVALID",
        severity: "error",
        message: `${descriptor.displayName} does not contain text-encoder weights.`,
        nodeId,
        action: "Disable separate text-encoder strength for this LoRA.",
      });
      continue;
    }
    if (
      selection.kind === "textual-inversion" &&
      model.architecture === "flux-1" &&
      selection.placement !== "positive"
    ) {
      diagnostics.push({
        code: "ADDON_CONFIG_INVALID",
        severity: "error",
        message: `${model.displayName} accepts textual-inversion tokens only in the positive prompt channel.`,
        nodeId,
        action: "Set the embedding prompt placement to Positive.",
      });
      continue;
    }
    const compatibility = inspectMediaModelAddonCompatibility(model, descriptor);
    if (compatibility.status === "incompatible") {
      diagnostics.push({
        code: "ADDON_ARCHITECTURE_MISMATCH",
        severity: "error",
        message: compatibility.reason,
        nodeId,
        action: "Choose an add-on trained for the selected model architecture.",
      });
      continue;
    }
    if (compatibility.status === "unverified") {
      diagnostics.push({
        code: "ADDON_BASE_MODEL_UNVERIFIED",
        severity: "warning",
        message: compatibility.reason,
        nodeId,
        action: "Review the publisher's base-model declaration before running.",
      });
    }
    resolved.push({
      descriptor,
      selection,
      compatibility: compatibility.status,
    });
  }
  return { addons: resolved, diagnostics };
};

const createExecutionSteps = (
  flow: MediaFlow,
  model: MediaModelDescriptor | null,
  models: readonly MediaModelDescriptor[],
  hasModelAddons: boolean,
): MediaExecutionStep[] => {
  const steps: MediaExecutionStep[] = [];
  const stepId = (
    node: MediaFlowNode,
    legacyNodeId: string,
    legacyStepId: string,
  ): string =>
    node.id === legacyNodeId ? legacyStepId : `${legacyStepId}:${node.id}`;

  for (const node of orderMediaFlowNodes(flow)) {
    switch (node.type) {
      case "source.prompt":
        steps.push({
          id: stepId(node, "prompt", "normalize-prompt"),
          sourceNodeId: node.id,
          kind: "normalize-prompt",
          label: "Normalize prompt and recipe inputs",
          target: "orchestrator",
          cacheable: true,
        });
        break;
      case "source.image":
        {
          const referenceRole =
            typeof node.config.referenceRole === "string"
              ? node.config.referenceRole.replaceAll("-", " ")
              : "base";
        steps.push({
          id: stepId(node, "source-image", "resolve-asset"),
          sourceNodeId: node.id,
          kind: "resolve-asset",
          label: `Resolve immutable ${referenceRole} reference and verify workspace access`,
          target: "orchestrator",
          cacheable: true,
        });
        break;
        }
      case "task.generate-image":
        {
        const isSvg = node.config.outputFormat === "svg";
        steps.push({
          id: stepId(node, "generate", "resolve-model"),
          sourceNodeId: node.id,
          kind: "resolve-model",
          label: "Resolve provider, model, and capability constraints",
          target: "orchestrator",
          cacheable: false,
        });
        if (hasModelAddons) {
          steps.push({
            id: stepId(node, "generate", "resolve-model-addons"),
            sourceNodeId: node.id,
            kind: "resolve-model-addons",
            label: "Resolve and validate model add-on weights",
            target: "orchestrator",
            cacheable: true,
          });
        }
        if (model) {
          const isVectorization =
            isSvg && node.config.svgMode === "vectorize";
          const generationStepKind = isVectorization
            ? "vectorize-svg"
            : isSvg
              ? "generate-svg"
              : "generate-image";
          steps.push({
            id: stepId(node, "generate", generationStepKind),
            sourceNodeId: node.id,
            kind: generationStepKind,
            label: isVectorization
              ? `Vectorize one source asset with ${model.displayName}`
              : `${isSvg ? "Generate SVG candidates" : "Generate"} with ${model.displayName}`,
            target: model.target,
            cacheable: model.target === "local",
            ...(model.target === "remote" ? { sideEffect: "paid-request" } : {}),
          });
          if (isSvg) {
            steps.push(
              {
                id: stepId(node, "generate", "validate-svg"),
                sourceNodeId: node.id,
                kind: "validate-svg",
                label: "Validate SVG Secure Static structure",
                target: "local",
                cacheable: true,
              },
              {
                id: stepId(node, "generate", "render-svg"),
                sourceNodeId: node.id,
                kind: "render-svg",
                label: "Render candidates deterministically at multiple scales",
                target: "local",
                cacheable: true,
              },
              {
                id: stepId(node, "generate", "score-svg"),
                sourceNodeId: node.id,
                kind: "score-svg",
                label: "Score canvas fit, visibility, and structural complexity",
                target: "local",
                cacheable: true,
              },
            );
            if (
              !isVectorization &&
              node.config.svgCriticEnabled === true &&
              node.config.modelPolicy === "quality" &&
              model.target === "remote"
            ) {
              steps.push({
                id: stepId(node, "generate", "repair-svg"),
                sourceNodeId: node.id,
                kind: "repair-svg",
                label: "Repair and independently verify shortlisted weak candidates with OpenAI",
                target: "remote",
                cacheable: false,
                sideEffect: "paid-request",
              });
            }
          }
        }
        break;
        }
      case "task.edit-image":
        steps.push({
          id: stepId(node, "edit", "resolve-model"),
          sourceNodeId: node.id,
          kind: "resolve-model",
          label: "Resolve edit provider, model, and capability constraints",
          target: "orchestrator",
          cacheable: false,
        });
        if (hasModelAddons) {
          steps.push({
            id: stepId(node, "edit", "resolve-model-addons"),
            sourceNodeId: node.id,
            kind: "resolve-model-addons",
            label: "Resolve and validate model add-on weights",
            target: "orchestrator",
            cacheable: true,
          });
        }
        if (model) {
          steps.push({
            id: stepId(node, "edit", "edit-image"),
            sourceNodeId: node.id,
            kind: "edit-image",
            label: `Edit with ${model.displayName}`,
            target: model.target,
            cacheable: model.target === "local",
            ...(model.target === "remote" ? { sideEffect: "paid-request" } : {}),
          });
        }
        break;
      case "operation.crop":
        steps.push({
          id: stepId(node, "crop", "crop-image"),
          sourceNodeId: node.id,
          kind: "crop-image",
          label: "Validate bounds and crop immutable source pixels",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.resize":
        steps.push({
          id: stepId(node, "resize", "resize-image"),
          sourceNodeId: node.id,
          kind: "resize-image",
          label: "Resize with the explicit target box and fit policy",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.format-convert":
        steps.push({
          id: stepId(node, "format-convert", "convert-image"),
          sourceNodeId: node.id,
          kind: "convert-image",
          label: "Re-encode pixels and verify output metadata",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.metadata-strip":
        steps.push({
          id: stepId(node, "metadata-strip", "strip-metadata"),
          sourceNodeId: node.id,
          kind: "strip-metadata",
          label: "Apply orientation and remove private image metadata",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.auto-tag":
        steps.push({
          id: stepId(node, "auto-tag", "auto-tag"),
          sourceNodeId: node.id,
          kind: "auto-tag",
          label: "Apply deterministic format, shape, resolution, and asset-role tags",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.contact-sheet":
        steps.push({
          id: stepId(node, "contact-sheet", "create-contact-sheet"),
          sourceNodeId: node.id,
          kind: "create-contact-sheet",
          label: "Compose the bounded image collection into a comparison sheet",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.subject-cutout":
        {
          const modelPriority = readSubjectCutoutModelPriority(node.config);
          const modelLabels = modelPriority.map(
            (modelId, index) =>
              `${index + 1} ${
                models.find((candidate) => candidate.id === modelId)?.displayName ??
                subjectCutoutModelLabel(modelId)
              }`,
          );
        steps.push({
          id: stepId(node, "subject-cutout", "cutout-subject"),
          sourceNodeId: node.id,
          kind: "cutout-subject",
          label: `Cut out subject · ${modelLabels.join(" → ")}`,
          target: "local",
          cacheable: true,
        });
        break;
        }
      case "operation.alpha-matte":
        steps.push({
          id: stepId(node, "alpha-matte", "extract-alpha-matte"),
          sourceNodeId: node.id,
          kind: "extract-alpha-matte",
          label: "Extract the exact 8-bit alpha channel as a grayscale matte",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.composite":
        steps.push({
          id: stepId(node, "composite", "composite-image"),
          sourceNodeId: node.id,
          kind: "composite-image",
          label: "Scale, center, and alpha-blend foreground over background",
          target: "local",
          cacheable: true,
        });
        break;
      case "operation.quality-analyze":
        steps.push({
          id: stepId(node, "quality-analyze", "analyze-quality"),
          sourceNodeId: node.id,
          kind: "analyze-quality",
          label: "Measure dimensions, alpha, blur, clipping, and artifacts",
          target: "local",
          cacheable: true,
        });
        break;
      case "control.quality-gate":
        steps.push({
          id: stepId(node, "quality-gate", "evaluate-gate"),
          sourceNodeId: node.id,
          kind: "evaluate-gate",
          label: "Evaluate the versioned quality profile",
          target: "orchestrator",
          cacheable: true,
        });
        break;
      case "control.human-review": {
        const maxSelections = readBoundedCardinality(node.config.maxSelections) ?? 1;
        const instructions =
          typeof node.config.instructions === "string"
            ? node.config.instructions.trim()
            : "Review the generated candidates before publication.";
        steps.push({
          id: stepId(node, "human-review", "wait-for-review"),
          sourceNodeId: node.id,
          kind: "wait-for-review",
          label: `Pause for human review · approve up to ${maxSelections}`,
          target: "orchestrator",
          cacheable: false,
          review: {
            instructions,
            maxSelections,
            requireComment: node.config.requireComment === true,
          },
        });
        break;
      }
      case "output.asset":
        steps.push({
          id: stepId(node, "asset-output", "ingest-asset"),
          sourceNodeId: node.id,
          kind: "ingest-asset",
          label: "Validate, hash, and publish immutable assets",
          target: "orchestrator",
          cacheable: false,
          sideEffect: "asset-write",
        });
        break;
    }
  }
  return steps;
};

export const compileMediaFlow = ({
  flow,
  models,
  addons = [],
  compiledAt,
}: CompileMediaFlowInput): MediaCompiledPlan => {
  const variableResolution = resolveMediaFlowVariables(flow);
  const effectiveFlow = variableResolution.flow;
  const imageTaskNodes = effectiveFlow.nodes.filter(
    (node) =>
      node.type === "task.generate-image" || node.type === "task.edit-image",
  );
  const imageTask = readMediaImageTaskSettings(effectiveFlow);
  const isLocalUtilityFlow =
    imageTaskNodes.length === 0 &&
    effectiveFlow.nodes.some((node) => node.type === "source.image") &&
    effectiveFlow.nodes.some((node) => node.type === "output.asset");
  const settings = imageTask?.settings ?? null;
  const promptNode = flow.nodes.find((node) => node.type === "source.prompt");
  const imageTaskNode = imageTask?.taskNode ?? null;
  const subjectCutoutNode = effectiveFlow.nodes.find(
    (node) => node.type === "operation.subject-cutout",
  );
  const humanReviewNode = flow.nodes.find(
    (node) => node.type === "control.human-review",
  );
  const diagnostics: MediaCompilerDiagnostic[] = [];
  const cardinality = analyzeMediaFlowCardinality(effectiveFlow);

  diagnostics.push(
    ...variableResolution.issues.map((issue) => ({
      code: issue.code,
      severity: "error" as const,
      message: issue.message,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
      action:
        issue.code === "VARIABLE_REFERENCE_UNKNOWN"
          ? "Declare the referenced variable or remove its token from the node configuration."
          : issue.code === "VARIABLE_REQUIRED"
            ? "Provide a binding, choose a preset, or define a safe default value."
            : "Review the typed variable declaration and its constraints.",
    })),
  );

  diagnostics.push(
    ...validateMediaFlowDocument(effectiveFlow).map((issue) => ({
      code: "NODE_SCHEMA_INVALID" as const,
      severity: issue.severity,
      message: issue.message,
      nodeId: issue.nodeId,
      action: issue.fieldId
        ? `Review ${issue.fieldId} in the schema-generated node inspector.`
        : issue.code === "UNKNOWN_NODE_DEFINITION" ||
            issue.code === "UNSUPPORTED_NODE_VERSION"
          ? "Install or migrate to a supported node definition."
          : "Repair the typed graph connection before enqueueing this flow.",
    })),
  );

  if (!settings && !isLocalUtilityFlow) {
    diagnostics.push({
      code: "MODEL_NOT_FOUND",
      severity: "error",
      message: "The current flow must contain exactly one supported image generation or edit task.",
      action: "Recreate the recipe or repair the missing task nodes.",
    });
  }

  if (
    settings &&
    settings.prompt.trim().length === 0 &&
    !(settings.outputFormat === "svg" && settings.svgMode === "vectorize")
  ) {
    diagnostics.push({
      code: "PROMPT_REQUIRED",
      severity: "error",
      message:
        imageTask?.taskType === "edit"
          ? "Describe the requested image edit before compiling this flow."
          : "Describe the image before compiling this flow.",
      nodeId: promptNode?.id ?? "prompt",
      action: "Add a concrete subject, setting, or visual direction.",
    });
  }

  const connectedSourceAssets =
    imageTask?.sourceAssets ??
    (isLocalUtilityFlow
      ? effectiveFlow.nodes
          .filter((node) => node.type === "source.image")
          .map((node) => ({
            nodeId: node.id,
            assetId:
              typeof node.config.assetId === "string"
                ? node.config.assetId
                : "",
            role:
              typeof node.config.referenceRole === "string"
                ? node.config.referenceRole
                : "source",
          }))
      : []);
  const normalizedSourceAssetIds = connectedSourceAssets
    .map((source) => source.assetId.trim())
    .filter(Boolean);
  const isSvgVectorization =
    imageTask?.taskType === "generate" &&
    settings?.outputFormat === "svg" &&
    settings.svgMode === "vectorize";
  if (imageTask?.taskType === "edit" || isLocalUtilityFlow || isSvgVectorization) {
    if (connectedSourceAssets.length === 0) {
      diagnostics.push({
        code: "SOURCE_ASSET_REQUIRED",
        severity: "error",
        message: isLocalUtilityFlow
          ? "Local image operations require at least one connected Media Studio source asset."
          : "Image editing requires at least one connected Media Studio source asset.",
        nodeId: imageTaskNode?.id ?? "edit",
        action: "Connect an immutable image asset before compiling this flow.",
      });
    }
    for (const source of connectedSourceAssets.filter(
      (entry) => entry.assetId.trim().length === 0,
    )) {
      diagnostics.push({
        code: "SOURCE_ASSET_REQUIRED",
        severity: "error",
        message: `The connected ${source.role.replaceAll("-", " ")} reference does not identify a stable Media Studio asset.`,
        nodeId: source.nodeId,
        action: "Choose an immutable image asset or disconnect this reference.",
      });
    }
  }
  if (
    isSvgVectorization &&
    connectedSourceAssets.length !== 1
  ) {
    diagnostics.push({
      code: "SOURCE_ASSET_REQUIRED",
      severity: "error",
      message: "SVG vectorization requires exactly one connected source asset.",
      nodeId: imageTaskNode?.id ?? "generate",
      action: "Connect one raster image or existing vector asset to the SVG task.",
    });
  }

  if (
    settings &&
    (!Number.isInteger(settings.outputCount) ||
      settings.outputCount < 1 ||
      settings.outputCount > 8)
  ) {
    diagnostics.push({
      code: "OUTPUT_COUNT_INVALID",
      severity: "error",
      message: "Output count must be an integer from 1 to 8.",
      nodeId: imageTaskNode?.id ?? "generate",
      action: "Reduce the variant count before compiling.",
    });
  }
  if (isSvgVectorization && settings?.outputCount !== 1) {
    diagnostics.push({
      code: "OUTPUT_COUNT_INVALID",
      severity: "error",
      message: "SVG vectorization produces exactly one verified vector asset per request.",
      nodeId: imageTaskNode?.id ?? "generate",
      action: "Set the output count to one.",
    });
  }

  const subjectCutoutModelPriority = subjectCutoutNode
    ? readSubjectCutoutModelPriority(subjectCutoutNode.config)
    : [];
  const subjectCutoutCandidates = subjectCutoutModelPriority.map((modelId) => ({
    modelId,
    descriptor: models.find((candidate) => candidate.id === modelId) ?? null,
  }));
  const isRunnableSubjectCutoutModel = (
    candidate: MediaModelDescriptor | null,
  ): candidate is MediaModelDescriptor =>
    candidate !== null &&
    candidate.configured &&
    candidate.installed &&
    candidate.lifecycle !== "removed";
  const selectedSubjectCutoutIndex = subjectCutoutCandidates.findIndex((candidate) =>
    isRunnableSubjectCutoutModel(candidate.descriptor),
  );
  const subjectCutoutModel =
    selectedSubjectCutoutIndex >= 0
      ? subjectCutoutCandidates[selectedSubjectCutoutIndex]?.descriptor ?? null
      : subjectCutoutCandidates.find((candidate) => candidate.descriptor)?.descriptor ?? null;
  const model = imageTask
    ? selectImageModel(
        imageTask.settings,
        models,
        imageTask.requiredCapability,
      )
    : subjectCutoutModel;
  const svgCriticRequested = Boolean(
    settings?.outputFormat === "svg" && settings.svgCriticEnabled === true,
  );
  const svgCriticActive = Boolean(
    svgCriticRequested &&
      !isSvgVectorization &&
      settings?.modelPolicy === "quality" &&
      model?.target === "remote",
  );
  const openAiConfigured = models.some(
    (candidate) => candidate.providerId === "openai" && candidate.configured,
  );
  const resolvedAddons = resolveModelAddons(
    settings?.modelAddons ?? [],
    addons,
    model,
    imageTaskNode?.id ?? "generate",
  );
  diagnostics.push(...resolvedAddons.diagnostics);

  if (subjectCutoutNode) {
    if (subjectCutoutModelPriority.length === 0) {
      diagnostics.push({
        code: "MODEL_NOT_FOUND",
        severity: "error",
        message: "Subject cutout requires at least one model in its priority list.",
        nodeId: subjectCutoutNode.id,
        action: "Select a primary subject-cutout model and optional fallbacks.",
      });
    } else if (selectedSubjectCutoutIndex < 0) {
      const installable = subjectCutoutCandidates.find(
        (candidate) => candidate.descriptor && !candidate.descriptor.installed,
      )?.descriptor;
      diagnostics.push({
        code: installable ? "LOCAL_MODEL_DOWNLOAD_REQUIRED" : "MODEL_NOT_FOUND",
        severity: "error",
        message: installable
          ? `${installable.displayName} must be reviewed and installed because no selected subject-cutout fallback is currently runnable.`
          : "None of the selected subject-cutout models is available and runnable.",
        nodeId: subjectCutoutNode.id,
        action: installable
          ? `Review and install ${installable.displayName}, or add a bundled fallback.`
          : "Choose an active background-removal model from the current media catalog.",
      });
    } else if (selectedSubjectCutoutIndex > 0) {
      const selected = subjectCutoutCandidates[selectedSubjectCutoutIndex]?.descriptor;
      const skipped = subjectCutoutCandidates
        .slice(0, selectedSubjectCutoutIndex)
        .map((candidate) =>
          candidate.descriptor?.displayName ?? subjectCutoutModelLabel(candidate.modelId),
        );
      diagnostics.push({
        code: "SUBJECT_CUTOUT_FALLBACK_SELECTED",
        severity: "warning",
        message: `${selected?.displayName ?? "A fallback model"} will run because ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not currently available.`,
        nodeId: subjectCutoutNode.id,
        action: "Reorder the model policy or install the preferred model if this fallback is not intended.",
      });
    }
  }

  if (settings) {
    diagnostics.push(
      ...createModelDiagnostics(
        model,
        settings,
        compiledAt,
        imageTaskNode?.id ?? "generate",
        imageTask?.requiredCapability ?? "text-to-image",
      ),
    );

    if (svgCriticRequested && !svgCriticActive) {
      diagnostics.push({
        code: "SVG_CRITIC_UNAVAILABLE",
        severity: "error",
        message:
          "OpenAI SVG render-feedback repair is available only for remote prompt-to-SVG generation with the quality policy.",
        nodeId: imageTaskNode?.id ?? "generate",
        action: "Disable repair or select a remote SVG model with the quality policy.",
      });
    } else if (svgCriticActive && !openAiConfigured) {
      diagnostics.push({
        code: "SVG_CRITIC_UNAVAILABLE",
        severity: "error",
        message: "OpenAI SVG render-feedback repair requires a configured OpenAI API key.",
        nodeId: imageTaskNode?.id ?? "generate",
        action: "Configure OpenAI in Settings or disable the repair pass.",
      });
    } else if (svgCriticActive) {
      diagnostics.push({
        code: "REMOTE_EXECUTION_SELECTED",
        severity: "info",
        message:
          "Weak SVG candidates may trigger separate paid OpenAI requests containing the prompt, candidate SVG, and deterministic PNG preview.",
        nodeId: imageTaskNode?.id ?? "generate",
      });
    }

    if (
      model?.target === "remote" &&
      matchesProviderPolicy(model, settings.providerPolicy)
    ) {
      if (imageTask?.taskType === "edit" || normalizedSourceAssetIds.length > 0) {
        diagnostics.push({
          code: "REMOTE_ASSET_UPLOAD_SELECTED",
          severity: "info",
          message: `${model.displayName} will receive prompt text and ${normalizedSourceAssetIds.length} disclosed source asset${normalizedSourceAssetIds.length === 1 ? "" : "s"}: ${normalizedSourceAssetIds.join(", ") || "none"}.`,
          nodeId: imageTaskNode?.id ?? "edit",
          action: "Review the exact upload manifest before enqueueing.",
        });
      } else {
        diagnostics.push({
          code: "REMOTE_EXECUTION_SELECTED",
          severity: "info",
          message: `${model.displayName} will receive the prompt and create ${settings.outputCount} remote output${settings.outputCount === 1 ? "" : "s"}.`,
          nodeId: imageTaskNode?.id ?? "generate",
        });
      }
    }

    if (model?.target === "local" && !model.installed) {
      diagnostics.push({
        code: "LOCAL_MODEL_DOWNLOAD_REQUIRED",
        severity: "info",
        message: `${model.displayName} requires a reviewed local model installation.`,
        nodeId: imageTaskNode?.id ?? "generate",
      });
    }

    if (
      settings.transparentBackground &&
      settings.outputFormat !== "svg" &&
      !model?.capabilities.includes("transparent-output")
    ) {
      diagnostics.push({
        code: "TRANSPARENCY_REQUIRES_POSTPROCESS",
        severity: "warning",
        message:
          "Transparency is compiled as an explicit local matting step because the selected image model does not provide native alpha.",
        nodeId: subjectCutoutNode?.id ?? "subject-cutout",
      });
    }
  }

  if (humanReviewNode) {
    diagnostics.push({
      code: "HUMAN_REVIEW_REQUIRED",
      severity: "info",
      message: `The run will pause with up to ${cardinality.generatedCandidates} candidate${cardinality.generatedCandidates === 1 ? "" : "s"}; at most ${cardinality.maxPublishedOutputs} approved output${cardinality.maxPublishedOutputs === 1 ? "" : "s"} may continue. Worker and GPU leases are released while waiting.`,
      nodeId: humanReviewNode.id,
      action: "Reviewers can approve or reject candidates without keeping a model loaded.",
    });
  }

  const fingerprint = createMediaFlowFingerprint(flow);
  const hasErrors = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const outputCount =
    settings || isLocalUtilityFlow ? cardinality.maxPublishedOutputs : 0;
  const privacySummary =
    (isLocalUtilityFlow
      ? `${normalizedSourceAssetIds.length} source asset${normalizedSourceAssetIds.length === 1 ? "" : "s"} ${normalizedSourceAssetIds.length === 1 ? "remains" : "remain"} on this device for local image operations.`
      : model && (imageTask?.taskType === "edit" || normalizedSourceAssetIds.length > 0)
        ? model.target === "remote"
          ? `Prompt text and ${normalizedSourceAssetIds.length} disclosed source asset${normalizedSourceAssetIds.length === 1 ? "" : "s"} are sent to ${model.displayName}.`
          : `Prompt text and ${normalizedSourceAssetIds.length} source asset${normalizedSourceAssetIds.length === 1 ? "" : "s"} remain on this device.`
        : model?.privacySummary ??
          "Execution privacy is unresolved until a model is selected.") +
    (svgCriticActive
      ? " Shortlisted weak candidates may also send the prompt, candidate SVG, and deterministic renders to OpenAI for up to two separately billed, audited repair-and-verification requests per candidate."
      : "");

  return {
    schemaVersion: 1,
    id: `${flow.id}:${fingerprint.slice("sha256:".length, 18)}`,
    flowId: flow.id,
    flowFingerprint: fingerprint,
    status: hasErrors ? "blocked" : "ready",
    compiledAt,
    model,
    addons: resolvedAddons.addons,
    steps: createExecutionSteps(
      effectiveFlow,
      model,
      models,
      resolvedAddons.addons.length > 0,
    ),
    diagnostics,
    preflight: {
      target: model?.target ?? (isLocalUtilityFlow ? "local" : null),
      modelId: model?.id ?? null,
      modelLabel:
        model?.displayName ??
        (isLocalUtilityFlow ? "Built-in media utilities" : "Unresolved model"),
      requiresRemoteRequest: model?.target === "remote",
      requiresModelDownload:
        (model?.target === "local" && !model.installed) ||
        Boolean(subjectCutoutModel && !subjectCutoutModel.installed),
      requiresHumanReview: cardinality.requiresHumanReview,
      remoteUploadAssetIds:
        model?.target === "remote" && normalizedSourceAssetIds.length > 0
          ? normalizedSourceAssetIds
          : [],
      generatedCandidates: cardinality.generatedCandidates,
      estimatedOutputs: outputCount,
      estimatedVramGb: model?.minVramGb ?? null,
      estimatedDownloadGb:
        (model?.target === "local" && !model.installed
          ? model.expectedDownloadGb ?? 0
          : 0) +
          (subjectCutoutModel &&
          subjectCutoutModel.id !== model?.id &&
          !subjectCutoutModel.installed
            ? subjectCutoutModel.expectedDownloadGb ?? 0
            : 0) || null,
      costHint:
        model?.costHint ??
        (isLocalUtilityFlow
          ? "No provider charge; uses local CPU and disk resources."
          : "Cost unavailable until a model is selected."),
      privacySummary,
    },
  };
};
