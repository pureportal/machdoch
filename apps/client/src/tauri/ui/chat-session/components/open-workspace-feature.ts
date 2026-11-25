import {
  showFilesView,
  toggleTerminalPanel,
} from "../../workspace-management/workspace-dock-layout";
import { workspaceDockStore } from "../../workspace-management/workspace-dock-store";

export const openWorkspaceFeature = (
  workspaceRoot: string,
  feature: "files" | "terminal",
): void => {
  if (feature === "files") {
    workspaceDockStore.updateLayout(workspaceRoot, (layout) => ({
      ...showFilesView(layout, layout.filesView),
      filesDock: "side",
    }));
    return;
  }
  workspaceDockStore.updateLayout(workspaceRoot, toggleTerminalPanel);
};
