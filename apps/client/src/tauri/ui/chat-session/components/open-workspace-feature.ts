import {
  showFilesView,
  toggleTerminalPanel,
} from "../../workspace-management/workspace-dock-layout";
import { workspaceDockStore } from "../../workspace-management/workspace-dock-store";
import { openWorkspaceSection } from "../../workspace-management/workspace-navigation";
import type { WorkspaceStatusFeature } from "../../workspace-management/workspace-status-strip";

export const openWorkspaceFeature = (
  workspaceRoot: string,
  feature: WorkspaceStatusFeature,
): void => {
  switch (feature) {
    case "files":
      workspaceDockStore.updateLayout(workspaceRoot, (layout) => ({
        ...showFilesView(layout, layout.filesView),
        filesDock: "side",
      }));
      return;
    case "terminal":
      workspaceDockStore.updateLayout(workspaceRoot, toggleTerminalPanel);
      return;
    case "git":
    case "run":
      openWorkspaceSection(workspaceRoot, feature);
  }
};
