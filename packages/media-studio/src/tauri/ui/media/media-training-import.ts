import {
  trainingArchitectureMatches,
  type MediaTrainingJob,
} from "./media-training";
import {
  importMediaLocalModel,
  importMediaModelAddon,
  inspectMediaLocalModel,
  inspectMediaModelAddon,
} from "./media-runtime";

export interface ImportedTrainingArtifact {
  id: string;
  architecture: MediaTrainingJob["architecture"];
  method: MediaTrainingJob["method"];
  baseModelId: MediaTrainingJob["baseModelId"];
}

export async function importTrainingArtifact(
  job: MediaTrainingJob,
  outputPath: string,
): Promise<ImportedTrainingArtifact> {
  if (job.method === "finetune") {
    const inspection = await inspectMediaLocalModel(outputPath);
    if (
      !inspection.canImport ||
      !trainingArchitectureMatches(
        inspection.detectedArchitecture,
        job.architecture,
      )
    )
      throw new Error(
        inspection.blockingReason ??
          "The trained model does not match its base model.",
      );
    const result = await importMediaLocalModel({
      sourcePath: outputPath,
      reviewToken: inspection.reviewToken,
      displayName: job.name,
      architecture: job.architecture,
      sourceUrl: null,
      licenseName: null,
      commercialUse: null,
    });
    return {
      id: result.modelId,
      architecture: job.architecture,
      method: job.method,
      baseModelId: job.baseModelId,
    };
  }
  const inspection = await inspectMediaModelAddon(outputPath);
  if (
    !inspection.canImport ||
    !trainingArchitectureMatches(
      inspection.detectedArchitecture,
      job.architecture,
    )
  )
    throw new Error(
      inspection.blockingReason ??
        "The trained weights do not match their base model.",
    );
  const result = await importMediaModelAddon({
    sourcePath: outputPath,
    reviewToken: inspection.reviewToken,
    displayName: job.name,
    kind: job.method === "embedding" ? "textual-inversion" : "lora",
    architecture: job.architecture,
    triggerWords: [job.triggerPhrase],
    token: job.method === "embedding" ? job.triggerPhrase : null,
    sourceUrl: null,
    licenseName: null,
    commercialUse: null,
  });
  return {
    id: result.addonId,
    architecture: job.architecture,
    method: job.method,
    baseModelId: job.baseModelId,
  };
}
