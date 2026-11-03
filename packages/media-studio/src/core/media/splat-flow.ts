import { createMediaFlowFingerprint } from "./canonicalize.js";
import {
  describeMediaModelReadiness,
  isMediaModelReady,
} from "./model-readiness.js";
import {
  createDefaultMediaNodeConfig,
  validateMediaFlowDocument,
} from "./node-registry.js";
import { resolveMediaFlowVariables } from "./variables.js";
import type {
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaCompilerDiagnostic,
  MediaFlow,
  MediaModelDescriptor,
  MediaSplatRecipeSettings,
} from "./contracts.js";

export const DEFAULT_SPLAT_RECIPE_SETTINGS: MediaSplatRecipeSettings = {
  sourceAssetId: null,
  modelId: null,
  inputKind: "synthetic",
  gaussianCount: 262_144,
  numInferenceSteps: 50,
  guidanceScale: 3,
  timeShift: 3,
  minOpacity: 0,
  seed: null,
};

const SPLAT_NODE_TYPES = ["source.image", "task.generate-splat", "output.splat"];

export const isMediaSplatModel = (model: MediaModelDescriptor): boolean =>
  model.target === "local" &&
  model.architecture === "idol" &&
  model.capabilities.includes("image-to-3d");

const PLY_BYTES_PER_GAUSSIAN = 68;

export const mediaSplatGaussianCount = (asset: MediaAssetRecord): number => {
  const operation = asset.operation;
  const generation: unknown =
    operation?.kind === "local-splat-generation"
      ? operation.generation
      : operation?.kind === "workflow"
        ? operation.details
        : null;
  const count =
    typeof generation === "object" && generation !== null
      ? (generation as { output?: { gaussianCount?: unknown } }).output?.gaussianCount
      : undefined;
  return typeof count === "number" ? count : Math.floor(asset.byteSize / PLY_BYTES_PER_GAUSSIAN);
};

export const mediaSplatSettingsError = (
  settings: MediaSplatRecipeSettings,
): string | null => {
  if (
    !Number.isInteger(settings.gaussianCount) ||
    settings.gaussianCount < 32_768 ||
    settings.gaussianCount > 1_048_576 ||
    settings.gaussianCount % 32 !== 0
  )
    return "Choose 32,768 to 1,048,576 Gaussians in multiples of 32.";
  if (
    !Number.isInteger(settings.numInferenceSteps) ||
    settings.numInferenceSteps < 4 ||
    settings.numInferenceSteps > 100
  )
    return "Choose 4 to 100 steps.";
  if (
    !Number.isFinite(settings.guidanceScale) ||
    settings.guidanceScale < 0 ||
    settings.guidanceScale > 10
  )
    return "Choose a guidance from 0 to 10.";
  if (
    !Number.isFinite(settings.timeShift) ||
    settings.timeShift < 1 ||
    settings.timeShift > 6
  )
    return "Choose a time shift from 1 to 6.";
  if (
    !Number.isFinite(settings.minOpacity) ||
    settings.minOpacity < 0 ||
    settings.minOpacity > 0.5
  )
    return "Choose a cleanup from 0 to 0.5.";
  if (
    settings.seed !== null &&
    (!Number.isSafeInteger(settings.seed) || settings.seed < 0)
  )
    return "Enter a whole seed from 0 through 9007199254740991.";
  return null;
};

export const createSplatRecipeFlow = ({
  id,
  createdAt,
  settings,
}: {
  id: string;
  createdAt: string;
  settings: MediaSplatRecipeSettings;
}): MediaFlow => ({
  schemaVersion: 1,
  id,
  name: "Create 3D",
  description: "",
  createdAt,
  updatedAt: createdAt,
  variables: [],
  variableBindings: {},
  presets: [],
  activePresetId: null,
  nodes: [
    {
      id: "source",
      type: "source.image",
      version: 1,
      label: "Image",
      layer: "source",
      config: {
        ...createDefaultMediaNodeConfig("source.image"),
        assetId: settings.sourceAssetId ?? "",
      },
    },
    {
      id: "generate",
      type: "task.generate-splat",
      version: 1,
      label: "Generate 3D",
      layer: "task",
      config: {
        modelId: settings.modelId,
        inputKind: settings.inputKind,
        gaussianCount: settings.gaussianCount,
        numInferenceSteps: settings.numInferenceSteps,
        guidanceScale: settings.guidanceScale,
        timeShift: settings.timeShift,
        minOpacity: settings.minOpacity,
        seed: settings.seed,
      },
    },
    {
      id: "output",
      type: "output.splat",
      version: 1,
      label: "Save 3D",
      layer: "output",
      config: { format: "ply" },
    },
  ],
  edges: [
    {
      id: "source-generate",
      fromNodeId: "source",
      fromPortId: "image",
      toNodeId: "generate",
      toPortId: "image",
    },
    {
      id: "generate-output",
      fromNodeId: "generate",
      fromPortId: "splat",
      toNodeId: "output",
      toPortId: "splat",
    },
  ],
});

export const readSplatRecipeSettings = (
  flow: MediaFlow,
): MediaSplatRecipeSettings | null => {
  const resolved = resolveMediaFlowVariables(flow).flow;
  const node = resolved.nodes.find(
    (entry) => entry.type === "task.generate-splat",
  );
  const source = resolved.nodes.find((entry) => entry.type === "source.image");
  if (!node || !source) return null;
  const {
    modelId,
    inputKind,
    gaussianCount,
    numInferenceSteps,
    guidanceScale,
    timeShift,
    minOpacity,
    seed,
  } = node.config;
  const assetId = source.config.assetId;
  if (
    !(modelId === null || typeof modelId === "string") ||
    (inputKind !== "synthetic" && inputKind !== "real") ||
    typeof gaussianCount !== "number" ||
    typeof numInferenceSteps !== "number" ||
    typeof guidanceScale !== "number" ||
    typeof timeShift !== "number" ||
    typeof minOpacity !== "number" ||
    !(seed === null || typeof seed === "number") ||
    typeof assetId !== "string"
  )
    return null;
  return {
    sourceAssetId: assetId.trim() || null,
    modelId,
    inputKind,
    gaussianCount,
    numInferenceSteps,
    guidanceScale,
    timeShift,
    minOpacity,
    seed,
  };
};

export const compileSplatFlow = ({
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
  const diagnostics: MediaCompilerDiagnostic[] = resolution.issues.map(
    (issue) => ({
      code: issue.code,
      severity: "error",
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
      message: issue.message,
    }),
  );
  for (const issue of validateMediaFlowDocument(resolved))
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      nodeId: issue.nodeId,
      message: issue.message,
    });
  const task = resolved.nodes.find(
    (node) => node.type === "task.generate-splat",
  );
  if (
    resolved.nodes.length !== 3 ||
    resolved.edges.length !== 2 ||
    SPLAT_NODE_TYPES.some(
      (type) => resolved.nodes.filter((node) => node.type === type).length !== 1,
    )
  )
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: "Connect one image, one 3D generator, and one 3D output.",
    });
  const settings = readSplatRecipeSettings(resolved);
  if (!settings?.sourceAssetId)
    diagnostics.push({
      code: "SOURCE_ASSET_REQUIRED",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: "Choose an image of one object.",
    });
  const settingsError = settings ? mediaSplatSettingsError(settings) : null;
  if (settingsError)
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: settingsError,
    });
  const candidates = models.filter(isMediaSplatModel);
  const model = task?.config.modelId
    ? (models.find((entry) => entry.id === task.config.modelId) ?? null)
    : (candidates.find(isMediaModelReady) ?? candidates[0] ?? null);
  if (!model)
    diagnostics.push({
      code: "MODEL_NOT_FOUND",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: "Choose a 3D model.",
    });
  else if (!candidates.includes(model))
    diagnostics.push({
      code: "MODEL_CAPABILITY_UNSUPPORTED",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: "Choose Idol.",
    });
  else if (!isMediaModelReady(model))
    diagnostics.push({
      code: "MODEL_NOT_READY",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message:
        describeMediaModelReadiness(model)?.message ?? "Install Idol.",
    });
  const fingerprint = createMediaFlowFingerprint(flow);
  const source = resolved.nodes.find((node) => node.type === "source.image");
  return {
    schemaVersion: 1,
    id: `${flow.id}:${fingerprint.slice(7, 18)}`,
    flowId: flow.id,
    flowFingerprint: fingerprint,
    status: diagnostics.some((entry) => entry.severity === "error")
      ? "blocked"
      : "ready",
    compiledAt,
    model,
    runtimeBindings:
      task && model
        ? [
            {
              nodeId: task.id,
              modality: "splat",
              requiredCapabilities: ["image-to-3d"],
              model,
            },
          ]
        : [],
    addons: [],
    diagnostics,
    steps: task
      ? [
          ...(source
            ? [
                {
                  id: `${source.id}:resolve-asset`,
                  sourceNodeId: source.id,
                  kind: "resolve-asset" as const,
                  label: "Resolve image",
                  target: "orchestrator" as const,
                  cacheable: true,
                },
              ]
            : []),
          {
            id: `${task.id}:generate-splat`,
            sourceNodeId: task.id,
            kind: "generate-splat",
            label: "Generate 3D",
            target: "local",
            cacheable: true,
          },
          {
            id: "output:ingest",
            sourceNodeId:
              resolved.nodes.find((node) => node.type === "output.splat")?.id ??
              task.id,
            kind: "ingest-asset",
            label: "Save 3D",
            target: "orchestrator",
            cacheable: false,
            sideEffect: "asset-write",
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
