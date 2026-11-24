import {
  Bot,
  Columns2,
  ExternalLink,
  FileSearch,
  FolderTree,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceGitRepository,
} from "@machdoch/fleet-protocol/workspace-contract";
import { loadWorkspaceGitRepositories } from "../runtime";
import { useWorkspaceFileDecorations } from "./use-workspace-file-decorations";
import type { AgentChangedFile } from "./workspace-agent-changes";
import { workspaceChangeFeed } from "./workspace-change-events";
import { useWorkspaceDock, workspaceDockStore } from "./workspace-dock-store";
import {
  closeEditorTab,
  editorTabNeedsCloseConfirmation,
  EMPTY_EDITOR_TABS,
  openEditorTab,
  renameEditorTab,
  toggleEditorSplit,
  updateEditorTab,
  type EditorPane,
  type EditorTab,
} from "./workspace-editor-tabs";
import { WorkspaceFileExplorer } from "./workspace-file-explorer";
import {
  WorkspaceFileViewer,
  type WorkspaceFileContext,
} from "./workspace-file-viewer";
import { repositoryForWorkspacePath } from "./workspace-path-repository";
import { WorkspaceQuickOpen } from "./workspace-quick-open";
import { WorkspaceTextSearchView } from "./workspace-text-search";
import { openWorkspaceToolWindow } from "./workspace-tools-runtime";

const fileEntry = (path: string): WorkspaceDirectoryEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind: "file",
  targetKind: null,
  size: null,
  modifiedAt: null,
  ignored: false,
});

const OPERATION_LETTER: Record<AgentChangedFile["operation"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  "type-changed": "T",
};

export interface WorkspaceFilesChatBridge {
  agentChangedFiles: readonly AgentChangedFile[];
  addPaths: (paths: readonly string[]) => void;
  addContext: (context: WorkspaceFileContext) => void;
  ask: (context: WorkspaceFileContext) => void;
}

export const WorkspaceFilesPanel = ({
  workspaceRoot,
  chat,
  standalone = false,
  onClose,
}: {
  workspaceRoot: string;
  chat?: WorkspaceFilesChatBridge;
  standalone?: boolean;
  onClose?: () => void;
}): JSX.Element => {
  const dock = useWorkspaceDock(workspaceRoot);
  const view = dock?.layout.filesView ?? "explorer";
  const [tabs, setTabs] = useState(EMPTY_EDITOR_TABS);
  const [reveals, setReveals] = useState<
    Record<string, { id: number; line: number }>
  >({});
  const [diskTokens, setDiskTokens] = useState<Record<string, number>>({});
  const [agentFilter, setAgentFilter] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [repositories, setRepositories] = useState<WorkspaceGitRepository[]>(
    [],
  );
  const decorations = useWorkspaceFileDecorations(workspaceRoot);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const revealIdRef = useRef(0);

  useEffect(() => {
    setTabs(EMPTY_EDITOR_TABS);
    setReveals({});
    setDiskTokens({});
    setAgentFilter(false);
    let active = true;
    void loadWorkspaceGitRepositories(workspaceRoot)
      .then((discovery) => {
        if (active) setRepositories(discovery.repositories);
      })
      .catch((error: unknown) =>
        console.error("Loading repositories failed", error),
      );
    return () => {
      active = false;
    };
  }, [workspaceRoot]);

  const openFile = useCallback(
    (
      path: string,
      {
        pinned = true,
        line,
        compare = false,
      }: { pinned?: boolean; line?: number; compare?: boolean } = {},
    ): void => {
      setTabs((current) => {
        const opened = openEditorTab(current, path, { pinned });
        return compare
          ? updateEditorTab(opened, path, { diffAgainstHead: true })
          : opened;
      });
      if (line)
        setReveals((current) => ({
          ...current,
          [path]: { id: ++revealIdRef.current, line },
        }));
    },
    [],
  );

  const fileRequestId = dock?.fileRequest?.id;
  useEffect(() => {
    const request = workspaceDockStore.takeFileRequest(workspaceRoot);
    if (request) openFile(request.path, { line: request.line });
  }, [fileRequestId, openFile, workspaceRoot]);

  const quickOpenRequested = dock?.quickOpenRequested ?? false;
  useEffect(() => {
    if (
      quickOpenRequested &&
      workspaceDockStore.takeQuickOpenRequest(workspaceRoot)
    ) {
      setQuickOpen(true);
    }
  }, [quickOpenRequested, workspaceRoot]);

  useEffect(
    () =>
      workspaceChangeFeed.subscribe(workspaceRoot, (event) => {
        const open = new Set(tabsRef.current.tabs.map((tab) => tab.path));
        const changed = event.paths.filter((path) => open.has(path));
        if (changed.length === 0) return;
        setDiskTokens((current) => {
          const next = { ...current };
          for (const path of changed) next[path] = (next[path] ?? 0) + 1;
          return next;
        });
      }),
    [workspaceRoot],
  );

  const dirty = tabs.tabs.some((tab) => tab.dirty);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const closeTab = (path: string): void => {
    if (
      editorTabNeedsCloseConfirmation(tabsRef.current, path) &&
      !window.confirm(`Discard unsaved changes to ${path}?`)
    ) {
      return;
    }
    setTabs((current) => closeEditorTab(current, path));
  };

  const activate = (path: string, pane: EditorPane = tabs.focusedPane): void =>
    setTabs((current) => ({
      ...current,
      active: { ...current.active, [pane]: path },
      focusedPane: pane,
    }));

  const setDirty = useCallback((path: string, nextDirty: boolean): void => {
    setTabs((current) =>
      current.tabs.some((tab) => tab.path === path && tab.dirty !== nextDirty)
        ? updateEditorTab(current, path, { dirty: nextDirty })
        : current,
    );
  }, []);

  const renderViewer = (
    tab: EditorTab,
    pane: EditorPane,
    visible: boolean,
  ): JSX.Element => (
    <div
      key={`${pane}:${tab.path}`}
      className={cn("min-h-0 flex-1 flex-col", visible ? "flex" : "hidden")}
      onFocusCapture={() => {
        if (tabs.focusedPane !== pane)
          setTabs((current) => ({ ...current, focusedPane: pane }));
      }}
    >
      <WorkspaceFileViewer
        workspaceRoot={workspaceRoot}
        selectedEntry={fileEntry(tab.path)}
        commandsActive={visible && tabs.focusedPane === pane}
        externalRefreshToken={String(diskTokens[tab.path] ?? 0)}
        repository={repositoryForWorkspacePath(repositories, tab.path)}
        reveal={reveals[tab.path] ?? null}
        initialHeadComparison={tab.diffAgainstHead}
        onDirtyChange={(nextDirty) => setDirty(tab.path, nextDirty)}
        onSaved={() => undefined}
        onExternalChange={() => undefined}
        {...(chat ? { onAddToChat: chat.addContext, onAsk: chat.ask } : {})}
      />
    </div>
  );

  const paneTabs = (pane: EditorPane): EditorTab[] => {
    const active = tabs.active[pane];
    return tabs.tabs.filter(
      (tab) =>
        tab.path === active ||
        (pane === "primary" && tab.dirty && tab.path !== tabs.active.secondary),
    );
  };

  const agentFiles = chat?.agentChangedFiles ?? [];

  return (
    <section
      aria-label="Files"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-slate-950 text-slate-200"
    >
      <header className="flex h-9 shrink-0 items-center gap-0.5 border-b border-slate-800/80 px-1.5">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Explorer"
          aria-pressed={view === "explorer" && !agentFilter}
          tooltip="Explorer"
          onClick={() => {
            setAgentFilter(false);
            workspaceDockStore.updateLayout(workspaceRoot, (layout) => ({
              ...layout,
              filesView: "explorer",
            }));
          }}
        >
          <FolderTree className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Search"
          aria-pressed={view === "search" && !agentFilter}
          tooltip="Search"
          onClick={() => {
            setAgentFilter(false);
            workspaceDockStore.updateLayout(workspaceRoot, (layout) => ({
              ...layout,
              filesView: "search",
            }));
          }}
        >
          <Search className="size-3.5" />
        </Button>
        {agentFiles.length ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Changed by agent"
            aria-pressed={agentFilter}
            tooltip="Changed by agent"
            onClick={() => setAgentFilter((current) => !current)}
          >
            <Bot className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Go to file"
          tooltip="Go to file"
          onClick={() => setQuickOpen(true)}
        >
          <FileSearch className="size-3.5" />
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Split editor"
          aria-pressed={tabs.split}
          tooltip="Split editor"
          disabled={!tabs.active.primary}
          onClick={() => setTabs(toggleEditorSplit)}
        >
          <Columns2 className="size-3.5" />
        </Button>
        {standalone ? null : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Open in new window"
            tooltip="Open in new window"
            onClick={() =>
              void openWorkspaceToolWindow(workspaceRoot, "files").catch(
                (error: unknown) =>
                  console.error("Opening the files window failed", error),
              )
            }
          >
            <ExternalLink className="size-3.5" />
          </Button>
        )}
        {onClose ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Close files"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[clamp(11rem,32%,18rem)] shrink-0 flex-col border-r border-slate-800/80">
          {agentFilter ? (
            <ul
              aria-label="Changed by agent"
              className="min-h-0 flex-1 overflow-auto py-1 text-xs"
            >
              {agentFiles.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1 text-left text-slate-300 hover:bg-slate-900"
                    onClick={() =>
                      openFile(file.path, {
                        compare: file.operation !== "deleted",
                      })
                    }
                  >
                    <span className="w-3 shrink-0 text-[10px] font-semibold text-amber-200">
                      {OPERATION_LETTER[file.operation]}
                    </span>
                    <span className="min-w-0 truncate">{file.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : view === "search" ? (
            <WorkspaceTextSearchView
              workspaceRoot={workspaceRoot}
              onOpenMatch={(path, line) => openFile(path, { line })}
            />
          ) : (
            <WorkspaceFileExplorer
              workspaceRoot={workspaceRoot}
              activePath={tabs.active[tabs.focusedPane]}
              decorations={decorations}
              onOpen={(path, options) => openFile(path, options)}
              onPathsRemoved={(paths) =>
                setTabs((current) =>
                  current.tabs
                    .filter((tab) =>
                      paths.some(
                        (path) =>
                          tab.path === path || tab.path.startsWith(`${path}/`),
                      ),
                    )
                    .reduce(
                      (next, tab) => closeEditorTab(next, tab.path),
                      current,
                    ),
                )
              }
              onPathMoved={(from, to) =>
                setTabs((current) => renameEditorTab(current, from, to))
              }
              {...(chat ? { onAddToChat: chat.addPaths } : {})}
            />
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tabs.tabs.length ? (
            <div
              role="tablist"
              aria-label="Open files"
              className="flex h-8 shrink-0 overflow-x-auto border-b border-slate-800/80"
            >
              {tabs.tabs.map((tab) => {
                const current = tab.path === tabs.active[tabs.focusedPane];
                return (
                  <div
                    key={tab.path}
                    role="tab"
                    aria-selected={current}
                    title={tab.path}
                    className={cn(
                      "group flex max-w-[14rem] shrink-0 cursor-default items-center gap-1 border-r border-slate-800/80 pl-2.5 pr-1 text-xs",
                      current
                        ? "bg-slate-900 text-slate-100"
                        : "text-slate-500 hover:text-slate-300",
                      !tab.pinned && "italic",
                    )}
                    onClick={() => activate(tab.path)}
                    onDoubleClick={() =>
                      setTabs((state) =>
                        openEditorTab(state, tab.path, { pinned: true }),
                      )
                    }
                    onAuxClick={(event) => {
                      if (event.button === 1) closeTab(tab.path);
                    }}
                  >
                    <span className="min-w-0 truncate">
                      {tab.path.split("/").at(-1)}
                    </span>
                    {tab.dirty ? (
                      <span
                        aria-label="Unsaved"
                        className="size-1.5 shrink-0 rounded-full bg-amber-300"
                      />
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Close ${tab.path}`}
                      className="grid size-5 place-items-center rounded text-slate-500 opacity-0 hover:bg-slate-800 hover:text-slate-200 group-hover:opacity-100 aria-selected:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.path);
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {tabs.tabs.length === 0 ? (
            <EmptyState
              icon={FolderTree}
              title="No file open"
              className="m-auto"
            />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div
                className={cn(
                  "flex min-h-0 min-w-0 flex-1 flex-col",
                  tabs.split && "border-r border-slate-800/80",
                )}
              >
                {paneTabs("primary").map((tab) =>
                  renderViewer(
                    tab,
                    "primary",
                    tab.path === tabs.active.primary,
                  ),
                )}
              </div>
              {tabs.split ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {paneTabs("secondary").map((tab) =>
                    renderViewer(tab, "secondary", true),
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
      <WorkspaceQuickOpen
        workspaceRoot={workspaceRoot}
        open={quickOpen}
        onOpenChange={setQuickOpen}
        onOpenFile={(path, line) => openFile(path, { line })}
      />
    </section>
  );
};
