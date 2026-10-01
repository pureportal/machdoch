import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type { FilePreviewReadResult } from "./runtime";

export const resolveLocalFilePreviewSource = async (
  path: string,
): Promise<string> => {
  if (!isTauri()) {
    throw new Error("File previews are only available in the desktop app.");
  }

  const resolvedPath = await invoke<string>("resolve_local_file_preview_path", {
    path,
  });
  return convertFileSrc(resolvedPath);
};

export const readLocalFilePreview = async (
  path: string,
): Promise<FilePreviewReadResult> => {
  if (!isTauri()) {
    throw new Error("File previews are only available in the desktop app.");
  }

  return invoke<FilePreviewReadResult>("read_local_file_preview", { path });
};

export const revealLocalFile = async (path: string): Promise<void> => {
  if (!isTauri()) {
    throw new Error("Files can only be opened in the desktop app.");
  }

  await invoke("reveal_local_file", { path });
};
