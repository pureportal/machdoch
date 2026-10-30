import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownFileContext } from "@machdoch/client-ui/conversation/markdown-content";
import {
  getLocalMarkdownLinkTarget,
  getWorkspaceMarkdownLinkTarget,
} from "@machdoch/client-ui/conversation/workspace-markdown-links";
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
  openWorkspacePath,
  readWorkspaceFilePreview,
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
  if (target.kind === "workspace") {
    return resolveWorkspaceFilePreviewSource(
      target.workspaceRoot,
      target.relativePath,
    );
  }
  return resolveLocalFilePreviewSource(
    target.kind === "attachment" ? target.attachment.path : target.path,
  );
};

const loadFilePreviewContent = async (target: FilePreviewTarget) => {
  if (target.kind === "workspace") {
    return readWorkspaceFilePreview(target.workspaceRoot, target.relativePath);
  }
  return readLocalFilePreview(
    target.kind === "attachment" ? target.attachment.path : target.path,
  );
};

const revealFilePreviewTarget = async (
  target: FilePreviewTarget,
): Promise<void> => {
  if (target.kind === "workspace") {
    return openWorkspacePath(target.workspaceRoot, target.relativePath);
  }
  return revealLocalFile(
    target.kind === "attachment" ? target.attachment.path : target.path,
  );
};

export const useFilePreview = (): {
  preview: FilePreview | null;
  showPreview: (target: FilePreviewTarget, external?: boolean) => void;
  markdownContext: MarkdownFileContext | undefined;
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

  const showPreview = useCallback(
    (target: FilePreviewTarget, external = false): void => {
      const request = ++requestRef.current;
      const nextPreview = createFilePreviewState(target);
      if (!external) setPreview(null);

      void (async () => {
        try {
          if (external) {
            await revealFilePreviewTarget(target);
            return;
          }
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
    },
    [],
  );

  const target = preview?.target;
  const markdownContext = useMemo<MarkdownFileContext | undefined>(() => {
    if (!target) return undefined;
    const workspaceRoot = target.kind === "local" ? null : target.workspaceRoot;
    const sourcePath =
      target.kind === "workspace"
        ? target.relativePath
        : target.kind === "attachment"
          ? target.attachment.path
          : target.path;
    return {
      workspaceRoot,
      sourcePath,
      onOpenWorkspaceFile: (relativePath, line, external) =>
        showPreview(
          { kind: "workspace", workspaceRoot, relativePath, line },
          external,
        ),
      onOpenLocalFile: (path, line, external) =>
        showPreview({ kind: "local", path, line }, external),
      resolveImageSource: async (href) => {
        const workspaceTarget = getWorkspaceMarkdownLinkTarget(
          href,
          workspaceRoot,
          sourcePath,
        );
        if (workspaceTarget && workspaceRoot) {
          return resolveWorkspaceFilePreviewSource(
            workspaceRoot,
            workspaceTarget.relativePath,
          );
        }
        const localTarget = getLocalMarkdownLinkTarget(href, sourcePath);
        if (localTarget) return resolveLocalFilePreviewSource(localTarget.path);
        throw new Error("Unable to resolve this image path.");
      },
    };
  }, [target, showPreview]);

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

  return {
    preview,
    showPreview,
    closePreview,
    openExternally,
    markdownContext,
  };
};
