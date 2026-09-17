import type { MediaRunDetail } from "../../../core/media/contracts.js";
import type { MediaGenerationQueueJob } from "./media-generation-queue";
import { countMediaImageRecipeOutputs } from "./media-generation-recipe";

export const generationJobToRunDetail = (
  job: MediaGenerationQueueJob,
): MediaRunDetail => {
  if (job.runDetail) {
    return {
      ...job.runDetail,
      status: job.status,
      currentStep: job.currentStep,
      progress: job.progress,
      error: job.error,
      failure: job.failure,
    };
  }
  return {
    id: job.runId,
    flowId: job.recipe.flowId,
    flowRevisionId: job.recipe.flowRevisionId,
    flowName: job.recipe.flowName,
    planId: job.recipe.planId,
    status: job.status,
    createdAt: job.submittedAt,
    updatedAt: job.completedAt ?? job.startedAt ?? job.submittedAt,
    prompt: job.recipe.prompt,
    modelLabel: job.recipe.modelLabel,
    target:
      job.recipe.modelId === null
        ? null
        : job.recipe.modelId.startsWith("local:")
          ? "local"
          : "remote",
    outputCount: job.recipe.imageSettings
      ? countMediaImageRecipeOutputs(
          job.recipe.imageSettings,
          job.recipe.outputBranches,
        )
      : 1,
    diagnosticCount: 0,
    progress: job.progress,
    currentStep: job.currentStep,
    executor:
      job.recipe.target === "video"
        ? "local-video"
        : job.recipe.target === "svg"
          ? "svg-ai-pipeline"
          : job.recipe.modelId?.startsWith("openai:")
            ? "openai-image-api"
            : job.recipe.modelId === "codex-cli:image-generation"
              ? "codex-cli-image"
              : job.recipe.modelId
                ? "local-image-flow"
                : "local-analysis",
    error: job.error,
    failure: job.failure,
    events: [],
    assets: [...job.assets],
    providerJobs: [],
    humanReviews: [],
    nodeExecutions: [],
    planSnapshot: null,
  };
};
