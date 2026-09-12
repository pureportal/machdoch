import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  MediaGenerationQueue,
  type EnqueueMediaGenerationInput,
} from "./media-generation-queue";
import { cancelMediaRun, getMediaRunDetail } from "./media-runtime";

export const mediaGenerationQueue = new MediaGenerationQueue({
  readRunDetail: getMediaRunDetail,
  cancelRun: cancelMediaRun,
});

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
  preparations.size > 0 || mediaGenerationQueue.hasPendingWork();

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
