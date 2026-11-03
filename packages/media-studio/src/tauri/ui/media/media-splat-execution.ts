import { compileMediaFlow } from "../../../core/media/compiler.js";
import { readSplatRecipeSettings } from "../../../core/media/splat-flow.js";
import type {
  GenerateMediaSplatRequest,
  MediaFlowRevision,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";
import type {
  MediaGenerationMode,
  MediaGenerationRecipeSnapshot,
} from "./media-generation-queue.js";

export const prepareSplatSubmission = ({
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
  request: GenerateMediaSplatRequest;
  recipe: MediaGenerationRecipeSnapshot;
} => {
  const flow = revision.flow;
  const settings = readSplatRecipeSettings(flow);
  const plan = compileMediaFlow({ flow, models, compiledAt });
  if (
    !settings?.sourceAssetId ||
    plan.status !== "ready" ||
    !plan.model ||
    plan.flowFingerprint !== revision.executionDigest
  ) {
    throw new Error(
      plan.diagnostics.find((entry) => entry.severity === "error")?.message ??
        "Save the 3D flow and retry generation.",
    );
  }
  const seed = settings.seed ?? randomSeed;
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error("Enter a whole seed from 0 through 9007199254740991.");
  const request: GenerateMediaSplatRequest = {
    schemaVersion: 1,
    runId,
    flowId: flow.id,
    flowRevisionId: revision.revisionId,
    flowName: flow.name,
    planId: plan.id,
    modelId: plan.model.id,
    modelLabel: plan.model.displayName,
    sourceAssetId: settings.sourceAssetId,
    inputKind: settings.inputKind,
    gaussianCount: settings.gaussianCount,
    numInferenceSteps: settings.numInferenceSteps,
    guidanceScale: settings.guidanceScale,
    timeShift: settings.timeShift,
    minOpacity: settings.minOpacity,
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
      target: "splat",
      flowId: flow.id,
      flowName: flow.name,
      flowRevisionId: revision.revisionId,
      flowRevisionNumber: revision.revisionNumber,
      planId: plan.id,
      prompt: "",
      modelId: request.modelId,
      modelLabel: request.modelLabel,
      modelAddons: [],
      outputBranches: [],
      imageSettings: null,
      videoSettings: null,
      splatSettings: { ...settings, modelId: request.modelId, seed },
      resultDestination: "assets",
    },
  };
};
