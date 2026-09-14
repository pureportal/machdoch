import type {
  MediaAssetRecord,
  ImageRecipeSettings,
  MediaFlow,
  MediaGenerationTarget,
  MediaModelDescriptor,
  MediaStudioState,
  MediaVideoRecipeSettings,
} from "../../../core/media/contracts.js";
import {
  createImageEditFlow,
  createImageRecipeFlow,
  createImageToVideoFlow,
} from "../../../core/media/compiler.js";
import {
  inferMediaVideoAspectRatio,
  isMediaAssetKnownTransparent,
} from "../../../core/media/video-quality.js";

export const createBasicMediaVideoFlow = ({
  id,
  createdAt,
  imageSettings,
  videoSettings,
}: {
  id: string;
  createdAt: string;
  imageSettings: ImageRecipeSettings;
  videoSettings: MediaVideoRecipeSettings;
}): MediaFlow => {
  const sourceAssetId = imageSettings.referenceImages[0]?.assetId;
  const flow = createImageToVideoFlow({
    id,
    createdAt,
    sourceAssetId,
    prompt: imageSettings.prompt.trim(),
    settings: videoSettings,
  });
  if (sourceAssetId) return flow;
  const firstFrameFlow = createImageRecipeFlow({
    id,
    createdAt,
    settings: {
      ...imageSettings,
      aspectRatio:
        videoSettings.aspectRatio === "21:9"
          ? "16:9"
          : videoSettings.aspectRatio,
      outputCount: 1,
      outputFormat: "png",
      transparentBackground: videoSettings.transparentBackground,
      qualityGateEnabled: false,
      referenceImages: [],
      baseImageAssetId: null,
      editMask: null,
      poseImageAssetId: null,
    },
  });
  const endpoint = firstFrameFlow.edges.find(
    (edge) => edge.toNodeId === "asset-output",
  );
  if (!endpoint) throw new Error("The first frame has no image output.");
  return {
    ...flow,
    nodes: [
      ...firstFrameFlow.nodes.filter((node) => node.id !== "asset-output"),
      ...flow.nodes.filter((node) => node.id !== "video-prompt"),
    ],
    edges: [
      ...firstFrameFlow.edges.filter(
        (edge) => edge.toNodeId !== "asset-output",
      ),
      ...flow.edges.map((edge) =>
        edge.fromNodeId === "video-prompt"
          ? { ...edge, fromNodeId: "prompt" }
          : edge,
      ),
      ...["first-frame", "last-frame"].map((port) => ({
        id: `generated-image-to-${port}`,
        fromNodeId: endpoint.fromNodeId,
        fromPortId: endpoint.fromPortId,
        toNodeId: "generate-video",
        toPortId: port,
      })),
    ],
  };
};

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
    ? (models.find((model) => model.id === settings.modelId) ?? null)
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
        referenceAssets: (target === "image" && settings.baseImageAssetId
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
    baseImageAssetId: null,
    poseImageAssetId: null,
    editMask: null,
    qualityGateEnabled: false,
  },
  videoRecipe: {
    ...state.videoRecipe,
    aspectRatio: inferMediaVideoAspectRatio(asset.width, asset.height),
    transparentBackground: isMediaAssetKnownTransparent(asset),
  },
});

export const createBasicImageDraftFromAsset = (
  state: MediaStudioState,
  asset: MediaAssetRecord,
  purpose: "edit" | "reference",
): MediaStudioState => ({
  ...state,
  activeSection: "generate",
  target: asset.kind === "vector" ? "svg" : "image",
  recipe: {
    ...state.recipe,
    prompt: "",
    modelId: null,
    modelAddons: [],
    outputFormat: asset.kind === "vector" ? "svg" : "png",
    transparentBackground: false,
    qualityGateEnabled: false,
    referenceImages:
      purpose === "reference"
        ? [{ assetId: asset.id, role: "subject", influence: 1 }]
        : [],
    baseImageAssetId: purpose === "edit" ? asset.id : null,
    poseImageAssetId: null,
    editMask: null,
  },
});
