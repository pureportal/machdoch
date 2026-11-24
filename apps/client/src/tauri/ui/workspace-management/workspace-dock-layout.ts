export type FilesDock = "side" | "window";
export type FilesView = "explorer" | "search";

export interface WorkspaceDockLayout {
  filesOpen: boolean;
  filesDock: FilesDock;
  filesView: FilesView;
  filesWidth: number;
  terminalOpen: boolean;
}

export const DEFAULT_WORKSPACE_DOCK_LAYOUT: WorkspaceDockLayout = {
  filesOpen: false,
  filesDock: "side",
  filesView: "explorer",
  filesWidth: 560,
  terminalOpen: false,
};

export const MIN_DOCK_PANEL_SIZE = 220;
export const MIN_CHAT_SIZE = 320;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const clampDockPanelSize = (size: number, available: number): number =>
  Math.round(
    Math.max(
      MIN_DOCK_PANEL_SIZE,
      Math.min(size, Math.max(MIN_DOCK_PANEL_SIZE, available - MIN_CHAT_SIZE)),
    ),
  );

export const normalizeWorkspaceDockLayout = (
  value: unknown,
): WorkspaceDockLayout => {
  if (!isRecord(value)) return DEFAULT_WORKSPACE_DOCK_LAYOUT;
  const width = Number(value.filesWidth);
  return {
    filesOpen: value.filesOpen === true,
    filesDock: value.filesDock === "window" ? "window" : "side",
    filesView: value.filesView === "search" ? "search" : "explorer",
    filesWidth:
      Number.isFinite(width) && width >= MIN_DOCK_PANEL_SIZE
        ? Math.min(Math.round(width), 4000)
        : DEFAULT_WORKSPACE_DOCK_LAYOUT.filesWidth,
    terminalOpen: value.terminalOpen === true,
  };
};

export const showFilesView = (
  layout: WorkspaceDockLayout,
  view: FilesView,
): WorkspaceDockLayout =>
  layout.filesOpen && layout.filesView === view && layout.filesDock === "side"
    ? { ...layout, filesOpen: false }
    : { ...layout, filesOpen: true, filesView: view };

export const toggleFilesPanel = (
  layout: WorkspaceDockLayout,
): WorkspaceDockLayout => ({ ...layout, filesOpen: !layout.filesOpen });

export const toggleTerminalPanel = (
  layout: WorkspaceDockLayout,
): WorkspaceDockLayout => ({ ...layout, terminalOpen: !layout.terminalOpen });
