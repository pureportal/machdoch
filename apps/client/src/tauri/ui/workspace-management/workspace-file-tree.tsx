import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useOptionalRegisterCommands } from "../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
} from "../commands/command-types";
import { cn } from "../lib/utils";
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listWorkspaceDirectory,
  openWorkspacePath,
  renameWorkspaceEntry,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectoryPage,
  type WorkspaceEntryKind,
} from "../runtime";
import {
  formatWorkspaceFileSize,
  isWorkspaceDirectory,
  isWorkspaceFile,
  reconcileWorkspaceTreeFocus,
  workspacePathParent,
} from "./workspace-tools-model";
import {
  startExclusiveWorkspaceOperation,
  type WorkspaceOperationLock,
} from "./workspace-operation-lock";

interface DirectoryState {
  page: WorkspaceDirectoryPage | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

interface VisibleEntry {
  entry: WorkspaceDirectoryEntry;
  parentPath: string;
  level: number;
}

type EntryFormMode = WorkspaceEntryKind | "rename";

const emptyDirectoryState = (): DirectoryState => ({
  page: null,
  loading: false,
  loadingMore: false,
  error: null,
});

const TreeAction = ({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element => (
  <Button
    type="button"
    size="icon"
    variant="ghost"
    className="size-7 text-slate-500 hover:text-slate-200"
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
  >
    <Icon className="size-3.5" />
  </Button>
);

const entryIcon = (
  entry: WorkspaceDirectoryEntry,
  expanded: boolean,
): LucideIcon => {
  if (entry.kind === "symlink") return Link2;
  if (entry.kind === "directory") return expanded ? FolderOpen : Folder;
  return File;
};

export const WorkspaceFileTree = ({
  workspaceRoot,
  selectedEntry,
  refreshToken,
  onSelect,
  onBeforeSelectedMutation,
  onMutation,
  onRefresh,
}: {
  workspaceRoot: string;
  selectedEntry: WorkspaceDirectoryEntry | null;
  refreshToken: number;
  onSelect: (entry: WorkspaceDirectoryEntry) => boolean;
  onBeforeSelectedMutation: () => boolean;
  onMutation: (
    previousPath: string | null,
    nextEntry: WorkspaceDirectoryEntry | null,
  ) => void;
  onRefresh: () => void;
}): JSX.Element => {
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(["."]),
  );
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<EntryFormMode | null>(null);
  const [entryName, setEntryName] = useState("");
  const [operationPending, setOperationPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const rootRef = useRef(workspaceRoot);
  const expandedPathsRef = useRef(new Set(["."]));
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const treeGenerationRef = useRef(0);
  const directoryRequestIdsRef = useRef(new Map<string, number>());
  const operationLockRef = useRef<WorkspaceOperationLock>({ pending: false });

  const loadDirectory = useCallback(
    async (path: string, offset = 0): Promise<void> => {
      const append = offset > 0;
      const generation = treeGenerationRef.current;
      const requestId = (directoryRequestIdsRef.current.get(path) ?? 0) + 1;
      directoryRequestIdsRef.current.set(path, requestId);
      setDirectories((current) => ({
        ...current,
        [path]: {
          ...(current[path] ?? emptyDirectoryState()),
          loading: !append,
          loadingMore: append,
          error: null,
        },
      }));
      try {
        const page = await listWorkspaceDirectory(workspaceRoot, path, offset);
        if (
          rootRef.current !== workspaceRoot ||
          treeGenerationRef.current !== generation ||
          directoryRequestIdsRef.current.get(path) !== requestId
        ) {
          return;
        }
        setDirectories((current) => {
          const previous = current[path]?.page;
          const entries = append
            ? [
                ...(previous?.entries ?? []),
                ...page.entries.filter(
                  (entry) =>
                    !(previous?.entries ?? []).some(
                      (candidate) => candidate.path === entry.path,
                    ),
                ),
              ]
            : page.entries;
          return {
            ...current,
            [path]: {
              page: { ...page, entries },
              loading: false,
              loadingMore: false,
              error: null,
            },
          };
        });
      } catch (error) {
        if (
          rootRef.current !== workspaceRoot ||
          treeGenerationRef.current !== generation ||
          directoryRequestIdsRef.current.get(path) !== requestId
        ) {
          return;
        }
        setDirectories((current) => ({
          ...current,
          [path]: {
            ...(current[path] ?? emptyDirectoryState()),
            loading: false,
            loadingMore: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [workspaceRoot],
  );

  const refreshTree = useCallback((): void => {
    treeGenerationRef.current += 1;
    directoryRequestIdsRef.current.clear();
    setDirectories({});
    for (const path of expandedPathsRef.current) void loadDirectory(path);
  }, [loadDirectory]);

  useEffect(() => {
    if (rootRef.current !== workspaceRoot) {
      const rootExpansion = new Set(["."]);
      expandedPathsRef.current = rootExpansion;
      setExpandedPaths(rootExpansion);
      setFocusedPath(null);
    }
    rootRef.current = workspaceRoot;
    setFormMode(null);
    setOperationError(null);
    refreshTree();
  }, [refreshToken, refreshTree, workspaceRoot]);

  const toggleDirectory = (path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      expandedPathsRef.current = next;
      return next;
    });
    if (!expandedPaths.has(path) && !directories[path]) {
      void loadDirectory(path);
    }
  };

  const visibleEntries = useMemo(() => {
    const result: VisibleEntry[] = [];
    const visit = (parentPath: string, level: number): void => {
      for (const entry of directories[parentPath]?.page?.entries ?? []) {
        result.push({ entry, parentPath, level });
        if (isWorkspaceDirectory(entry) && expandedPaths.has(entry.path)) {
          visit(entry.path, level + 1);
        }
      }
    };
    visit(".", 1);
    return result;
  }, [directories, expandedPaths]);

  useEffect(() => {
    const nextFocusedPath = reconcileWorkspaceTreeFocus(
      visibleEntries.map(({ entry }) => entry.path),
      focusedPath,
      selectedEntry?.path ?? null,
    );
    if (nextFocusedPath !== focusedPath) setFocusedPath(nextFocusedPath);
  }, [focusedPath, selectedEntry?.path, visibleEntries]);

  useEffect(() => {
    setFormMode(null);
    setEntryName("");
  }, [selectedEntry?.path]);

  const focusPath = (path: string): void => {
    setFocusedPath(path);
    window.requestAnimationFrame(() => rowRefs.current.get(path)?.focus());
  };

  const activateEntry = (entry: WorkspaceDirectoryEntry): void => {
    setFocusedPath(entry.path);
    if (isWorkspaceDirectory(entry)) toggleDirectory(entry.path);
    onSelect(entry);
  };

  const handleTreeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    entry: WorkspaceDirectoryEntry,
  ): void => {
    const index = visibleEntries.findIndex(
      (candidate) => candidate.entry.path === entry.path,
    );
    if (index < 0) return;
    const move = (nextIndex: number): void => {
      const next = visibleEntries[nextIndex]?.entry;
      if (next) focusPath(next.path);
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(Math.min(index + 1, visibleEntries.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        move(Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(visibleEntries.length - 1);
        break;
      case "ArrowRight":
        if (isWorkspaceDirectory(entry)) {
          event.preventDefault();
          if (!expandedPaths.has(entry.path)) toggleDirectory(entry.path);
          else move(index + 1);
        }
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (isWorkspaceDirectory(entry) && expandedPaths.has(entry.path)) {
          toggleDirectory(entry.path);
        } else {
          const parent = visibleEntries[index]?.parentPath;
          if (parent && parent !== ".") focusPath(parent);
        }
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        activateEntry(entry);
        break;
    }
  };

  const parentForCreation =
    selectedEntry && isWorkspaceDirectory(selectedEntry)
      ? selectedEntry.path
      : selectedEntry
        ? workspacePathParent(selectedEntry.path)
        : ".";

  const openForm = (mode: EntryFormMode): void => {
    setOperationError(null);
    setFormMode(mode);
    setEntryName(mode === "rename" ? (selectedEntry?.name ?? "") : "");
  };

  const submitForm = async (): Promise<void> => {
    if (!formMode || !entryName.trim() || operationLockRef.current.pending) {
      return;
    }
    if (!onBeforeSelectedMutation()) return;
    const operation = startExclusiveWorkspaceOperation(
      operationLockRef.current,
      async () => {
        setOperationPending(true);
        setOperationError(null);
        try {
          if (formMode === "rename") {
            if (!selectedEntry) return;
            const previousPath = selectedEntry.path;
            const nextPath = await renameWorkspaceEntry(
              workspaceRoot,
              previousPath,
              entryName.trim(),
            );
            if (rootRef.current !== workspaceRoot) return;
            const nextEntry = {
              ...selectedEntry,
              name: entryName.trim(),
              path: nextPath,
            };
            const remappedExpandedPaths = new Set(
              [...expandedPathsRef.current].map((path) =>
                path === previousPath || path.startsWith(`${previousPath}/`)
                  ? `${nextPath}${path.slice(previousPath.length)}`
                  : path,
              ),
            );
            expandedPathsRef.current = remappedExpandedPaths;
            setExpandedPaths(remappedExpandedPaths);
            setFocusedPath((current) =>
              current === previousPath ||
              current?.startsWith(`${previousPath}/`)
                ? `${nextPath}${current.slice(previousPath.length)}`
                : current,
            );
            onMutation(previousPath, nextEntry);
          } else {
            const path = await createWorkspaceEntry(
              workspaceRoot,
              parentForCreation,
              entryName.trim(),
              formMode,
            );
            if (rootRef.current !== workspaceRoot) return;
            const nextEntry: WorkspaceDirectoryEntry = {
              name: entryName.trim(),
              path,
              kind: formMode,
              targetKind: null,
              size: formMode === "file" ? 0 : null,
              modifiedAt: Date.now(),
            };
            onMutation(null, nextEntry);
          }
          setFormMode(null);
          setEntryName("");
          refreshTree();
        } catch (error) {
          setOperationError(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          setOperationPending(false);
        }
      },
    );
    if (operation) await operation;
  };

  const deleteSelected = async (): Promise<void> => {
    if (!selectedEntry || operationLockRef.current.pending) return;
    if (!onBeforeSelectedMutation()) return;
    const operation = startExclusiveWorkspaceOperation(
      operationLockRef.current,
      async () => {
        const directory = isWorkspaceDirectory(selectedEntry);
        const confirmed = window.confirm(
          directory
            ? `Delete “${selectedEntry.name}” and everything inside it?`
            : `Delete “${selectedEntry.name}”?`,
        );
        if (!confirmed) return;
        setOperationPending(true);
        setOperationError(null);
        try {
          await deleteWorkspaceEntry(
            workspaceRoot,
            selectedEntry.path,
            directory,
          );
          if (rootRef.current !== workspaceRoot) return;
          const remainingExpandedPaths = new Set(
            [...expandedPathsRef.current].filter(
              (path) =>
                path !== selectedEntry.path &&
                !path.startsWith(`${selectedEntry.path}/`),
            ),
          );
          expandedPathsRef.current = remainingExpandedPaths;
          setExpandedPaths(remainingExpandedPaths);
          setFocusedPath((current) =>
            current === selectedEntry.path ||
            current?.startsWith(`${selectedEntry.path}/`)
              ? null
              : current,
          );
          onMutation(selectedEntry.path, null);
          refreshTree();
        } catch (error) {
          setOperationError(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          setOperationPending(false);
        }
      },
    );
    if (operation) await operation;
  };

  const refreshFiles = (): void => {
    refreshTree();
    onRefresh();
  };

  const openSelectedExternally = (): void => {
    if (!selectedEntry) return;
    setOperationError(null);
    void openWorkspacePath(workspaceRoot, selectedEntry.path).catch(
      (error: unknown) =>
        setOperationError(
          error instanceof Error ? error.message : String(error),
        ),
    );
  };

  const fileTreeCommandStateRef = useRef({
    visibleEntries,
    selectedEntry,
    operationPending,
    formMode,
    entryName,
    openForm,
    submitForm,
    deleteSelected,
    refreshFiles,
    openSelectedExternally,
    activateEntry,
    setFormMode,
  });
  fileTreeCommandStateRef.current = {
    visibleEntries,
    selectedEntry,
    operationPending,
    formMode,
    entryName,
    openForm,
    submitForm,
    deleteSelected,
    refreshFiles,
    openSelectedExternally,
    activateEntry,
    setFormMode,
  };
  const fileTreeCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = {
      kind: "view" as const,
      ownerId: "workspaces",
      viewId: "workspaces",
    };
    const state = () => fileTreeCommandStateRef.current;
    const selectedAvailability = () =>
      !state().selectedEntry
        ? { state: "hidden" as const }
        : state().operationPending
          ? {
              state: "disabled" as const,
              reason: "A file operation is in progress.",
            }
          : { state: "enabled" as const };
    return asPaletteCommands([
      {
        id: "workspaces.files.select",
        title: "Open workspace file",
        group: "Workspace files",
        scope,
        availability: () =>
          state().visibleEntries.length
            ? { state: "enabled" }
            : { state: "disabled", reason: "No loaded workspace files." },
        children: () => ({
          id: "workspaces.files.select.page",
          title: "Open workspace file",
          searchPlaceholder: "Search workspace files",
          groups: [
            {
              id: "entries",
              items: state().visibleEntries.map(({ entry }) => ({
                id: entry.path,
                title: entry.name,
                keywords: [entry.path, entry.kind],
                current: state().selectedEntry?.path === entry.path,
                execute: () => state().activateEntry(entry),
              })),
            },
          ],
        }),
      },
      {
        id: "workspaces.files.new-file",
        title: "New workspace file",
        group: "Workspace files",
        scope,
        availability: () =>
          state().operationPending
            ? { state: "disabled", reason: "A file operation is in progress." }
            : { state: "enabled" },
        execute: () => state().openForm("file"),
      },
      {
        id: "workspaces.files.new-folder",
        title: "New workspace folder",
        group: "Workspace files",
        scope,
        availability: () =>
          state().operationPending
            ? { state: "disabled", reason: "A file operation is in progress." }
            : { state: "enabled" },
        execute: () => state().openForm("directory"),
      },
      {
        id: "workspaces.files.rename",
        title: "Rename workspace entry",
        group: "Workspace files",
        scope,
        availability: selectedAvailability,
        execute: () => state().openForm("rename"),
      },
      {
        id: "workspaces.files.delete",
        title: "Delete workspace entry",
        group: "Workspace files",
        scope,
        availability: selectedAvailability,
        execute: () => void state().deleteSelected(),
      },
      {
        id: "workspaces.files.open-system",
        title: "Open workspace entry in system",
        group: "Workspace files",
        scope,
        availability: selectedAvailability,
        execute: () => state().openSelectedExternally(),
      },
      {
        id: "workspaces.files.refresh",
        title: "Refresh workspace files",
        group: "Workspace files",
        scope,
        availability: () =>
          state().operationPending
            ? { state: "disabled", reason: "A file operation is in progress." }
            : { state: "enabled" },
        execute: () => state().refreshFiles(),
      },
      {
        id: "workspaces.files.form.submit",
        title: "Submit workspace file operation",
        group: "Workspace files",
        scope,
        availability: () =>
          !state().formMode
            ? { state: "hidden" }
            : !state().entryName.trim() || state().operationPending
              ? { state: "disabled", reason: "Enter a name first." }
              : { state: "enabled" },
        execute: () => void state().submitForm(),
      },
      {
        id: "workspaces.files.form.cancel",
        title: "Cancel workspace file operation",
        group: "Workspace files",
        scope,
        availability: () =>
          state().formMode ? { state: "enabled" } : { state: "hidden" },
        execute: () => state().setFormMode(null),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(fileTreeCommands);

  const renderDirectory = (path: string, level: number): JSX.Element => {
    const state = directories[path];
    if (state?.loading && !state.page) {
      return (
        <div
          className="flex h-8 items-center text-xs text-slate-600"
          style={{ paddingLeft: `${10 + level * 16}px` }}
        >
          <LoaderCircle className="mr-2 size-3.5 animate-spin" />
          Loading
        </div>
      );
    }
    if (state?.error && !state.page) {
      return (
        <button
          type="button"
          className="w-full py-2 pr-2 text-left text-xs text-red-300 hover:text-red-200"
          style={{ paddingLeft: `${10 + level * 16}px` }}
          onClick={() => void loadDirectory(path)}
        >
          {state.error}
        </button>
      );
    }

    return (
      <>
        {(state?.page?.entries ?? []).map((entry) => {
          const expanded = expandedPaths.has(entry.path);
          const Icon = entryIcon(entry, expanded);
          const directory = isWorkspaceDirectory(entry);
          const selected = selectedEntry?.path === entry.path;
          return (
            <Fragment key={entry.path}>
              <button
                ref={(element) => {
                  if (element) rowRefs.current.set(entry.path, element);
                  else rowRefs.current.delete(entry.path);
                }}
                type="button"
                role="treeitem"
                aria-level={level}
                aria-selected={selected}
                aria-expanded={directory ? expanded : undefined}
                tabIndex={
                  focusedPath === entry.path ||
                  (!focusedPath && selected) ||
                  (!focusedPath &&
                    !selectedEntry &&
                    visibleEntries[0]?.entry.path === entry.path)
                    ? 0
                    : -1
                }
                onFocus={() => setFocusedPath(entry.path)}
                onClick={() => activateEntry(entry)}
                onKeyDown={(event) => handleTreeKeyDown(event, entry)}
                className={cn(
                  "group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-xs outline-none",
                  "focus-visible:ring-1 focus-visible:ring-sky-400/70",
                  selected
                    ? "bg-sky-500/12 text-sky-100"
                    : "text-slate-400 hover:bg-slate-900/75 hover:text-slate-200",
                )}
                style={{ paddingLeft: `${6 + (level - 1) * 16}px` }}
              >
                <span className="grid size-3.5 shrink-0 place-items-center text-slate-600">
                  {directory ? (
                    expanded ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )
                  ) : null}
                </span>
                <Icon
                  className={cn(
                    "size-3.5 shrink-0",
                    directory ? "text-sky-400/80" : "text-slate-500",
                    entry.kind === "symlink" && "text-violet-400/80",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
              {directory && expanded
                ? renderDirectory(entry.path, level + 1)
                : null}
            </Fragment>
          );
        })}
        {state?.page?.nextOffset !== null &&
        state?.page?.nextOffset !== undefined ? (
          <button
            type="button"
            disabled={state.loadingMore}
            onClick={() =>
              void loadDirectory(path, state.page?.nextOffset ?? 0)
            }
            className="flex h-7 items-center text-xs text-sky-400 hover:text-sky-300 disabled:opacity-50"
            style={{ paddingLeft: `${10 + level * 16}px` }}
          >
            {state.loadingMore ? (
              <LoaderCircle className="mr-1.5 size-3 animate-spin" />
            ) : null}
            Load more
          </button>
        ) : null}
        {state?.page?.limitReached ? (
          <p
            role="status"
            className="py-1 pr-2 text-[11px] text-amber-300"
            style={{ paddingLeft: `${10 + level * 16}px` }}
          >
            {state.page.totalEntries - state.page.omittedEntries} shown
            {state.page.omittedEntries > 0
              ? ` · ${state.page.omittedEntries} omitted`
              : ""}
          </p>
        ) : null}
      </>
    );
  };

  return (
    <aside className="flex min-h-0 min-w-0 flex-col border-r border-slate-800/80 bg-slate-950/45">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-800/80 px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Explorer
        </span>
        <TreeAction
          label="New file"
          icon={FilePlus2}
          disabled={operationPending}
          onClick={() => openForm("file")}
        />
        <TreeAction
          label="New folder"
          icon={FolderPlus}
          disabled={operationPending}
          onClick={() => openForm("directory")}
        />
        <TreeAction
          label="Refresh files"
          icon={RefreshCw}
          disabled={operationPending}
          onClick={refreshFiles}
        />
      </header>

      {formMode ? (
        <form
          className="flex shrink-0 items-center gap-1 border-b border-slate-800/80 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitForm();
          }}
        >
          <Input
            autoFocus
            value={entryName}
            aria-label={formMode === "rename" ? "New name" : "Entry name"}
            placeholder={formMode === "rename" ? "New name" : "Name"}
            className="h-7 min-w-0 flex-1 border-slate-800 bg-slate-950 px-2 text-xs"
            onChange={(event) => setEntryName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFormMode(null);
            }}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={formMode === "rename" ? "Rename" : "Create"}
            disabled={!entryName.trim() || operationPending}
          >
            {operationPending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Cancel"
            onClick={() => setFormMode(null)}
          >
            <X className="size-3.5" />
          </Button>
        </form>
      ) : null}

      {operationError ? (
        <button
          type="button"
          role="alert"
          className="shrink-0 border-b border-red-950 bg-red-950/25 px-3 py-2 text-left text-xs text-red-200"
          onClick={() => setOperationError(null)}
        >
          {operationError}
        </button>
      ) : null}

      <div
        role="tree"
        aria-label="Workspace files"
        className="min-h-0 flex-1 overflow-auto px-1.5 py-2"
      >
        {renderDirectory(".", 1)}
        {!directories["."]?.loading &&
        !directories["."]?.error &&
        directories["."]?.page?.entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-slate-600">
            Empty folder
          </p>
        ) : null}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-0.5 border-t border-slate-800/80 px-2">
        <TreeAction
          label="Rename"
          icon={Pencil}
          disabled={!selectedEntry || operationPending}
          onClick={() => openForm("rename")}
        />
        <TreeAction
          label="Delete"
          icon={Trash2}
          disabled={!selectedEntry || operationPending}
          onClick={() => void deleteSelected()}
        />
        <TreeAction
          label="Open in system"
          icon={ExternalLink}
          disabled={!selectedEntry || operationPending}
          onClick={openSelectedExternally}
        />
        {selectedEntry && isWorkspaceFile(selectedEntry) ? (
          <span className="ml-auto truncate pl-2 text-[10px] text-slate-600">
            {selectedEntry.size === null
              ? ""
              : formatWorkspaceFileSize(selectedEntry.size)}
          </span>
        ) : null}
      </footer>
    </aside>
  );
};
