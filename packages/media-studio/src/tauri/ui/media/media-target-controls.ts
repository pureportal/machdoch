import {
  MEDIA_MESH_VIEWS,
  type MediaGenerationTarget,
  type MediaNodeType,
  type MediaStudioState,
} from "../../../core/media/contracts.js";
import {
  getMediaNodeDefinition,
  type MediaNodeFieldDefinition,
} from "../../../core/media/node-registry.js";
import type { AppControlValueSchema } from "../app-control/app-control-contract";

type RecipeKey = "splatRecipe" | "meshRecipe" | "audioRecipe";

export interface MediaTargetControl {
  target: MediaGenerationTarget;
  recipeKey: RecipeKey;
  nodeType: MediaNodeType;
  imageSlots: readonly string[];
  readImages: (state: MediaStudioState) => Record<string, string | null>;
  writeImages: (
    state: MediaStudioState,
    images: Readonly<Record<string, string | null>>,
  ) => MediaStudioState;
}

const CLEAR_VALUE = -1;

export const MEDIA_TARGET_CONTROLS: readonly MediaTargetControl[] = [
  {
    target: "mesh",
    recipeKey: "meshRecipe",
    nodeType: "task.generate-mesh",
    imageSlots: MEDIA_MESH_VIEWS,
    readImages: (state) =>
      Object.fromEntries(
        MEDIA_MESH_VIEWS.map((view) => [view, state.meshRecipe.viewAssetIds[view] ?? null]),
      ),
    writeImages: (state, images) => {
      const viewAssetIds = { ...state.meshRecipe.viewAssetIds };
      for (const view of MEDIA_MESH_VIEWS) {
        if (!Object.hasOwn(images, view)) continue;
        const assetId = images[view];
        if (assetId) viewAssetIds[view] = assetId;
        else delete viewAssetIds[view];
      }
      return { ...state, meshRecipe: { ...state.meshRecipe, viewAssetIds } };
    },
  },
  {
    target: "splat",
    recipeKey: "splatRecipe",
    nodeType: "task.generate-splat",
    imageSlots: ["image"],
    readImages: (state) => ({ image: state.splatRecipe.sourceAssetId }),
    writeImages: (state, images) =>
      Object.hasOwn(images, "image")
        ? { ...state, splatRecipe: { ...state.splatRecipe, sourceAssetId: images.image ?? null } }
        : state,
  },
  {
    target: "audio",
    recipeKey: "audioRecipe",
    nodeType: "task.generate-audio",
    imageSlots: [],
    readImages: () => ({}),
    writeImages: (state) => state,
  },
];

export const findMediaTargetControl = (
  target: MediaGenerationTarget,
): MediaTargetControl | undefined =>
  MEDIA_TARGET_CONTROLS.find((control) => control.target === target);

export const mediaTargetControlFields = (
  control: MediaTargetControl,
): MediaNodeFieldDefinition[] =>
  (getMediaNodeDefinition(control.nodeType)?.fields ?? []).filter(
    (field) =>
      (field.kind === "number" && field.min !== undefined && field.max !== undefined) ||
      field.kind === "boolean" ||
      (field.kind === "select" && Boolean(field.options?.length)) ||
      ((field.kind === "text" || field.kind === "textarea") && field.id !== "prompt"),
  );

const fieldSchema = (field: MediaNodeFieldDefinition): AppControlValueSchema => {
  const description = [
    field.label,
    field.description,
    field.recommended
      ? `Recommended ${field.recommended.min} to ${field.recommended.max}.`
      : "",
    !field.required && field.kind === "number" ? `${CLEAR_VALUE} clears it.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (field.kind === "boolean") return { type: "boolean", description };
  if (field.kind === "select")
    return {
      type: "string",
      description,
      enum: (field.options ?? []).map((option) => option.value),
    };
  if (field.kind === "number")
    return {
      type: field.integer ? "integer" : "number",
      description,
      minimum: field.required ? field.min! : Math.min(CLEAR_VALUE, field.min!),
      maximum: field.max!,
    };
  return { type: "string", description, maxLength: field.maxLength ?? 8_000 };
};

export const mediaTargetOptionSchema = (
  control: MediaTargetControl,
): Record<string, AppControlValueSchema> =>
  Object.fromEntries(
    mediaTargetControlFields(control).map((field) => [field.id, fieldSchema(field)]),
  );

export const describeMediaTargetOptions = (
  control: MediaTargetControl,
  state: MediaStudioState,
) => {
  const settings = state[control.recipeKey] as unknown as Record<string, unknown>;
  return mediaTargetControlFields(control).map((field) => ({
    id: field.id,
    label: field.label,
    description: field.description,
    kind: field.kind,
    value: settings[field.id] ?? null,
    default: field.defaultValue,
    ...(field.kind === "number" ? { min: field.min, max: field.max } : {}),
    ...(field.recommended ? { recommended: field.recommended } : {}),
    ...(field.options ? { options: field.options.map((option) => option.value) } : {}),
    group: field.group === "Expert" ? "more-options" : "basic",
  }));
};

export const applyMediaTargetOptions = (
  control: MediaTargetControl,
  state: MediaStudioState,
  input: Readonly<Record<string, unknown>>,
): MediaStudioState => {
  const fields = mediaTargetControlFields(control);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = fields.find((entry) => entry.id === key);
    if (!field) throw new Error(`${key} is not an option for ${control.target}.`);
    if (field.kind !== "number") {
      patch[key] = value;
      continue;
    }
    if (value === CLEAR_VALUE && !field.required) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== "number" || value < field.min! || value > field.max!)
      throw new Error(`${field.label} must be between ${field.min} and ${field.max}.`);
    patch[key] = value;
  }
  return {
    ...state,
    [control.recipeKey]: { ...state[control.recipeKey], ...patch },
  };
};
