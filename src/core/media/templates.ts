import {
  createImageRecipeFlow,
  createMediaFlowLayout,
} from "./compiler.js";
import type {
  ImageRecipeSettings,
  InstantiateMediaFlowTemplateResult,
  MediaFlow,
  MediaFlowPreset,
  MediaFlowTemplateDescriptor,
  MediaFlowVariable,
} from "./contracts.js";

const TEMPLATE_CREATED_AT = "2026-07-14T00:00:00.000Z";

const cloneJsonDocument = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const replaceNodeConfig = (
  flow: MediaFlow,
  nodeId: string,
  config: Record<string, unknown>,
): MediaFlow => ({
  ...flow,
  nodes: flow.nodes.map((node) => node.id === nodeId
    ? { ...node, config: { ...node.config, ...config } }
    : node),
});

interface TemplateHumanReview {
  instructions: string;
  maxSelections: number;
  requireComment: boolean;
}

const insertHumanReviewBeforeOutput = (
  flow: MediaFlow,
  review: TemplateHumanReview,
): MediaFlow => {
  const outputEdge = flow.edges.find(
    (edge) => edge.toNodeId === "asset-output" && edge.toPortId === "image",
  );
  if (!outputEdge) throw new Error("Template flow requires an asset publication edge.");
  return {
    ...flow,
    nodes: flow.nodes.flatMap((node) => node.id === "asset-output"
      ? [
          {
            id: "human-review",
            type: "control.human-review" as const,
            version: 1 as const,
            label: "Human review",
            layer: "control" as const,
            config: {
              instructions: review.instructions,
              maxSelections: review.maxSelections,
              requireComment: review.requireComment,
            },
          },
          { ...node, config: { ...node.config, outputCount: review.maxSelections } },
        ]
      : [node]),
    edges: [
      ...flow.edges.filter((edge) => edge.id !== outputEdge.id),
      {
        ...outputEdge,
        id: `${outputEdge.fromNodeId}-to-human-review`,
        toNodeId: "human-review",
      },
      {
        id: "human-review-to-output",
        fromNodeId: "human-review",
        fromPortId: "image",
        toNodeId: "asset-output",
        toPortId: "image",
      },
    ],
  };
};

const createTemplate = ({
  id,
  name,
  description,
  category,
  tags,
  workflowSummary,
  privacySummary,
  settings,
  variables,
  presets,
  prompt,
  humanReview,
}: Omit<MediaFlowTemplateDescriptor, "schemaVersion" | "flow" | "layout" | "remoteCapable"> & {
  settings: ImageRecipeSettings;
  variables: MediaFlowVariable[];
  presets: MediaFlowPreset[];
  prompt: string;
  humanReview?: TemplateHumanReview;
}): MediaFlowTemplateDescriptor => {
  let flow = createImageRecipeFlow({
    id: `template:${id}`,
    createdAt: TEMPLATE_CREATED_AT,
    settings,
  });
  flow = replaceNodeConfig(flow, "prompt", { prompt });
  const outputCountVariable = variables.find((variable) => variable.id === "variant-count");
  if (outputCountVariable) {
    flow = replaceNodeConfig(flow, "generate", { outputCount: "{{variant-count}}" });
    if (!humanReview) {
      flow = replaceNodeConfig(flow, "asset-output", { outputCount: "{{variant-count}}" });
    }
  }
  if (humanReview) flow = insertHumanReviewBeforeOutput(flow, humanReview);
  flow = {
    ...flow,
    name,
    description,
    variables,
    variableBindings: {},
    presets,
    activePresetId: null,
  };
  return {
    schemaVersion: 1,
    id,
    name,
    description,
    category,
    tags,
    workflowSummary,
    privacySummary,
    remoteCapable: settings.providerPolicy !== "local",
    flow,
    layout: createMediaFlowLayout(flow),
  };
};

const creativeBriefVariable = (defaultValue: string): MediaFlowVariable => ({
  id: "creative-brief",
  name: "Creative brief",
  description: "The reusable subject, scene, and composition requested from the image model.",
  type: "text",
  required: true,
  defaultValue,
  constraints: { maxLength: 2_000 },
});

const variantCountVariable = (defaultValue: number): MediaFlowVariable => ({
  id: "variant-count",
  name: "Variant count",
  description: "A bounded number of generated candidates. Remote providers may bill per output.",
  type: "number",
  required: true,
  defaultValue,
  constraints: { min: 1, max: 8, step: 1 },
});

const createBuiltInTemplates = (): MediaFlowTemplateDescriptor[] => [
  createTemplate({
    id: "text-to-image-variants",
    name: "Text to image variants",
    description: "Create a small, bounded image set from one reusable brief and art direction preset.",
    category: "Generation",
    tags: ["text-to-image", "variants", "starter"],
    workflowSummary: "Creative brief → image generation → bounded human selection → immutable asset publication",
    privacySummary: "The execution boundary remains explicit. Choosing a remote model uploads prompt text; local execution keeps it on-device.",
    settings: {
      prompt: "",
      providerPolicy: "auto",
      modelPolicy: "balanced",
      modelId: null,
      aspectRatio: "1:1",
      outputCount: 4,
      outputFormat: "png",
      transparentBackground: false,
      qualityGateEnabled: false,
      referenceImages: [],
      modelAddons: [],
    },
    variables: [
      creativeBriefVariable("A sculptural table lamp in a calm editorial studio"),
      {
        id: "art-direction",
        name: "Art direction",
        description: "A controlled visual direction appended to the creative brief.",
        type: "choice",
        required: true,
        defaultValue: "Editorial",
        constraints: { options: ["Editorial", "Cinematic", "Minimal", "Playful"] },
      },
      variantCountVariable(4),
    ],
    presets: [
      {
        id: "preset-editorial",
        name: "Editorial set",
        description: "Balanced editorial defaults for a first review round.",
        values: {
          "creative-brief": "A sculptural table lamp in a calm editorial studio",
          "art-direction": "Editorial",
          "variant-count": 4,
        },
      },
      {
        id: "preset-cinematic",
        name: "Cinematic set",
        description: "A more dramatic lighting direction with fewer review candidates.",
        values: {
          "creative-brief": "A sculptural table lamp in a dark architectural interior",
          "art-direction": "Cinematic",
          "variant-count": 3,
        },
      },
    ],
    prompt: "{{creative-brief}}, {{art-direction}} art direction",
    humanReview: {
      instructions: "Approve up to two compositionally distinct candidates with clean subject detail.",
      maxSelections: 2,
      requireComment: false,
    },
  }),
  createTemplate({
    id: "product-cutout-quality",
    name: "Product cutout with quality gate",
    description: "Generate product candidates, extract clean transparency, analyze technical quality, and publish only gated assets.",
    category: "Product",
    tags: ["product", "transparency", "quality-gate"],
    workflowSummary: "Product brief → generation → background removal → quality analysis → tri-state gate → human selection → assets",
    privacySummary: "Matting and technical analysis run locally. Prompt upload occurs only if the resolved generation model is remote.",
    settings: {
      prompt: "",
      providerPolicy: "auto",
      modelPolicy: "quality",
      modelId: null,
      aspectRatio: "1:1",
      outputCount: 3,
      outputFormat: "png",
      transparentBackground: true,
      qualityGateEnabled: true,
      referenceImages: [],
      modelAddons: [],
    },
    variables: [
      creativeBriefVariable("A premium reusable water bottle, centered three-quarter view"),
      {
        id: "surface",
        name: "Surface treatment",
        description: "Material and finish used to steer highlights and edge detail.",
        type: "choice",
        required: true,
        defaultValue: "Brushed metal",
        constraints: { options: ["Brushed metal", "Matte ceramic", "Clear glass", "Soft-touch polymer"] },
      },
      variantCountVariable(3),
    ],
    presets: [
      {
        id: "preset-catalog",
        name: "Catalog cutout",
        description: "Neutral catalog framing with a conservative candidate count.",
        values: {
          "creative-brief": "A premium reusable water bottle, centered three-quarter view",
          surface: "Brushed metal",
          "variant-count": 3,
        },
      },
    ],
    prompt: "{{creative-brief}}, {{surface}}, isolated product photography, clean silhouette and soft edge lighting",
    humanReview: {
      instructions: "Approve only cutouts with faithful material detail, a clean silhouette, and no visible alpha halo.",
      maxSelections: 2,
      requireComment: true,
    },
  }),
  createTemplate({
    id: "quality-gated-campaign",
    name: "Quality-gated campaign image",
    description: "Create one review-ready campaign image with explicit technical analysis and a conservative unknown-result policy.",
    category: "Quality",
    tags: ["campaign", "quality", "review"],
    workflowSummary: "Campaign brief → quality-biased generation → technical analysis → human-review gate → asset",
    privacySummary: "Technical checks are local. The selected generation policy determines whether prompt text leaves the device.",
    settings: {
      prompt: "",
      providerPolicy: "auto",
      modelPolicy: "quality",
      modelId: null,
      aspectRatio: "16:9",
      outputCount: 2,
      outputFormat: "png",
      transparentBackground: false,
      qualityGateEnabled: true,
      referenceImages: [],
      modelAddons: [],
    },
    variables: [
      creativeBriefVariable("A sustainable travel campaign hero image at golden hour"),
      {
        id: "tone",
        name: "Campaign tone",
        description: "The emotional direction applied consistently to the campaign brief.",
        type: "choice",
        required: true,
        defaultValue: "Aspirational",
        constraints: { options: ["Aspirational", "Documentary", "Energetic", "Serene"] },
      },
      variantCountVariable(2),
    ],
    presets: [
      {
        id: "preset-aspirational",
        name: "Aspirational launch",
        description: "Warm launch imagery with two candidates for human comparison.",
        values: {
          "creative-brief": "A sustainable travel campaign hero image at golden hour",
          tone: "Aspirational",
          "variant-count": 2,
        },
      },
    ],
    prompt: "{{creative-brief}}, {{tone}} campaign tone, authentic environmental detail",
    humanReview: {
      instructions: "Select the single campaign image that best satisfies the brief and technical quality report.",
      maxSelections: 1,
      requireComment: true,
    },
  }),
];

export const listBuiltInMediaFlowTemplates = (): readonly MediaFlowTemplateDescriptor[] =>
  createBuiltInTemplates().map(cloneJsonDocument);

export const instantiateMediaFlowTemplate = ({
  templateId,
  flowId,
  createdAt,
}: {
  templateId: string;
  flowId: string;
  createdAt: string;
}): InstantiateMediaFlowTemplateResult => {
  const template = createBuiltInTemplates().find((candidate) => candidate.id === templateId);
  if (!template) throw new Error(`Media flow template ${templateId} was not found.`);
  if (!flowId.trim()) throw new Error("Template forks require a stable flow id.");
  const flow = cloneJsonDocument(template.flow);
  flow.id = flowId.trim().slice(0, 256);
  flow.name = template.name;
  flow.createdAt = createdAt;
  flow.updatedAt = createdAt;
  const layout = cloneJsonDocument(template.layout);
  layout.flowId = flow.id;
  return { templateId, flow, layout };
};
