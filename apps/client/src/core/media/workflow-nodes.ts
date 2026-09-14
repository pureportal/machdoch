import type {
  MediaNodeDefinition,
  MediaNodeFieldDefinition,
  MediaNodePortDefinition,
} from "./node-registry.js";

const image: MediaNodePortDefinition = {
  id: "image",
  label: "Image",
  dataType: "image",
  required: true,
  cardinality: "single",
  description: "",
};
const prompt: MediaNodePortDefinition = {
  ...image,
  id: "prompt",
  label: "Prompt",
  dataType: "prompt",
};
export const workflowMaskPort: MediaNodePortDefinition = {
  ...image,
  id: "mask",
  label: "Mask",
  dataType: "mask",
  required: false,
};
const field = (
  id: string,
  label: string,
  kind: MediaNodeFieldDefinition["kind"],
  defaultValue: unknown,
  extra: Partial<MediaNodeFieldDefinition> = {},
): MediaNodeFieldDefinition => ({
  id,
  label,
  kind,
  defaultValue,
  description: "",
  group: "Basic",
  required: true,
  examples: [],
  ...extra,
});
const choices = (...values: [string, string][]) =>
  values.map(([value, label]) => ({ value, label, description: "" }));

export const WORKFLOW_NODE_DEFINITIONS: readonly MediaNodeDefinition[] = [
  {
    type: "operation.visual-check",
    version: 1,
    displayName: "Check image",
    summary: "",
    layer: "operation",
    category: "Quality",
    paletteVisibility: "advanced",
    inputs: [
      image,
      { ...image, id: "reference", label: "Reference image", required: false },
      { ...workflowMaskPort, label: "Edit mask" },
    ],
    outputs: [
      {
        ...image,
        id: "report",
        label: "Quality report",
        dataType: "quality-report",
      },
    ],
    privacyEffects: [],
    costEffects: [],
    fields: [
      field("criteria", "Visual criteria", "textarea", "", {
        allowEmpty: true,
        maxLength: 4000,
        description:
          "One criterion per line (up to eight); AI checks can miss defects.",
      }),
      field("modelPath", "Vision model folder", "directory", "", {
        allowEmpty: true,
        maxLength: 2048,
      }),
      field("reviewPasses", "Review passes", "number", 2, {
        required: false,
        min: 1,
        max: 3,
        integer: true,
      }),
      field("compareReference", "Compare reference visually", "boolean", true, {
        required: false,
      }),
      field("maxPixels", "Pixels per image", "number", 1048576, {
        group: "Expert",
        min: 65536,
        max: 2097152,
        integer: true,
      }),
      field("maxTokens", "Maximum tokens", "number", 768, {
        group: "Expert",
        min: 128,
        max: 2048,
        integer: true,
      }),
    ],
  },
  {
    type: "operation.prepare-mask",
    version: 1,
    displayName: "Prepare mask",
    summary: "",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "advanced",
    inputs: [
      image,
      workflowMaskPort,
      { ...image, id: "reference", label: "Mask reference", required: false },
    ],
    outputs: [{ ...image, required: false }, workflowMaskPort],
    privacyEffects: [],
    costEffects: [],
    fields: [
      field("editMask", "Paint selection", "mask", null, { required: false }),
      field("region", "Area", "select", "selection", {
        required: false,
        options: choices(
          ["selection", "Whole selection"],
          ["surroundings", "Outside selection"],
          ["boundary", "Selection boundary"],
        ),
      }),
      field("boundaryWidth", "Boundary radius (px)", "number", 8, {
        required: false,
        min: 1,
        max: 64,
        integer: true,
        visibleWhen: { fieldId: "region", equals: "boundary" },
      }),
      field("grow", "Grow / shrink (px)", "number", 0, {
        min: -64,
        max: 64,
        integer: true,
      }),
      field("feather", "Feather (px)", "number", 0, {
        min: 0,
        max: 32,
        integer: true,
      }),
    ],
  },
  {
    type: "task.generate-prompt",
    version: 1,
    displayName: "Generate prompt",
    summary: "",
    layer: "task",
    category: "Generation",
    paletteVisibility: "advanced",
    inputs: [prompt],
    outputs: [prompt],
    privacyEffects: [],
    costEffects: [],
    fields: [
      field(
        "instructions",
        "Instructions",
        "textarea",
        "Write a concise image prompt. Preserve the requested subject and changes. Return only the prompt.",
        { maxLength: 4000 },
      ),
      field("modelPath", "Text model folder", "directory", "", {
        allowEmpty: true,
        maxLength: 2048,
      }),
      field("maxTokens", "Maximum tokens", "number", 256, {
        group: "Expert",
        min: 32,
        max: 1024,
        integer: true,
      }),
    ],
  },
  {
    type: "operation.segment",
    version: 1,
    displayName: "Select objects · SAM3",
    summary: "",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "advanced",
    inputs: [image],
    outputs: [{ ...image, required: false }, workflowMaskPort],
    privacyEffects: [],
    costEffects: [],
    fields: [
      field("query", "Object", "text", "", {
        allowEmpty: true,
        maxLength: 256,
      }),
      field("selection", "Select", "select", "all", {
        options: choices(
          ["all", "All matches"],
          ["largest", "Largest match"],
          ["best", "Best match"],
        ),
      }),
      field("invert", "Select surrounding area", "boolean", false),
      field("modelPath", "SAM3 model folder", "directory", "", {
        allowEmpty: true,
        maxLength: 2048,
      }),
      field("threshold", "Confidence", "number", 0.5, {
        group: "Expert",
        min: 0.05,
        max: 0.95,
        step: 0.05,
      }),
      field("grow", "Grow / shrink (px)", "number", 0, {
        group: "Creative",
        min: -64,
        max: 64,
        integer: true,
      }),
      field("feather", "Feather (px)", "number", 0, {
        group: "Creative",
        min: 0,
        max: 32,
        integer: true,
      }),
    ],
  },
  {
    type: "operation.upscale",
    version: 1,
    displayName: "AI upscale",
    summary: "",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "advanced",
    inputs: [image],
    outputs: [image],
    privacyEffects: [],
    costEffects: [],
    fields: [
      field("modelPath", "Upscaler model", "file", "", {
        allowEmpty: true,
        maxLength: 2048,
        description:
          "Choose a Spandrel model, such as Real-ESRGAN, SwinIR, HAT, or SPAN.",
      }),
      field("scale", "Scale", "select", "2", {
        options: choices(["2", "2×"], ["4", "4×"]),
      }),
      field("tileSize", "Tile size", "number", 256, {
        group: "Expert",
        min: 64,
        max: 512,
        step: 64,
        integer: true,
      }),
    ],
  },
  {
    type: "control.repeat",
    version: 1,
    displayName: "Refinement loop",
    summary: "",
    layer: "control",
    category: "Control",
    paletteVisibility: "advanced",
    maxInstances: 1,
    inputs: [],
    outputs: [],
    privacyEffects: [],
    costEffects: [],
    fields: [
      field("startNodeId", "Repeat from", "node", "", {
        allowEmpty: true,
        maxLength: 128,
      }),
      field("maxIterations", "Maximum attempts", "number", 3, {
        min: 1,
        max: 20,
        integer: true,
      }),
      field("seedStep", "Seed increment", "number", 1, {
        group: "Expert",
        min: 1,
        max: 1000000,
        integer: true,
      }),
      field("feedback", "Refine the next prompt", "boolean", true),
      field("stopOnRepeatedImage", "Stop on repeated image", "boolean", true, {
        required: false,
      }),
      field("inputMode", "Next attempt", "select", "original", {
        required: false,
        options: choices(
          ["original", "Retry original input"],
          ["previous", "Refine previous edit"],
        ),
      }),
    ],
  },
];

export const WORKFLOW_GATE_FIELDS: readonly MediaNodeFieldDefinition[] = [
  field("minWidth", "Minimum width", "number", 512, {
    min: 1,
    max: 16384,
    integer: true,
  }),
  field("minHeight", "Minimum height", "number", 512, {
    min: 1,
    max: 16384,
    integer: true,
  }),
  field("maxClipping", "Clipped pixels (fraction)", "number", 0.95, {
    group: "Expert",
    min: 0,
    max: 1,
    step: 0.05,
  }),
  field("onFailure", "When checks fail", "select", "stop", {
    options: choices(["stop", "Stop"], ["repeat", "Repeat loop"]),
  }),
];
