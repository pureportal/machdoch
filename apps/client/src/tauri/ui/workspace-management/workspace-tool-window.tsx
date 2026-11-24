import type { JSX } from "react";
import { WorkspaceFilesPanel } from "./workspace-files-panel";
import { WorkspaceTerminalPanel } from "./workspace-terminal";
import type { WorkspaceToolWindowRoute } from "./workspace-tool-window-route";

export const WorkspaceToolWindow = ({
  route,
}: {
  route: WorkspaceToolWindowRoute;
}): JSX.Element => (
  <main className="flex h-dvh min-h-0 flex-col bg-slate-950 text-slate-50">
    {route.tool === "files" ? (
      <WorkspaceFilesPanel workspaceRoot={route.workspaceRoot} standalone />
    ) : (
      <WorkspaceTerminalPanel workspaceRoot={route.workspaceRoot} standalone />
    )}
  </main>
);
