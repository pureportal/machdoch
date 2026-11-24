import type { JSX } from "react";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { WorkspaceToolWindow } from "./workspace-management/workspace-tool-window";
import type { WorkspaceToolWindowRoute } from "./workspace-management/workspace-tool-window-route";

export const WorkspaceToolShell = ({
  route,
}: {
  route: WorkspaceToolWindowRoute;
}): JSX.Element => (
  <TooltipProvider delayDuration={300}>
    <CommandProvider activeView="workspaces">
      <WorkspaceToolWindow route={route} />
    </CommandProvider>
  </TooltipProvider>
);
