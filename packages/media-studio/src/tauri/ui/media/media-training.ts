import { invoke, isRemoteMedia } from "./media-platform";

export type MediaTrainingConcept = "style" | "face" | "character" | "object";
export type MediaTrainingArchitecture = "krea-2" | "stable-diffusion-xl";

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
}

export interface MediaTrainingJob {
  id: string;
  name: string;
  concept: MediaTrainingConcept;
  triggerPhrase: string;
  architecture: MediaTrainingArchitecture;
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
