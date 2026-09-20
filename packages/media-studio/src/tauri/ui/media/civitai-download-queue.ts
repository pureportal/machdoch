import {
  civitaiImportArchitecture,
  civitaiImportMetadata,
  type CivitaiDownloadedResource,
  type CivitaiInspection,
  type CivitaiPreview,
} from "../../../core/media/civitai.js";
import { parseMediaTriggerWords } from "../../../core/media/asset-metadata.js";
import { civitaiRuntime } from "./civitai-runtime";
import { mediaImportQueue } from "./media-import-queue";
import { importMediaLocalModel, importMediaModelAddon } from "./media-runtime";
import { saveImportedMediaMetadata } from "./media-studio-store";

export function enqueueCivitaiDownload(input: {
  label: string;
  source: string;
  inspection: CivitaiInspection;
  images: readonly CivitaiPreview[];
}): void {
  const { label, source, inspection, images } = structuredClone(input);
  if (!inspection.canDownload || !inspection.file) return;
  const file = inspection.file;
  let downloaded: CivitaiDownloadedResource | null = null;
  let resourceId: string | null = null;
  mediaImportQueue.enqueue(
    label,
    async ({ signal, update }) => {
      if (!downloaded) {
        const storage = await civitaiRuntime.storage(file.byteSize);
        signal.throwIfAborted();
        if (storage.blockingReason) throw new Error(storage.blockingReason);
        update({ warning: storage.warning, total: file.byteSize, received: 0 });
        const operationId = crypto.randomUUID();
        const cancel = () => {
          void civitaiRuntime.cancel(operationId).catch((error: Error) => {
            update({
              warning: `Could not cancel the transfer: ${error.message}`,
            });
          });
        };
        const unlisten = await civitaiRuntime.progress((progress) => {
          if (progress.operationId !== operationId) return;
          if (signal.aborted) cancel();
          update({ received: progress.received, total: progress.total });
          if (progress.storage) update({ warning: progress.storage.warning });
        });
        signal.addEventListener("abort", cancel);
        try {
          signal.throwIfAborted();
          downloaded = await civitaiRuntime.download(
            source,
            file.id,
            inspection.reviewToken,
            operationId,
          );
        } finally {
          signal.removeEventListener("abort", cancel);
          unlisten();
        }
      }
      signal.throwIfAborted();
      update({ status: "importing" });
      const local = downloaded.model ?? downloaded.addon;
      if (!local?.canImport)
        throw new Error(
          local?.blockingReason ?? "This file cannot be imported.",
        );
      const architecture = civitaiImportArchitecture(
        local.detectedArchitecture,
        downloaded.metadata.suggestedArchitecture,
      );
      if (!architecture)
        throw new Error(
          "The model architecture could not be identified. Import the file locally to choose its architecture.",
        );
      const metadata = civitaiImportMetadata(downloaded.metadata, images);
      if (!resourceId) {
        const common = {
          sourcePath: local.sourcePath,
          reviewToken: local.reviewToken,
          displayName: label,
          architecture,
          sourceUrl: downloaded.metadata.sourceUrl,
          licenseName: null,
          commercialUse: null,
        };
        const words = parseMediaTriggerWords(metadata.triggerWords);
        resourceId = downloaded.model
          ? (await importMediaLocalModel(common)).modelId
          : (
              await importMediaModelAddon({
                ...common,
                kind: downloaded.addon!.detectedKind!,
                triggerWords: words,
                token:
                  downloaded.addon!.detectedKind === "textual-inversion"
                    ? (downloaded.addon!.suggestedToken ?? words[0] ?? null)
                    : null,
              })
            ).addonId;
      }
      await saveImportedMediaMetadata(resourceId, metadata);
      return resourceId;
    },
    file.sha256.toLowerCase(),
  );
}
