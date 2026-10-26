import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownFileContext } from "../conversation/markdown-content";
import {
  getLocalMarkdownLinkTarget,
  getWorkspaceMarkdownLinkTarget,
  normalizeLocalPath,
} from "../conversation/workspace-markdown-links";
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
  const [preview, setPreview] = useState<
    (FilePreview & { messageId?: string }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const previewSource = useRef<string | null>(null);
  const previewVersion = useRef(0);
  const externalSources = useRef<string[]>([]);
  useEffect(() => {
    previewVersion.current++;
    setPreview(null);
    setError(null);
    return () => {
      previewVersion.current++;
      if (previewSource.current) URL.revokeObjectURL(previewSource.current);
      previewSource.current = null;
      for (const source of externalSources.current) URL.revokeObjectURL(source);
      externalSources.current = [];
    };
  }, [sessionId, workspace, workspaceTransport, mediaTransport]);

  const open = useCallback(
    (
      attachment: ChatSessionContextAttachment,
      line?: number,
      messageId?: string,
      external = false,
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
        setError("This file cannot be previewed.");
        return;
      }
      const initial: FilePreview & { messageId?: string } = {
        ...(messageId ? { messageId } : {}),
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
      if (!external) setPreview(initial);
      const externalWindow = external ? window.open("", "_blank") : null;
      if (externalWindow) externalWindow.opener = null;
      void (async () => {
        try {
          let file: WorkspaceFilePreview;
          if (attachment.source === "path")
            file = await workspaceTransport.invoke(
              "read_context_attachment_preview",
              {
                sessionId: sessionId,
                path: attachment.path,
                ...(messageId ? { messageId } : {}),
              },
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
          if (previewVersion.current !== version) {
            externalWindow?.close();
            return;
          }
          const bytes = Uint8Array.from(atob(file.dataBase64), (value) =>
            value.charCodeAt(0),
          );
          const source = URL.createObjectURL(
            new Blob([bytes], { type: file.mediaType }),
          );
          if (external) {
            if (externalWindow) {
              externalSources.current.push(source);
              externalWindow.location.href = source;
            } else {
              URL.revokeObjectURL(source);
              setError("Allow pop-ups to open this file externally.");
            }
            return;
          }
          if (previewSource.current) URL.revokeObjectURL(previewSource.current);
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
          externalWindow?.close();
          if (previewVersion.current === version)
            setPreview({
              ...initial,
              loading: false,
              error: reason instanceof Error ? reason.message : String(reason),
            });
        }
      })();
    },
    [sessionId, workspaceTransport, mediaTransport],
  );
  const sourcePath = preview?.path;
  const messageId = preview?.messageId;
  const markdownContext = useMemo<MarkdownFileContext>(() => {
    const openPath = (path: string, line?: number, external?: boolean) =>
      open(
        {
          source: "path",
          id: path,
          path,
          kind: "file",
          name: path.split(/[\\/]/u).at(-1) || path,
        },
        line,
        messageId,
        external,
      );
    const workspacePath = (path: string) =>
      `${normalizeLocalPath(workspace ?? "").replace(/\/+$/u, "")}/${path}`;
    return {
      workspaceRoot: workspace,
      sourcePath,
      onOpenLocalFile: openPath,
      onOpenWorkspaceFile: (path, line, external) =>
        openPath(workspacePath(path), line, external),
      resolveImageSource: async (href) => {
        const relative = getWorkspaceMarkdownLinkTarget(
          href,
          workspace,
          sourcePath,
        );
        const local = getLocalMarkdownLinkTarget(href, sourcePath);
        const path =
          relative && workspace
            ? workspacePath(relative.relativePath)
            : local?.path;
        if (!path) throw new Error("Unable to resolve this image path.");
        const file = await workspaceTransport.invoke<WorkspaceFilePreview>(
          "read_context_attachment_preview",
          {
            sessionId,
            path,
            ...(messageId ? { messageId } : {}),
          },
        );
        return `data:${file.mediaType};base64,${file.dataBase64}`;
      },
    };
  }, [sourcePath, messageId, workspace, open, workspaceTransport, sessionId]);
  return {
    open,
    error,
    dialog: (
      <FilePreviewDialog
        preview={preview}
        markdownContext={markdownContext}
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
