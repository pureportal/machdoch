import {
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { getDefaultCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-defaults.js";
import type { CommandDefinition } from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  clampDockPanelSize,
  showFilesView,
  toggleTerminalPanel,
} from "./workspace-dock-layout";
import { useWorkspaceDock, workspaceDockStore } from "./workspace-dock-store";
import {
  WorkspaceFilesPanel,
  type WorkspaceFilesChatBridge,
} from "./workspace-files-panel";
import {
  WorkspaceTerminalPanel,
  type WorkspaceTerminalChatBridge,
} from "./workspace-terminal";

const DockResizer = ({
  orientation,
  onResize,
  onCommit,
}: {
  orientation: "vertical" | "horizontal";
  onResize: (delta: number) => void;
  onCommit: () => void;
}): JSX.Element => {
  const startRef = useRef<number | null>(null);
  const position = (event: PointerEvent<HTMLDivElement>) =>
    orientation === "vertical" ? event.clientX : event.clientY;
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "shrink-0 bg-slate-900 transition-colors hover:bg-sky-700/60",
        orientation === "vertical"
          ? "w-1 cursor-col-resize"
          : "h-1 cursor-row-resize",
      )}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = position(event);
      }}
      onPointerMove={(event) => {
        if (startRef.current === null) return;
        onResize(startRef.current - position(event));
      }}
      onPointerUp={(event) => {
        if (startRef.current === null) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        startRef.current = null;
        onCommit();
      }}
    />
  );
};

const useWorkspaceDockCommands = (workspaceRoot: string | null): void => {
  const rootRef = useRef(workspaceRoot);
  rootRef.current = workspaceRoot;
  const commands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = { kind: "view" as const, ownerId: "chat" };
    const allowIn = ["document", "text-entry", "interactive-control"] as const;
    const available = () =>
      rootRef.current
        ? ({ state: "enabled" } as const)
        : ({ state: "hidden" } as const);
    const withRoot = (run: (root: string) => void) => () => {
      if (rootRef.current) run(rootRef.current);
    };
    return [
      {
        id: "workspaces.files.quick-open",
        title: "Go to file",
        group: "Files",
        keywords: ["quick open", "find file"],
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("workspaces.files.quick-open"),
            allowIn,
          },
        ],
        palette: "visible",
        availability: available,
        execute: withRoot((root) => {
          workspaceDockStore.updateLayout(root, (layout) => ({
            ...layout,
            filesOpen: true,
          }));
          workspaceDockStore.requestQuickOpen(root);
        }),
      },
      {
        id: "workspaces.files.explorer",
        title: "Toggle file explorer",
        group: "Files",
        keywords: ["files", "tree"],
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("workspaces.files.explorer"),
            allowIn,
          },
        ],
        palette: "visible",
        availability: available,
        execute: withRoot((root) =>
          workspaceDockStore.updateLayout(root, (layout) =>
            showFilesView(layout, "explorer"),
          ),
        ),
      },
      {
        id: "workspaces.files.search",
        title: "Search in files",
        group: "Files",
        keywords: ["find", "replace", "grep"],
        scope,
        palette: "visible",
        availability: available,
        execute: withRoot((root) =>
          workspaceDockStore.updateLayout(root, (layout) =>
            showFilesView(layout, "search"),
          ),
        ),
      },
      {
        id: "workspaces.terminal.toggle",
        title: "Toggle terminal",
        group: "Terminal",
        keywords: ["shell", "console"],
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("workspaces.terminal.toggle"),
            allowIn: [...allowIn, "terminal"],
          },
        ],
        palette: "visible",
        availability: available,
        execute: withRoot((root) =>
          workspaceDockStore.updateLayout(root, toggleTerminalPanel),
        ),
      },
    ];
  }, []);
  useOptionalRegisterCommands(commands);
};

export const WorkspaceChatDock = ({
  workspaceRoot,
  filesChat,
  terminalChat,
  children,
}: {
  workspaceRoot: string | null;
  filesChat?: WorkspaceFilesChatBridge;
  terminalChat?: WorkspaceTerminalChatBridge;
  children: ReactNode;
}): JSX.Element => {
  const dock = useWorkspaceDock(workspaceRoot);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{
    side: number | null;
    bottom: number | null;
  }>({ side: null, bottom: null });
  const [filesMounted, setFilesMounted] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  useWorkspaceDockCommands(workspaceRoot);

  if (!workspaceRoot || !dock) return <>{children}</>;

  const filesVisible =
    dock.layout.filesOpen && dock.layout.filesDock === "side";
  const terminalVisible =
    dock.layout.terminalOpen && dock.terminal.dock !== "window";
  const terminalSide = dock.terminal.dock === "side";
  if (filesVisible && !filesMounted) setFilesMounted(true);
  if (terminalVisible && !terminalMounted) setTerminalMounted(true);
  const sideVisible = filesVisible || (terminalVisible && terminalSide);
  const sideWidth = drag.side ?? dock.layout.filesWidth;
  const terminalSize = drag.bottom ?? dock.terminal.size;

  const resizeSide = (delta: number): void => {
    const available = containerRef.current?.clientWidth ?? 0;
    setDrag((current) => ({
      ...current,
      side: clampDockPanelSize(dock.layout.filesWidth + delta, available),
    }));
  };
  const resizeBottom = (delta: number): void => {
    const available =
      (terminalSide ? containerRef.current : columnRef.current)?.clientHeight ??
      0;
    setDrag((current) => ({
      ...current,
      bottom: clampDockPanelSize(dock.terminal.size + delta, available),
    }));
  };
  const commitSide = (): void => {
    if (drag.side !== null) {
      const width = drag.side;
      workspaceDockStore.updateLayout(workspaceRoot, (layout) => ({
        ...layout,
        filesWidth: width,
      }));
    }
    setDrag((current) => ({ ...current, side: null }));
  };
  const commitBottom = (): void => {
    if (drag.bottom !== null) {
      const size = drag.bottom;
      workspaceDockStore.updateTerminal(workspaceRoot, (terminal) => ({
        ...terminal,
        size,
      }));
    }
    setDrag((current) => ({ ...current, bottom: null }));
  };
  const closeFiles = (): void =>
    workspaceDockStore.updateLayout(workspaceRoot, (layout) => ({
      ...layout,
      filesOpen: false,
    }));
  const closeTerminal = (): void =>
    workspaceDockStore.updateLayout(workspaceRoot, (layout) => ({
      ...layout,
      terminalOpen: false,
    }));

  const terminal = terminalMounted ? (
    <WorkspaceTerminalPanel
      workspaceRoot={workspaceRoot}
      chat={terminalChat}
      onClose={closeTerminal}
    />
  ) : null;

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <div
        ref={columnRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {children}
        {terminalVisible && !terminalSide ? (
          <DockResizer
            orientation="horizontal"
            onResize={resizeBottom}
            onCommit={commitBottom}
          />
        ) : null}
        {!terminalSide ? (
          <div
            className={cn(
              "min-h-0 shrink-0 overflow-hidden",
              !terminalVisible && "hidden",
            )}
            style={{ height: terminalSize }}
          >
            {terminal}
          </div>
        ) : null}
      </div>
      {sideVisible ? (
        <DockResizer
          orientation="vertical"
          onResize={resizeSide}
          onCommit={commitSide}
        />
      ) : null}
      <aside
        aria-label="Workspace tools"
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-slate-900",
          !sideVisible && "hidden",
        )}
        style={{ width: sideWidth }}
      >
        {filesMounted ? (
          <div
            className={cn(
              "min-h-0 flex-1 overflow-hidden",
              !filesVisible && "hidden",
            )}
          >
            <WorkspaceFilesPanel
              workspaceRoot={workspaceRoot}
              chat={filesChat}
              onClose={closeFiles}
            />
          </div>
        ) : null}
        {terminalSide ? (
          <>
            {filesVisible && terminalVisible ? (
              <DockResizer
                orientation="horizontal"
                onResize={resizeBottom}
                onCommit={commitBottom}
              />
            ) : null}
            <div
              className={cn(
                "min-h-0 overflow-hidden",
                !terminalVisible && "hidden",
                filesVisible ? "shrink-0" : "flex-1",
              )}
              style={filesVisible ? { height: terminalSize } : undefined}
            >
              {terminal}
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
};
