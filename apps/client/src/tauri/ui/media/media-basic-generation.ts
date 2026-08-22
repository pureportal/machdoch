import type {
  MediaAssetRecord,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import {
  inferMediaVideoAspectRatio,
  isMediaAssetKnownTransparent,
} from "../../../core/media/video-quality.js";

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
