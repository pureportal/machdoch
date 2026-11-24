import { createMediaFlowFingerprint } from "./canonicalize.js";
import {
  describeMediaModelReadiness,
  isMediaModelReady,
} from "./model-readiness.js";
import {
  createDefaultMediaNodeConfig,
  validateMediaFlowDocument,
  type MediaNumberRange,
} from "./node-registry.js";
import { resolveMediaFlowVariables } from "./variables.js";
import {
  MEDIA_MESH_STYLES,
  MEDIA_MESH_VIEWS,
  type MediaAssetRecord,
  type MediaCompiledPlan,
  type MediaCompilerDiagnostic,
  type MediaFlow,
  type MediaFlowNode,
  type MediaMeshRecipeSettings,
  type MediaMeshStyle,
  type MediaMeshView,
  type MediaMeshViewAssets,
  type MediaModelDescriptor,
} from "./contracts.js";

export const MEDIA_MESH_VIEW_LABELS: Readonly<Record<MediaMeshView, string>> = {
  front: "Front",
  left: "Left",
  back: "Back",
  right: "Right",
};

export interface MediaMeshModelProfile {
  numInferenceSteps: number;
  stepsRecommended: MediaNumberRange;
}

const STANDARD_PROFILE: MediaMeshModelProfile = {
  numInferenceSteps: 30,
  stepsRecommended: { min: 25, max: 50 },
};

const TURBO_PROFILE: MediaMeshModelProfile = {
  numInferenceSteps: 5,
  stepsRecommended: { min: 4, max: 10 },
};

export const mediaMeshModelProfile = (
  model: MediaModelDescriptor | null,
): MediaMeshModelProfile =>
  model?.architecture === "hunyuan3d-2mv-turbo" ? TURBO_PROFILE : STANDARD_PROFILE;

export const DEFAULT_MESH_RECIPE_SETTINGS: MediaMeshRecipeSettings = {
  viewAssetIds: {},
  modelId: null,
  removeBackground: true,
  numInferenceSteps: TURBO_PROFILE.numInferenceSteps,
  guidanceScale: 5,
  octreeResolution: 384,
  numChunks: 20_000,
  removeFloaters: true,
  maxFaceCount: 200_000,
  style: "smooth",
  voxelResolution: 64,
  voxelFill: 0.5,
  polygonCount: 1_500,
  seed: null,
};

export const isMediaMeshModel = (model: MediaModelDescriptor): boolean =>
  model.target === "local" &&
  model.packageType === "hunyuan3d" &&
  model.capabilities.includes("multiview-to-3d");

const isMediaMeshStyle = (value: unknown): value is MediaMeshStyle =>
  MEDIA_MESH_STYLES.some((style) => style === value);

const viewNodeId = (view: MediaMeshView): string => `view-${view}`;

const integerInRange = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

export const mediaMeshSettingsError = (
  settings: MediaMeshRecipeSettings,
): string | null => {
  if (!integerInRange(settings.numInferenceSteps, 1, 100))
    return "Choose 1 to 100 steps.";
  if (
    !Number.isFinite(settings.guidanceScale) ||
    settings.guidanceScale < 0 ||
    settings.guidanceScale > 15
  )
    return "Choose a guidance from 0 to 15.";
  if (!integerInRange(settings.octreeResolution, 64, 512))
    return "Choose a resolution from 64 to 512.";
  if (!integerInRange(settings.numChunks, 1_000, 500_000))
    return "Choose a decode batch from 1,000 to 500,000.";
  if (
    settings.maxFaceCount !== null &&
    !integerInRange(settings.maxFaceCount, 1_000, 2_000_000)
  )
    return "Choose a face limit from 1,000 to 2,000,000, or leave it empty.";
  if (!integerInRange(settings.voxelResolution, 8, 128))
    return "Choose a voxel resolution from 8 to 128.";
  if (
    !Number.isFinite(settings.voxelFill) ||
    settings.voxelFill < 0.1 ||
    settings.voxelFill > 0.9
  )
    return "Choose a voxel fill from 0.1 to 0.9.";
  if (!integerInRange(settings.polygonCount, 100, 20_000))
    return "Choose a polygon count from 100 to 20,000.";
  if (
    settings.seed !== null &&
    (!Number.isSafeInteger(settings.seed) || settings.seed < 0)
  )
    return "Enter a whole seed from 0 through 9007199254740991.";
  return null;
};

export const meshRecipeViews = (
  viewAssetIds: MediaMeshViewAssets,
): MediaMeshView[] => MEDIA_MESH_VIEWS.filter((view) => Boolean(viewAssetIds[view]));

export const createMeshRecipeFlow = ({
  id,
  createdAt,
  settings,
}: {
  id: string;
  createdAt: string;
  settings: MediaMeshRecipeSettings;
}): MediaFlow => {
  const views: MediaMeshView[] = [
    "front",
    ...meshRecipeViews(settings.viewAssetIds).filter((view) => view !== "front"),
  ];
  const sources: MediaFlowNode[] = views.map((view) => ({
    id: viewNodeId(view),
    type: "source.image",
    version: 1,
    label: `${MEDIA_MESH_VIEW_LABELS[view]} view`,
    layer: "source",
    config: {
      ...createDefaultMediaNodeConfig("source.image"),
      assetId: settings.viewAssetIds[view] ?? "",
    },
  }));
  return {
    schemaVersion: 1,
    id,
    name: "Create 3D mesh",
    description: "",
    createdAt,
    updatedAt: createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes: [
      ...sources,
      {
        id: "generate",
        type: "task.generate-mesh",
        version: 1,
        label: "Generate 3D mesh",
        layer: "task",
        config: {
          modelId: settings.modelId,
          removeBackground: settings.removeBackground,
          numInferenceSteps: settings.numInferenceSteps,
          guidanceScale: settings.guidanceScale,
          octreeResolution: settings.octreeResolution,
          numChunks: settings.numChunks,
          removeFloaters: settings.removeFloaters,
          maxFaceCount: settings.maxFaceCount,
          style: settings.style,
          voxelResolution: settings.voxelResolution,
          voxelFill: settings.voxelFill,
          polygonCount: settings.polygonCount,
          seed: settings.seed,
        },
      },
      {
        id: "output",
        type: "output.mesh",
        version: 1,
        label: "Save 3D mesh",
        layer: "output",
        config: { format: "glb" },
      },
    ],
    edges: [
      ...views.map((view) => ({
        id: `${viewNodeId(view)}-generate`,
        fromNodeId: viewNodeId(view),
        fromPortId: "image",
        toNodeId: "generate",
        toPortId: view,
      })),
      {
        id: "generate-output",
        fromNodeId: "generate",
        fromPortId: "mesh",
        toNodeId: "output",
        toPortId: "mesh",
      },
    ],
  };
};

export const readMeshRecipeSettings = (
  flow: MediaFlow,
): MediaMeshRecipeSettings | null => {
  const resolved = resolveMediaFlowVariables(flow).flow;
  const task = resolved.nodes.find((entry) => entry.type === "task.generate-mesh");
  if (!task) return null;
  const viewAssetIds: MediaMeshViewAssets = {};
  for (const edge of resolved.edges) {
    if (edge.toNodeId !== task.id) continue;
    const view = MEDIA_MESH_VIEWS.find((entry) => entry === edge.toPortId);
    const source = resolved.nodes.find((node) => node.id === edge.fromNodeId);
    const assetId = source?.type === "source.image" ? source.config.assetId : null;
    if (!view || typeof assetId !== "string") return null;
    if (assetId.trim()) viewAssetIds[view] = assetId.trim();
  }
  const {
    modelId,
    removeBackground,
    numInferenceSteps,
    guidanceScale,
    octreeResolution,
    numChunks,
    removeFloaters,
    maxFaceCount,
    style,
    voxelResolution,
    voxelFill,
    polygonCount,
    seed,
  } = task.config;
  if (
    !(modelId === null || typeof modelId === "string") ||
    typeof removeBackground !== "boolean" ||
    typeof numInferenceSteps !== "number" ||
    typeof guidanceScale !== "number" ||
    typeof octreeResolution !== "number" ||
    typeof numChunks !== "number" ||
    typeof removeFloaters !== "boolean" ||
    !(maxFaceCount === null || typeof maxFaceCount === "number") ||
    !isMediaMeshStyle(style) ||
    typeof voxelResolution !== "number" ||
    typeof voxelFill !== "number" ||
    typeof polygonCount !== "number" ||
    !(seed === null || typeof seed === "number")
  )
    return null;
  return {
    viewAssetIds,
    modelId,
    removeBackground,
    numInferenceSteps,
    guidanceScale,
    octreeResolution,
    numChunks,
    removeFloaters,
    maxFaceCount,
    style,
    voxelResolution,
    voxelFill,
    polygonCount,
    seed,
  };
};

export const compileMeshFlow = ({
  flow,
  models,
  compiledAt,
}: {
  flow: MediaFlow;
  models: readonly MediaModelDescriptor[];
  compiledAt: string;
}): MediaCompiledPlan => {
  const resolution = resolveMediaFlowVariables(flow);
  const resolved = resolution.flow;
  const diagnostics: MediaCompilerDiagnostic[] = resolution.issues.map((issue) => ({
    code: issue.code,
    severity: "error",
    ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    message: issue.message,
  }));
  for (const issue of validateMediaFlowDocument(resolved))
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      nodeId: issue.nodeId,
      message: issue.message,
    });
  const task = resolved.nodes.find((node) => node.type === "task.generate-mesh");
  const taskNode = task ? { nodeId: task.id } : {};
  const sources = resolved.nodes.filter((node) => node.type === "source.image");
  if (
    !task ||
    resolved.nodes.filter((node) => node.type === "task.generate-mesh").length !== 1 ||
    resolved.nodes.filter((node) => node.type === "output.mesh").length !== 1 ||
    resolved.nodes.length !== sources.length + 2 ||
    resolved.edges.length !== sources.length + 1
  )
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      ...taskNode,
      message: "Connect the views, one 3D mesh generator, and one 3D mesh output.",
    });
  const settings = readMeshRecipeSettings(resolved);
  if (!settings?.viewAssetIds.front)
    diagnostics.push({
      code: "SOURCE_ASSET_REQUIRED",
      severity: "error",
      ...taskNode,
      message: "Add a front view of the object.",
    });
  const settingsError = settings ? mediaMeshSettingsError(settings) : null;
  if (settingsError)
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      ...taskNode,
      message: settingsError,
    });
  const candidates = models.filter(isMediaMeshModel);
  const model = task?.config.modelId
    ? (models.find((entry) => entry.id === task.config.modelId) ?? null)
    : (candidates.find(isMediaModelReady) ?? candidates[0] ?? null);
  if (!model)
    diagnostics.push({
      code: "MODEL_NOT_FOUND",
      severity: "error",
      ...taskNode,
      message: "Choose a 3D mesh model.",
    });
  else if (!candidates.includes(model))
    diagnostics.push({
      code: "MODEL_CAPABILITY_UNSUPPORTED",
      severity: "error",
      ...taskNode,
      message: "Choose Hunyuan3D-2mv or Hunyuan3D-2mv Turbo.",
    });
  else if (!isMediaModelReady(model))
    diagnostics.push({
      code: "MODEL_NOT_READY",
      severity: "error",
      ...taskNode,
      message:
        describeMediaModelReadiness(model)?.message ?? `Install ${model.displayName}.`,
    });
  const fingerprint = createMediaFlowFingerprint(flow);
  return {
    schemaVersion: 1,
    id: `${flow.id}:${fingerprint.slice(7, 18)}`,
    flowId: flow.id,
    flowFingerprint: fingerprint,
    status: diagnostics.some((entry) => entry.severity === "error") ? "blocked" : "ready",
    compiledAt,
    model,
    runtimeBindings:
      task && model
        ? [
            {
              nodeId: task.id,
              modality: "mesh",
              requiredCapabilities: ["multiview-to-3d"],
              model,
            },
          ]
        : [],
    addons: [],
    diagnostics,
    steps: task
      ? [
          ...sources.map((source) => ({
            id: `${source.id}:resolve-asset`,
            sourceNodeId: source.id,
            kind: "resolve-asset" as const,
            label: `Resolve ${source.label.toLowerCase()}`,
            target: "orchestrator" as const,
            cacheable: true,
          })),
          {
            id: `${task.id}:generate-mesh`,
            sourceNodeId: task.id,
            kind: "generate-mesh" as const,
            label: "Generate 3D mesh",
            target: "local" as const,
            cacheable: true,
          },
          {
            id: "output:ingest",
            sourceNodeId:
              resolved.nodes.find((node) => node.type === "output.mesh")?.id ?? task.id,
            kind: "ingest-asset" as const,
            label: "Save 3D mesh",
            target: "orchestrator" as const,
            cacheable: false,
            sideEffect: "asset-write" as const,
          },
        ]
      : [],
    preflight: {
      target: model?.target ?? null,
      modelId: model?.id ?? null,
      modelLabel: model?.displayName ?? "Choose model",
      requiresRemoteRequest: false,
      requiresModelDownload: Boolean(model && !model.installed),
      requiresHumanReview: false,
      remoteUploadAssetIds: [],
      generatedCandidates: 1,
      estimatedOutputs: 1,
      estimatedVramGb: model?.minVramGb ?? null,
      estimatedDownloadGb:
        model && !model.installed ? (model.expectedDownloadGb ?? null) : null,
      costHint: model?.costHint ?? "",
      privacySummary: model?.privacySummary ?? "",
    },
  };
};

export const mediaMeshFaceCount = (asset: MediaAssetRecord): number => {
  const operation = asset.operation;
  const generation: unknown =
    operation?.kind === "local-mesh-generation"
      ? operation.generation
      : operation?.kind === "workflow"
        ? operation.details
        : null;
  const count =
    typeof generation === "object" && generation !== null
      ? (generation as { output?: { faceCount?: unknown } }).output?.faceCount
      : undefined;
  return typeof count === "number" ? count : 0;
};
