import { invoke, isRemoteMedia } from "./media-platform";

export type KreaLoraConcept = "style" | "face" | "character" | "object";

export interface KreaTrainingImage {
  path: string;
  caption: string;
}

export interface KreaTrainingImageInspection {
  path: string;
  width: number;
  height: number;
}

export interface KreaTrainingRequest {
  name: string;
  concept: KreaLoraConcept;
  triggerPhrase: string;
  images: KreaTrainingImage[];
  rawModelPath: string;
  steps: number;
  learningRate: number;
  resolution: 512 | 768 | 1024;
  rank: 16 | 32 | 64;
  attentionOnly: boolean;
  fourBit: boolean;
}

export interface KreaTrainingJob {
  id: string;
  name: string;
  concept: KreaLoraConcept;
  triggerPhrase: string;
}

export interface KreaTrainingStatus {
  state: "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  message: string | null;
  outputPath: string | null;
  canResume: boolean;
  completedSteps: number | null;
  totalSteps: number;
}

const localInvoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  if (isRemoteMedia()) throw new Error("Open Media Studio on this computer to train locally.");
  return invoke(command, args);
};

export const submitKreaTraining = (request: KreaTrainingRequest): Promise<KreaTrainingJob> =>
  localInvoke("media_submit_krea_training", { request });

export const inspectKreaTrainingImages = (paths: string[]): Promise<KreaTrainingImageInspection[]> =>
  localInvoke("media_inspect_krea_training_images", { paths });

export const getKreaTrainingStatus = (requestId: string): Promise<KreaTrainingStatus> =>
  localInvoke("media_get_krea_training_status", { requestId });

export const cancelKreaTraining = (requestId: string): Promise<void> =>
  localInvoke("media_cancel_krea_training", { requestId });

export const resumeKreaTraining = (requestId: string): Promise<void> =>
  localInvoke("media_resume_krea_training", { requestId });

export const finishKreaTraining = (requestId: string): Promise<void> =>
  localInvoke("media_finish_krea_training", { requestId });
