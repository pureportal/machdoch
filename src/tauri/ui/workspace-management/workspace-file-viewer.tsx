import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorView, keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileQuestion,
  FileText,
  Folder,
  LoaderCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { MarkdownContent } from "../components/markdown-content";
import { getWorkspaceMarkdownLinkTarget } from "../components/workspace-markdown-links";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { useOptionalRegisterCommands } from "../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
} from "../commands/command-types";
import { cn } from "../lib/utils";
import {
  openWorkspacePath,
  openExternalUrl,
  readWorkspaceFile,
  resolveWorkspaceFilePreviewSource,
  saveWorkspaceFile,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileDocument,
} from "../runtime";
import {
  formatWorkspaceFileSize,
  isWorkspaceFile,
  resolveWorkspaceMarkdownPath,
  workspacePathParent,
} from "./workspace-tools-model";
import {
  startExclusiveWorkspaceOperation,
  type WorkspaceOperationLock,
} from "./workspace-operation-lock";

type ViewerMode = "edit" | "preview";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const defaultViewerMode = (document: WorkspaceFileDocument): ViewerMode =>
  document.previewKind && !document.editable ? "preview" : "edit";

const WorkspaceMarkdownImage = ({
  workspaceRoot,
  documentPath,
  source,
  alt,
  title,
}: {
  workspaceRoot: string;
  documentPath: string;
  source: string | undefined;
  alt: string | undefined;
  title: string | undefined;
}): JSX.Element | null => {
  const [resolvedSource, setResolvedSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setResolvedSource(null);
    if (!source) return () => {};
    if (/^(?:https?:|data:image\/)/iu.test(source)) {
      setResolvedSource(source);
      return () => {};
    }
    const path = resolveWorkspaceMarkdownPath(documentPath, source);
    if (!path) {
      setFailed(true);
      return () => {};
    }
    void resolveWorkspaceFilePreviewSource(workspaceRoot, path)
      .then((nextSource) => {
        if (active) setResolvedSource(nextSource);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [documentPath, source, workspaceRoot]);

  if (failed) {
    return (
      <span
        role="img"
        aria-label={alt ?? "Image unavailable"}
        className="text-slate-500"
      >
        {alt ?? "Image unavailable"}
      </span>
    );
  }
  if (!resolvedSource) return null;
  return (
    <img
      src={resolvedSource}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="my-4 max-h-[32rem] max-w-full rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  );
};

export const WorkspaceFileViewer = ({
  workspaceRoot,
  selectedEntry,
  externalRefreshToken,
  onDirtyChange,
  onSaved,
  onExternalChange,
}: {
  workspaceRoot: string;
  selectedEntry: WorkspaceDirectoryEntry | null;
  externalRefreshToken: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  onExternalChange: () => void;
}): JSX.Element => {
  const [document, setDocument] = useState<WorkspaceFileDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ViewerMode>("edit");
  const [languageExtensions, setLanguageExtensions] = useState<Extension[]>([]);
  const [previewSource, setPreviewSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [externalChanged, setExternalChanged] = useState(false);
  const [saved, setSaved] = useState(false);
  const requestIdRef = useRef(0);
  const diskVersionRef = useRef(0);
  const externalCheckIdRef = useRef(0);
  const handledExternalRefreshRef = useRef(externalRefreshToken);
  const saveRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const saveTimerRef = useRef<number | null>(null);
  const saveLockRef = useRef<WorkspaceOperationLock>({ pending: false });

  const selectedFile =
    selectedEntry && isWorkspaceFile(selectedEntry) ? selectedEntry : null;
  const dirty =
    document?.editable === true &&
    document.content !== null &&
    draft !== document.content;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange(false);
      if (saveTimerRef.current !== null)
        window.clearTimeout(saveTimerRef.current);
    },
    [onDirtyChange],
  );

  const loadFile = useCallback(
    async (path: string): Promise<void> => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      setSaveError(null);
      setExternalChanged(false);
      setPreviewSource(null);
      setPreviewError(null);
      try {
        const next = await readWorkspaceFile(workspaceRoot, path);
        if (requestId !== requestIdRef.current) return;
        diskVersionRef.current += 1;
        setDocument(next);
        setDraft(next.content ?? "");
        setMode(defaultViewerMode(next));
      } catch (loadError) {
        if (requestId !== requestIdRef.current) return;
        setDocument(null);
        setDraft("");
        setError(errorMessage(loadError));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [workspaceRoot],
  );

  useEffect(() => {
    requestIdRef.current += 1;
    setDocument(null);
    setDraft("");
    setError(null);
    setSaveError(null);
    setPreviewError(null);
    setExternalChanged(false);
    setSaved(false);
    setSaving(false);
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (selectedFile) void loadFile(selectedFile.path);
  }, [loadFile, selectedFile?.path]);

  useEffect(() => {
    let active = true;
    setLanguageExtensions([]);
    if (!document?.name || document.kind !== "text") return () => {};
    const language = LanguageDescription.matchFilename(
      languages,
      document.name,
    );
    if (language) {
      void language
        .load()
        .then((support) => {
          if (active) setLanguageExtensions([support]);
        })
        .catch(() => {
          if (active) setLanguageExtensions([]);
        });
    }
    return () => {
      active = false;
    };
  }, [document?.kind, document?.name]);

  useEffect(() => {
    let active = true;
    setPreviewSource(null);
    setPreviewError(null);
    if (!document?.previewKind || document.previewKind === "markdown") {
      return () => {};
    }
    if (document.previewKind === "image" && document.language === "xml") {
      const source = URL.createObjectURL(
        new Blob([draft], { type: "image/svg+xml" }),
      );
      setPreviewSource(source);
      return () => URL.revokeObjectURL(source);
    }
    void resolveWorkspaceFilePreviewSource(workspaceRoot, document.path)
      .then((source) => {
        if (active) setPreviewSource(source);
      })
      .catch((previewError: unknown) => {
        if (active) setPreviewError(errorMessage(previewError));
      });
    return () => {
      active = false;
    };
  }, [
    document?.language,
    document?.path,
    document?.previewKind,
    draft,
    workspaceRoot,
  ]);

  const save = useCallback(
    async (force = false): Promise<void> => {
      const currentDocument = document;
      if (
        !currentDocument?.editable ||
        currentDocument.revision === null ||
        (!dirty && !force)
      ) {
        return;
      }
      const requestId = requestIdRef.current;
      const diskVersion = diskVersionRef.current;
      const path = currentDocument.path;
      const revision = currentDocument.revision;
      const content = draft;
      const bom = currentDocument.bom;
      const operation = startExclusiveWorkspaceOperation(
        saveLockRef.current,
        async () => {
          setSaving(true);
          setSaveError(null);
          setSaved(false);
          try {
            const result = await saveWorkspaceFile(
              workspaceRoot,
              path,
              content,
              revision,
              { force, bom },
            );
            if (
              requestId !== requestIdRef.current ||
              diskVersion !== diskVersionRef.current
            ) {
              return;
            }
            if (result.status === "conflict") {
              setExternalChanged(true);
              return;
            }
            diskVersionRef.current += 1;
            setDocument((current) =>
              current?.path === path
                ? {
                    ...current,
                    content,
                    revision: result.revision,
                    modifiedAt: result.modifiedAt,
                    size: result.size,
                  }
                : current,
            );
            setExternalChanged(false);
            setSaved(true);
            if (saveTimerRef.current !== null) {
              window.clearTimeout(saveTimerRef.current);
            }
            saveTimerRef.current = window.setTimeout(
              () => setSaved(false),
              1800,
            );
            onSaved();
          } catch (saveFailure) {
            if (requestId === requestIdRef.current) {
              setSaveError(errorMessage(saveFailure));
            }
          } finally {
            if (requestId === requestIdRef.current) setSaving(false);
          }
        },
      );
      if (operation) await operation;
    },
    [dirty, document, draft, onSaved, workspaceRoot],
  );
  saveRef.current = save;

  const editorExtensions = useMemo<Extension[]>(
    () => [
      ...languageExtensions,
      EditorView.contentAttributes.of({
        "aria-label": `Edit ${document?.name ?? "file"}`,
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void saveRef.current();
            return true;
          },
        },
      ]),
    ],
    [document?.name, languageExtensions],
  );

  useEffect(() => {
    if (!document?.path || !document.revision) return;
    let active = true;
    const checkForExternalChange = (): void => {
      const requestId = requestIdRef.current;
      const diskVersion = diskVersionRef.current;
      const checkId = ++externalCheckIdRef.current;
      void readWorkspaceFile(workspaceRoot, document.path)
        .then((current) => {
          if (
            !active ||
            checkId !== externalCheckIdRef.current ||
            requestId !== requestIdRef.current ||
            diskVersion !== diskVersionRef.current
          ) {
            return;
          }
          if (current.revision === document.revision) return;
          onExternalChange();
          if (dirty) {
            setExternalChanged(true);
          } else {
            diskVersionRef.current += 1;
            setDocument(current);
            setDraft(current.content ?? "");
            setMode(defaultViewerMode(current));
            setExternalChanged(false);
          }
        })
        .catch((checkError: unknown) => {
          if (
            !active ||
            checkId !== externalCheckIdRef.current ||
            requestId !== requestIdRef.current ||
            diskVersion !== diskVersionRef.current
          ) {
            return;
          }
          if (dirty) setSaveError(errorMessage(checkError));
          else setError(errorMessage(checkError));
          onExternalChange();
        });
    };
    const checkWhenVisible = (): void => {
      if (window.document.visibilityState === "visible")
        checkForExternalChange();
    };
    if (handledExternalRefreshRef.current !== externalRefreshToken) {
      handledExternalRefreshRef.current = externalRefreshToken;
      checkForExternalChange();
    }
    window.addEventListener("focus", checkForExternalChange);
    window.document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      active = false;
      window.removeEventListener("focus", checkForExternalChange);
      window.document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [
    dirty,
    document?.path,
    document?.revision,
    externalRefreshToken,
    onExternalChange,
    workspaceRoot,
  ]);

  const reloadFromDisk = async (): Promise<void> => {
    if (!document || saving) return;
    if (
      dirty &&
      !window.confirm("Reload from disk and discard your unsaved changes?")
    ) {
      return;
    }
    await loadFile(document.path);
  };

  const openExternally = (): void => {
    if (!selectedEntry) return;
    setSaveError(null);
    void openWorkspacePath(workspaceRoot, selectedEntry.path).catch(
      (openError: unknown) => setSaveError(errorMessage(openError)),
    );
  };

  const fileViewerCommandStateRef = useRef({
    selectedEntry,
    selectedFile,
    document,
    dirty,
    mode,
    loading,
    saving,
    externalChanged,
    loadFile,
    save,
    reloadFromDisk,
    openExternally,
    setMode,
  });
  fileViewerCommandStateRef.current = {
    selectedEntry,
    selectedFile,
    document,
    dirty,
    mode,
    loading,
    saving,
    externalChanged,
    loadFile,
    save,
    reloadFromDisk,
    openExternally,
    setMode,
  };
  const fileViewerCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = {
      kind: "view" as const,
      ownerId: "workspaces",
      viewId: "workspaces",
    };
    const state = () => fileViewerCommandStateRef.current;
    const selectedAvailability = () =>
      state().selectedEntry
        ? { state: "enabled" as const }
        : { state: "hidden" as const };
    return asPaletteCommands([
      {
        id: "workspaces.file.save",
        title: "Save workspace file",
        group: "Workspace files",
        scope,
        availability: () => {
          const current = state();
          if (!current.document?.editable) return { state: "hidden" };
          if (current.saving)
            return { state: "disabled", reason: "File is already saving." };
          return current.dirty
            ? { state: "enabled" }
            : { state: "disabled", reason: "No file changes to save." };
        },
        execute: () => void state().save(),
      },
      {
        id: "workspaces.file.reload",
        title: "Reload workspace file from disk",
        group: "Workspace files",
        scope,
        availability: () =>
          !state().document
            ? { state: "hidden" }
            : state().saving || state().loading
              ? { state: "disabled", reason: "File is busy." }
              : { state: "enabled" },
        execute: () => void state().reloadFromDisk(),
      },
      {
        id: "workspaces.file.open-system",
        title: "Open selected file in system",
        group: "Workspace files",
        scope,
        availability: selectedAvailability,
        execute: () => state().openExternally(),
      },
      {
        id: "workspaces.file.mode",
        title: "Choose workspace file view",
        group: "Workspace files",
        scope,
        availability: () =>
          state().document?.editable && state().document?.previewKind
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "workspaces.file.mode.page",
          title: "Choose workspace file view",
          searchPlaceholder: "Search views",
          numericSelection: true,
          groups: [
            {
              id: "views",
              items: (["edit", "preview"] as const).map((mode, index) => ({
                id: mode,
                title: mode === "edit" ? "Edit" : "Preview",
                current: state().mode === mode,
                numericKey: index === 0 ? "1" : "2",
                execute: () => state().setMode(mode),
              })),
            },
          ],
        }),
      },
      {
        id: "workspaces.file.overwrite",
        title: "Overwrite externally changed file",
        group: "Workspace files",
        scope,
        availability: () =>
          state().externalChanged && state().dirty
            ? state().saving
              ? { state: "disabled", reason: "File is already saving." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => void state().save(true),
      },
      {
        id: "workspaces.file.retry",
        title: "Retry opening workspace file",
        group: "Workspace files",
        scope,
        availability: () =>
          state().selectedFile && !state().document && !state().loading
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => {
          const file = state().selectedFile;
          if (file) void state().loadFile(file.path);
        },
      },
    ]);
  }, []);
  useOptionalRegisterCommands(fileViewerCommands);

  if (!selectedEntry) {
    return (
      <div className="grid min-h-0 min-w-0 flex-1 place-items-center bg-slate-950/30 p-6">
        <EmptyState icon={FileText} title="Select a file" size="compact" />
      </div>
    );
  }

  if (!selectedFile) {
    return (
      <div className="grid min-h-0 min-w-0 flex-1 place-items-center bg-slate-950/30 p-6">
        <EmptyState
          icon={Folder}
          title={selectedEntry.name}
          size="compact"
          action={
            <Button size="sm" variant="outline" onClick={openExternally}>
              <ExternalLink className="size-3.5" />
              Open
            </Button>
          }
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="grid min-h-0 min-w-0 flex-1 place-items-center bg-slate-950/30">
        <LoaderCircle className="size-5 animate-spin text-slate-500" />
      </div>
    );
  }

  if (error || !document) {
    return (
      <div className="grid min-h-0 min-w-0 flex-1 place-items-center bg-slate-950/30 p-6">
        <EmptyState
          icon={FileQuestion}
          title="File unavailable"
          description={error ?? undefined}
          action={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadFile(selectedFile.path)}
              >
                <RefreshCw className="size-3.5" />
                Retry
              </Button>
              <Button size="sm" variant="outline" onClick={openExternally}>
                <ExternalLink className="size-3.5" />
                Open
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const canPreview = document.previewKind !== null;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-950/30">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3">
        <FileText className="size-3.5 shrink-0 text-slate-500" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-xs font-medium text-slate-200">
            {document.name}
          </span>
          <span className="hidden truncate text-[10px] text-slate-600 sm:inline">
            {workspacePathParent(document.path)}
          </span>
        </div>
        {dirty ? (
          <span className="text-[11px] text-amber-300">Unsaved</span>
        ) : saved ? (
          <span
            role="status"
            className="flex items-center gap-1 text-[11px] text-emerald-300"
          >
            <Check className="size-3" />
            Saved
          </span>
        ) : (
          <span className="hidden text-[10px] text-slate-600 md:inline">
            {formatWorkspaceFileSize(document.size)}
          </span>
        )}
        {document.editable && canPreview ? (
          <div className="flex rounded-md border border-slate-800 bg-slate-950 p-0.5">
            {(["edit", "preview"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  "rounded px-2 py-1 text-[10px]",
                  mode === value
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-500 hover:text-slate-300",
                )}
              >
                {value === "edit" ? "Edit" : "Preview"}
              </button>
            ))}
          </div>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Reload from disk"
          disabled={saving}
          onClick={() => void reloadFromDisk()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Open in system"
          onClick={openExternally}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        {document.editable ? (
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            Save
          </Button>
        ) : null}
      </header>

      {externalChanged ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Changed on disk</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => void reloadFromDisk()}
          >
            Reload
          </Button>
          {dirty ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={saving}
              onClick={() => void save(true)}
            >
              Overwrite
            </Button>
          ) : null}
        </div>
      ) : null}

      {saveError ? (
        <button
          type="button"
          role="alert"
          className="shrink-0 border-b border-red-950 bg-red-950/30 px-3 py-2 text-left text-xs text-red-200"
          onClick={() => setSaveError(null)}
        >
          {saveError}
        </button>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {document.kind === "text" && mode === "edit" ? (
          <div className="h-full" data-command-focus="editor">
            <CodeMirror
              key={document.path}
              value={draft}
              height="100%"
              theme={oneDark}
              extensions={editorExtensions}
              className="h-full text-[13px] [&_.cm-editor]:h-full [&_.cm-editor]:bg-slate-950/35 [&_.cm-gutters]:border-r-slate-800 [&_.cm-gutters]:bg-slate-950/70 [&_.cm-scroller]:font-mono"
              onChange={setDraft}
            />
          </div>
        ) : document.previewKind === "markdown" ? (
          <article className="h-full overflow-auto px-6 py-5">
            <MarkdownContent
              content={draft}
              workspaceRoot={workspaceRoot}
              className="text-sm text-slate-300"
              components={{
                a: ({ href, children, title }) => (
                  <a
                    href={href}
                    title={title}
                    className="app-markdown-link"
                    onClick={(event) => {
                      if (!href || href.startsWith("#")) return;
                      event.preventDefault();
                      const workspaceTarget = getWorkspaceMarkdownLinkTarget(
                        href,
                        workspaceRoot,
                      );
                      const external =
                        href.startsWith("//") ||
                        /^[a-z][a-z\d+.-]*:/iu.test(href);
                      if (external && !workspaceTarget) {
                        const target = href.startsWith("//")
                          ? `https:${href}`
                          : href;
                        void openExternalUrl(target).catch(
                          (openError: unknown) =>
                            setSaveError(errorMessage(openError)),
                        );
                        return;
                      }
                      const absoluteWorkspaceTarget =
                        workspaceTarget &&
                        (/^(?:file:|[a-z]:[\\/]|[\\/])/iu.test(href) ||
                          href.startsWith("//"));
                      const path = absoluteWorkspaceTarget
                        ? workspaceTarget.relativePath
                        : resolveWorkspaceMarkdownPath(
                            document.path,
                            workspaceTarget?.relativePath ?? href,
                          );
                      if (!path) {
                        setSaveError("This link points outside the workspace.");
                        return;
                      }
                      void openWorkspacePath(workspaceRoot, path).catch(
                        (openError: unknown) =>
                          setSaveError(errorMessage(openError)),
                      );
                    }}
                  >
                    {children}
                  </a>
                ),
                img: ({ src, alt, title }) => (
                  <WorkspaceMarkdownImage
                    workspaceRoot={workspaceRoot}
                    documentPath={document.path}
                    source={src}
                    alt={alt}
                    title={title}
                  />
                ),
              }}
            />
          </article>
        ) : previewError ? (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              icon={FileQuestion}
              title="Preview unavailable"
              description={previewError}
              size="compact"
              action={
                <Button size="sm" variant="outline" onClick={openExternally}>
                  <ExternalLink className="size-3.5" />
                  Open
                </Button>
              }
            />
          </div>
        ) : document.previewKind === "image" && previewSource ? (
          <div className="grid h-full place-items-center overflow-auto bg-[radial-gradient(circle_at_center,rgba(30,41,59,0.35),transparent_65%)] p-6">
            <img
              src={previewSource}
              alt={document.name}
              onError={() => setPreviewError("The image could not be loaded.")}
              className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
            />
          </div>
        ) : document.previewKind === "pdf" && previewSource ? (
          <iframe
            src={previewSource}
            title={document.name}
            sandbox=""
            onError={() => setPreviewError("The PDF could not be loaded.")}
            className="h-full w-full border-0 bg-white"
          />
        ) : document.previewKind === "audio" && previewSource ? (
          <div className="grid h-full place-items-center p-6">
            <audio
              controls
              src={previewSource}
              onError={() => setPreviewError("The audio could not be loaded.")}
              className="w-full max-w-xl"
            />
          </div>
        ) : document.previewKind === "video" && previewSource ? (
          <div className="grid h-full place-items-center p-4">
            <video
              controls
              src={previewSource}
              onError={() => setPreviewError("The video could not be loaded.")}
              className="max-h-full max-w-full rounded-md"
            />
          </div>
        ) : document.kind === "binary" || document.kind === "oversized" ? (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              icon={FileQuestion}
              title={
                document.kind === "oversized"
                  ? "File too large"
                  : "Preview unavailable"
              }
              description={document.reason ?? undefined}
              size="compact"
              action={
                <Button size="sm" variant="outline" onClick={openExternally}>
                  <ExternalLink className="size-3.5" />
                  Open
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center">
            <LoaderCircle className="size-5 animate-spin text-slate-500" />
          </div>
        )}
      </div>
    </section>
  );
};
