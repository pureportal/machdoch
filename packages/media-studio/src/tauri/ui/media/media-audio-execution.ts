import { compileMediaFlow } from "../../../core/media/compiler.js";
import { readAudioRecipeSettings } from "../../../core/media/audio-flow.js";
import type {
  GenerateMediaAudioRequest,
  MediaFlowRevision,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";
import type {
  MediaGenerationMode,
  MediaGenerationRecipeSnapshot,
} from "./media-generation-queue.js";

export const prepareAudioSubmission = ({
  revision,
  models,
  runId,
  mode,
  compiledAt,
  randomSeed,
}: {
  revision: MediaFlowRevision;
  models: readonly MediaModelDescriptor[];
  runId: string;
  mode: MediaGenerationMode;
  compiledAt: string;
  randomSeed: number;
}): {
  request: GenerateMediaAudioRequest;
  recipe: MediaGenerationRecipeSnapshot;
} => {
  const flow = revision.flow;
  const settings = readAudioRecipeSettings(flow);
  const plan = compileMediaFlow({ flow, models, compiledAt });
  if (
    !settings ||
    plan.status !== "ready" ||
    !plan.model ||
    plan.flowFingerprint !== revision.executionDigest
  ) {
    throw new Error(
      plan.diagnostics.find((entry) => entry.severity === "error")?.message ??
        "Save the audio flow and retry generation.",
    );
  }
  const seed = settings.seed ?? randomSeed;
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error("Enter a whole seed from 0 through 9007199254740991.");
  const request: GenerateMediaAudioRequest = {
    schemaVersion: 1,
    runId,
    flowId: flow.id,
    flowRevisionId: revision.revisionId,
    flowName: flow.name,
    planId: plan.id,
    modelId: plan.model.id,
    modelLabel: plan.model.displayName,
    prompt: settings.prompt.trim(),
    negativePrompt: settings.negativePrompt.trim(),
    durationSeconds: settings.durationSeconds,
    numInferenceSteps: settings.numInferenceSteps,
    guidanceScale: settings.guidanceScale,
    seed,
    diagnosticCount: plan.diagnostics.length,
    planSnapshot: {
      schemaVersion: 1,
      planId: plan.id,
      flowId: flow.id,
      flowFingerprint: plan.flowFingerprint,
      compiledAt,
      nodes: flow.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: plan.steps,
    },
  };
  return {
    request,
    recipe: {
      schemaVersion: 1,
      mode,
      target: "audio",
      flowId: flow.id,
      flowName: flow.name,
      flowRevisionId: revision.revisionId,
      flowRevisionNumber: revision.revisionNumber,
      planId: plan.id,
      prompt: request.prompt,
      modelId: request.modelId,
      modelLabel: request.modelLabel,
      modelAddons: [],
      outputBranches: [],
      imageSettings: null,
      videoSettings: null,
      audioSettings: { ...settings, modelId: request.modelId, seed },
      resultDestination: "assets",
    },
  };
};
