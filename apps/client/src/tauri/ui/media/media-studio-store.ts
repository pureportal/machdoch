import type {
  ImageRecipeSettings,
  MediaAssetCategory,
  MediaFlow,
  MediaExecutionTarget,
  MediaGenerationAssetMetadata,
  MediaGenerationTarget,
  MediaLoraDenoisingSchedule,
  MediaProviderPolicy,
  MediaRunRecord,
  MediaRunStatus,
  MediaStudioSection,
  MediaStudioState,
  MediaVideoRecipeSettings,
} from "../../../core/media/contracts.js";
import {
  DEFAULT_MEDIA_ASSET_CATEGORIES,
  normalizeMediaAssetCategories,
} from "../../../core/media/asset-categories.js";
import {
  normalizeMediaCivitaiSampleImageUrl,
  normalizeMediaExternalLink,
  normalizeMediaTriggerWords,
} from "../../../core/media/asset-metadata.js";
import { getMediaNodeDefinition } from "../../../core/media/node-registry.js";
import { normalizeMediaImageMask } from "../../../core/media/image-mask.js";
import { validateMediaFlowVariableDocument } from "../../../core/media/variables.js";
import {
  loadStoredValue,
  saveStoredValue,
} from "../lib/_helpers/shell-store-storage.helper";

const MEDIA_STUDIO_STORAGE_KEY = "machdoch.desktop.media-studio-state";
const MAX_STORED_RUNS = 50;

export const DEFAULT_IMAGE_RECIPE_SETTINGS = {
  prompt: "",
  providerPolicy: "auto",
  modelPolicy: "quality",
  modelId: null,
  aspectRatio: "1:1",
  outputCount: 1,
  outputFormat: "png",
  transparentBackground: false,
  qualityGateEnabled: false,
  referenceImages: [],
  baseImageAssetId: null,
  poseImageAssetId: null,
  poseStrength: 1,
  poseStart: 0,
  poseEnd: 1,
  editMask: null,
  editStrength: 0.65,
  maskStrength: 1,
  seed: null,
  requireChromaBackground: false,
  memoryProfile: "auto",
  modelAddons: [],
  svgMode: "generate",
  svgAutoCrop: true,
  svgTargetSize: 1024,
  svgStyle: "illustration",
  svgTextPolicy: "avoid",
  svgCandidateCount: 6,
  svgCriticEnabled: false,
} as const satisfies ImageRecipeSettings;

export const DEFAULT_VIDEO_RECIPE_SETTINGS = {
  modelId: null,
  aspectRatio: "16:9",
  resolution: "quality-640",
  transparentBackground: false,
  loopMode: "none",
  fps: 16,
  numFrames: 33,
  memoryProfile: "auto",
} as const satisfies MediaVideoRecipeSettings;

export const DEFAULT_MEDIA_STUDIO_STATE = {
  version: 5,
  activeSection: "generate",
  target: "image",
  recipe: DEFAULT_IMAGE_RECIPE_SETTINGS,
  videoRecipe: DEFAULT_VIDEO_RECIPE_SETTINGS,
  categories: DEFAULT_MEDIA_ASSET_CATEGORIES.map((category) => ({
    ...category,
  })),
  assetMetadata: {},
  flow: null,
  flowLayout: null,
  runs: [],
} as const satisfies MediaStudioState;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const normalizeOneOf = <T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T => {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback;
};

const normalizeOutputCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_IMAGE_RECIPE_SETTINGS.outputCount;
  }

  return Math.min(8, Math.max(1, Math.round(value)));
};

const normalizeBoundedNumber = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, value));
};

const normalizeReferenceImages = (
  value: unknown,
): ImageRecipeSettings["referenceImages"] => {
  if (!Array.isArray(value)) return [];
  const seenAssetIds = new Set<string>();
  const references: ImageRecipeSettings["referenceImages"] = [];
  for (const entry of value) {
    if (references.length >= 8) break;
    if (!isRecord(entry) || typeof entry.assetId !== "string") continue;
    const assetId = entry.assetId.trim();
    if (!assetId || seenAssetIds.has(assetId)) continue;
    seenAssetIds.add(assetId);
    const role = normalizeOneOf<
      Exclude<
        ImageRecipeSettings["referenceImages"][number]["role"],
        "base" | "pose"
      >
    >(
      entry.role,
      ["subject", "style", "composition", "palette", "detail"] as const,
      "subject",
    );
    const influence =
      typeof entry.influence === "number" && Number.isFinite(entry.influence)
        ? Math.min(2, Math.max(0, entry.influence))
        : 1;
    references.push({ assetId, role, influence });
  }
  return references;
};

const normalizeAddonStrength = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(-100, value));
};

const normalizeLoraDenoisingSchedule = (
  value: unknown,
): MediaLoraDenoisingSchedule | null => {
  if (!isRecord(value)) return null;
  const start = value.start;
  const end = value.end;
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    typeof end !== "number" ||
    !Number.isFinite(end)
  ) {
    return null;
  }
  const normalizedStart = Math.min(0.99, Math.max(0, start));
  const normalizedEnd = Math.min(1, Math.max(0.01, end));
  return normalizedStart < normalizedEnd
    ? { start: normalizedStart, end: normalizedEnd }
    : null;
};

const normalizeModelAddons = (
  value: unknown,
): ImageRecipeSettings["modelAddons"] => {
  if (!Array.isArray(value)) return [];
  const seenAddonIds = new Set<string>();
  const addons: ImageRecipeSettings["modelAddons"] = [];
  for (const entry of value) {
    if (addons.length >= 24) break;
    if (!isRecord(entry)) continue;
    if (typeof entry.addonId !== "string") continue;
    const addonId = entry.addonId.trim();
    if (!addonId || addonId.length > 256 || seenAddonIds.has(addonId)) continue;
    seenAddonIds.add(addonId);
    if (entry.kind === "lora") {
      addons.push({
        kind: "lora",
        addonId,
        enabled: entry.enabled !== false,
        modelStrength: normalizeAddonStrength(entry.modelStrength, 1),
        textEncoderStrength:
          entry.textEncoderStrength === null
            ? null
            : normalizeAddonStrength(entry.textEncoderStrength, 1),
        denoisingSchedule: normalizeLoraDenoisingSchedule(
          entry.denoisingSchedule,
        ),
      });
      continue;
    }
    if (entry.kind !== "textual-inversion" || typeof entry.token !== "string") {
      continue;
    }
    const token = entry.token.trim();
    if (!token || token.length > 128 || /[\p{Cc}]/u.test(token)) continue;
    addons.push({
      kind: "textual-inversion",
      addonId,
      enabled: entry.enabled !== false,
      token,
      placement: normalizeOneOf(
        entry.placement,
        ["positive", "negative", "both"],
        "positive",
      ),
    });
  }
  return addons;
};

const normalizeVideoRecipeSettings = (
  value: unknown,
): MediaVideoRecipeSettings => {
  if (!isRecord(value)) return { ...DEFAULT_VIDEO_RECIPE_SETTINGS };
  const modelId = normalizeOneOf<
    NonNullable<MediaVideoRecipeSettings["modelId"]>
  >(
    value.modelId,
    [
      "local:framepack-i2v-hy-13b",
      "local:hunyuan-video-1.5-i2v-step-distilled",
      "local:ltx-video-0.9.8-13b-distilled-fp8",
      "local:ltx-video-0.9.8-2b-distilled-fp8",
      "local:wan2.2-ti2v-5b",
    ],
    "local:hunyuan-video-1.5-i2v-step-distilled",
  );
  return {
    modelId: typeof value.modelId === "string" ? modelId : null,
    aspectRatio: normalizeOneOf(
      value.aspectRatio,
      ["1:1", "16:9", "9:16", "21:9"],
      DEFAULT_VIDEO_RECIPE_SETTINGS.aspectRatio,
    ),
    resolution: normalizeOneOf(
      value.resolution,
      ["preview-512", "quality-640", "quality-768"],
      DEFAULT_VIDEO_RECIPE_SETTINGS.resolution,
    ),
    transparentBackground: value.transparentBackground === true,
    loopMode: normalizeOneOf(
      value.loopMode,
      ["none", "ping-pong", "seamless"],
      DEFAULT_VIDEO_RECIPE_SETTINGS.loopMode,
    ),
    fps: Math.round(
      normalizeBoundedNumber(
        value.fps,
        DEFAULT_VIDEO_RECIPE_SETTINGS.fps,
        8,
        30,
      ),
    ),
    numFrames: Math.round(
      normalizeBoundedNumber(
        value.numFrames,
        DEFAULT_VIDEO_RECIPE_SETTINGS.numFrames,
        9,
        257,
      ),
    ),
    memoryProfile: normalizeOneOf(
      value.memoryProfile,
      ["auto", "memory-saver", "balanced", "maximum-speed"],
      DEFAULT_VIDEO_RECIPE_SETTINGS.memoryProfile,
    ),
  };
};

const normalizeShortStrings = (
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): string[] => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((entry) => {
        if (typeof entry !== "string") return [];
        const normalized = entry.trim().slice(0, maximumLength);
        return normalized ? [normalized] : [];
      }),
    ),
  ].slice(0, maximumItems);
};

const normalizeAssetMetadata = (
  value: unknown,
  categories: readonly MediaAssetCategory[],
): Record<string, MediaGenerationAssetMetadata> => {
  if (!isRecord(value)) return {};
  const categoryIds = new Set(categories.map((category) => category.id));
  return Object.fromEntries(
    Object.entries(value).flatMap(([resourceId, entry]) => {
      if (!resourceId.trim() || !isRecord(entry)) return [];
      const sampleImages = Array.isArray(entry.sampleImages)
        ? entry.sampleImages
            .flatMap((image) => {
              if (!isRecord(image) || typeof image.url !== "string") return [];
              const url = normalizeMediaCivitaiSampleImageUrl(image.url);
              if (!url) return [];
              return [
                {
                  url,
                  width: typeof image.width === "number" ? image.width : null,
                  height:
                    typeof image.height === "number" ? image.height : null,
                },
              ];
            })
            .slice(0, 12)
        : [];
      return [
        [
          resourceId,
          {
            categoryIds: normalizeShortStrings(
              entry.categoryIds,
              24,
              128,
            ).filter((categoryId) => categoryIds.has(categoryId)),
            tags: normalizeShortStrings(entry.tags, 24, 64),
            triggerWords: normalizeMediaTriggerWords(
              typeof entry.triggerWords === "string" ? entry.triggerWords : [],
            ),
            sourceUrl:
              typeof entry.sourceUrl === "string"
                ? normalizeMediaExternalLink(entry.sourceUrl)
                : null,
            sampleAssetIds: normalizeShortStrings(
              entry.sampleAssetIds,
              12,
              256,
            ),
            sampleImages,
          } satisfies MediaGenerationAssetMetadata,
        ],
      ];
    }),
  );
};

export const normalizeImageRecipeSettings = (
  value: unknown,
): ImageRecipeSettings => {
  if (!isRecord(value)) {
    return { ...DEFAULT_IMAGE_RECIPE_SETTINGS };
  }

  const baseImageAssetId =
    typeof value.baseImageAssetId === "string" &&
    value.baseImageAssetId.trim().length > 0
      ? value.baseImageAssetId.trim().slice(0, 256)
      : null;
  const poseImageAssetId =
    typeof value.poseImageAssetId === "string" &&
    value.poseImageAssetId.trim().length > 0 &&
    value.poseImageAssetId.trim() !== baseImageAssetId
      ? value.poseImageAssetId.trim().slice(0, 256)
      : null;
  const editMask = normalizeMediaImageMask(value.editMask);
  const poseStart = normalizeBoundedNumber(
    value.poseStart,
    DEFAULT_IMAGE_RECIPE_SETTINGS.poseStart,
    0,
    0.95,
  );
  const poseEnd = normalizeBoundedNumber(
    value.poseEnd,
    DEFAULT_IMAGE_RECIPE_SETTINGS.poseEnd,
    0.05,
    1,
  );

  return {
    prompt:
      typeof value.prompt === "string" ? value.prompt.slice(0, 8_000) : "",
    providerPolicy: normalizeOneOf<MediaProviderPolicy>(
      value.providerPolicy,
      ["auto", "local", "remote"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.providerPolicy,
    ),
    modelPolicy: normalizeOneOf(
      value.modelPolicy,
      ["balanced", "fast", "quality"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.modelPolicy,
    ),
    modelId:
      typeof value.modelId === "string" && value.modelId.trim()
        ? value.modelId.trim()
        : null,
    aspectRatio: normalizeOneOf(
      value.aspectRatio,
      ["1:1", "4:5", "16:9", "9:16"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.aspectRatio,
    ),
    outputCount: normalizeOutputCount(value.outputCount),
    outputFormat: normalizeOneOf(
      value.outputFormat,
      ["png", "jpeg", "webp", "svg"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.outputFormat,
    ),
    transparentBackground: value.transparentBackground === true,
    qualityGateEnabled: value.qualityGateEnabled !== false,
    referenceImages: normalizeReferenceImages(value.referenceImages),
    baseImageAssetId,
    poseImageAssetId,
    poseStrength: normalizeBoundedNumber(
      value.poseStrength,
      DEFAULT_IMAGE_RECIPE_SETTINGS.poseStrength,
      0,
      2,
    ),
    poseStart: Math.min(poseStart, poseEnd - 0.05),
    poseEnd: Math.max(poseEnd, poseStart + 0.05),
    editMask: editMask?.sourceAssetId === baseImageAssetId ? editMask : null,
    editStrength: normalizeBoundedNumber(
      value.editStrength,
      DEFAULT_IMAGE_RECIPE_SETTINGS.editStrength,
      0,
      1,
    ),
    maskStrength: normalizeBoundedNumber(
      value.maskStrength,
      DEFAULT_IMAGE_RECIPE_SETTINGS.maskStrength,
      0,
      1,
    ),
    seed:
      typeof value.seed === "number" &&
      Number.isSafeInteger(value.seed) &&
      value.seed >= 0
        ? value.seed
        : null,
    requireChromaBackground: value.requireChromaBackground === true,
    memoryProfile: normalizeOneOf<
      NonNullable<ImageRecipeSettings["memoryProfile"]>
    >(
      value.memoryProfile,
      ["auto", "memory-saver", "balanced", "maximum-speed"] as const,
      DEFAULT_IMAGE_RECIPE_SETTINGS.memoryProfile,
    ),
    modelAddons: normalizeModelAddons(value.modelAddons),
    svgMode: normalizeOneOf<NonNullable<ImageRecipeSettings["svgMode"]>>(
      value.svgMode,
      ["generate", "vectorize"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.svgMode,
    ),
    svgAutoCrop: value.svgAutoCrop !== false,
    svgTargetSize:
      typeof value.svgTargetSize === "number" &&
      Number.isFinite(value.svgTargetSize)
        ? Math.min(4_096, Math.max(128, Math.round(value.svgTargetSize)))
        : DEFAULT_IMAGE_RECIPE_SETTINGS.svgTargetSize,
    svgStyle: normalizeOneOf<NonNullable<ImageRecipeSettings["svgStyle"]>>(
      value.svgStyle,
      ["illustration", "icon", "logo", "diagram", "technical"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.svgStyle,
    ),
    svgTextPolicy: normalizeOneOf<
      NonNullable<ImageRecipeSettings["svgTextPolicy"]>
    >(
      value.svgTextPolicy,
      ["avoid", "editable", "outlines"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.svgTextPolicy,
    ),
    svgCandidateCount: Math.min(
      16,
      Math.max(
        normalizeOutputCount(value.outputCount),
        typeof value.svgCandidateCount === "number" &&
          Number.isFinite(value.svgCandidateCount)
          ? Math.round(value.svgCandidateCount)
          : DEFAULT_IMAGE_RECIPE_SETTINGS.svgCandidateCount,
      ),
    ),
    svgCriticEnabled: value.svgCriticEnabled === true,
  };
};

const normalizeRunStatus = (value: unknown): MediaRunStatus => {
  return normalizeOneOf<MediaRunStatus>(
    value,
    [
      "draft",
      "blocked",
      "ready",
      "queued",
      "running",
      "waiting-for-review",
      "needs-review",
      "canceling",
      "completed",
      "failed",
      "canceled",
    ],
    "draft",
  );
};

const normalizeExecutionTarget = (
  value: unknown,
): MediaExecutionTarget | null => {
  if (value === "local" || value === "remote") {
    return value;
  }

  return null;
};

const normalizeRun = (value: unknown): MediaRunRecord | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const flowId = typeof value.flowId === "string" ? value.flowId.trim() : "";
  const planId = typeof value.planId === "string" ? value.planId.trim() : "";
  const createdAt =
    typeof value.createdAt === "string" ? value.createdAt.trim() : "";

  if (!id || !flowId || !planId || !createdAt) {
    return undefined;
  }

  return {
    id,
    flowId,
    flowRevisionId:
      typeof value.flowRevisionId === "string" && value.flowRevisionId.trim()
        ? value.flowRevisionId.trim()
        : null,
    planId,
    createdAt,
    flowName:
      typeof value.flowName === "string" && value.flowName.trim()
        ? value.flowName.trim()
        : "Create image",
    status: normalizeRunStatus(value.status),
    prompt:
      typeof value.prompt === "string" ? value.prompt.slice(0, 8_000) : "",
    modelLabel:
      typeof value.modelLabel === "string" && value.modelLabel.trim()
        ? value.modelLabel.trim()
        : "Unresolved model",
    target: normalizeExecutionTarget(value.target),
    outputCount:
      typeof value.outputCount === "number"
        ? Math.max(0, Math.round(value.outputCount))
        : 0,
    diagnosticCount:
      typeof value.diagnosticCount === "number"
        ? Math.max(0, Math.round(value.diagnosticCount))
        : 0,
  };
};

const normalizeStoredFlow = (value: unknown): MediaFlow | null => {
  if (!isRecord(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 2_000_000) return null;
    const candidate = JSON.parse(serialized) as MediaFlow;
    if (
      candidate.schemaVersion !== 1 ||
      typeof candidate.id !== "string" ||
      candidate.id.trim().length === 0 ||
      candidate.id.length > 256 ||
      typeof candidate.name !== "string" ||
      candidate.name.trim().length === 0 ||
      candidate.name.length > 256 ||
      typeof candidate.description !== "string" ||
      candidate.description.length > 2_000 ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.updatedAt !== "string" ||
      !Array.isArray(candidate.variables) ||
      !isRecord(candidate.variableBindings) ||
      !Array.isArray(candidate.presets) ||
      !(
        candidate.activePresetId === null ||
        typeof candidate.activePresetId === "string"
      ) ||
      !Array.isArray(candidate.nodes) ||
      candidate.nodes.length === 0 ||
      candidate.nodes.length > 1_000 ||
      !Array.isArray(candidate.edges) ||
      candidate.edges.length > 4_000
    ) {
      return null;
    }

    const nodeIds = new Set<string>();
    for (const node of candidate.nodes) {
      const definition =
        isRecord(node) && typeof node.type === "string"
          ? getMediaNodeDefinition(node.type)
          : undefined;
      if (
        !isRecord(node) ||
        typeof node.id !== "string" ||
        node.id.trim().length === 0 ||
        node.id.length > 128 ||
        nodeIds.has(node.id) ||
        typeof node.type !== "string" ||
        !definition ||
        typeof node.version !== "number" ||
        !Number.isInteger(node.version) ||
        typeof node.label !== "string" ||
        node.label.trim().length === 0 ||
        node.label.length > 160 ||
        !["source", "task", "operation", "control", "output"].includes(
          node.layer,
        ) ||
        !isRecord(node.config)
      ) {
        return null;
      }
      node.config = Object.fromEntries(
        Object.entries(node.config).filter(([fieldId]) =>
          definition.fields.some((field) => field.id === fieldId),
        ),
      );
      nodeIds.add(node.id);
    }

    const edgeIds = new Set<string>();
    for (const edge of candidate.edges) {
      if (
        !isRecord(edge) ||
        typeof edge.id !== "string" ||
        edge.id.trim().length === 0 ||
        edge.id.length > 160 ||
        edgeIds.has(edge.id) ||
        typeof edge.fromNodeId !== "string" ||
        typeof edge.fromPortId !== "string" ||
        typeof edge.toNodeId !== "string" ||
        typeof edge.toPortId !== "string" ||
        !nodeIds.has(edge.fromNodeId) ||
        !nodeIds.has(edge.toNodeId)
      ) {
        return null;
      }
      edgeIds.add(edge.id);
    }

    return validateMediaFlowVariableDocument(candidate).length === 0
      ? candidate
      : null;
  } catch {
    return null;
  }
};

const normalizeFlowLayout = (
  value: unknown,
): MediaStudioState["flowLayout"] => {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return null;
  }

  const flowId = typeof value.flowId === "string" ? value.flowId.trim() : "";
  if (!flowId) {
    return null;
  }

  const nodes = value.nodes.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const nodeId = typeof entry.nodeId === "string" ? entry.nodeId.trim() : "";
    if (
      !nodeId ||
      typeof entry.x !== "number" ||
      !Number.isFinite(entry.x) ||
      typeof entry.y !== "number" ||
      !Number.isFinite(entry.y)
    ) {
      return [];
    }
    return [
      {
        nodeId,
        x: Math.max(-100_000, Math.min(100_000, entry.x)),
        y: Math.max(-100_000, Math.min(100_000, entry.y)),
      },
    ];
  });
  const knownNodeIds = new Set(nodes.map((node) => node.nodeId));
  const groupedNodeIds = new Set<string>();
  const groupIds = new Set<string>();
  const groups = Array.isArray(value.groups)
    ? value.groups
        .flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const id = typeof entry.id === "string" ? entry.id.trim() : "";
          const label =
            typeof entry.label === "string" ? entry.label.trim() : "";
          if (
            !id ||
            !label ||
            groupIds.has(id) ||
            !Array.isArray(entry.nodeIds)
          ) {
            return [];
          }
          const nodeIds = [...new Set(entry.nodeIds)].flatMap((nodeId) =>
            typeof nodeId === "string" &&
            knownNodeIds.has(nodeId) &&
            !groupedNodeIds.has(nodeId)
              ? [nodeId]
              : [],
          );
          if (nodeIds.length < 2) return [];
          groupIds.add(id);
          for (const nodeId of nodeIds) groupedNodeIds.add(nodeId);
          return [
            {
              id: id.slice(0, 128),
              label: label.slice(0, 80),
              color: normalizeOneOf(
                entry.color,
                ["slate", "cyan", "violet", "amber", "emerald"],
                "cyan",
              ),
              collapsed: entry.collapsed === true,
              nodeIds,
            },
          ];
        })
        .slice(0, 64)
    : [];
  const commentIds = new Set<string>();
  const comments = Array.isArray(value.comments)
    ? value.comments
        .flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const id =
            typeof entry.id === "string" ? entry.id.trim().slice(0, 128) : "";
          const body =
            typeof entry.body === "string"
              ? entry.body.trim().slice(0, 1_000)
              : "";
          if (
            !id ||
            !body ||
            commentIds.has(id) ||
            typeof entry.x !== "number" ||
            !Number.isFinite(entry.x) ||
            typeof entry.y !== "number" ||
            !Number.isFinite(entry.y)
          ) {
            return [];
          }
          commentIds.add(id);
          const width =
            typeof entry.width === "number" && Number.isFinite(entry.width)
              ? entry.width
              : 240;
          const height =
            typeof entry.height === "number" && Number.isFinite(entry.height)
              ? entry.height
              : 120;
          return [
            {
              id,
              body,
              color: normalizeOneOf(
                entry.color,
                ["slate", "cyan", "violet", "amber", "emerald"],
                "amber",
              ),
              x: Math.max(-1_000_000, Math.min(1_000_000, entry.x)),
              y: Math.max(-1_000_000, Math.min(1_000_000, entry.y)),
              width: Math.max(180, Math.min(600, Math.round(width))),
              height: Math.max(80, Math.min(600, Math.round(height))),
            },
          ];
        })
        .slice(0, 64)
    : [];

  return {
    schemaVersion: 1,
    flowId,
    nodes: nodes.slice(0, 1_000),
    groups,
    comments,
  };
};

export const normalizeMediaStudioState = (value: unknown): MediaStudioState => {
  if (!isRecord(value) || value.version !== 5) {
    return {
      ...DEFAULT_MEDIA_STUDIO_STATE,
      recipe: { ...DEFAULT_IMAGE_RECIPE_SETTINGS },
      videoRecipe: { ...DEFAULT_VIDEO_RECIPE_SETTINGS },
      categories: DEFAULT_MEDIA_ASSET_CATEGORIES.map((category) => ({
        ...category,
      })),
      assetMetadata: {},
      flow: null,
      flowLayout: null,
      runs: [],
    };
  }

  const runs = Array.isArray(value.runs)
    ? value.runs.flatMap((entry) => {
        const normalized = normalizeRun(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const categories = normalizeMediaAssetCategories(value.categories);

  return {
    version: 5,
    activeSection: normalizeOneOf<MediaStudioSection>(
      value.activeSection,
      ["generate", "flow", "library", "runs"],
      DEFAULT_MEDIA_STUDIO_STATE.activeSection,
    ),
    target: normalizeOneOf<MediaGenerationTarget>(
      value.target,
      ["image", "video", "svg"],
      DEFAULT_MEDIA_STUDIO_STATE.target,
    ),
    recipe: normalizeImageRecipeSettings(value.recipe),
    videoRecipe: normalizeVideoRecipeSettings(value.videoRecipe),
    categories,
    assetMetadata: normalizeAssetMetadata(value.assetMetadata, categories),
    flow: normalizeStoredFlow(value.flow),
    flowLayout: normalizeFlowLayout(value.flowLayout),
    runs: runs.slice(0, MAX_STORED_RUNS),
  };
};

export const loadMediaStudioState = async (): Promise<MediaStudioState> => {
  return loadStoredValue<MediaStudioState>({
    storageKey: MEDIA_STUDIO_STORAGE_KEY,
    fallback: normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE),
    normalize: normalizeMediaStudioState,
    tauriErrorMessage: "Failed to load Media Studio state from Tauri store",
    localStorageErrorMessage:
      "Failed to load Media Studio state from localStorage",
  });
};

export const saveMediaStudioState = async (
  state: MediaStudioState,
): Promise<void> => {
  const saved = await saveStoredValue({
    storageKey: MEDIA_STUDIO_STORAGE_KEY,
    value: normalizeMediaStudioState(state),
    tauriErrorMessage: "Failed to persist Media Studio state to Tauri store",
    localStorageErrorMessage:
      "Failed to persist Media Studio state to localStorage",
  });

  if (!saved) {
    throw new Error("Media Studio state could not be persisted.");
  }
};
