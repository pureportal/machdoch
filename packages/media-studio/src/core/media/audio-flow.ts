import { createMediaFlowFingerprint } from "./canonicalize.js";
import {
  describeMediaModelReadiness,
  isMediaModelReady,
} from "./model-readiness.js";
import {
  createDefaultMediaNodeConfig,
  validateMediaFlowDocument,
} from "./node-registry.js";
import { resolveMediaNodePrompt } from "./prompt-resolution.js";
import { resolveMediaFlowVariables } from "./variables.js";
import type {
  MediaAudioRecipeSettings,
  MediaCompiledPlan,
  MediaCompilerDiagnostic,
  MediaFlow,
  MediaModelDescriptor,
} from "./contracts.js";

export const DEFAULT_AUDIO_RECIPE_SETTINGS: MediaAudioRecipeSettings = {
  prompt: "",
  modelId: null,
  negativePrompt: "",
  durationSeconds: 5,
  numInferenceSteps: 100,
  guidanceScale: 3.5,
  seed: null,
};

export const createAudioRecipeFlow = ({
  id,
  createdAt,
  settings,
}: {
  id: string;
  createdAt: string;
  settings: MediaAudioRecipeSettings;
}): MediaFlow => ({
  schemaVersion: 1,
  id,
  name: "Create audio",
  description: "",
  createdAt,
  updatedAt: createdAt,
  variables: [],
  variableBindings: {},
  presets: [],
  activePresetId: null,
  nodes: [
    {
      id: "prompt",
      type: "source.prompt",
      version: 1,
      label: "Prompt",
      layer: "source",
      config: {
        ...createDefaultMediaNodeConfig("source.prompt"),
        prompt: settings.prompt.trim(),
      },
    },
    {
      id: "generate",
      type: "task.generate-audio",
      version: 1,
      label: "Generate audio",
      layer: "task",
      config: {
        modelId: settings.modelId,
        negativePrompt: settings.negativePrompt.trim(),
        durationSeconds: settings.durationSeconds,
        numInferenceSteps: settings.numInferenceSteps,
        guidanceScale: settings.guidanceScale,
        seed: settings.seed,
      },
    },
    {
      id: "output",
      type: "output.audio",
      version: 1,
      label: "Save audio",
      layer: "output",
      config: { format: "wav" },
    },
  ],
  edges: [
    {
      id: "prompt-generate",
      fromNodeId: "prompt",
      fromPortId: "prompt",
      toNodeId: "generate",
      toPortId: "prompt",
    },
    {
      id: "generate-output",
      fromNodeId: "generate",
      fromPortId: "audio",
      toNodeId: "output",
      toPortId: "audio",
    },
  ],
});

export const readAudioRecipeSettings = (
  flow: MediaFlow,
): MediaAudioRecipeSettings | null => {
  const resolved = resolveMediaFlowVariables(flow).flow;
  const node = resolved.nodes.find(
    (entry) => entry.type === "task.generate-audio",
  );
  if (!node) return null;
  const {
    modelId,
    negativePrompt,
    durationSeconds,
    numInferenceSteps,
    guidanceScale,
    seed,
  } = node.config;
  if (
    !(modelId === null || typeof modelId === "string") ||
    typeof negativePrompt !== "string" ||
    typeof durationSeconds !== "number" ||
    typeof numInferenceSteps !== "number" ||
    typeof guidanceScale !== "number" ||
    !(seed === null || typeof seed === "number")
  )
    return null;
  return {
    prompt: resolveMediaNodePrompt(resolved, node.id).prompt ?? "",
    modelId,
    negativePrompt,
    durationSeconds,
    numInferenceSteps,
    guidanceScale,
    seed,
  };
};

export const compileAudioFlow = ({
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
  const tasks = resolved.nodes.filter(
    (node) => node.type === "task.generate-audio",
  );
  if (
    resolved.nodes.length !== 3 ||
    resolved.edges.length !== 2 ||
    resolved.nodes.filter((node) => node.type === "source.prompt").length !==
      1 ||
    tasks.length !== 1 ||
    resolved.nodes.filter((node) => node.type === "output.audio").length !==
      1 ||
    resolved.nodes.some(
      (node) =>
        !["source.prompt", "task.generate-audio", "output.audio"].includes(
          node.type,
        ),
    )
  ) {
    diagnostics.push({
      code: "NODE_SCHEMA_INVALID",
      severity: "error",
      ...(tasks[0] ? { nodeId: tasks[0].id } : {}),
      message: "Connect one prompt, one audio generator, and one audio output.",
    });
  }
  const task = tasks[0];
  const prompt = task ? resolveMediaNodePrompt(resolved, task.id).prompt : null;
  if (!prompt?.trim())
    diagnostics.push({
      code: "PROMPT_REQUIRED",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: "Enter an audio prompt.",
    });
  const candidates = models.filter(
    (model) =>
      model.target === "local" &&
      model.architecture === "audioldm-2" &&
      model.capabilities.includes("text-to-audio"),
  );
  const model = task?.config.modelId
    ? (models.find((entry) => entry.id === task.config.modelId) ?? null)
    : (candidates.find(isMediaModelReady) ?? candidates[0] ?? null);
  if (!model)
    diagnostics.push({
      code: "MODEL_NOT_FOUND",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: "Choose an audio model.",
    });
  else if (!candidates.includes(model))
    diagnostics.push({
      code: "MODEL_CAPABILITY_UNSUPPORTED",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message: "Choose an AudioLDM 2 model.",
    });
  else if (!isMediaModelReady(model))
    diagnostics.push({
      code: "MODEL_NOT_READY",
      severity: "error",
      ...(task ? { nodeId: task.id } : {}),
      message:
        describeMediaModelReadiness(model)?.message ??
        "Install the audio model.",
    });
  const fingerprint = createMediaFlowFingerprint(flow);
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
              modality: "audio",
              requiredCapabilities: ["text-to-audio"],
              model,
            },
          ]
        : [],
    addons: [],
    diagnostics,
    steps: task
      ? [
          {
            id: `${task.id}:generate-audio`,
            sourceNodeId: task.id,
            kind: "generate-audio",
            label: "Generate audio",
            target: "local",
            cacheable: true,
          },
          {
            id: "output:ingest",
            sourceNodeId:
              resolved.nodes.find((node) => node.type === "output.audio")?.id ??
              task.id,
            kind: "ingest-asset",
            label: "Save audio",
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
