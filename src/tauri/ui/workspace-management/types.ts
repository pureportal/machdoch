export interface WorkspaceManagementControls {
  workspaceRoots: string[];
  loading: boolean;
  onAdd: (workspaceRoot: string) => void;
  onRemove: (workspaceRoot: string) => void;
  onRelink: (currentWorkspaceRoot: string, nextWorkspaceRoot: string) => void;
}
