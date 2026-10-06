import { useEffect, useRef, useState } from "react";
import type { FleetOperationTransport } from "@machdoch/product-ui";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import type { WorkspaceFilePreview } from "@machdoch/fleet-protocol/workspace-contract";
import type { ChatSessionContextAttachment } from "../composer/model";
import { FilePreviewDialog, type FilePreview } from "./dialog";
import {
  getFilePreviewRenderKind,
  resolveFilePreviewSyntax,
} from "./file-preview-language";

export function useRemoteFilePreview({
  sessionId,
  workspace,
  workspaceTransport,
  mediaTransport,
}: {
  sessionId: string;
  workspace?: string | undefined;
  workspaceTransport: FleetOperationTransport;
  mediaTransport: FleetMediaTransport;
}) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewSource = useRef<string | null>(null);
  const previewVersion = useRef(0);
  useEffect(() => {
    previewVersion.current++;
    setPreview(null);
    setError(null);
    return () => {
      previewVersion.current++;
      if (previewSource.current) URL.revokeObjectURL(previewSource.current);
      previewSource.current = null;
    };
  }, [sessionId, workspace, workspaceTransport, mediaTransport]);

  const report = (reason: unknown): void =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const open = (
    attachment: ChatSessionContextAttachment,
    line?: number,
    messageId?: string,
  ): void => {
    if (
      attachment.source === "path" &&
      /^(?:https?:|mailto:|ftp:)/iu.test(attachment.path)
    ) {
      window.open(attachment.path, "_blank", "noopener,noreferrer");
      return;
    }
    setError(null);
    const version = ++previewVersion.current;
    const path =
      attachment.source === "path" ? attachment.path : attachment.assetId;
    const syntax = resolveFilePreviewSyntax(attachment.name);
    const mode =
      attachment.source === "media-asset"
        ? "image"
        : getFilePreviewRenderKind(attachment.name);
    if (!mode) {
      report(new Error("This file cannot be previewed."));
      return;
    }
    const initial: FilePreview = {
      title: attachment.name,
      path,
      mode,
      loading: true,
      error: null,
      source: null,
      content: null,
      language: syntax.language,
      languageLabel: syntax.label,
      truncated: false,
      lossy: false,
      targetLine: line ?? null,
    };
    setPreview(initial);
    void (async () => {
      try {
        let file: WorkspaceFilePreview;
        if (attachment.source === "path")
          file = await workspaceTransport.invoke(
            "read_context_attachment_preview",
            { sessionId: sessionId, path: attachment.path, ...(messageId ? { messageId } : {}) },
          );
        else {
          const bytes = await mediaTransport.invoke<ArrayBuffer>(
            "media_read_asset_preview",
            { assetId: attachment.assetId, maxEdge: 2048 },
          );
          let binary = "";
          for (const byte of new Uint8Array(bytes))
            binary += String.fromCharCode(byte);
          file = { dataBase64: btoa(binary), mediaType: "image/webp" };
        }
        if (previewVersion.current !== version) return;
        const bytes = Uint8Array.from(atob(file.dataBase64), (value) =>
          value.charCodeAt(0),
        );
        if (previewSource.current) URL.revokeObjectURL(previewSource.current);
        const source = URL.createObjectURL(
          new Blob([bytes], { type: file.mediaType }),
        );
        previewSource.current = source;
        let content: string | null = null;
        let lossy = false;
        if (mode === "text") {
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            content = new TextDecoder().decode(bytes);
            lossy = true;
          }
        }
        setPreview({
          ...initial,
          loading: false,
          source,
          content: content?.slice(0, 200_000) ?? null,
          truncated: (content?.length ?? 0) > 200_000,
          lossy,
        });
      } catch (reason) {
        if (previewVersion.current === version)
          setPreview({
            ...initial,
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      }
    })();
  };
  return {
    open,
    error,
    dialog: (
      <FilePreviewDialog
        preview={preview}
        onOpenChange={(opened) => {
          if (!opened) {
            previewVersion.current++;
            setPreview(null);
            if (previewSource.current)
              URL.revokeObjectURL(previewSource.current);
            previewSource.current = null;
          }
        }}
        onOpenExternal={() => {
          if (previewSource.current)
            window.open(previewSource.current, "_blank", "noopener,noreferrer");
        }}
      />
    ),
  };
}
