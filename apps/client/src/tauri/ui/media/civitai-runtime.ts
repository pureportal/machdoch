import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CivitaiDownloadedResource,
  CivitaiDownloadProgress,
  CivitaiInspection,
  CivitaiModel,
  CivitaiOptions,
  CivitaiSearch,
  CivitaiSearchPage,
} from "../../../core/media/civitai.js";

async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri())
    throw new Error("Open the desktop app to connect to Civitai.");
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(
      typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error),
    );
  }
}

export const civitaiRuntime = {
  options: () => call<CivitaiOptions>("media_civitai_options"),
  search: (request: CivitaiSearch) =>
    call<CivitaiSearchPage>("media_search_civitai", { request }),
  getModel: (source: string, nsfw: boolean) =>
    call<CivitaiModel>("media_get_civitai_model", { source, nsfw }),
  inspect: (source: string, fileId: number) =>
    call<CivitaiInspection>("media_inspect_civitai_file", { source, fileId }),
  connection: () => call<boolean>("media_civitai_connection"),
  connect: (token: string | null) =>
    call<boolean>("media_connect_civitai", { token }),
  download: (
    source: string,
    fileId: number,
    reviewToken: string,
    operationId: string,
  ) =>
    call<CivitaiDownloadedResource>("media_download_civitai_resource", {
      request: { source, fileId, reviewToken, operationId },
    }),
  cancel: (operationId: string) =>
    call<void>("media_cancel_civitai_download", { operationId }),
  progress: (onProgress: (progress: CivitaiDownloadProgress) => void) =>
    listen<CivitaiDownloadProgress>(
      "media-civitai-download-progress",
      ({ payload }) => onProgress(payload),
    ),
};
