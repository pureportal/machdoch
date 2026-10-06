import { invoke, isRemoteMedia } from "./media-platform";

export type MediaTrainingConcept = "style" | "face" | "character" | "object";
export type MediaTrainingArchitecture =
  | "krea-2"
  | "stable-diffusion-xl"
  | "pony"
  | "stable-diffusion-1"
  | "stable-diffusion-2"
  | "stable-diffusion-3";
export type MediaTrainingMethod = "lora" | "finetune" | "embedding";

export interface MediaTrainingOptions {
  method: MediaTrainingMethod;
  precision: "bf16" | "fp16" | "float32";
  batchSize: number;
  gradientAccumulation: number;
  lrScheduler: "constant" | "linear" | "cosine";
  warmupSteps: number;
  weightDecay: number;
  maxGradNorm: number;
  snrGamma: number;
  noiseOffset: number;
  loraDropout: number;
  checkpointInterval: number;
  checkpointRetention: number;
  gradientCheckpointing: boolean;
  preserveAspectRatio: boolean;
  initializerToken: string;
}

export const TRAINING_ARCHITECTURES: readonly {
  value: MediaTrainingArchitecture;
  label: string;
}[] = [
  { value: "stable-diffusion-xl", label: "SDXL" },
  { value: "pony", label: "Pony (SDXL)" },
  { value: "stable-diffusion-1", label: "Stable Diffusion 1" },
  { value: "stable-diffusion-2", label: "Stable Diffusion 2" },
  { value: "stable-diffusion-3", label: "Stable Diffusion 3" },
  { value: "krea-2", label: "KREA 2 RAW" },
];

export const defaultTrainingOptions = (): MediaTrainingOptions => ({
  method: "lora",
  precision: "bf16",
  batchSize: 1,
  gradientAccumulation: 1,
  lrScheduler: "constant",
  warmupSteps: 0,
  weightDecay: 0.01,
  maxGradNorm: 1,
  snrGamma: 0,
  noiseOffset: 0,
  loraDropout: 0,
  checkpointInterval: 250,
  checkpointRetention: 2,
  gradientCheckpointing: true,
  preserveAspectRatio: false,
  initializerToken: "",
});

export const trainingArchitectureMatches = (
  left: string | null,
  right: MediaTrainingArchitecture,
): boolean =>
  left === right ||
  (["stable-diffusion-xl", "pony"].includes(left ?? "") &&
    ["stable-diffusion-xl", "pony"].includes(right));

export interface MediaTrainingImage {
  path: string;
  caption: string;
}

export interface MediaTrainingImageInspection {
  path: string;
  width: number;
  height: number;
}

export interface MediaTrainingRequest {
  name: string;
  concept: MediaTrainingConcept;
  triggerPhrase: string;
  images: MediaTrainingImage[];
  architecture: MediaTrainingArchitecture;
  modelId: string | null;
  modelPath: string;
  steps: number;
  learningRate: number;
  resolution: 512 | 768 | 1024;
  rank: 4 | 8 | 16 | 32 | 64;
  attentionOnly: boolean;
  fourBit: boolean;
  seed: number;
  options: MediaTrainingOptions;
}

export interface MediaTrainingJob {
  id: string;
  name: string;
  concept: MediaTrainingConcept;
  triggerPhrase: string;
  architecture: MediaTrainingArchitecture;
  method: MediaTrainingMethod;
  baseModelId: string | null;
}

export interface MediaTrainingStatus {
  state:
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  message: string | null;
  outputPath: string | null;
  canResume: boolean;
  completedSteps: number | null;
  totalSteps: number;
  progress: {
    completedSteps: number;
    totalSteps: number;
    loss: number;
    learningRate: number;
    elapsedSeconds: number;
    remainingSeconds: number;
  } | null;
}

const localInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  if (isRemoteMedia())
    throw new Error("Open Media Studio on this computer to train locally.");
  return invoke(command, args);
};

export const submitTraining = (
  request: MediaTrainingRequest,
): Promise<MediaTrainingJob> =>
  localInvoke("media_submit_training", { request });

export const inspectTrainingImages = (
  paths: string[],
): Promise<MediaTrainingImageInspection[]> =>
  localInvoke("media_inspect_training_images", { paths });

export const getTrainingStatus = (
  requestId: string,
): Promise<MediaTrainingStatus> =>
  localInvoke("media_get_training_status", { requestId });

export const cancelTraining = (requestId: string): Promise<void> =>
  localInvoke("media_cancel_training", { requestId });

export const resumeTraining = (requestId: string): Promise<void> =>
  localInvoke("media_resume_training", { requestId });

export const finishTraining = (requestId: string): Promise<void> =>
  localInvoke("media_finish_training", { requestId });
