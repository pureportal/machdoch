import type {
  MediaGenerationTarget,
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
  MediaModelCatalogSnapshot,
  MediaModelDescriptor,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import {
  createMediaModelAddonSelection,
  getMediaModelAddonTriggerWords,
  inspectMediaModelAddonCompatibility,
  mediaModelAcceptsAddonArchitecture,
  promptContainsMediaModelAddonTrigger,
} from "../../../core/media/model-addons.js";
import { isMediaModelReady } from "../../../core/media/model-readiness.js";
import type {
  CivitaiModel,
  CivitaiOptions,
} from "../../../core/media/civitai.js";
import { civitaiModelUrl } from "../../../core/media/civitai.js";

export const MEDIA_TARGET_LABELS: Readonly<
  Record<MediaGenerationTarget, string>
> = {
  image: "Image",
  video: "Video",
  svg: "SVG",
  audio: "Audio",
  splat: "3D",
};

type AddonRecipeKey = "recipe" | "videoRecipe";

const addonRecipeKey = (target: MediaGenerationTarget): AddonRecipeKey => {
  if (target === "video") return "videoRecipe";
  if (target === "image") return "recipe";
  throw new Error(
    `${MEDIA_TARGET_LABELS[target]} generation does not use LoRAs. Switch to Image or Video.`,
  );
};

export const mediaTargetModelId = (state: MediaStudioState): string | null =>
  state.target === "video"
    ? state.videoRecipe.modelId
    : state.target === "audio"
      ? state.audioRecipe.modelId
      : state.target === "splat"
        ? state.splatRecipe.modelId
        : state.recipe.modelId;

export const mediaTargetPrompt = (state: MediaStudioState): string =>
  state.target === "audio" ? state.audioRecipe.prompt : state.recipe.prompt;

export const withMediaTargetPrompt = (
  state: MediaStudioState,
  prompt: string,
): MediaStudioState =>
  state.target === "audio"
    ? { ...state, audioRecipe: { ...state.audioRecipe, prompt } }
    : { ...state, recipe: { ...state.recipe, prompt } };

export const describeMediaModel = (model: MediaModelDescriptor) => ({
  id: model.id,
  name: model.displayName,
  architecture: model.architecture,
  provider: model.providerId,
  installed: model.installed,
  ready: isMediaModelReady(model),
});

export const describeMediaAddonSelections = (
  state: MediaStudioState,
  addons: readonly MediaModelAddonDescriptor[],
) => {
  if (state.target !== "image" && state.target !== "video") return [];
  const prompt = mediaTargetPrompt(state);
  return state[addonRecipeKey(state.target)].modelAddons.map((selection) => {
    const addon = addons.find(({ id }) => id === selection.addonId);
    return {
      addonId: selection.addonId,
      name: addon?.displayName ?? "Unavailable",
      kind: selection.kind,
      enabled: selection.enabled,
      ...(selection.kind === "lora"
        ? { strength: selection.modelStrength }
        : { token: selection.token }),
      triggerWords: addon ? getMediaModelAddonTriggerWords(addon) : [],
      triggerInPrompt: addon
        ? promptContainsMediaModelAddonTrigger(prompt, addon)
        : false,
    };
  });
};

export const describeInstalledMediaAddons = (
  state: MediaStudioState,
  catalog: MediaModelCatalogSnapshot,
  query: string,
) => {
  const model = catalog.models.find(
    ({ id }) => id === mediaTargetModelId(state),
  );
  const selected =
    state.target === "image" || state.target === "video"
      ? new Set(
          state[addonRecipeKey(state.target)].modelAddons.map(
            ({ addonId }) => addonId,
          ),
        )
      : new Set<string>();
  const needle = query.trim().toLowerCase();
  return catalog.addons
    .filter(
      (addon) =>
        !needle ||
        addon.displayName.toLowerCase().includes(needle) ||
        addon.triggerWords.some((word) => word.toLowerCase().includes(needle)),
    )
    .map((addon) => {
      const compatibility = model
        ? inspectMediaModelAddonCompatibility(model, addon)
        : null;
      return {
        addonId: addon.id,
        name: addon.displayName,
        kind: addon.kind,
        architecture: addon.architecture,
        triggerWords: getMediaModelAddonTriggerWords(addon),
        selected: selected.has(addon.id),
        compatible: compatibility?.status === "compatible",
        ...(compatibility && compatibility.status !== "compatible"
          ? { reason: compatibility.reason }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        Number(right.compatible) - Number(left.compatible) ||
        left.name.localeCompare(right.name),
    );
};

export interface MediaAddonChange {
  strength?: number;
  enabled?: boolean;
  insertTriggerWords?: boolean;
}

export const addMediaAddonSelection = (
  state: MediaStudioState,
  catalog: MediaModelCatalogSnapshot,
  addonId: string,
  change: MediaAddonChange,
): { state: MediaStudioState; insertedTrigger: string | null } => {
  const key = addonRecipeKey(state.target);
  const addon = catalog.addons.find(({ id }) => id === addonId);
  if (!addon)
    throw new Error(
      "No installed LoRA or embedding has that id. Use media.list_loras or install one first.",
    );
  const recipe = state[key];
  const model = catalog.models.find(({ id }) => id === recipe.modelId);
  if (!model) throw new Error("Select a model first.");
  const compatibility = inspectMediaModelAddonCompatibility(model, addon);
  if (compatibility.status !== "compatible")
    throw new Error(compatibility.reason);
  const existing = recipe.modelAddons.find(
    (selection) => selection.addonId === addonId,
  );
  const capacity =
    model.addonCapabilities.find(({ kind }) => kind === addon.kind)
      ?.maxActive ?? 0;
  const activeOfKind = recipe.modelAddons.filter(
    (selection) =>
      selection.kind === addon.kind &&
      selection.enabled &&
      selection.addonId !== addonId,
  ).length;
  if (activeOfKind >= capacity)
    throw new Error(
      `${model.displayName} supports at most ${capacity} active ${addon.kind === "lora" ? "LoRAs" : "embeddings"}. Disable or remove one first.`,
    );
  const base = existing ?? createMediaModelAddonSelection(addon);
  const selection: MediaModelAddonSelection =
    base.kind === "lora" && change.strength !== undefined
      ? { ...base, enabled: true, modelStrength: change.strength }
      : { ...base, enabled: true };
  const modelAddons = existing
    ? recipe.modelAddons.map((entry) =>
        entry.addonId === addonId ? selection : entry,
      )
    : [...recipe.modelAddons, selection];
  let next: MediaStudioState = { ...state, [key]: { ...recipe, modelAddons } };
  const prompt = mediaTargetPrompt(next);
  const trigger = getMediaModelAddonTriggerWords(addon)[0];
  const insertedTrigger =
    change.insertTriggerWords !== false &&
    addon.kind === "lora" &&
    trigger &&
    !promptContainsMediaModelAddonTrigger(prompt, addon)
      ? trigger
      : null;
  if (insertedTrigger)
    next = withMediaTargetPrompt(
      next,
      prompt.trim() ? `${prompt.trim()}, ${insertedTrigger}` : insertedTrigger,
    );
  return { state: next, insertedTrigger };
};

export const updateMediaAddonSelection = (
  state: MediaStudioState,
  addonId: string,
  change: MediaAddonChange & { remove?: boolean },
): MediaStudioState => {
  const key = addonRecipeKey(state.target);
  const recipe = state[key];
  if (!recipe.modelAddons.some((selection) => selection.addonId === addonId))
    throw new Error("That LoRA is not in the current list.");
  const modelAddons = change.remove
    ? recipe.modelAddons.filter((selection) => selection.addonId !== addonId)
    : recipe.modelAddons.map((selection) => {
        if (selection.addonId !== addonId) return selection;
        const enabled = change.enabled ?? selection.enabled;
        return selection.kind === "lora"
          ? {
              ...selection,
              enabled,
              modelStrength: change.strength ?? selection.modelStrength,
            }
          : { ...selection, enabled };
      });
  return { ...state, [key]: { ...recipe, modelAddons } };
};

export const civitaiBaseModelsFor = (
  model: MediaModelDescriptor | undefined,
  options: CivitaiOptions,
  modelType: string,
): string[] => {
  const supported = options.baseModelsByType[modelType] ?? options.baseModels;
  if (!model?.architecture) return [];
  const identities = [model.architecture, model.family, model.displayName].map(
    baseModelIdentity,
  );
  const rank = (baseModel: string): number => {
    const identity = baseModelIdentity(baseModel);
    if (identities.some((candidate) => candidate.includes(identity))) return 0;
    return LEGACY_BASE_MODEL.test(baseModel) ? 2 : 1;
  };
  return supported
    .filter((baseModel) => {
      const architecture = options.baseModelArchitectures[baseModel];
      return (
        architecture !== undefined &&
        mediaModelAcceptsAddonArchitecture(model, architecture)
      );
    })
    .map((baseModel, index) => ({ baseModel, index, rank: rank(baseModel) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ baseModel }) => baseModel);
};

const LEGACY_BASE_MODEL = /\b(?:0\.9|1\.4|2\.0)\b|\b768$/u;

const baseModelIdentity = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/gu, "");

const publishedAt = (model: CivitaiModel): number =>
  Math.max(
    0,
    ...model.modelVersions.map((version) =>
      version.publishedAt ? Date.parse(version.publishedAt) || 0 : 0,
    ),
  );

export const compareCivitaiResults =
  (sort: string) =>
  (left: CivitaiModel, right: CivitaiModel): number =>
    sort === "Newest"
      ? publishedAt(right) - publishedAt(left)
      : sort === "Highest Rated"
        ? (right.stats?.thumbsUpCount ?? 0) - (left.stats?.thumbsUpCount ?? 0)
        : (right.stats?.downloadCount ?? 0) - (left.stats?.downloadCount ?? 0);

export const describeCivitaiResult = (
  model: CivitaiModel,
  options: CivitaiOptions,
  selected: MediaModelDescriptor | undefined,
  installedDigests: ReadonlySet<string>,
) => ({
  modelId: model.id,
  name: model.name,
  type: model.type,
  creator: model.creator?.username ?? null,
  downloads: model.stats?.downloadCount ?? null,
  likes: model.stats?.thumbsUpCount ?? null,
  nsfw: model.nsfw,
  url: civitaiModelUrl(model),
  tags: model.tags.slice(0, 6),
  versions: model.modelVersions.slice(0, 3).map((version) => {
    const architecture = version.baseModel
      ? options.baseModelArchitectures[version.baseModel]
      : undefined;
    const file =
      version.files.find((candidate) => candidate.primary) ?? version.files[0];
    return {
      versionId: version.id,
      name: version.name,
      baseModel: version.baseModel,
      trainedWords: version.trainedWords.slice(0, 8),
      compatible:
        selected !== undefined &&
        architecture !== undefined &&
        mediaModelAcceptsAddonArchitecture(selected, architecture),
      installed: version.files.some((candidate) =>
        installedDigests.has(candidate.hashes?.SHA256?.toLowerCase() ?? ""),
      ),
      ...(file ? { sizeMb: Math.round(file.sizeKB / 1024) } : {}),
    };
  }),
});
