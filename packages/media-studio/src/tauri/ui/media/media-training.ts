import { invoke, isRemoteMedia } from "./media-platform";

export type MediaTrainingConcept = "style" | "face" | "character" | "object";
export type MediaTrainingArchitecture =
  | "krea-2"
  | "stable-diffusion-xl"
  | "pony"
  | "stable-diffusion-1"
  | "stable-diffusion-2"
  | "stable-diffusion-3"
  | "flux-1"
  | "flux-1-dev"
  | "flux-1-schnell"
  | "flux-2"
  | "flux-2-klein-base-4b"
  | "flux-2-klein-9b"
  | "flux-2-klein-base-9b"
  | "sana"
  | "z-image"
  | "z-image-turbo"
  | "cogvideox-2b"
  | "cogvideox-1.5-5b"
  | "cogvideox-1.5-5b-i2v"
  | "wan-2.1-t2v-1.3b";
export type MediaTrainingMethod = "lora" | "finetune" | "embedding";

export interface MediaTrainingOptions {
  method: MediaTrainingMethod;
  precision: "bf16" | "fp16" | "float32";
  optimizer: "adamw" | "adafactor";
  trainablePrecision: "bf16" | "float32";
  batchSize: number;
  gradientAccumulation: number;
  lrScheduler: "constant" | "linear" | "cosine";
  warmupSteps: number;
  weightDecay: number;
  maxGradNorm: number;
  snrGamma: number;
  noiseOffset: number;
  loraDropout: number;
  guidanceScale: number;
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
  { value: "flux-1", label: "FLUX.1" },
  { value: "flux-1-dev", label: "FLUX.1 dev" },
  { value: "flux-1-schnell", label: "FLUX.1 Schnell" },
  { value: "flux-2", label: "FLUX.2 Klein 4B" },
  { value: "flux-2-klein-base-4b", label: "FLUX.2 Klein Base 4B" },
  { value: "flux-2-klein-9b", label: "FLUX.2 Klein 9B" },
  { value: "flux-2-klein-base-9b", label: "FLUX.2 Klein Base 9B" },
  { value: "sana", label: "SANA" },
  { value: "z-image", label: "Z-Image Base" },
  { value: "z-image-turbo", label: "Z-Image Turbo" },
  { value: "krea-2", label: "KREA 2 RAW" },
  { value: "cogvideox-2b", label: "CogVideoX 2B" },
  { value: "cogvideox-1.5-5b", label: "CogVideoX 1.5 5B" },
  { value: "cogvideox-1.5-5b-i2v", label: "CogVideoX 1.5 5B I2V" },
  { value: "wan-2.1-t2v-1.3b", label: "Wan 2.1 T2V 1.3B" },
];

export const isVideoTrainingArchitecture = (
  architecture: MediaTrainingArchitecture,
): boolean => architecture.startsWith("cogvideox-") || architecture === "wan-2.1-t2v-1.3b";

export interface MediaTrainingVideoSettings {
  width: number;
  height: number;
  frames: number;
  fps: number;
  image_dropout: number;
}

export const defaultTrainingVideoSettings = (): MediaTrainingVideoSettings => ({
  width: 720,
  height: 480,
  frames: 49,
  fps: 8,
  image_dropout: 0,
});

export const validTrainingVideoSettings = (
  settings: MediaTrainingVideoSettings,
): boolean =>
  [settings.width, settings.height].every(
    (value) =>
      Number.isInteger(value) &&
      value >= 64 &&
      value <= 2048 &&
      value % 16 === 0,
  ) &&
  Number.isInteger(settings.frames) &&
  settings.frames >= 5 &&
  settings.frames <= 161 &&
  (settings.frames - 1) % 4 === 0 &&
  Number.isInteger(settings.fps) &&
  settings.fps >= 1 &&
  settings.fps <= 60 &&
  Number.isFinite(settings.image_dropout) &&
  settings.image_dropout >= 0 &&
  settings.image_dropout <= 1 &&
  settings.width * settings.height * settings.frames * 12 <= 1024 ** 3;

export const defaultTrainingOptions = (): MediaTrainingOptions => ({
  method: "lora",
  precision: "bf16",
  optimizer: "adamw",
  trainablePrecision: "float32",
  batchSize: 1,
  gradientAccumulation: 1,
  lrScheduler: "constant",
  warmupSteps: 0,
  weightDecay: 0.01,
  maxGradNorm: 1,
  snrGamma: 0,
  noiseOffset: 0,
  loraDropout: 0,
  guidanceScale: 3.5,
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
    ["stable-diffusion-xl", "pony"].includes(right)) ||
  (["flux-1", "flux-1-dev", "flux-1-schnell"].includes(left ?? "") &&
    ["flux-1", "flux-1-dev", "flux-1-schnell"].includes(right)) ||
  ([
    "flux-2",
    "flux-2-klein-base-4b",
    "flux-2-klein-9b",
    "flux-2-klein-base-9b",
  ].includes(left ?? "") &&
    [
      "flux-2",
      "flux-2-klein-base-4b",
      "flux-2-klein-9b",
      "flux-2-klein-base-9b",
    ].includes(right)) ||
  (["z-image", "z-image-turbo"].includes(left ?? "") &&
    ["z-image", "z-image-turbo"].includes(right));

export const isFlowTrainingArchitecture = (
  architecture: MediaTrainingArchitecture,
): boolean =>
  [
    "stable-diffusion-3",
    "flux-1",
    "flux-1-dev",
    "flux-1-schnell",
    "flux-2",
    "flux-2-klein-base-4b",
    "flux-2-klein-9b",
    "flux-2-klein-base-9b",
    "sana",
    "z-image",
    "z-image-turbo",
  ].includes(architecture);

export const supportsEmbeddingTraining = (
  architecture: MediaTrainingArchitecture,
): boolean => architecture !== "krea-2";

export interface MediaTrainingSample {
  path: string;
  caption: string;
}

export interface MediaTrainingSampleInspection {
  path: string;
  width: number;
  height: number;
  durationSeconds: number | null;
  fps: number | null;
}

export interface MediaTrainingRequest {
  name: string;
  concept: MediaTrainingConcept;
  triggerPhrase: string;
  samples: MediaTrainingSample[];
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
  video: MediaTrainingVideoSettings | null;
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

export const inspectTrainingSamples = (
  paths: string[],
  architecture: MediaTrainingArchitecture,
): Promise<MediaTrainingSampleInspection[]> =>
  localInvoke("media_inspect_training_samples", { paths, architecture });

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
