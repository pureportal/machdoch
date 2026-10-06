import { useCallback, useEffect, useRef, useState } from "react";
import {
  prepareFilePreview,
  type FilePreviewTarget,
} from "./file-preview-runtime";
import {
  readLocalFilePreview,
  resolveLocalFilePreviewSource,
  revealLocalFile,
} from "../../local-file-runtime";
import {
  openAttachedPath,
  openWorkspacePath,
  readAttachedFilePreview,
  readWorkspaceFilePreview,
  resolveAttachedFilePreviewSource,
  resolveWorkspaceFilePreviewSource,
} from "../../runtime";
import type { FilePreview } from "@machdoch/client-ui/file-preview/dialog";
import {
  getFilePreviewFileName,
  getFilePreviewRenderKind,
  resolveFilePreviewSyntax,
} from "@machdoch/client-ui/file-preview/file-preview-language";

interface FilePreviewState extends FilePreview {
  target: FilePreviewTarget;
}

const createFilePreviewState = (
  target: FilePreviewTarget,
): FilePreviewState => {
  const path =
    target.kind === "attachment"
      ? target.attachment.path
      : target.kind === "local"
        ? target.path
        : target.relativePath;
  const title =
    target.kind === "attachment"
      ? target.attachment.name
      : getFilePreviewFileName(path);
  const syntax = resolveFilePreviewSyntax(path);

  return {
    target,
    title: title || path,
    path,
    mode: getFilePreviewRenderKind(path) ?? "text",
    loading: true,
    error: null,
    source: null,
    content: null,
    language: syntax.language,
    languageLabel: syntax.label,
    truncated: false,
    lossy: false,
    targetLine: target.kind === "attachment" ? null : (target.line ?? null),
  };
};

const loadFilePreviewSource = async (
  target: FilePreviewTarget,
): Promise<string> => {
  if (target.kind === "local") {
    return resolveLocalFilePreviewSource(target.path);
  }
  if (target.kind === "attachment") {
    return resolveAttachedFilePreviewSource(
      target.attachment.path,
      target.workspaceRoot,
    );
  }
  return resolveWorkspaceFilePreviewSource(
    target.workspaceRoot,
    target.relativePath,
  );
};

const loadFilePreviewContent = async (target: FilePreviewTarget) => {
  if (target.kind === "local") {
    return readLocalFilePreview(target.path);
  }
  if (target.kind === "attachment") {
    return readAttachedFilePreview(
      target.attachment.path,
      target.workspaceRoot,
    );
  }
  return readWorkspaceFilePreview(target.workspaceRoot, target.relativePath);
};

const revealFilePreviewTarget = async (
  target: FilePreviewTarget,
): Promise<void> => {
  if (target.kind === "local") {
    return revealLocalFile(target.path);
  }
  if (target.kind === "attachment") {
    return openAttachedPath(target.attachment.path, target.workspaceRoot);
  }
  return openWorkspacePath(target.workspaceRoot, target.relativePath);
};

export const useFilePreview = (): {
  preview: FilePreview | null;
  showPreview: (target: FilePreviewTarget) => void;
  closePreview: () => void;
  openExternally: () => void;
} => {
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const closePreview = useCallback((): void => {
    requestRef.current += 1;
    setPreview(null);
  }, []);

  const showPreview = useCallback((target: FilePreviewTarget): void => {
    const request = ++requestRef.current;
    const nextPreview = createFilePreviewState(target);
    setPreview(null);

    void (async () => {
      try {
        const canPreview = await prepareFilePreview(target);
        if (!canPreview || requestRef.current !== request) {
          return;
        }
        setPreview(nextPreview);
        const loadedPreview =
          nextPreview.mode === "text"
            ? { ...nextPreview, ...(await loadFilePreviewContent(target)) }
            : { ...nextPreview, source: await loadFilePreviewSource(target) };
        if (requestRef.current === request) {
          setPreview({ ...loadedPreview, loading: false });
        }
      } catch (error) {
        if (requestRef.current === request) {
          setPreview({
            ...nextPreview,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
  }, []);

  const openExternally = (): void => {
    if (!preview) {
      return;
    }
    const request = requestRef.current;
    void revealFilePreviewTarget(preview.target).catch((error: unknown) => {
      if (requestRef.current === request) {
        setPreview((current) =>
          current
            ? {
                ...current,
                error: error instanceof Error ? error.message : String(error),
              }
            : null,
        );
      }
    });
  };

  return { preview, showPreview, closePreview, openExternally };
};
