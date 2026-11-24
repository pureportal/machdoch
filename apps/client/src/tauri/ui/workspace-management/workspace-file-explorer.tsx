import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  ExternalLink,
  File,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Link2,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  X,
  Check,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  ContextActionMenu,
  type ContextMenuAction,
} from "@machdoch/media-studio/tauri/ui/components/ui/context-action-menu.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { copyText } from "@machdoch/media-studio/tauri/ui/lib/clipboard.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceEntryTransfer,
} from "@machdoch/fleet-protocol/workspace-contract";
import {
  createWorkspaceEntry,
  listWorkspaceDirectory,
  openWorkspaceFile,
  openWorkspacePath,
  renameWorkspaceEntry,
} from "../runtime";
import { registerNativeDropZone } from "../lib/native-drop-zones";
import { changedDirectories } from "./workspace-change-feed";
import { workspaceChangeFeed } from "./workspace-change-events";
import {
  decorationForPath,
  type FileDecoration,
  type FileDecorationIndex,
} from "./workspace-file-decorations";
import {
  canMoveInto,
  EMPTY_FILE_SELECTION,
  remapPathAfterMove,
  selectFilePath,
  topLevelPaths,
  uploadTargetPath,
  type FileSelection,
} from "./workspace-file-selection";
import {
  directoriesToReload,
  dropDirectoryFor,
  entryPaths,
  flattenTree,
  isDirectoryEntry,
  parentDirectory,
  type TreeDirectory,
  type TreeRow,
  visibleRowRange,
} from "./workspace-file-tree-rows";
import { workspaceEntryAbsolutePath } from "./workspace-tools-model";
import {
  canImportWorkspaceEntries,
  copyWorkspaceEntries,
  deleteWorkspaceEntries,
  importWorkspaceEntries,
  uploadWorkspaceFile,
} from "./workspace-tools-runtime";

const ROW_HEIGHT = 26;
const PATHS_MIME = "application/x-machdoch-workspace-paths";

type EntryForm =
  | { mode: "file" | "directory"; parent: string }
  | { mode: "rename"; path: string };

interface FileClipboard {
  workspaceRoot: string;
  mode: "copy" | "move";
  paths: string[];
}

let fileClipboard: FileClipboard | null = null;

const DECORATION_CLASS: Record<FileDecoration, string> = {
  conflicted: "text-rose-300",
  modified: "text-amber-200",
  added: "text-emerald-300",
  untracked: "text-emerald-300",
  deleted: "text-red-300",
  renamed: "text-sky-300",
  ignored: "text-slate-600",
};

const DECORATION_LETTER: Record<FileDecoration, string> = {
  conflicted: "!",
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  ignored: "",
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const entryIcon = (
  entry: WorkspaceDirectoryEntry,
  expanded: boolean,
): LucideIcon => {
  if (entry.kind === "symlink") return Link2;
  if (isDirectoryEntry(entry)) return expanded ? FolderOpen : Folder;
  return File;
};

const transferErrors = (
  transfers: readonly WorkspaceEntryTransfer[],
): string | null => {
  const failed = transfers.filter((transfer) => transfer.error);
  return failed.length
    ? failed.map((transfer) => transfer.error).join("\n")
    : null;
};

const rowId = (path: string): string =>
  `workspace-tree-${encodeURIComponent(path)}`;

export const WorkspaceFileExplorer = ({
  workspaceRoot,
  activePath,
  decorations,
  onOpen,
  onPathsRemoved,
  onPathMoved,
  onAddToChat,
}: {
  workspaceRoot: string;
  activePath: string | null;
  decorations: FileDecorationIndex;
  onOpen: (path: string, options: { pinned: boolean }) => void;
  onPathsRemoved: (paths: readonly string[]) => void;
  onPathMoved: (from: string, to: string) => void;
  onAddToChat?: (paths: readonly string[]) => void;
}): JSX.Element => {
  const [directories, setDirectories] = useState<Record<string, TreeDirectory>>(
    {},
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] =
    useState<FileSelection>(EMPTY_FILE_SELECTION);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [form, setForm] = useState<EntryForm | null>(null);
  const [formName, setFormName] = useState("");
  const [pending, setPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const requestIdsRef = useRef(new Map<string, number>());
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;

  const loadDirectory = useCallback(
    async (path: string, offset = 0): Promise<void> => {
      const requestId = (requestIdsRef.current.get(path) ?? 0) + 1;
      requestIdsRef.current.set(path, requestId);
      setDirectories((current) => ({
        ...current,
        [path]: {
          entries: current[path]?.entries ?? [],
          nextOffset: current[path]?.nextOffset ?? null,
          loading: true,
          error: null,
        },
      }));
      try {
        const page = await listWorkspaceDirectory(workspaceRoot, path, offset);
        if (requestIdsRef.current.get(path) !== requestId) return;
        setDirectories((current) => {
          const previous = offset > 0 ? (current[path]?.entries ?? []) : [];
          const known = new Set(previous.map((entry) => entry.path));
          return {
            ...current,
            [path]: {
              entries: [
                ...previous,
                ...page.entries.filter((entry) => !known.has(entry.path)),
              ],
              nextOffset: page.nextOffset,
              loading: false,
              error: null,
            },
          };
        });
      } catch (error) {
        if (requestIdsRef.current.get(path) !== requestId) return;
        setDirectories((current) => ({
          ...current,
          [path]: {
            entries: current[path]?.entries ?? [],
            nextOffset: null,
            loading: false,
            error: errorText(error),
          },
        }));
      }
    },
    [workspaceRoot],
  );

  const reloadLoaded = useCallback(
    (paths?: readonly string[]): void => {
      const loaded = new Set(Object.keys(directoriesRef.current));
      for (const path of paths ? directoriesToReload(paths, loaded) : loaded) {
        void loadDirectory(path);
      }
    },
    [loadDirectory],
  );

  useEffect(() => {
    requestIdsRef.current.clear();
    setDirectories({});
    setExpanded(new Set());
    setSelection(EMPTY_FILE_SELECTION);
    setFocusedPath(null);
    setForm(null);
    void loadDirectory(".");
    return workspaceChangeFeed.subscribe(workspaceRoot, (event) => {
      if (event.rescan || event.pathsTruncated) reloadLoaded();
      else reloadLoaded(changedDirectories(event));
    });
  }, [loadDirectory, reloadLoaded, workspaceRoot]);

  const rows = useMemo(
    () => flattenTree(directories, expanded),
    [directories, expanded],
  );
  const orderedPaths = useMemo(() => entryPaths(rows), [rows]);
  const entriesByPath = useMemo(() => {
    const map = new Map<string, WorkspaceDirectoryEntry>();
    for (const row of rows)
      if (row.kind === "entry") map.set(row.entry.path, row.entry);
    return map;
  }, [rows]);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const observer = new ResizeObserver(() =>
      setViewportHeight(tree.clientHeight),
    );
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);

  const toggleDirectory = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!directoriesRef.current[path]) void loadDirectory(path);
      }
      return next;
    });
  };

  const scrollIntoView = (path: string): void => {
    const index = rows.findIndex(
      (row) => row.kind === "entry" && row.entry.path === path,
    );
    const tree = treeRef.current;
    if (index < 0 || !tree) return;
    const top = index * ROW_HEIGHT;
    if (top < tree.scrollTop) tree.scrollTop = top;
    else if (top + ROW_HEIGHT > tree.scrollTop + tree.clientHeight) {
      tree.scrollTop = top + ROW_HEIGHT - tree.clientHeight;
    }
  };

  const focus = (
    path: string,
    modifiers = { toggle: false, range: false },
  ): void => {
    setFocusedPath(path);
    setSelection((current) =>
      selectFilePath(current, path, orderedPaths, modifiers),
    );
    scrollIntoView(path);
  };

  const selectedPaths = (): string[] =>
    selection.paths.size > 0
      ? topLevelPaths(selection.paths)
      : focusedPath
        ? [focusedPath]
        : [];

  const runOperation = async (
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (pending) return;
    setPending(true);
    setOperationError(null);
    try {
      await operation();
    } catch (error) {
      setOperationError(errorText(error));
    } finally {
      setPending(false);
    }
  };

  const transfer = (sources: string[], target: string, mode: "copy" | "move") =>
    runOperation(async () => {
      if (mode === "move" && !canMoveInto(sources, target)) return;
      const transfers = await copyWorkspaceEntries(
        workspaceRoot,
        sources,
        target,
        mode,
      );
      if (mode === "move") {
        for (const moved of transfers) {
          if (moved.path) onPathMoved(moved.source, moved.path);
        }
        setExpanded(
          (current) =>
            new Set(
              [...current].map((path) =>
                transfers.reduce(
                  (mapped, moved) =>
                    moved.path
                      ? remapPathAfterMove(mapped, moved.source, moved.path)
                      : mapped,
                  path,
                ),
              ),
            ),
        );
      }
      reloadLoaded([target, ...sources.map(parentDirectory)]);
      const failed = transferErrors(transfers);
      if (failed) throw new Error(failed);
    });

  const importNative = (paths: string[], target: string) =>
    runOperation(async () => {
      const transfers = await importWorkspaceEntries(
        workspaceRoot,
        paths,
        target,
      );
      reloadLoaded([target]);
      const failed = transferErrors(transfers);
      if (failed) throw new Error(failed);
    });

  const uploadFiles = (files: readonly globalThis.File[], target: string) =>
    runOperation(async () => {
      for (const file of files) {
        await uploadWorkspaceFile(
          workspaceRoot,
          uploadTargetPath(target, file.name),
          file,
        );
      }
      reloadLoaded([target]);
    });

  const trash = (paths: string[]) =>
    runOperation(async () => {
      if (paths.length === 0) return;
      const confirmed = window.confirm(
        paths.length === 1
          ? `Move “${paths[0]}” to the trash?`
          : `Move ${paths.length} items to the trash?`,
      );
      if (!confirmed) return;
      const deletions = await deleteWorkspaceEntries(
        workspaceRoot,
        paths,
        true,
      );
      const removed = deletions
        .filter((deletion) => !deletion.error)
        .map((deletion) => deletion.path);
      onPathsRemoved(removed);
      setSelection(EMPTY_FILE_SELECTION);
      reloadLoaded(paths.map(parentDirectory));
      const failed = deletions.filter((deletion) => deletion.error);
      if (failed.length)
        throw new Error(failed.map((deletion) => deletion.error).join("\n"));
    });

  const paste = (target: string) => {
    const clipboard = fileClipboard;
    if (!clipboard || clipboard.workspaceRoot !== workspaceRoot) return;
    if (clipboard.mode === "move") fileClipboard = null;
    void transfer(clipboard.paths, target, clipboard.mode);
  };

  const submitForm = () =>
    runOperation(async () => {
      if (!form || !formName.trim()) return;
      const name = formName.trim();
      if (form.mode === "rename") {
        const next = await renameWorkspaceEntry(workspaceRoot, form.path, name);
        onPathMoved(form.path, next);
        reloadLoaded([parentDirectory(form.path)]);
        setForm(null);
        focus(next);
        return;
      }
      const path = await createWorkspaceEntry(
        workspaceRoot,
        form.parent,
        name,
        form.mode,
      );
      setExpanded((current) => new Set(current).add(form.parent));
      reloadLoaded([form.parent]);
      if (form.parent !== "." && !directoriesRef.current[form.parent])
        void loadDirectory(form.parent);
      setForm(null);
      if (form.mode === "file") onOpen(path, { pinned: true });
    });

  const openForm = (next: EntryForm): void => {
    setOperationError(null);
    setForm(next);
    setFormName(
      next.mode === "rename" ? (next.path.split("/").at(-1) ?? "") : "",
    );
  };

  const focusedEntry = focusedPath
    ? (entriesByPath.get(focusedPath) ?? null)
    : null;

  const activate = (entry: WorkspaceDirectoryEntry, pinned: boolean): void => {
    if (isDirectoryEntry(entry)) toggleDirectory(entry.path);
    else onOpen(entry.path, { pinned });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    const index = focusedPath ? orderedPaths.indexOf(focusedPath) : -1;
    const mod = event.ctrlKey || event.metaKey;
    const move = (next: number) => {
      const path =
        orderedPaths[Math.max(0, Math.min(next, orderedPaths.length - 1))];
      if (path) focus(path, { toggle: false, range: event.shiftKey });
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? 0 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(orderedPaths.length - 1);
    else if (
      event.key === "ArrowRight" &&
      focusedEntry &&
      isDirectoryEntry(focusedEntry)
    ) {
      if (!expanded.has(focusedEntry.path)) toggleDirectory(focusedEntry.path);
      else move(index + 1);
    } else if (event.key === "ArrowLeft" && focusedEntry) {
      if (isDirectoryEntry(focusedEntry) && expanded.has(focusedEntry.path)) {
        toggleDirectory(focusedEntry.path);
      } else if (parentDirectory(focusedEntry.path) !== ".") {
        focus(parentDirectory(focusedEntry.path));
      }
    } else if (event.key === "Enter" && focusedEntry)
      activate(focusedEntry, true);
    else if (event.key === "F2" && focusedEntry)
      openForm({ mode: "rename", path: focusedEntry.path });
    else if (event.key === "Delete") void trash(selectedPaths());
    else if (mod && event.key.toLowerCase() === "c") {
      fileClipboard = { workspaceRoot, mode: "copy", paths: selectedPaths() };
    } else if (mod && event.key.toLowerCase() === "x") {
      fileClipboard = { workspaceRoot, mode: "move", paths: selectedPaths() };
    } else if (mod && event.key.toLowerCase() === "v")
      paste(dropDirectoryFor(focusedEntry));
    else if (mod && event.key.toLowerCase() === "a") {
      setSelection({
        paths: new Set(orderedPaths),
        anchor: orderedPaths[0] ?? null,
      });
    } else return;
    event.preventDefault();
  };

  const rowClick = (
    event: MouseEvent,
    entry: WorkspaceDirectoryEntry,
  ): void => {
    const toggle = event.ctrlKey || event.metaKey;
    focus(entry.path, { toggle, range: event.shiftKey });
    if (!toggle && !event.shiftKey) activate(entry, event.detail > 1);
  };

  const dragTargetFromEvent = (event: DragEvent): string => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-tree-path]",
    );
    const path = row?.dataset.treePath;
    const entry = path ? (entriesByPath.get(path) ?? null) : null;
    return dropDirectoryFor(entry);
  };

  const acceptsDrag = (event: DragEvent): boolean =>
    event.dataTransfer.types.includes(PATHS_MIME) ||
    event.dataTransfer.types.includes("Files");

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const internal = event.dataTransfer.types.includes(PATHS_MIME);
    event.dataTransfer.dropEffect =
      internal && !(event.ctrlKey || event.altKey) ? "move" : "copy";
    setDropTarget(dragTargetFromEvent(event));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = dragTargetFromEvent(event);
    setDropTarget(null);
    const internal = event.dataTransfer.getData(PATHS_MIME);
    if (internal) {
      const sources = JSON.parse(internal) as string[];
      void transfer(
        sources,
        target,
        event.ctrlKey || event.altKey ? "copy" : "move",
      );
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length) void uploadFiles(files, target);
  };

  const nativeDropRef = useRef({ importNative, entriesByPath });
  nativeDropRef.current = { importNative, entriesByPath };
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !canImportWorkspaceEntries()) return;
    const targetAt = (point: { x: number; y: number }): string => {
      const row = document
        .elementFromPoint(point.x, point.y)
        ?.closest<HTMLElement>("[data-tree-path]");
      const path = row?.dataset.treePath;
      return dropDirectoryFor(
        path ? (nativeDropRef.current.entriesByPath.get(path) ?? null) : null,
      );
    };
    return registerNativeDropZone({
      element: tree,
      onHover: (point) => setDropTarget(point ? targetAt(point) : null),
      onDrop: (paths, point) =>
        void nativeDropRef.current.importNative(paths, targetAt(point)),
    });
  }, []);

  const contextActions = (
    entry: WorkspaceDirectoryEntry | null,
  ): ContextMenuAction[] => {
    const paths =
      entry && selection.paths.has(entry.path)
        ? topLevelPaths(selection.paths)
        : entry
          ? [entry.path]
          : [];
    const target = dropDirectoryFor(entry);
    const clipboard =
      fileClipboard?.workspaceRoot === workspaceRoot ? fileClipboard : null;
    const actions: ContextMenuAction[] = [
      {
        label: "New file",
        icon: FilePlus2,
        onSelect: () => openForm({ mode: "file", parent: target }),
      },
      {
        label: "New folder",
        icon: FolderPlus,
        onSelect: () => openForm({ mode: "directory", parent: target }),
      },
    ];
    if (clipboard) {
      actions.push({
        label: "Paste",
        icon: ClipboardPaste,
        onSelect: () => paste(target),
      });
    }
    if (!entry) return actions;
    actions.push(
      {
        label: "Copy",
        icon: Copy,
        onSelect: () => {
          fileClipboard = { workspaceRoot, mode: "copy", paths };
        },
      },
      {
        label: "Cut",
        icon: Scissors,
        onSelect: () => {
          fileClipboard = { workspaceRoot, mode: "move", paths };
        },
      },
      {
        label: "Duplicate",
        icon: CopyPlus,
        onSelect: () => transfer(paths, parentDirectory(entry.path), "copy"),
      },
      {
        label: "Rename",
        icon: Pencil,
        disabled: paths.length > 1,
        onSelect: () => openForm({ mode: "rename", path: entry.path }),
      },
      {
        label: "Copy path",
        icon: Copy,
        onSelect: () =>
          copyText(
            paths
              .map((path) => workspaceEntryAbsolutePath(workspaceRoot, path))
              .join("\n"),
          ),
      },
      {
        label: "Copy relative path",
        icon: Copy,
        onSelect: () => copyText(paths.join("\n")),
      },
      {
        label: "Reveal in file manager",
        icon: FolderSearch,
        onSelect: () => openWorkspacePath(workspaceRoot, entry.path),
      },
    );
    if (!isDirectoryEntry(entry)) {
      actions.push({
        label: "Open in default app",
        icon: ExternalLink,
        onSelect: () => openWorkspaceFile(workspaceRoot, entry.path),
      });
    }
    if (onAddToChat) {
      actions.push({
        label: "Add to chat",
        icon: MessageSquarePlus,
        onSelect: () => onAddToChat(paths),
      });
    }
    actions.push({
      label: "Move to trash",
      icon: Trash2,
      destructive: true,
      onSelect: () => trash(paths),
    });
    return actions;
  };

  const { start, end } = visibleRowRange(
    scrollTop,
    viewportHeight,
    ROW_HEIGHT,
    rows.length,
  );

  const renderRow = (row: TreeRow, index: number): JSX.Element => {
    const style = {
      top: index * ROW_HEIGHT,
      height: ROW_HEIGHT,
      paddingLeft: 8 + row.level * 14,
    };
    if (row.kind === "loading") {
      return (
        <div
          key={`loading:${row.path}`}
          className="absolute inset-x-0 flex items-center text-xs text-slate-600"
          style={style}
        >
          <LoaderCircle className="mr-2 size-3.5 animate-spin" />
        </div>
      );
    }
    if (row.kind === "error") {
      return (
        <button
          key={`error:${row.path}`}
          type="button"
          className="absolute inset-x-0 truncate text-left text-xs text-red-300"
          style={style}
          onClick={() => void loadDirectory(row.path)}
        >
          {row.message}
        </button>
      );
    }
    if (row.kind === "more") {
      return (
        <button
          key={`more:${row.path}`}
          type="button"
          disabled={row.loading}
          className="absolute inset-x-0 text-left text-xs text-sky-400 hover:text-sky-300 disabled:opacity-50"
          style={style}
          onClick={() => void loadDirectory(row.path, row.offset)}
        >
          Load more
        </button>
      );
    }
    const { entry } = row;
    const directory = isDirectoryEntry(entry);
    const isExpanded = expanded.has(entry.path);
    const Icon = entryIcon(entry, isExpanded);
    const decoration = entry.ignored
      ? "ignored"
      : decorationForPath(
          decorations,
          entry.path,
          directory ? "directory" : "file",
        );
    const selected = selection.paths.has(entry.path);
    return (
      <ContextActionMenu
        key={entry.path}
        label={entry.name}
        actions={() => contextActions(entry)}
      >
        <div
          id={rowId(entry.path)}
          role="treeitem"
          aria-level={row.level + 1}
          aria-selected={selected}
          aria-expanded={directory ? isExpanded : undefined}
          data-tree-path={entry.path}
          draggable
          onDragStart={(event) => {
            const paths = selection.paths.has(entry.path)
              ? topLevelPaths(selection.paths)
              : [entry.path];
            event.dataTransfer.setData(PATHS_MIME, JSON.stringify(paths));
            event.dataTransfer.setData("text/plain", paths.join("\n"));
            event.dataTransfer.effectAllowed = "copyMove";
          }}
          onClick={(event) => rowClick(event, entry)}
          className={cn(
            "absolute inset-x-0 flex cursor-default items-center gap-1.5 pr-2 text-xs",
            selected
              ? "bg-sky-500/15 text-sky-100"
              : "text-slate-400 hover:bg-slate-900/75 hover:text-slate-200",
            focusedPath === entry.path && "ring-1 ring-inset ring-sky-400/50",
            activePath === entry.path && !selected && "text-slate-100",
            dropTarget === entry.path && directory && "bg-sky-500/20",
          )}
          style={style}
        >
          <span className="grid size-3.5 shrink-0 place-items-center text-slate-600">
            {directory ? (
              isExpanded ? (
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
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              decoration && DECORATION_CLASS[decoration],
            )}
          >
            {entry.name}
          </span>
          {decoration && decoration !== "ignored" ? (
            directory ? (
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full bg-current",
                  DECORATION_CLASS[decoration],
                )}
              />
            ) : (
              <span
                className={cn(
                  "shrink-0 text-[10px] font-semibold",
                  DECORATION_CLASS[decoration],
                )}
              >
                {DECORATION_LETTER[decoration]}
              </span>
            )
          ) : null}
        </div>
      </ContextActionMenu>
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 px-1.5">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-slate-500"
          aria-label="New file"
          disabled={pending}
          onClick={() =>
            openForm({ mode: "file", parent: dropDirectoryFor(focusedEntry) })
          }
        >
          <FilePlus2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-slate-500"
          aria-label="New folder"
          disabled={pending}
          onClick={() =>
            openForm({
              mode: "directory",
              parent: dropDirectoryFor(focusedEntry),
            })
          }
        >
          <FolderPlus className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-slate-500"
          aria-label="Refresh"
          disabled={pending}
          onClick={() => reloadLoaded()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {form ? (
        <form
          className="flex shrink-0 items-center gap-1 border-y border-slate-800/80 p-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitForm();
          }}
        >
          <Input
            autoFocus
            value={formName}
            aria-label="Name"
            placeholder="Name"
            className="h-7 min-w-0 flex-1 border-slate-800 bg-slate-950 px-2 text-xs"
            onChange={(event) => setFormName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setForm(null);
            }}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Save"
            disabled={!formName.trim() || pending}
          >
            {pending ? (
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
            onClick={() => setForm(null)}
          >
            <X className="size-3.5" />
          </Button>
        </form>
      ) : null}
      {operationError ? (
        <button
          type="button"
          role="alert"
          className="shrink-0 whitespace-pre-line border-b border-red-950 bg-red-950/25 px-3 py-2 text-left text-xs text-red-200"
          onClick={() => setOperationError(null)}
        >
          {operationError}
        </button>
      ) : null}
      <ContextActionMenu label="Files" actions={() => contextActions(null)}>
        <div
          ref={treeRef}
          role="tree"
          aria-label="Workspace files"
          aria-multiselectable
          aria-activedescendant={focusedPath ? rowId(focusedPath) : undefined}
          tabIndex={0}
          className={cn(
            "relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-sky-400/40",
            dropTarget === "." && "bg-sky-500/5",
          )}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onKeyDown={handleKeyDown}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDropTarget(null);
          }}
          onDrop={handleDrop}
        >
          <div style={{ height: rows.length * ROW_HEIGHT }} />
          {rows
            .slice(start, end)
            .map((row, offset) => renderRow(row, start + offset))}
        </div>
      </ContextActionMenu>
    </div>
  );
};
