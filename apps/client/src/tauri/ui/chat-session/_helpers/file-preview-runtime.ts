import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ChatSessionPathContextAttachment } from "../../chat-session.model";
import { getFilePreviewRenderKind } from "./file-preview-language";

export type FilePreviewTarget =
  | { kind: "local"; path: string; line?: number }
  | {
      kind: "workspace";
      workspaceRoot: string | null | undefined;
      relativePath: string;
      line?: number;
    }
  | {
      kind: "attachment";
      attachment: ChatSessionPathContextAttachment;
      workspaceRoot: string | null | undefined;
    };

export const prepareFilePreview = async (
  target: FilePreviewTarget,
): Promise<boolean> => {
  if (!isTauri()) {
    throw new Error("Files can only be opened in the desktop app.");
  }

  const path =
    target.kind === "attachment"
      ? target.attachment.path
      : target.kind === "workspace"
        ? target.relativePath
        : target.path;
  const nativeTarget =
    target.kind === "attachment"
      ? {
          kind: target.kind,
          path,
          workspaceRoot: target.workspaceRoot?.trim() || null,
        }
      : target.kind === "workspace"
        ? {
            kind: target.kind,
            relativePath: path,
            workspaceRoot: target.workspaceRoot?.trim() ?? "",
          }
        : { kind: target.kind, path };

  return invoke<boolean>("prepare_file_preview", {
    target: nativeTarget,
    mode: getFilePreviewRenderKind(path),
  });
};
