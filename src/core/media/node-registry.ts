import type {
  MediaFlow,
  MediaFlowNode,
  MediaNodeLayer,
  MediaNodeType,
  MediaPortDataType,
} from "./contracts.js";
import { resolveMediaFlowVariables } from "./variables.js";
import { DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY } from "./subject-cutout-policy.js";

export type MediaNodeInspectorGroup = "Basic" | "Creative" | "Expert";
export type MediaNodeFieldKind =
  | "text"
  | "textarea"
  | "asset"
  | "number"
  | "boolean"
  | "select"
  | "model"
  | "model-priority"
  | "addons";

export interface MediaNodeFieldOption {
  value: string;
  label: string;
  description: string;
}

export interface MediaNodeFieldVisibility {
  fieldId: string;
  equals: string | number | boolean | null;
}

export interface MediaNodeFieldDefinition {
  id: string;
  label: string;
  description: string;
  group: MediaNodeInspectorGroup;
  kind: MediaNodeFieldKind;
  required: boolean;
  defaultValue: unknown;
  examples: readonly unknown[];
  readOnly?: boolean;
  allowEmpty?: boolean;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  maxLength?: number;
  options?: readonly MediaNodeFieldOption[];
  visibleWhen?: MediaNodeFieldVisibility;
}

export interface MediaNodePortDefinition {
  id: string;
  label: string;
  dataType: MediaPortDataType;
  required: boolean;
  cardinality: "single" | "collection";
  maxConnections?: number;
  description: string;
}

export interface MediaNodeDefinition {
  type: MediaNodeType;
  version: 1;
  displayName: string;
  summary: string;
  layer: MediaNodeLayer;
  category: "Input" | "Generation" | "Transform" | "Quality" | "Control" | "Output";
  paletteVisibility: "default" | "advanced" | "output";
  maxInstances?: number;
  inputs: readonly MediaNodePortDefinition[];
  outputs: readonly MediaNodePortDefinition[];
  fields: readonly MediaNodeFieldDefinition[];
  privacyEffects: readonly string[];
  costEffects: readonly string[];
  migrationSources: readonly number[];
}

export interface MediaNodeValidationIssue {
  code:
    | "UNKNOWN_NODE_DEFINITION"
    | "UNSUPPORTED_NODE_VERSION"
    | "INVALID_NODE_LAYER"
    | "UNKNOWN_CONFIG_FIELD"
    | "MISSING_CONFIG_FIELD"
    | "INVALID_CONFIG_VALUE"
    | "DUPLICATE_NODE_ID"
    | "NODE_TYPE_CARDINALITY_EXCEEDED"
    | "DUPLICATE_EDGE_ID"
    | "UNKNOWN_EDGE_NODE"
    | "UNKNOWN_EDGE_PORT"
    | "PORT_TYPE_MISMATCH"
    | "INPUT_CARDINALITY_EXCEEDED"
    | "REQUIRED_INPUT_MISSING"
    | "REQUIRED_OUTPUT_MISSING"
    | "GRAPH_CYCLE";
  severity: "error";
  nodeId: string;
  fieldId: string | null;
  message: string;
}

const option = (
  value: string,
  label: string,
  description: string,
): MediaNodeFieldOption => ({ value, label, description });

const promptPort: MediaNodePortDefinition = {
  id: "prompt",
  label: "Prompt",
  dataType: "prompt",
  required: true,
  cardinality: "single",
  description: "Normalized creative intent passed to a semantic generation task.",
};

const imageInput: MediaNodePortDefinition = {
  id: "image",
  label: "Image",
  dataType: "image",
  required: true,
  cardinality: "single",
  description: "One immutable image asset with lineage and verified metadata.",
};

const imageReferenceInput: MediaNodePortDefinition = {
  ...imageInput,
  label: "References",
  cardinality: "collection",
  maxConnections: 8,
  description:
    "One to eight explicitly labeled immutable image references in stable flow order.",
};

const optionalImageReferenceInput: MediaNodePortDefinition = {
  ...imageReferenceInput,
  required: false,
  description:
    "Optional ordered visual guidance for multimodal generation models, with immutable lineage.",
};

const imageCollectionInput: MediaNodePortDefinition = {
  ...imageInput,
  label: "Images",
  cardinality: "collection",
  maxConnections: 8,
  description: "One to eight immutable images in stable flow order.",
};

const imageOutput: MediaNodePortDefinition = {
  ...imageInput,
  required: true,
  description: "One generated or transformed image with source-node lineage.",
};

const foregroundInput: MediaNodePortDefinition = {
  ...imageInput,
  id: "foreground",
  label: "Foreground",
  description: "Image placed over the background using its alpha channel.",
};

const backgroundInput: MediaNodePortDefinition = {
  ...imageInput,
  id: "background",
  label: "Background",
  description: "Image defining the final canvas dimensions and base pixels.",
};

export const MEDIA_NODE_DEFINITIONS = [
  {
    type: "source.prompt",
    version: 1,
    displayName: "Creative brief",
    summary: "Captures provider-neutral creative intent without runtime prompt plumbing.",
    layer: "source",
    category: "Input",
    paletteVisibility: "default",
    maxInstances: 1,
    inputs: [],
    outputs: [promptPort],
    fields: [
      {
        id: "prompt",
        label: "Prompt",
        description: "Describe subject, environment, light, material, camera, and exclusions.",
        group: "Basic",
        kind: "textarea",
        required: true,
        defaultValue: "",
        examples: [
          "Editorial product photograph of a ceramic lamp in soft window light",
        ],
        allowEmpty: true,
        maxLength: 8_000,
      },
    ],
    privacyEffects: ["Prompt text follows the selected generation provider's data boundary."],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "source.image",
    version: 1,
    displayName: "Image asset",
    summary: "References one immutable Media Studio image without copying provider URLs or bytes into the flow.",
    layer: "source",
    category: "Input",
    paletteVisibility: "default",
    maxInstances: 8,
    inputs: [],
    outputs: [imageOutput],
    fields: [
      {
        id: "assetId",
        label: "Source asset",
        description: "A stable Media Studio asset id resolved through the privileged runtime boundary.",
        group: "Basic",
        kind: "asset",
        required: true,
        defaultValue: "",
        examples: ["asset:approved-product-shot"],
        allowEmpty: true,
        maxLength: 256,
      },
      {
        id: "referenceRole",
        label: "Reference role",
        description: "Explains how downstream edit tasks should use this image.",
        group: "Creative",
        kind: "select",
        required: false,
        defaultValue: "base",
        examples: ["base", "style"],
        options: [
          option("base", "Base image", "Primary pixels and composition to edit."),
          option("subject", "Subject identity", "Preserve the referenced subject or product."),
          option("style", "Visual style", "Borrow visual treatment without replacing identity."),
          option("composition", "Composition", "Follow framing, pose, or spatial arrangement."),
          option("palette", "Color palette", "Use the reference primarily for color direction."),
          option("detail", "Detail", "Use the reference for material or localized detail."),
        ],
      },
      {
        id: "influence",
        label: "Reference influence",
        description: "Provider-neutral relative influence; adapters clamp or disclose unsupported mapping.",
        group: "Creative",
        kind: "number",
        required: false,
        defaultValue: 1,
        examples: [0.5, 1],
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
    privacyEffects: [
      "The source remains local unless a downstream task explicitly resolves a remote provider.",
    ],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "task.generate-image",
    version: 1,
    displayName: "Generate image",
    summary: "Resolves a semantic image request into a compatible local or remote runtime plan.",
    layer: "task",
    category: "Generation",
    paletteVisibility: "default",
    maxInstances: 1,
    inputs: [promptPort, optionalImageReferenceInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "providerPolicy",
        label: "Execution boundary",
        description: "Auto chooses a ready compatible model; Local prevents remote prompt upload.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "auto",
        examples: ["auto", "local"],
        options: [
          option("auto", "Automatic", "Choose the best ready compatible runtime."),
          option("local", "Local only", "Keep generation on this device."),
          option("remote", "Remote only", "Use a configured cloud provider."),
        ],
      },
      {
        id: "aspectRatio",
        label: "Aspect ratio",
        description: "Output composition requested from the selected model.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "1:1",
        examples: ["1:1", "16:9"],
        options: [
          option("1:1", "1:1 Square", "Balanced square composition."),
          option("4:5", "4:5 Portrait", "Portrait-oriented social and product framing."),
          option("16:9", "16:9 Landscape", "Wide cinematic composition."),
          option("9:16", "9:16 Vertical", "Full-height mobile composition."),
        ],
      },
      {
        id: "outputCount",
        label: "Variants",
        description: "Explicit bounded cardinality. Remote providers may bill per output.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1,
        examples: [1, 4],
        min: 1,
        max: 8,
        step: 1,
        integer: true,
      },
      {
        id: "outputFormat",
        label: "Output format",
        description: "The requested immutable asset encoding.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "png",
        examples: ["png", "webp"],
        options: [
          option("png", "PNG", "Lossless output with alpha support."),
          option("webp", "WebP", "Efficient lossless or photographic output."),
          option("jpeg", "JPEG", "Photographic output without alpha."),
          option("svg", "SVG", "Editable vector source with a deterministic raster preview."),
        ],
      },
      {
        id: "svgMode",
        label: "SVG workflow",
        description: "Generate from a brief or faithfully vectorize one source asset.",
        group: "Basic",
        kind: "select",
        required: false,
        defaultValue: "generate",
        examples: ["generate", "vectorize"],
        options: [
          option("generate", "Create from prompt", "Generate new editable vector artwork."),
          option("vectorize", "Vectorize image", "Convert one reference into editable paths."),
        ],
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "svgAutoCrop",
        label: "Auto-crop vectorization",
        description: "Ask supported vectorization providers to isolate the dominant subject.",
        group: "Creative",
        kind: "boolean",
        required: false,
        defaultValue: true,
        examples: [true],
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "svgTargetSize",
        label: "Vectorization target",
        description: "Provider-side square analysis resolution for image-to-SVG conversion.",
        group: "Expert",
        kind: "number",
        required: false,
        defaultValue: 1024,
        examples: [1024, 2048],
        min: 128,
        max: 4096,
        step: 128,
        integer: true,
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "svgStyle",
        label: "Vector design lane",
        description: "Chooses the structural brief used by native SVG generators and critics.",
        group: "Creative",
        kind: "select",
        required: false,
        defaultValue: "illustration",
        examples: ["illustration", "diagram"],
        options: [
          option("illustration", "Illustration", "Layered creative vector artwork."),
          option("icon", "Icon", "Compact, low-complexity symbolic artwork."),
          option("logo", "Logo", "Clean brand-mark geometry."),
          option("diagram", "Diagram", "Structured explanatory layout."),
          option("technical", "Technical figure", "Precise scientific or engineering figure."),
        ],
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "svgTextPolicy",
        label: "Vector text",
        description: "Controls whether generated lettering is avoided, editable, or converted to paths.",
        group: "Creative",
        kind: "select",
        required: false,
        defaultValue: "avoid",
        examples: ["avoid", "editable"],
        options: [
          option("avoid", "Avoid", "Avoid text unless explicitly required by the brief."),
          option("editable", "Editable", "Keep necessary text as SVG text."),
          option("outlines", "Outlines", "Represent necessary lettering as vector paths."),
        ],
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "svgCandidateCount",
        label: "SVG candidates",
        description: "Generate a wider candidate pool for local render verification and ranking.",
        group: "Expert",
        kind: "number",
        required: false,
        defaultValue: 6,
        examples: [6, 16],
        min: 1,
        max: 16,
        step: 1,
        integer: true,
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "svgCriticEnabled",
        label: "OpenAI render-feedback repair",
        description: "Optionally send weak candidates and deterministic previews to OpenAI in separately billed, durably audited repair requests; keep only validated improvements.",
        group: "Expert",
        kind: "boolean",
        required: false,
        defaultValue: false,
        examples: [true],
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "transparentBackground",
        label: "Transparent canvas",
        description: "Leaves the SVG canvas transparent instead of requesting a backdrop.",
        group: "Creative",
        kind: "boolean",
        required: false,
        defaultValue: false,
        examples: [true],
        visibleWhen: { fieldId: "outputFormat", equals: "svg" },
      },
      {
        id: "modelPolicy",
        label: "Optimization goal",
        description: "Balances model quality and latency without pinning provider internals.",
        group: "Creative",
        kind: "select",
        required: true,
        defaultValue: "balanced",
        examples: ["balanced", "quality"],
        options: [
          option("balanced", "Balanced", "Balance quality and responsiveness."),
          option("fast", "Faster", "Prefer lower latency where compatible."),
          option("quality", "Higher quality", "Prefer quality over latency."),
        ],
      },
      {
        id: "modelId",
        label: "Exact model pin",
        description: "Expert override. Automatic selection remains reproducible in the compiled plan.",
        group: "Expert",
        kind: "model",
        required: true,
        defaultValue: null,
        examples: [null],
      },
      {
        id: "modelAddons",
        label: "LoRAs and embeddings",
        description: "Managed in Generate. Stored here so model add-ons remain part of the reproducible flow.",
        group: "Expert",
        kind: "addons",
        required: false,
        defaultValue: [],
        examples: [[]],
        readOnly: true,
      },
    ],
    privacyEffects: [
      "Remote execution uploads prompt text to the resolved provider.",
      "Local-only execution performs no provider request.",
    ],
    costEffects: ["Remote generation can create one billable request per output variant."],
    migrationSources: [],
  },
  {
    type: "task.edit-image",
    version: 1,
    displayName: "Edit image",
    summary: "Applies provider-neutral text-guided changes to one or more labeled immutable references.",
    layer: "task",
    category: "Generation",
    paletteVisibility: "default",
    maxInstances: 1,
    inputs: [promptPort, imageReferenceInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "providerPolicy",
        label: "Execution boundary",
        description: "Auto chooses a ready compatible model; Local prevents source-image upload.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "auto",
        examples: ["auto", "local"],
        options: [
          option("auto", "Automatic", "Choose the best ready compatible runtime."),
          option("local", "Local only", "Keep prompt and source pixels on this device."),
          option("remote", "Remote only", "Upload the disclosed source to a configured provider."),
        ],
      },
      {
        id: "aspectRatio",
        label: "Aspect ratio",
        description: "Output composition requested from the selected edit model.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "1:1",
        examples: ["1:1", "16:9"],
        options: [
          option("1:1", "1:1 Square", "Balanced square composition."),
          option("4:5", "4:5 Portrait", "Portrait-oriented social and product framing."),
          option("16:9", "16:9 Landscape", "Wide cinematic composition."),
          option("9:16", "9:16 Vertical", "Full-height mobile composition."),
        ],
      },
      {
        id: "outputCount",
        label: "Variants",
        description: "Explicit bounded edit cardinality. Remote providers may bill per output.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1,
        examples: [1, 4],
        min: 1,
        max: 8,
        step: 1,
        integer: true,
      },
      {
        id: "outputFormat",
        label: "Output format",
        description: "The requested immutable encoding for edited outputs.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "png",
        examples: ["png", "webp"],
        options: [
          option("png", "PNG", "Lossless output with alpha support."),
          option("webp", "WebP", "Efficient lossless or photographic output."),
          option("jpeg", "JPEG", "Photographic output without alpha."),
        ],
      },
      {
        id: "editStrength",
        label: "Edit strength",
        description: "Provider-neutral intent strength; adapters map it only when their contract supports an equivalent control.",
        group: "Creative",
        kind: "number",
        required: true,
        defaultValue: 0.65,
        examples: [0.35, 0.65],
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        id: "modelPolicy",
        label: "Optimization goal",
        description: "Balances edit quality and latency without exposing runtime plumbing.",
        group: "Creative",
        kind: "select",
        required: true,
        defaultValue: "balanced",
        examples: ["balanced", "quality"],
        options: [
          option("balanced", "Balanced", "Balance quality and responsiveness."),
          option("fast", "Faster", "Prefer lower latency where compatible."),
          option("quality", "Higher quality", "Prefer edit fidelity over latency."),
        ],
      },
      {
        id: "modelId",
        label: "Exact model pin",
        description: "Expert override. Automatic selection remains reproducible in the compiled plan.",
        group: "Expert",
        kind: "model",
        required: true,
        defaultValue: null,
        examples: [null],
      },
      {
        id: "modelAddons",
        label: "LoRAs and embeddings",
        description: "Managed in Generate. Stored here so model add-ons remain part of the reproducible flow.",
        group: "Expert",
        kind: "addons",
        required: false,
        defaultValue: [],
        examples: [[]],
        readOnly: true,
      },
    ],
    privacyEffects: [
      "Remote execution uploads prompt text and only the explicitly connected reference assets.",
      "Local-only execution performs no provider request.",
    ],
    costEffects: ["Remote editing can create one billable request per output variant."],
    migrationSources: [],
  },
  {
    type: "operation.crop",
    version: 1,
    displayName: "Crop image",
    summary: "Publishes a bounded rectangular derivative without mutating the source image.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "default",
    inputs: [imageInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "x",
        label: "X",
        description: "Left edge in source pixels.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 0,
        examples: [0, 128],
        min: 0,
        max: 1_000_000,
        step: 1,
        integer: true,
      },
      {
        id: "y",
        label: "Y",
        description: "Top edge in source pixels.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 0,
        examples: [0, 128],
        min: 0,
        max: 1_000_000,
        step: 1,
        integer: true,
      },
      {
        id: "width",
        label: "Width",
        description: "Output width in pixels; runtime validation keeps the rectangle inside the source.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1024,
        examples: [512, 1024],
        min: 1,
        max: 32_768,
        step: 1,
        integer: true,
      },
      {
        id: "height",
        label: "Height",
        description: "Output height in pixels; runtime validation keeps the rectangle inside the source.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1024,
        examples: [512, 1024],
        min: 1,
        max: 32_768,
        step: 1,
        integer: true,
      },
    ],
    privacyEffects: ["Cropping executes locally against an immutable source asset."],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.resize",
    version: 1,
    displayName: "Resize image",
    summary: "Creates a dimension-constrained derivative with an explicit fit policy.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "default",
    inputs: [imageInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "width",
        label: "Width",
        description: "Target box width in pixels.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1024,
        examples: [512, 1920],
        min: 1,
        max: 32_768,
        step: 1,
        integer: true,
      },
      {
        id: "height",
        label: "Height",
        description: "Target box height in pixels.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1024,
        examples: [512, 1080],
        min: 1,
        max: 32_768,
        step: 1,
        integer: true,
      },
      {
        id: "fit",
        label: "Fit mode",
        description: "Controls whether pixels are preserved, cropped to fill, or stretched.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "contain",
        examples: ["contain", "cover"],
        options: [
          option("contain", "Contain", "Preserve every source pixel inside the target box."),
          option("cover", "Cover", "Crop edges as needed to fill the target box."),
          option("stretch", "Stretch", "Scale directly to the exact target dimensions."),
        ],
      },
    ],
    privacyEffects: ["Resizing executes locally against an immutable source asset."],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.format-convert",
    version: 1,
    displayName: "Convert image format",
    summary: "Re-encodes an image into an explicit output format and preserves lineage.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "default",
    inputs: [imageInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "outputFormat",
        label: "Output format",
        description: "The immutable encoding published by this operation.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "png",
        examples: ["png", "webp"],
        options: [
          option("png", "PNG", "Lossless output with alpha support."),
          option("webp", "WebP", "Efficient lossless or photographic output."),
          option("jpeg", "JPEG", "Photographic output without alpha."),
        ],
      },
      {
        id: "quality",
        label: "Lossy quality",
        description: "Used for JPEG and lossy WebP adapters; ignored by lossless encoders.",
        group: "Creative",
        kind: "number",
        required: true,
        defaultValue: 90,
        examples: [85, 95],
        min: 1,
        max: 100,
        step: 1,
        integer: true,
      },
      {
        id: "jpegBackground",
        label: "JPEG alpha background",
        description: "Explicit color used when flattening transparent pixels into JPEG.",
        group: "Creative",
        kind: "text",
        required: false,
        defaultValue: "#ffffff",
        examples: ["#ffffff", "#111827"],
        maxLength: 7,
        visibleWhen: { fieldId: "outputFormat", equals: "jpeg" },
      },
    ],
    privacyEffects: ["Format conversion executes locally and strips unsupported container metadata."],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.metadata-strip",
    version: 1,
    displayName: "Strip image metadata",
    summary: "Re-encodes image pixels without private container metadata while preserving explicit color policy.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "default",
    inputs: [imageInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "preserveColorProfile",
        label: "Preserve color profile",
        description: "Retain a validated embedded color profile when the output format supports it.",
        group: "Basic",
        kind: "boolean",
        required: true,
        defaultValue: true,
        examples: [true],
      },
      {
        id: "applyOrientation",
        label: "Apply orientation",
        description: "Bake validated EXIF orientation into pixels before removing metadata.",
        group: "Basic",
        kind: "boolean",
        required: true,
        defaultValue: true,
        examples: [true],
      },
    ],
    privacyEffects: [
      "Metadata stripping executes locally and removes EXIF, XMP, and IPTC payloads.",
    ],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.auto-tag",
    version: 1,
    displayName: "Auto tag",
    summary: "Adds deterministic format, shape, resolution, and asset-role tags.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "advanced",
    inputs: [imageInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "profile",
        label: "Tag profile",
        description: "Pinned deterministic vocabulary; this profile does not infer semantic content.",
        group: "Expert",
        kind: "select",
        required: true,
        defaultValue: "technical-metadata-v1",
        examples: ["technical-metadata-v1"],
        options: [
          option(
            "technical-metadata-v1",
            "Technical metadata v1",
            "Tag format, aspect shape, resolution class, and known asset role without an AI model.",
          ),
        ],
      },
    ],
    privacyEffects: [
      "The pinned technical metadata profile executes locally and does not inspect semantic image content.",
    ],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.contact-sheet",
    version: 1,
    displayName: "Create contact sheet",
    summary: "Composes a bounded image collection into one deterministic comparison sheet.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "default",
    inputs: [imageCollectionInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "columns",
        label: "Columns",
        description: "Maximum number of cells per row.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 3,
        examples: [2, 4],
        min: 1,
        max: 8,
        step: 1,
        integer: true,
      },
      {
        id: "cellWidth",
        label: "Cell width",
        description: "Width of each fitted image cell in pixels.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 512,
        examples: [256, 512],
        min: 32,
        max: 4096,
        step: 1,
        integer: true,
      },
      {
        id: "cellHeight",
        label: "Cell height",
        description: "Height of each fitted image cell in pixels.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 512,
        examples: [256, 512],
        min: 32,
        max: 4096,
        step: 1,
        integer: true,
      },
      {
        id: "gap",
        label: "Cell gap",
        description: "Spacing between cells in pixels.",
        group: "Creative",
        kind: "number",
        required: true,
        defaultValue: 16,
        examples: [0, 24],
        min: 0,
        max: 256,
        step: 1,
        integer: true,
      },
      {
        id: "background",
        label: "Background",
        description: "Six-digit color used for the canvas and letterboxing.",
        group: "Creative",
        kind: "text",
        required: true,
        defaultValue: "#0f172a",
        examples: ["#0f172a", "#ffffff"],
        maxLength: 7,
      },
      {
        id: "labelMode",
        label: "Labels",
        description: "Optional deterministic index labels for comparison review.",
        group: "Creative",
        kind: "select",
        required: true,
        defaultValue: "index",
        examples: ["index", "none"],
        options: [
          option("index", "Index", "Label cells with their stable one-based order."),
          option("none", "None", "Render images without labels."),
        ],
      },
    ],
    privacyEffects: ["Contact sheet composition executes locally."],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.subject-cutout",
    version: 1,
    displayName: "Cut out subject",
    summary: "Creates a soft subject matte with an ordered local model fallback policy.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "default",
    inputs: [imageInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "modelPriority",
        label: "Model priority and fallback",
        description:
          "Runs the first model in this ordered list and tries each later model if an earlier one is unavailable or fails.",
        group: "Basic",
        kind: "model-priority",
        required: false,
        defaultValue: [...DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY],
        examples: [
          [...DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY],
          ["local:border-matte-v1", "local:birefnet-matting"],
        ],
      },
      {
        id: "outputMatte",
        label: "Publish alpha matte",
        description: "Keep the matte as an explicit lineage asset for downstream corrections.",
        group: "Expert",
        kind: "boolean",
        required: true,
        defaultValue: true,
        examples: [true, false],
      },
    ],
    privacyEffects: [
      "Every supported subject-cutout model executes locally; image pixels are not sent to a provider.",
      "Installable models are used only after their reviewed package is available.",
    ],
    costEffects: [
      "The bundled border matte has no download; the managed BiRefNet package is approximately 0.91 GB.",
    ],
    migrationSources: [],
  },
  {
    type: "operation.alpha-matte",
    version: 1,
    displayName: "Extract alpha matte",
    summary: "Publishes the image alpha channel as an exact grayscale matte.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "advanced",
    inputs: [imageInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "invert",
        label: "Invert matte",
        description: "Swap protected and transparent areas after extracting the alpha channel.",
        group: "Creative",
        kind: "boolean",
        required: true,
        defaultValue: false,
        examples: [false, true],
      },
    ],
    privacyEffects: [
      "Alpha extraction executes locally with a bounded pixel loop and no network request.",
      "The exact 8-bit channel is preserved only in lossless PNG or WebP output.",
    ],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.composite",
    version: 1,
    displayName: "Composite images",
    summary: "Centers an alpha-aware foreground over a background canvas.",
    layer: "operation",
    category: "Transform",
    paletteVisibility: "default",
    inputs: [foregroundInput, backgroundInput],
    outputs: [imageOutput],
    fields: [
      {
        id: "fit",
        label: "Foreground fit",
        description: "How the foreground is scaled into the background canvas before blending.",
        group: "Creative",
        kind: "select",
        required: true,
        defaultValue: "contain",
        examples: ["contain", "cover", "stretch"],
        options: [
          option("contain", "Contain", "Preserve the entire foreground and center it."),
          option("cover", "Cover", "Fill the canvas and crop overflow from the center."),
          option("stretch", "Stretch", "Resize the foreground to the exact canvas dimensions."),
        ],
      },
      {
        id: "opacityPercent",
        label: "Foreground opacity",
        description: "Scales the foreground alpha channel before source-over blending.",
        group: "Creative",
        kind: "number",
        required: true,
        defaultValue: 100,
        examples: [100, 75],
        min: 0,
        max: 100,
        step: 1,
        integer: true,
      },
    ],
    privacyEffects: [
      "Both immutable inputs are decoded and composited locally with bounded allocations.",
    ],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "operation.quality-analyze",
    version: 1,
    displayName: "Analyze quality",
    summary: "Measures explicit quality observations without silently changing image pixels.",
    layer: "operation",
    category: "Quality",
    paletteVisibility: "advanced",
    inputs: [imageInput],
    outputs: [
      {
        id: "report",
        label: "Quality report",
        dataType: "report",
        required: true,
        cardinality: "single",
        description: "Versioned observations, thresholds, and evidence for downstream gates.",
      },
    ],
    fields: [
      {
        id: "profile",
        label: "Quality profile",
        description: "Versioned rubric used for deterministic image checks.",
        group: "Expert",
        kind: "text",
        required: true,
        defaultValue: "quality.standard.v1",
        examples: ["quality.standard.v1"],
        maxLength: 128,
      },
    ],
    privacyEffects: ["The current technical quality profile executes locally."],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "control.quality-gate",
    version: 1,
    displayName: "Quality gate",
    summary: "Routes an image through an explicit tri-state quality decision.",
    layer: "control",
    category: "Control",
    paletteVisibility: "advanced",
    inputs: [
      imageInput,
      {
        id: "report",
        label: "Quality report",
        dataType: "report",
        required: true,
        cardinality: "single",
        description: "Observations evaluated by the pinned quality profile.",
      },
    ],
    outputs: [imageOutput],
    fields: [
      {
        id: "onUnknown",
        label: "Unknown result",
        description: "Choose an explicit policy when evidence cannot produce pass or fail.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "human-review",
        examples: ["human-review", "fail"],
        options: [
          option("human-review", "Require human review", "Pause before publication."),
          option("fail", "Treat as failed", "Block publication conservatively."),
          option("pass", "Treat as passed", "Continue despite incomplete evidence."),
        ],
      },
      {
        id: "profile",
        label: "Quality profile",
        description: "Must match the report semantics consumed by this gate.",
        group: "Expert",
        kind: "text",
        required: true,
        defaultValue: "quality.standard.v1",
        examples: ["quality.standard.v1"],
        maxLength: 128,
      },
    ],
    privacyEffects: [],
    costEffects: [],
    migrationSources: [],
  },
  {
    type: "control.human-review",
    version: 1,
    displayName: "Human review",
    summary: "Pauses the run for an explicit bounded candidate selection before publication.",
    layer: "control",
    category: "Control",
    paletteVisibility: "advanced",
    inputs: [
      {
        ...imageInput,
        label: "Candidates",
        description: "The bounded candidate stream presented to the reviewer.",
      },
    ],
    outputs: [
      {
        ...imageOutput,
        label: "Approved images",
        description: "At most the configured number of explicitly approved images.",
      },
    ],
    fields: [
      {
        id: "instructions",
        label: "Review instructions",
        description: "A concrete rubric shown with the candidates; this does not invoke an AI evaluator.",
        group: "Basic",
        kind: "textarea",
        required: true,
        defaultValue: "Select the strongest candidate and reject outputs with visible technical defects.",
        examples: ["Approve only candidates with a clean silhouette and faithful material detail."],
        maxLength: 1_000,
      },
      {
        id: "maxSelections",
        label: "Maximum approvals",
        description: "A hard upper bound on assets that may continue beyond this review gate.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1,
        examples: [1, 3],
        min: 1,
        max: 8,
        step: 1,
        integer: true,
      },
      {
        id: "requireComment",
        label: "Require review note",
        description: "Require the reviewer to record a note with the approval or rejection decision.",
        group: "Expert",
        kind: "boolean",
        required: true,
        defaultValue: false,
        examples: [false, true],
      },
    ],
    privacyEffects: ["Review decisions and notes remain in the local run event history."],
    costEffects: ["Waiting releases worker and GPU leases; immutable input assets remain pinned."],
    migrationSources: [],
  },
  {
    type: "output.asset",
    version: 1,
    displayName: "Save assets",
    summary: "Validates, hashes, and publishes immutable output assets with lineage.",
    layer: "output",
    category: "Output",
    paletteVisibility: "output",
    maxInstances: 1,
    inputs: [imageInput],
    outputs: [],
    fields: [
      {
        id: "format",
        label: "Output format",
        description: "Synchronized from the generation task for this compound recipe.",
        group: "Basic",
        kind: "select",
        required: true,
        defaultValue: "png",
        examples: ["png", "webp"],
        readOnly: true,
        options: [
          option("png", "PNG", "Lossless output with alpha support."),
          option("webp", "WebP", "Efficient lossless or photographic output."),
          option("jpeg", "JPEG", "Photographic output without alpha."),
          option("svg", "SVG", "Editable Secure Static vector output."),
        ],
      },
      {
        id: "outputCount",
        label: "Expected assets",
        description: "Synchronized from generation cardinality.",
        group: "Basic",
        kind: "number",
        required: true,
        defaultValue: 1,
        examples: [1, 4],
        readOnly: true,
        min: 1,
        max: 8,
        step: 1,
        integer: true,
      },
    ],
    privacyEffects: ["Asset publication writes to the managed local content-addressed store."],
    costEffects: [],
    migrationSources: [],
  },
] as const satisfies readonly MediaNodeDefinition[];

const definitionsByType = new Map<MediaNodeType, MediaNodeDefinition>(
  MEDIA_NODE_DEFINITIONS.map((definition) => [definition.type, definition]),
);

export const listMediaNodeDefinitions = (): readonly MediaNodeDefinition[] =>
  MEDIA_NODE_DEFINITIONS;

export const getMediaNodeDefinition = (
  type: MediaNodeType,
): MediaNodeDefinition | null => definitionsByType.get(type) ?? null;

const isFieldVisible = (
  field: MediaNodeFieldDefinition,
  config: Record<string, unknown>,
): boolean =>
  !field.visibleWhen ||
  config[field.visibleWhen.fieldId] === field.visibleWhen.equals;

export const listVisibleMediaNodeFields = (
  definition: MediaNodeDefinition,
  config: Record<string, unknown>,
  group: MediaNodeInspectorGroup,
): readonly MediaNodeFieldDefinition[] =>
  definition.fields.filter(
    (field) => field.group === group && isFieldVisible(field, config),
  );

const isModelAddonSelectionList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 24 &&
  value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const selection = entry as Record<string, unknown>;
    if (
      typeof selection.addonId !== "string" ||
      selection.addonId.length === 0 ||
      selection.addonId !== selection.addonId.trim() ||
      typeof selection.enabled !== "boolean"
    ) {
      return false;
    }
    if (selection.kind === "lora") {
      const schedule = selection.denoisingSchedule;
      return (
        typeof selection.modelStrength === "number" &&
        Number.isFinite(selection.modelStrength) &&
        selection.modelStrength >= -100 &&
        selection.modelStrength <= 100 &&
        (selection.textEncoderStrength === null ||
          (typeof selection.textEncoderStrength === "number" &&
            Number.isFinite(selection.textEncoderStrength) &&
            selection.textEncoderStrength >= -100 &&
            selection.textEncoderStrength <= 100)) &&
        (schedule === undefined ||
          schedule === null ||
          (typeof schedule === "object" &&
            !Array.isArray(schedule) &&
            typeof (schedule as Record<string, unknown>).start === "number" &&
            Number.isFinite((schedule as Record<string, unknown>).start) &&
            typeof (schedule as Record<string, unknown>).end === "number" &&
            Number.isFinite((schedule as Record<string, unknown>).end) &&
            ((schedule as Record<string, unknown>).start as number) >= 0 &&
            ((schedule as Record<string, unknown>).start as number) <
              ((schedule as Record<string, unknown>).end as number) &&
            ((schedule as Record<string, unknown>).end as number) <= 1))
      );
    }
    return (
      selection.kind === "textual-inversion" &&
      typeof selection.token === "string" &&
      selection.token.length > 0 &&
      selection.token === selection.token.trim() &&
      [...selection.token].length <= 128 &&
      ["positive", "negative", "both"].includes(String(selection.placement))
    );
  });

const validateFieldValue = (
  node: MediaFlowNode,
  field: MediaNodeFieldDefinition,
): MediaNodeValidationIssue | null => {
  const value = node.config[field.id];
  if (value === undefined) {
    return field.required
      ? {
          code: "MISSING_CONFIG_FIELD",
          severity: "error",
          nodeId: node.id,
          fieldId: field.id,
          message: `${field.label} is required.`,
        }
      : null;
  }
  let isValid = false;
  switch (field.kind) {
    case "text":
    case "textarea":
    case "asset":
      isValid =
        typeof value === "string" &&
        (field.allowEmpty === true || value.trim().length > 0) &&
        (field.kind === "textarea" || value === value.trim()) &&
        [...value].length <= (field.maxLength ?? Number.POSITIVE_INFINITY) &&
        ![...value].some(
          (character) =>
            !["\n", "\r", "\t"].includes(character) && /\p{Cc}/u.test(character),
        );
      break;
    case "number":
      isValid =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!field.integer || Number.isInteger(value)) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max);
      break;
    case "boolean":
      isValid = typeof value === "boolean";
      break;
    case "select":
      isValid =
        typeof value === "string" &&
        field.options?.some((candidate) => candidate.value === value) === true;
      break;
    case "model":
      isValid = value === null || (typeof value === "string" && value.trim().length > 0);
      break;
    case "model-priority":
      isValid =
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= 8 &&
        value.every(
          (modelId) =>
            typeof modelId === "string" &&
            modelId.length > 0 &&
            modelId === modelId.trim() &&
            modelId.length <= 128,
        ) &&
        new Set(value).size === value.length;
      break;
    case "addons":
      isValid = isModelAddonSelectionList(value);
      break;
  }
  return isValid
    ? null
    : {
        code: "INVALID_CONFIG_VALUE",
        severity: "error",
        nodeId: node.id,
        fieldId: field.id,
        message: `${field.label} does not satisfy the node's versioned constraints.`,
      };
};

export const validateMediaFlowNode = (
  node: MediaFlowNode,
): readonly MediaNodeValidationIssue[] => {
  const definition = getMediaNodeDefinition(node.type);
  if (!definition) {
    return [
      {
        code: "UNKNOWN_NODE_DEFINITION",
        severity: "error",
        nodeId: node.id,
        fieldId: null,
        message: `No node definition is installed for ${node.type}.`,
      },
    ];
  }
  const issues: MediaNodeValidationIssue[] = [];
  if (node.version !== definition.version) {
    issues.push({
      code: "UNSUPPORTED_NODE_VERSION",
      severity: "error",
      nodeId: node.id,
      fieldId: null,
      message: `${definition.displayName} version ${node.version} is not supported.`,
    });
  }
  if (node.layer !== definition.layer) {
    issues.push({
      code: "INVALID_NODE_LAYER",
      severity: "error",
      nodeId: node.id,
      fieldId: null,
      message: `${definition.displayName} must use the ${definition.layer} semantic layer.`,
    });
  }
  const knownFields = new Set(definition.fields.map((field) => field.id));
  for (const fieldId of Object.keys(node.config)) {
    if (!knownFields.has(fieldId)) {
      issues.push({
        code: "UNKNOWN_CONFIG_FIELD",
        severity: "error",
        nodeId: node.id,
        fieldId,
        message: `${definition.displayName} does not declare config field ${fieldId}.`,
      });
    }
  }
  for (const field of definition.fields) {
    const issue = validateFieldValue(node, field);
    if (issue) issues.push(issue);
  }
  if (
    node.type === "operation.format-convert" &&
    typeof node.config.jpegBackground === "string" &&
    !/^#[\da-f]{6}$/iu.test(node.config.jpegBackground)
  ) {
    issues.push({
      code: "INVALID_CONFIG_VALUE",
      severity: "error",
      nodeId: node.id,
      fieldId: "jpegBackground",
      message: "JPEG alpha background must be a six-digit hex color.",
    });
  }
  if (
    node.type === "operation.contact-sheet" &&
    typeof node.config.background === "string" &&
    !/^#[\da-f]{6}$/iu.test(node.config.background)
  ) {
    issues.push({
      code: "INVALID_CONFIG_VALUE",
      severity: "error",
      nodeId: node.id,
      fieldId: "background",
      message: "Contact sheet background must be a six-digit hex color.",
    });
  }
  return issues;
};

export const validateMediaFlowNodes = (
  flow: MediaFlow,
): readonly MediaNodeValidationIssue[] =>
  flow.nodes.flatMap((node) => validateMediaFlowNode(node));

export const validateMediaFlowGraph = (
  flow: MediaFlow,
): readonly MediaNodeValidationIssue[] => {
  const issues: MediaNodeValidationIssue[] = [];
  const nodesById = new Map<string, MediaFlowNode>();
  for (const node of flow.nodes) {
    if (nodesById.has(node.id)) {
      issues.push({
        code: "DUPLICATE_NODE_ID",
        severity: "error",
        nodeId: node.id,
        fieldId: null,
        message: `Node id ${node.id} is duplicated.`,
      });
    }
    nodesById.set(node.id, node);
  }
  for (const definition of listMediaNodeDefinitions()) {
    if (definition.maxInstances === undefined) continue;
    const matchingNodes = flow.nodes.filter((node) => node.type === definition.type);
    if (matchingNodes.length > definition.maxInstances) {
      issues.push({
        code: "NODE_TYPE_CARDINALITY_EXCEEDED",
        severity: "error",
        nodeId: matchingNodes[definition.maxInstances]?.id ?? matchingNodes[0]?.id ?? flow.id,
        fieldId: null,
        message: `${definition.displayName} allows at most ${definition.maxInstances} instance${definition.maxInstances === 1 ? "" : "s"} in this flow.`,
      });
    }
  }
  const incomingByPort = new Map<string, number>();
  const outgoingByPort = new Set<string>();
  const edgeIds = new Set<string>();

  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "DUPLICATE_EDGE_ID",
        severity: "error",
        nodeId: edge.toNodeId,
        fieldId: null,
        message: `Edge id ${edge.id} is duplicated.`,
      });
    }
    edgeIds.add(edge.id);

    const sourceNode = nodesById.get(edge.fromNodeId);
    const targetNode = nodesById.get(edge.toNodeId);
    if (!sourceNode || !targetNode) {
      issues.push({
        code: "UNKNOWN_EDGE_NODE",
        severity: "error",
        nodeId: targetNode?.id ?? sourceNode?.id ?? edge.toNodeId,
        fieldId: null,
        message: `Edge ${edge.id} references a node that is not present in this flow.`,
      });
      continue;
    }

    const sourcePort = getMediaNodeDefinition(sourceNode.type)?.outputs.find(
      (port) => port.id === edge.fromPortId,
    );
    const targetPort = getMediaNodeDefinition(targetNode.type)?.inputs.find(
      (port) => port.id === edge.toPortId,
    );
    if (!sourcePort || !targetPort) {
      issues.push({
        code: "UNKNOWN_EDGE_PORT",
        severity: "error",
        nodeId: !targetPort ? targetNode.id : sourceNode.id,
        fieldId: null,
        message: `Edge ${edge.id} references an undeclared ${!sourcePort ? "output" : "input"} port.`,
      });
      continue;
    }
    if (sourcePort.dataType !== targetPort.dataType) {
      issues.push({
        code: "PORT_TYPE_MISMATCH",
        severity: "error",
        nodeId: targetNode.id,
        fieldId: null,
        message: `Edge ${edge.id} cannot connect ${sourcePort.dataType} to ${targetPort.dataType}.`,
      });
    }
    const targetIsSvgVectorization =
      targetNode.type === "task.generate-image" &&
      targetNode.config.outputFormat === "svg" &&
      targetNode.config.svgMode === "vectorize";
    if (targetIsSvgVectorization && targetPort.id === "prompt") {
      issues.push({
        code: "INVALID_CONFIG_VALUE",
        severity: "error",
        nodeId: targetNode.id,
        fieldId: "svgMode",
        message: "SVG vectorization accepts one source image instead of a creative brief.",
      });
    }
    outgoingByPort.add(`${sourceNode.id}\u001f${sourcePort.id}`);

    const targetKey = `${targetNode.id}\u001f${targetPort.id}`;
    const incomingCount = (incomingByPort.get(targetKey) ?? 0) + 1;
    incomingByPort.set(targetKey, incomingCount);
    const maxConnections =
      targetIsSvgVectorization && targetPort.id === "image"
        ? 1
        : targetPort.maxConnections;
    if (
      (targetPort.cardinality === "single" && incomingCount > 1) ||
      (maxConnections !== undefined && incomingCount > maxConnections)
    ) {
      issues.push({
        code: "INPUT_CARDINALITY_EXCEEDED",
        severity: "error",
        nodeId: targetNode.id,
        fieldId: null,
        message:
          targetPort.cardinality === "single"
            ? `${targetPort.label} accepts exactly one incoming connection.`
            : `${targetPort.label} accepts at most ${maxConnections} incoming connections.`,
      });
    }
  }

  for (const node of flow.nodes) {
    const definition = getMediaNodeDefinition(node.type);
    const isSvgVectorization =
      node.type === "task.generate-image" &&
      node.config.outputFormat === "svg" &&
      node.config.svgMode === "vectorize";
    for (const port of definition?.inputs ?? []) {
      const required = isSvgVectorization
        ? port.id === "image"
        : port.required;
      if (required && !incomingByPort.has(`${node.id}\u001f${port.id}`)) {
        issues.push({
          code: "REQUIRED_INPUT_MISSING",
          severity: "error",
          nodeId: node.id,
          fieldId: null,
          message: `${definition?.displayName ?? node.label} requires a ${port.label} input.`,
        });
      }
    }
    for (const port of definition?.outputs ?? []) {
      if (port.required && !outgoingByPort.has(`${node.id}\u001f${port.id}`)) {
        issues.push({
          code: "REQUIRED_OUTPUT_MISSING",
          severity: "error",
          nodeId: node.id,
          fieldId: null,
          message: `${definition?.displayName ?? node.label} requires its ${port.label} output to be connected.`,
        });
      }
    }
  }

  const indegree = new Map(flow.nodes.map((node) => [node.id, 0]));
  const targetsBySource = new Map<string, string[]>();
  for (const edge of flow.edges) {
    if (!nodesById.has(edge.fromNodeId) || !nodesById.has(edge.toNodeId)) continue;
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
    targetsBySource.set(edge.fromNodeId, [
      ...(targetsBySource.get(edge.fromNodeId) ?? []),
      edge.toNodeId,
    ]);
  }
  const ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId);
  let visited = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift();
    if (!nodeId) continue;
    visited += 1;
    for (const targetId of targetsBySource.get(nodeId) ?? []) {
      const nextIndegree = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, nextIndegree);
      if (nextIndegree === 0) ready.push(targetId);
    }
  }
  if (visited !== flow.nodes.length) {
    const cycleNodeId = [...indegree].find(([, count]) => count > 0)?.[0] ?? flow.id;
    issues.push({
      code: "GRAPH_CYCLE",
      severity: "error",
      nodeId: cycleNodeId,
      fieldId: null,
      message: "Media flows must be acyclic before they can be compiled.",
    });
  }

  return issues;
};

export const validateMediaFlowDocument = (
  flow: MediaFlow,
): readonly MediaNodeValidationIssue[] => [
  ...validateMediaFlowNodes(resolveMediaFlowVariables(flow).flow),
  ...validateMediaFlowGraph(flow),
];

export interface MediaFlowConnectionRequest {
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
}

export interface MediaFlowConnectionCheck {
  valid: boolean;
  reason: string | null;
}

export interface AddMediaFlowNodeResult {
  flow: MediaFlow;
  nodeId: string;
}

export interface MediaFlowClipboardNode {
  sourceNodeId: string;
  nodeType: MediaNodeType;
  nodeVersion: 1;
  label: string;
  config: Record<string, unknown>;
}

export interface MediaFlowNodeClipboardPayload {
  schemaVersion: 1;
  label: string;
  nodes: readonly MediaFlowClipboardNode[];
  connections: readonly MediaFlowConnectionRequest[];
}

export interface PasteMediaFlowNodesResult {
  flow: MediaFlow;
  nodeIds: readonly string[];
  idMap: Readonly<Record<string, string>>;
}

const cloneConfigValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)]),
    );
  }
  return value;
};

const createUniqueId = (base: string, existingIds: ReadonlySet<string>): string => {
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

const normalizeNodeIdBase = (type: MediaNodeType): string =>
  type
    .replace(/^(?:source|task|operation|control|output)\./u, "")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 72) || "media-node";

export const addMediaFlowNode = ({
  flow,
  type,
  updatedAt,
}: {
  flow: MediaFlow;
  type: MediaNodeType;
  updatedAt: string;
}): AddMediaFlowNodeResult => {
  const definition = getMediaNodeDefinition(type);
  if (!definition) {
    throw new Error(`Media node definition ${type} is not installed.`);
  }
  const existingCount = flow.nodes.filter((node) => node.type === type).length;
  if (
    definition.maxInstances !== undefined &&
    existingCount >= definition.maxInstances
  ) {
    throw new Error(`${definition.displayName} is already present in this flow.`);
  }

  const nodeId = createUniqueId(
    normalizeNodeIdBase(type),
    new Set(flow.nodes.map((node) => node.id)),
  );
  const config = Object.fromEntries(
    definition.fields.map((field) => [
      field.id,
      cloneConfigValue(field.defaultValue),
    ]),
  );
  const imageTaskNode = flow.nodes.find(
    (node) =>
      node.type === "task.generate-image" || node.type === "task.edit-image",
  );
  if (type === "output.asset" && imageTaskNode) {
    config.format = imageTaskNode.config.outputFormat;
    config.outputCount = imageTaskNode.config.outputCount;
  }
  const qualityPeer = flow.nodes.find((node) =>
    type === "operation.quality-analyze"
      ? node.type === "control.quality-gate"
      : node.type === "operation.quality-analyze",
  );
  if (
    (type === "operation.quality-analyze" || type === "control.quality-gate") &&
    typeof qualityPeer?.config.profile === "string"
  ) {
    config.profile = qualityPeer.config.profile;
  }

  return {
    nodeId,
    flow: {
      ...flow,
      updatedAt,
      nodes: [
        ...flow.nodes,
        {
          id: nodeId,
          type,
          version: definition.version,
          label: definition.displayName,
          layer: definition.layer,
          config,
        },
      ],
    },
  };
};

export const removeMediaFlowNode = ({
  flow,
  nodeId,
  updatedAt,
}: {
  flow: MediaFlow;
  nodeId: string;
  updatedAt: string;
}): MediaFlow => {
  if (!flow.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Media node ${nodeId} was not found.`);
  }
  return {
    ...flow,
    updatedAt,
    nodes: flow.nodes.filter((node) => node.id !== nodeId),
    edges: flow.edges.filter(
      (edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId,
    ),
  };
};

export const copyMediaFlowNode = (
  flow: MediaFlow,
  nodeId: string,
): MediaFlowNodeClipboardPayload => copyMediaFlowNodes(flow, [nodeId]);

export const copyMediaFlowNodes = (
  flow: MediaFlow,
  nodeIds: readonly string[],
): MediaFlowNodeClipboardPayload => {
  const selectedIds = new Set(nodeIds);
  const nodes = flow.nodes.filter((node) => selectedIds.has(node.id));
  if (nodes.length === 0 || nodes.length !== selectedIds.size) {
    throw new Error("Every copied media node must exist in the current flow.");
  }
  return {
    schemaVersion: 1,
    label: nodes.length === 1 ? nodes[0]?.label ?? "Media node" : `${nodes.length} nodes`,
    nodes: nodes.map((node) => ({
      sourceNodeId: node.id,
      nodeType: node.type,
      nodeVersion: node.version,
      label: node.label,
      config: cloneConfigValue(node.config) as Record<string, unknown>,
    })),
    connections: flow.edges
      .filter((edge) => selectedIds.has(edge.toNodeId))
      .map(({ fromNodeId, fromPortId, toNodeId, toPortId }) => ({
        fromNodeId,
        fromPortId,
        toNodeId,
        toPortId,
      })),
  };
};

export const inspectMediaFlowNodePaste = (
  flow: MediaFlow,
  payload: MediaFlowNodeClipboardPayload,
): MediaFlowConnectionCheck => {
  if (payload.schemaVersion !== 1) {
    return { valid: false, reason: "The copied node uses an unsupported clipboard schema." };
  }
  if (payload.nodes.length === 0 || payload.nodes.length > 64) {
    return { valid: false, reason: "The clipboard must contain between one and 64 nodes." };
  }
  if (flow.nodes.length + payload.nodes.length > 64) {
    return { valid: false, reason: "Pasting would exceed the 64-node flow limit." };
  }
  if (flow.edges.length + payload.connections.length > 128) {
    return { valid: false, reason: "Pasting would exceed the 128-edge flow limit." };
  }
  const sourceNodeIds = new Set<string>();
  for (const clipboardNode of payload.nodes) {
    const sourceNodeId = clipboardNode.sourceNodeId;
    if (
      sourceNodeId !== sourceNodeId.trim() ||
      sourceNodeId.length === 0 ||
      sourceNodeId.length > 128 ||
      sourceNodeIds.has(sourceNodeId)
    ) {
      return {
        valid: false,
        reason: "Every clipboard node must have a unique bounded source identity.",
      };
    }
    sourceNodeIds.add(sourceNodeId);
  }
  const currentNodeIds = new Set(flow.nodes.map((node) => node.id));
  const connectionIdentities = new Set<string>();
  for (const connection of payload.connections) {
    const identity = [
      connection.fromNodeId,
      connection.fromPortId,
      connection.toNodeId,
      connection.toPortId,
    ].join("\u001f");
    if (
      !sourceNodeIds.has(connection.toNodeId) ||
      (!sourceNodeIds.has(connection.fromNodeId) &&
        !currentNodeIds.has(connection.fromNodeId)) ||
      connection.fromPortId.length === 0 ||
      connection.fromPortId.length > 64 ||
      connection.toPortId.length === 0 ||
      connection.toPortId.length > 64 ||
      connectionIdentities.has(identity)
    ) {
      return {
        valid: false,
        reason: "The clipboard contains an invalid or duplicate connection.",
      };
    }
    connectionIdentities.add(identity);
  }
  const projectedCounts = new Map<MediaNodeType, number>();
  for (const clipboardNode of payload.nodes) {
    const definition = getMediaNodeDefinition(clipboardNode.nodeType);
    if (!definition || definition.version !== clipboardNode.nodeVersion) {
      return {
        valid: false,
        reason: `Media node definition ${clipboardNode.nodeType}@${clipboardNode.nodeVersion} is not installed.`,
      };
    }
    const existingCount =
      projectedCounts.get(clipboardNode.nodeType) ??
      flow.nodes.filter((node) => node.type === clipboardNode.nodeType).length;
    if (
      definition.maxInstances !== undefined &&
      existingCount >= definition.maxInstances
    ) {
      return {
        valid: false,
        reason: `${definition.displayName} is already present in this flow.`,
      };
    }
    projectedCounts.set(clipboardNode.nodeType, existingCount + 1);
    const validationIssues = validateMediaFlowNode({
      id: `clipboard-preview-${clipboardNode.sourceNodeId}`,
      type: clipboardNode.nodeType,
      version: clipboardNode.nodeVersion,
      label: clipboardNode.label,
      layer: definition.layer,
      config: clipboardNode.config,
    });
    const error = validationIssues.find((issue) => issue.severity === "error");
    if (error) return { valid: false, reason: error.message };
  }
  return { valid: true, reason: null };
};

export const pasteMediaFlowNodes = ({
  flow,
  payload,
  updatedAt,
}: {
  flow: MediaFlow;
  payload: MediaFlowNodeClipboardPayload;
  updatedAt: string;
}): PasteMediaFlowNodesResult => {
  const check = inspectMediaFlowNodePaste(flow, payload);
  if (!check.valid) {
    throw new Error(check.reason ?? "The copied media nodes cannot be pasted here.");
  }
  let nextFlow = flow;
  const idMap = new Map<string, string>();
  for (const clipboardNode of payload.nodes) {
    const added = addMediaFlowNode({
      flow: nextFlow,
      type: clipboardNode.nodeType,
      updatedAt,
    });
    const copyLabel = clipboardNode.label.endsWith(" copy")
      ? clipboardNode.label
      : `${clipboardNode.label} copy`;
    idMap.set(clipboardNode.sourceNodeId, added.nodeId);
    nextFlow = {
      ...added.flow,
      nodes: added.flow.nodes.map((node) =>
        node.id === added.nodeId
          ? {
              ...node,
              label: copyLabel.slice(0, 160),
              config: cloneConfigValue(clipboardNode.config) as Record<string, unknown>,
            }
          : node,
      ),
    };
  }
  for (const connection of payload.connections) {
    const toNodeId = idMap.get(connection.toNodeId);
    if (!toNodeId) continue;
    const request: MediaFlowConnectionRequest = {
      ...connection,
      fromNodeId: idMap.get(connection.fromNodeId) ?? connection.fromNodeId,
      toNodeId,
    };
    if (!nextFlow.nodes.some((node) => node.id === request.fromNodeId)) continue;
    if (!inspectMediaFlowConnection(nextFlow, request).valid) continue;
    nextFlow = connectMediaFlowPorts({ flow: nextFlow, request, updatedAt });
  }
  return {
    flow: nextFlow,
    nodeIds: [...idMap.values()],
    idMap: Object.fromEntries(idMap),
  };
};

export const pasteMediaFlowNode = ({
  flow,
  payload,
  updatedAt,
}: {
  flow: MediaFlow;
  payload: MediaFlowNodeClipboardPayload;
  updatedAt: string;
}): AddMediaFlowNodeResult => {
  const check = inspectMediaFlowNodePaste(flow, payload);
  if (!check.valid) {
    throw new Error(check.reason ?? "The copied media node cannot be pasted here.");
  }
  const pasted = pasteMediaFlowNodes({ flow, payload, updatedAt });
  const nodeId = pasted.nodeIds[0];
  if (!nodeId) throw new Error("The copied media node could not be pasted.");
  return { flow: pasted.flow, nodeId };
};

const hasDirectedPath = ({
  edges,
  fromNodeId,
  toNodeId,
}: {
  edges: MediaFlow["edges"];
  fromNodeId: string;
  toNodeId: string;
}): boolean => {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    targetsBySource.set(edge.fromNodeId, [
      ...(targetsBySource.get(edge.fromNodeId) ?? []),
      edge.toNodeId,
    ]);
  }
  const pending = [fromNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === toNodeId) return true;
    visited.add(current);
    pending.push(...(targetsBySource.get(current) ?? []));
  }
  return false;
};

export const inspectMediaFlowConnection = (
  flow: MediaFlow,
  request: MediaFlowConnectionRequest,
): MediaFlowConnectionCheck => {
  if (request.fromNodeId === request.toNodeId) {
    return { valid: false, reason: "A node cannot connect to itself." };
  }
  const sourceNode = flow.nodes.find((node) => node.id === request.fromNodeId);
  const targetNode = flow.nodes.find((node) => node.id === request.toNodeId);
  if (!sourceNode || !targetNode) {
    return { valid: false, reason: "Both connection nodes must exist in the flow." };
  }
  const sourcePort = getMediaNodeDefinition(sourceNode.type)?.outputs.find(
    (port) => port.id === request.fromPortId,
  );
  const targetPort = getMediaNodeDefinition(targetNode.type)?.inputs.find(
    (port) => port.id === request.toPortId,
  );
  if (!sourcePort || !targetPort) {
    return { valid: false, reason: "Both connection ports must be declared." };
  }
  if (sourcePort.dataType !== targetPort.dataType) {
    return {
      valid: false,
      reason: `${sourcePort.label} produces ${sourcePort.dataType}, but ${targetPort.label} accepts ${targetPort.dataType}.`,
    };
  }

  const exactConnectionExists = flow.edges.some(
    (edge) =>
      edge.fromNodeId === request.fromNodeId &&
      edge.fromPortId === request.fromPortId &&
      edge.toNodeId === request.toNodeId &&
      edge.toPortId === request.toPortId,
  );
  const incomingCount = flow.edges.filter(
    (edge) =>
      edge.toNodeId === request.toNodeId &&
      edge.toPortId === request.toPortId,
  ).length;
  if (
    !exactConnectionExists &&
    targetPort.maxConnections !== undefined &&
    incomingCount >= targetPort.maxConnections
  ) {
    return {
      valid: false,
      reason: `${targetPort.label} accepts at most ${targetPort.maxConnections} incoming connections.`,
    };
  }

  const retainedEdges =
    targetPort.cardinality === "single"
      ? flow.edges.filter(
          (edge) =>
            edge.toNodeId !== request.toNodeId || edge.toPortId !== request.toPortId,
        )
      : flow.edges;
  if (
    hasDirectedPath({
      edges: retainedEdges,
      fromNodeId: request.toNodeId,
      toNodeId: request.fromNodeId,
    })
  ) {
    return { valid: false, reason: "This connection would create a cycle." };
  }
  return { valid: true, reason: null };
};

const shortStableHash = (value: string): string => {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
};

const createConnectionId = (
  flow: MediaFlow,
  request: MediaFlowConnectionRequest,
): string => {
  const identity = `${request.fromNodeId}\u001f${request.fromPortId}\u001f${request.toNodeId}\u001f${request.toPortId}`;
  const compact = (value: string, length: number): string =>
    value.replaceAll(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, length) || "port";
  const base = `edge-${compact(request.fromNodeId, 20)}-${compact(request.fromPortId, 12)}-${compact(request.toNodeId, 20)}-${compact(request.toPortId, 12)}-${shortStableHash(identity)}`;
  return createUniqueId(base, new Set(flow.edges.map((edge) => edge.id)));
};

const synchronizeMediaFlowAssetCounts = (flow: MediaFlow): MediaFlow => {
  const effectiveNodes = new Map(
    resolveMediaFlowVariables(flow).flow.nodes.map((node) => [node.id, node]),
  );
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
  const outputCounts = new Map<string, unknown>();
  const outputFormats = new Map<string, unknown>();

  for (const output of flow.nodes.filter((node) => node.type === "output.asset")) {
    let currentNodeId = output.id;
    let generatedOutputCount: unknown;
    let resolvedOutputFormat: unknown;
    let fixedOutputCount: number | undefined;
    const numericalBounds: number[] = [];
    let hasHumanReview = false;
    const visited = new Set<string>();

    while (!visited.has(currentNodeId) && visited.size <= 64) {
      visited.add(currentNodeId);
      const inputEdge = flow.edges.find(
        (edge) => edge.toNodeId === currentNodeId && edge.toPortId === "image",
      );
      if (!inputEdge) break;
      const sourceNode = nodesById.get(inputEdge.fromNodeId);
      const effectiveNode = effectiveNodes.get(inputEdge.fromNodeId);
      if (!sourceNode || !effectiveNode) break;
      if (
        sourceNode.type === "task.generate-image" ||
        sourceNode.type === "task.edit-image"
      ) {
        generatedOutputCount = sourceNode.config.outputCount;
        resolvedOutputFormat ??= sourceNode.config.outputFormat;
        const value = effectiveNode.config.outputCount;
        if (typeof value === "number" && Number.isInteger(value)) numericalBounds.push(value);
      }
      if (sourceNode.type === "operation.format-convert") {
        resolvedOutputFormat = sourceNode.config.outputFormat;
      }
      if (sourceNode.type === "operation.contact-sheet") {
        fixedOutputCount = 1;
      }
      if (sourceNode.type === "control.human-review") {
        hasHumanReview = true;
        const value = effectiveNode.config.maxSelections;
        if (typeof value === "number" && Number.isInteger(value)) numericalBounds.push(value);
      }
      currentNodeId = sourceNode.id;
    }

    if (fixedOutputCount !== undefined) {
      outputCounts.set(output.id, fixedOutputCount);
    } else if (hasHumanReview && numericalBounds.length > 0) {
      outputCounts.set(output.id, Math.min(...numericalBounds));
    } else if (generatedOutputCount !== undefined) {
      outputCounts.set(output.id, generatedOutputCount);
    }
    if (resolvedOutputFormat !== undefined) {
      outputFormats.set(output.id, resolvedOutputFormat);
    }
  }

  if (outputCounts.size === 0 && outputFormats.size === 0) return flow;
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const outputCount = outputCounts.get(node.id);
      const format = outputFormats.get(node.id);
      return outputCount === undefined && format === undefined
        ? node
        : {
            ...node,
            config: {
              ...node.config,
              ...(outputCount !== undefined ? { outputCount } : {}),
              ...(format !== undefined ? { format } : {}),
            },
          };
    }),
  };
};

export const connectMediaFlowPorts = ({
  flow,
  request,
  updatedAt,
}: {
  flow: MediaFlow;
  request: MediaFlowConnectionRequest;
  updatedAt: string;
}): MediaFlow => {
  const check = inspectMediaFlowConnection(flow, request);
  if (!check.valid) {
    throw new Error(check.reason ?? "The typed connection is not valid.");
  }
  if (
    flow.edges.some(
      (edge) =>
        edge.fromNodeId === request.fromNodeId &&
        edge.fromPortId === request.fromPortId &&
        edge.toNodeId === request.toNodeId &&
        edge.toPortId === request.toPortId,
    )
  ) {
    return flow;
  }
  const targetNode = flow.nodes.find((node) => node.id === request.toNodeId);
  const targetPort = targetNode
    ? getMediaNodeDefinition(targetNode.type)?.inputs.find(
        (port) => port.id === request.toPortId,
      )
    : null;
  const retainedEdges =
    targetPort?.cardinality === "single"
      ? flow.edges.filter(
          (edge) =>
            edge.toNodeId !== request.toNodeId || edge.toPortId !== request.toPortId,
        )
      : flow.edges;
  return synchronizeMediaFlowAssetCounts({
    ...flow,
    updatedAt,
    edges: [
      ...retainedEdges,
      {
        id: createConnectionId(flow, request),
        ...request,
      },
    ],
  });
};

export const disconnectMediaFlowInput = ({
  flow,
  nodeId,
  portId,
  updatedAt,
}: {
  flow: MediaFlow;
  nodeId: string;
  portId: string;
  updatedAt: string;
}): MediaFlow => {
  const edges = flow.edges.filter(
    (edge) => edge.toNodeId !== nodeId || edge.toPortId !== portId,
  );
  return edges.length === flow.edges.length
    ? flow
    : { ...flow, updatedAt, edges };
};

export const disconnectMediaFlowConnection = ({
  flow,
  request,
  updatedAt,
}: {
  flow: MediaFlow;
  request: MediaFlowConnectionRequest;
  updatedAt: string;
}): MediaFlow => {
  const edges = flow.edges.filter(
    (edge) =>
      edge.fromNodeId !== request.fromNodeId ||
      edge.fromPortId !== request.fromPortId ||
      edge.toNodeId !== request.toNodeId ||
      edge.toPortId !== request.toPortId,
  );
  return edges.length === flow.edges.length
    ? flow
    : synchronizeMediaFlowAssetCounts({ ...flow, updatedAt, edges });
};

export const orderMediaFlowNodes = (flow: MediaFlow): readonly MediaFlowNode[] => {
  const nodeIndex = new Map(flow.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(flow.nodes.map((node) => [node.id, 0]));
  const targetsBySource = new Map<string, string[]>();
  for (const edge of flow.edges) {
    if (!indegree.has(edge.fromNodeId) || !indegree.has(edge.toNodeId)) continue;
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
    targetsBySource.set(edge.fromNodeId, [
      ...(targetsBySource.get(edge.fromNodeId) ?? []),
      edge.toNodeId,
    ]);
  }
  const ready = flow.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const ordered: MediaFlowNode[] = [];
  while (ready.length > 0) {
    ready.sort(
      (left, right) => (nodeIndex.get(left) ?? 0) - (nodeIndex.get(right) ?? 0),
    );
    const nodeId = ready.shift();
    if (!nodeId) continue;
    const node = flow.nodes[nodeIndex.get(nodeId) ?? -1];
    if (node) ordered.push(node);
    for (const targetId of targetsBySource.get(nodeId) ?? []) {
      const nextIndegree = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, nextIndegree);
      if (nextIndegree === 0) ready.push(targetId);
    }
  }
  return ordered.length === flow.nodes.length ? ordered : flow.nodes;
};

export const updateMediaFlowNodeConfig = ({
  flow,
  nodeId,
  fieldId,
  value,
  updatedAt,
}: {
  flow: MediaFlow;
  nodeId: string;
  fieldId: string;
  value: unknown;
  updatedAt: string;
}): MediaFlow => {
  const sourceNode = flow.nodes.find((node) => node.id === nodeId);
  if (!sourceNode) {
    throw new Error(`Media node ${nodeId} was not found.`);
  }
  const definition = getMediaNodeDefinition(sourceNode.type);
  const field = definition?.fields.find((candidate) => candidate.id === fieldId);
  if (!definition || !field) {
    throw new Error(`Config field ${fieldId} is not declared by ${sourceNode.type}.`);
  }
  if (field.readOnly) {
    throw new Error(`Config field ${fieldId} is synchronized and read-only.`);
  }

  const nodes = flow.nodes.map((node) => {
    if (node.id === nodeId) {
      return { ...node, config: { ...node.config, [fieldId]: value } };
    }
    if (
      (sourceNode.type === "task.generate-image" ||
        sourceNode.type === "task.edit-image") &&
      node.type === "output.asset"
    ) {
      if (fieldId === "outputCount") {
        return { ...node, config: { ...node.config, outputCount: value } };
      }
      if (fieldId === "outputFormat") {
        return { ...node, config: { ...node.config, format: value } };
      }
    }
    if (
      sourceNode.type === "operation.quality-analyze" &&
      fieldId === "profile" &&
      node.type === "control.quality-gate"
    ) {
      return { ...node, config: { ...node.config, profile: value } };
    }
    return node;
  });

  return synchronizeMediaFlowAssetCounts({ ...flow, updatedAt, nodes });
};
