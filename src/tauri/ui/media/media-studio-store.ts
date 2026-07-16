import type {
  ImageRecipeSettings,
  MediaFlow,
  MediaExecutionTarget,
  MediaLoraDenoisingSchedule,
  MediaProviderPolicy,
  MediaRunRecord,
  MediaRunStatus,
  MediaStudioSection,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import { getMediaNodeDefinition } from "../../../core/media/node-registry.js";
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
  outputCount: 4,
  outputFormat: "png",
  transparentBackground: false,
  qualityGateEnabled: true,
  referenceImages: [],
  modelAddons: [],
  svgMode: "generate",
  svgAutoCrop: true,
  svgTargetSize: 1024,
  svgStyle: "illustration",
  svgTextPolicy: "avoid",
  svgCandidateCount: 6,
  svgCriticEnabled: false,
} as const satisfies ImageRecipeSettings;

export const DEFAULT_MEDIA_STUDIO_STATE = {
  version: 3,
  activeSection: "generate",
  recipe: DEFAULT_IMAGE_RECIPE_SETTINGS,
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
    const role: ImageRecipeSettings["referenceImages"][number]["role"] =
      references.length === 0
        ? "base"
        : normalizeOneOf<Exclude<
            ImageRecipeSettings["referenceImages"][number]["role"],
            "base"
          >>(
            entry.role,
            ["subject", "style", "composition", "palette", "detail"] as const,
            "subject",
          );
    const influence = typeof entry.influence === "number" && Number.isFinite(entry.influence)
      ? Math.min(1, Math.max(0, entry.influence))
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

export const normalizeImageRecipeSettings = (
  value: unknown,
): ImageRecipeSettings => {
  if (!isRecord(value)) {
    return { ...DEFAULT_IMAGE_RECIPE_SETTINGS };
  }

  return {
    prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 8_000) : "",
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
    modelAddons: normalizeModelAddons(value.modelAddons),
    svgMode: normalizeOneOf<NonNullable<ImageRecipeSettings["svgMode"]>>(
      value.svgMode,
      ["generate", "vectorize"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.svgMode,
    ),
    svgAutoCrop: value.svgAutoCrop !== false,
    svgTargetSize:
      typeof value.svgTargetSize === "number" && Number.isFinite(value.svgTargetSize)
        ? Math.min(4_096, Math.max(128, Math.round(value.svgTargetSize)))
        : DEFAULT_IMAGE_RECIPE_SETTINGS.svgTargetSize,
    svgStyle: normalizeOneOf<NonNullable<ImageRecipeSettings["svgStyle"]>>(
      value.svgStyle,
      ["illustration", "icon", "logo", "diagram", "technical"],
      DEFAULT_IMAGE_RECIPE_SETTINGS.svgStyle,
    ),
    svgTextPolicy: normalizeOneOf<NonNullable<ImageRecipeSettings["svgTextPolicy"]>>(
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
    prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 8_000) : "",
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
      !(candidate.activePresetId === null || typeof candidate.activePresetId === "string") ||
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
      if (
        !isRecord(node) ||
        typeof node.id !== "string" ||
        node.id.trim().length === 0 ||
        node.id.length > 128 ||
        nodeIds.has(node.id) ||
        typeof node.type !== "string" ||
        !getMediaNodeDefinition(node.type) ||
        typeof node.version !== "number" ||
        !Number.isInteger(node.version) ||
        typeof node.label !== "string" ||
        node.label.trim().length === 0 ||
        node.label.length > 160 ||
        !["source", "task", "operation", "control", "output"].includes(node.layer) ||
        !isRecord(node.config)
      ) {
        return null;
      }
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

const normalizeFlowLayout = (value: unknown): MediaStudioState["flowLayout"] => {
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
    ? value.groups.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        const label = typeof entry.label === "string" ? entry.label.trim() : "";
        if (!id || !label || groupIds.has(id) || !Array.isArray(entry.nodeIds)) {
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
        return [{
          id: id.slice(0, 128),
          label: label.slice(0, 80),
          color: normalizeOneOf(
            entry.color,
            ["slate", "cyan", "violet", "amber", "emerald"],
            "cyan",
          ),
          collapsed: entry.collapsed === true,
          nodeIds,
        }];
      }).slice(0, 64)
    : [];
  const commentIds = new Set<string>();
  const comments = Array.isArray(value.comments)
    ? value.comments.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = typeof entry.id === "string" ? entry.id.trim().slice(0, 128) : "";
        const body = typeof entry.body === "string" ? entry.body.trim().slice(0, 1_000) : "";
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
        const width = typeof entry.width === "number" && Number.isFinite(entry.width)
          ? entry.width
          : 240;
        const height = typeof entry.height === "number" && Number.isFinite(entry.height)
          ? entry.height
          : 120;
        return [{
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
        }];
      }).slice(0, 64)
    : [];

  return {
    schemaVersion: 1,
    flowId,
    nodes: nodes.slice(0, 1_000),
    groups,
    comments,
  };
};

export const normalizeMediaStudioState = (
  value: unknown,
): MediaStudioState => {
  if (!isRecord(value)) {
    return {
      ...DEFAULT_MEDIA_STUDIO_STATE,
      recipe: { ...DEFAULT_IMAGE_RECIPE_SETTINGS },
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

  return {
    version: 3,
    activeSection: normalizeOneOf<MediaStudioSection>(
      value.activeSection,
      ["generate", "flow", "library", "runs", "models"],
      DEFAULT_MEDIA_STUDIO_STATE.activeSection,
    ),
    recipe: normalizeImageRecipeSettings(value.recipe),
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
