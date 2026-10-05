import {
  createAudioRecipeFlow,
  readAudioRecipeSettings,
} from "../../../core/media/audio-flow.js";
import {
  canonicalizeMediaValue,
  createMediaFlowFingerprint,
} from "../../../core/media/canonicalize.js";
import {
  compileMediaFlow,
  readImageRecipeSettings,
} from "../../../core/media/compiler.js";
import { mediaImageSamplingError } from "../../../core/media/image-sampling.js";
import type {
  MediaFlow,
  MediaModelDescriptor,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import { openMediaModelProfile } from "../../../core/media/open-model-profiles.js";
import { resolveMediaNodePrompt } from "../../../core/media/prompt-resolution.js";
import {
  createDefaultMediaNodeConfig,
  validateMediaFlowDocument,
} from "../../../core/media/node-registry.js";
import {
  createBasicMediaRecipeFlow,
  createBasicMediaVideoFlow,
} from "./media-basic-generation";
import { readMediaVideoRecipeSettings } from "./media-generation-recipe";
import { basicImageModelError } from "./media-basic-image-options";

export type MediaBasicAssistantDraft = Pick<
  MediaStudioState,
  "target" | "recipe" | "videoRecipe" | "audioRecipe"
>;

export const basicAssistantDraftIdentity = (
  draft: MediaBasicAssistantDraft,
): string => JSON.stringify(canonicalizeMediaValue(draft));

const executionFingerprint = (flow: MediaFlow): string =>
  createMediaFlowFingerprint({
    ...flow,
    nodes: flow.nodes.map((node) => ({
      ...node,
      config: {
        ...createDefaultMediaNodeConfig(node.type),
        ...Object.fromEntries(
          Object.entries(node.config).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      },
    })),
  });

export function createBasicAssistantFlow(
  draft: MediaBasicAssistantDraft,
  models: readonly MediaModelDescriptor[],
): MediaFlow {
  const identity = {
    id: "basic-assistant",
    createdAt: new Date().toISOString(),
  };
  if (draft.target === "audio")
    return createAudioRecipeFlow({ ...identity, settings: draft.audioRecipe });
  if (draft.target === "video") {
    const model = models.find(
      (entry) => entry.id === draft.videoRecipe.modelId,
    );
    const profile = openMediaModelProfile(model?.architecture);
    return createBasicMediaVideoFlow({
      ...identity,
      imageSettings: draft.recipe,
      videoSettings: draft.videoRecipe,
      nativeTextToVideo: model?.capabilities.includes("text-to-video") ?? false,
      generateAudio:
        model?.architecture === "minimax-h3-ref2va" || profile?.audio === true,
    });
  }
  return createBasicMediaRecipeFlow({
    ...identity,
    target: draft.target,
    settings: draft.recipe,
  });
}

export function readBasicAssistantDraft(
  flow: MediaFlow,
  draft: MediaBasicAssistantDraft,
  models: readonly MediaModelDescriptor[],
): MediaBasicAssistantDraft {
  const issues = validateMediaFlowDocument(flow);
  if (issues.length)
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  let updated: MediaBasicAssistantDraft;
  if (draft.target === "audio") {
    const audioRecipe = readAudioRecipeSettings(flow);
    if (!audioRecipe)
      throw new Error(
        "The assistant returned invalid audio settings. Try again.",
      );
    updated = { ...draft, audioRecipe };
  } else if (draft.target === "video") {
    const videoRecipe = readMediaVideoRecipeSettings(flow);
    const task = flow.nodes.find((node) => node.type === "task.generate-video");
    if (!videoRecipe || !task)
      throw new Error(
        "The assistant returned invalid video settings. Try again.",
      );
    const imageRecipe = readImageRecipeSettings(flow);
    const opening = flow.edges.find(
      (edge) => edge.toNodeId === task.id && edge.toPortId === "first-frame",
    );
    const source = flow.nodes.find(
      (node) => node.type === "source.image" && node.id === opening?.fromNodeId,
    );
    updated = {
      ...draft,
      videoRecipe,
      recipe: {
        ...draft.recipe,
        ...imageRecipe,
        prompt: resolveMediaNodePrompt(flow, task.id).prompt ?? "",
        ...(!imageRecipe && source
          ? {
              referenceImages: [
                {
                  assetId: String(source.config.assetId),
                  role: "base" as const,
                  influence: 1,
                },
              ],
            }
          : {}),
      },
    };
  } else {
    const recipe = readImageRecipeSettings(flow);
    if (!recipe || (recipe.outputFormat === "svg") !== (draft.target === "svg"))
      throw new Error(
        "The assistant changed the media type. Select that type and try again.",
      );
    updated = { ...draft, recipe: { ...draft.recipe, ...recipe } };
  }
  if (
    executionFingerprint(createBasicAssistantFlow(updated, models)) !==
    executionFingerprint(flow)
  )
    throw new Error(
      "These changes need Advanced mode. Convert to Advanced and use the flow assistant.",
    );
  const imageRecipe = readImageRecipeSettings(flow);
  if (imageRecipe && imageRecipe.outputFormat !== "svg") {
    const imageFlow = createBasicMediaRecipeFlow({
      id: flow.id,
      createdAt: flow.createdAt,
      target: "image",
      settings: imageRecipe,
    });
    const model = compileMediaFlow({
      flow: imageFlow,
      models,
      compiledAt: flow.updatedAt,
    }).model;
    const error =
      mediaImageSamplingError(imageRecipe.sampling ?? {}) ??
      (model ? basicImageModelError(imageRecipe, model) : null);
    if (error) throw new Error(error);
  }
  return updated;
}
