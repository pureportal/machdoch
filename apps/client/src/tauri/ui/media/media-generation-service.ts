import { mediaImportQueue } from "./media-import-queue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  MediaGenerationQueue,
  type EnqueueMediaGenerationInput,
} from "./media-generation-queue";
import { cancelMediaRun, getMediaRunDetail } from "./media-runtime";
import { generationJobToRunDetail } from "./media-generation-run";
import type { MediaRunDetail } from "../../../core/media/contracts.js";

export const mediaGenerationQueue = new MediaGenerationQueue({
  readRunDetail: getMediaRunDetail,
  cancelRun: cancelMediaRun,
});

export const getMediaGenerationRunDetail = (
  runId: string,
): Promise<MediaRunDetail> => {
  const job = mediaGenerationQueue.getJob(runId);
  return job
    ? Promise.resolve(generationJobToRunDetail(job))
    : getMediaRunDetail(runId);
};

const preparations = new Set<symbol>();
let activityUpdate = Promise.resolve();
let activityRetry: ReturnType<typeof setTimeout> | undefined;

const synchronizeMediaActivity = (): Promise<void> => {
  if (!isTauri()) return Promise.resolve();
  clearTimeout(activityRetry);
  const pending = hasPendingMediaGeneration();
  const update = activityUpdate.then(() =>
    invoke<void>("set_window_pending_media_work", { pending }),
  );
  activityUpdate = update.catch((error: unknown) => {
    console.error("Could not synchronize media activity", error);
    activityRetry = setTimeout(() => {
      void synchronizeMediaActivity();
    }, 1_000);
  });
  return update;
};

export const setMediaGenerationPreparing = (
  id: symbol,
  value: boolean,
): Promise<void> => {
  if (value) preparations.add(id);
  else preparations.delete(id);
  const update = synchronizeMediaActivity();
  return value ? update : activityUpdate;
};

export const hasPendingMediaGeneration = (): boolean =>
  preparations.size > 0 ||
  mediaGenerationQueue.hasPendingWork() ||
  mediaImportQueue.hasPendingWork();

export const enqueueMediaGeneration = (input: EnqueueMediaGenerationInput) =>
  mediaGenerationQueue.enqueue({
    ...input,
    execute: async () => {
      await synchronizeMediaActivity();
      return input.execute();
    },
  });

mediaGenerationQueue.subscribe(() => {
  void synchronizeMediaActivity();
});
void synchronizeMediaActivity();

mediaImportQueue.subscribe(() => {
  void synchronizeMediaActivity();
});
