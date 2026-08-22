import type {
  MediaAssetRecord,
  ImageRecipeSettings,
  MediaFlow,
  MediaGenerationTarget,
  MediaModelDescriptor,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import {
  createImageEditFlow,
  createImageRecipeFlow,
} from "../../../core/media/compiler.js";
import {
  inferMediaVideoAspectRatio,
  isMediaAssetKnownTransparent,
} from "../../../core/media/video-quality.js";

interface CreateBasicMediaRecipeFlowInput {
  id: string;
  createdAt: string;
  target: MediaGenerationTarget;
  settings: ImageRecipeSettings;
  models: readonly MediaModelDescriptor[];
}

export const createBasicMediaRecipeFlow = ({
  id,
  createdAt,
  target,
  settings,
  models,
}: CreateBasicMediaRecipeFlowInput): MediaFlow => {
  const [firstReference, ...additionalReferences] = settings.referenceImages;
  const primarySource =
    target === "image" && settings.baseImageAssetId
      ? { assetId: settings.baseImageAssetId, role: "base" as const }
      : firstReference
        ? { assetId: firstReference.assetId, role: firstReference.role }
        : target === "image" && settings.poseImageAssetId
          ? { assetId: settings.poseImageAssetId, role: "pose" as const }
          : null;
  const configuredModel = settings.modelId
    ? models.find((model) => model.id === settings.modelId) ?? null
    : null;
  const sourceRole =
    (settings.providerPolicy === "remote" ||
      configuredModel?.target === "remote") &&
    primarySource?.role !== "pose"
      ? ("base" as const)
      : primarySource?.role;

  return primarySource && sourceRole && settings.outputFormat !== "svg"
    ? createImageEditFlow({
        id,
        createdAt,
        settings:
          primarySource.role === "pose"
            ? { ...settings, poseImageAssetId: null }
            : settings,
        sourceAssetId: primarySource.assetId,
        sourceRole,
        referenceAssets: (
          target === "image" && settings.baseImageAssetId
            ? settings.referenceImages
            : additionalReferences
        ).map((reference) => ({
          assetId: reference.assetId,
          role: reference.role === "base" ? "subject" : reference.role,
          influence: reference.influence,
        })),
      })
    : createImageRecipeFlow({ id, createdAt, settings });
};

export const createBasicVideoDraftFromImage = (
  state: MediaStudioState,
  asset: MediaAssetRecord,
): MediaStudioState => ({
  ...state,
  activeSection: "generate",
  target: "video",
  recipe: {
    ...state.recipe,
    prompt: "",
    outputFormat:
      state.recipe.outputFormat === "svg" ? "png" : state.recipe.outputFormat,
    referenceImages: [{ assetId: asset.id, role: "base", influence: 1 }],
    editMask: null,
  },
  videoRecipe: {
    ...state.videoRecipe,
    aspectRatio: inferMediaVideoAspectRatio(asset.width, asset.height),
    transparentBackground: isMediaAssetKnownTransparent(asset),
  },
});
