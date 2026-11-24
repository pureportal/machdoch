export type WorkspaceTool = "files" | "terminal";

export interface WorkspaceToolWindowRoute {
  tool: WorkspaceTool;
  workspaceRoot: string;
}

export const parseWorkspaceToolWindowRoute = (
  search: string,
): WorkspaceToolWindowRoute | null => {
  const parameters = new URLSearchParams(search);
  const tool = parameters.get("tool");
  const workspaceRoot = parameters.get("workspace")?.trim();
  if ((tool !== "files" && tool !== "terminal") || !workspaceRoot) return null;
  return { tool, workspaceRoot };
};
