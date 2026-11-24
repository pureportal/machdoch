import { createWorkspaceRootKey } from "./workspace-management-model";
import {
  writeWorkspaceViewPreferences,
  type WorkspaceDetailSection,
} from "./workspace-view-preferences";

const OPEN_SECTION_EVENT = "machdoch:open-workspace-section";

export const openWorkspaceSection = (
  workspaceRoot: string,
  section: WorkspaceDetailSection,
): void => {
  const selectedWorkspaceKey = createWorkspaceRootKey(workspaceRoot);
  writeWorkspaceViewPreferences((current) => ({
    ...current,
    section,
    selectedWorkspaceKey,
  }));
  window.dispatchEvent(new Event(OPEN_SECTION_EVENT));
};

export const onOpenWorkspaceSection = (listener: () => void): (() => void) => {
  window.addEventListener(OPEN_SECTION_EVENT, listener);
  return () => window.removeEventListener(OPEN_SECTION_EVENT, listener);
};
