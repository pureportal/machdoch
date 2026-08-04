import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { WorkspaceDirectoryEntry } from "../runtime";
import { WorkspaceFileTree } from "./workspace-file-tree";
import { WorkspaceFileViewer } from "./workspace-file-viewer";
import { WorkspaceTerminal } from "./workspace-terminal";

const MIN_TERMINAL_HEIGHT = 150;
const MAX_TERMINAL_HEIGHT = 500;
const MIN_FILES_HEIGHT = 280;

export const WorkspaceTools = ({
  workspaceRoot,
  refreshToken,
  onDirtyChange,
  onWorkspaceMutation,
}: {
  workspaceRoot: string;
  refreshToken: number;
  onDirtyChange: (dirty: boolean) => void;
  onWorkspaceMutation: () => void;
}): JSX.Element => {
  const [selectedEntry, setSelectedEntry] =
    useState<WorkspaceDirectoryEntry | null>(null);
  const [dirty, setDirty] = useState(false);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [viewerRefreshToken, setViewerRefreshToken] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const containerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const updateDirty = useCallback(
    (nextDirty: boolean): void => {
      setDirty(nextDirty);
      onDirtyChange(nextDirty);
    },
    [onDirtyChange],
  );

  useEffect(() => {
    setSelectedEntry(null);
    updateDirty(false);
    setTreeRefreshToken((current) => current + 1);
  }, [updateDirty, workspaceRoot]);

  useEffect(() => {
    const preventUnsavedClose = (event: BeforeUnloadEvent): void => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnsavedClose);
    return () =>
      window.removeEventListener("beforeunload", preventUnsavedClose);
  }, [dirty]);

  const confirmDiscard = useCallback((): boolean => {
    if (!dirty) return true;
    return window.confirm("Discard your unsaved changes?");
  }, [dirty]);

  const refreshTreeAndWorkspace = useCallback((): void => {
    setTreeRefreshToken((current) => current + 1);
    onWorkspaceMutation();
  }, [onWorkspaceMutation]);

  const selectEntry = (entry: WorkspaceDirectoryEntry): boolean => {
    if (selectedEntry?.path !== entry.path && !confirmDiscard()) return false;
    setSelectedEntry(entry);
    return true;
  };

  const handleMutation = (
    previousPath: string | null,
    nextEntry: WorkspaceDirectoryEntry | null,
  ): void => {
    if (previousPath === null || selectedEntry?.path === previousPath) {
      setSelectedEntry(nextEntry);
      updateDirty(false);
    }
    onWorkspaceMutation();
  };

  const clampTerminalHeight = useCallback((height: number): number => {
    const containerHeight =
      containerRef.current?.getBoundingClientRect().height ?? 680;
    return Math.max(
      MIN_TERMINAL_HEIGHT,
      Math.min(height, MAX_TERMINAL_HEIGHT, containerHeight - MIN_FILES_HEIGHT),
    );
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setTerminalHeight((current) => clampTerminalHeight(current));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [clampTerminalHeight]);

  return (
    <section
      ref={containerRef}
      aria-label="Workspace files and terminal"
      className="flex h-[clamp(32rem,calc(100vh-13.5rem),54rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20 shadow-[0_18px_60px_rgba(0,0,0,0.18)]"
    >
      <div className="grid min-h-[17.5rem] min-w-0 flex-1 grid-cols-[clamp(12rem,24%,16rem)_minmax(0,1fr)] overflow-hidden">
        <WorkspaceFileTree
          workspaceRoot={workspaceRoot}
          selectedEntry={selectedEntry}
          refreshToken={treeRefreshToken + refreshToken}
          onSelect={selectEntry}
          onBeforeSelectedMutation={confirmDiscard}
          onMutation={handleMutation}
          onRefresh={() => {
            setViewerRefreshToken((current) => current + 1);
            onWorkspaceMutation();
          }}
        />
        <WorkspaceFileViewer
          workspaceRoot={workspaceRoot}
          selectedEntry={selectedEntry}
          externalRefreshToken={`${refreshToken}:${viewerRefreshToken}`}
          onDirtyChange={updateDirty}
          onExternalChange={refreshTreeAndWorkspace}
          onSaved={refreshTreeAndWorkspace}
        />
      </div>

      {terminalOpen ? (
        <div
          role="separator"
          aria-label="Resize terminal"
          aria-orientation="horizontal"
          aria-valuemin={MIN_TERMINAL_HEIGHT}
          aria-valuemax={MAX_TERMINAL_HEIGHT}
          aria-valuenow={terminalHeight}
          tabIndex={0}
          className="group relative z-10 h-1.5 shrink-0 cursor-row-resize bg-slate-800/80 outline-none focus-visible:bg-sky-500/70"
          onPointerDown={(event) => {
            dragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startHeight: terminalHeight,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setTerminalHeight(
              clampTerminalHeight(
                drag.startHeight + drag.startY - event.clientY,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) {
              dragRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) {
              dragRef.current = null;
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setTerminalHeight((current) => clampTerminalHeight(current + 24));
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setTerminalHeight((current) => clampTerminalHeight(current - 24));
            }
          }}
        >
          <span className="absolute left-1/2 top-1/2 h-0.5 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-600 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
        </div>
      ) : null}

      <div
        id="workspace-terminal-panel"
        className="shrink-0 overflow-hidden"
        style={{ height: terminalOpen ? terminalHeight : 40 }}
      >
        <WorkspaceTerminal
          key={workspaceRoot}
          workspaceRoot={workspaceRoot}
          open={terminalOpen}
          onToggle={() => setTerminalOpen((current) => !current)}
        />
      </div>
    </section>
  );
};
