import type { WorkspaceLibraryRequest } from "@machdoch/fleet-protocol/workspace-library";
import { invokeWorkspaceTools } from "./workspace-platform";

export function invokeWorkspaceLibrary<T>(workspaceRoot: string, input: WorkspaceLibraryRequest): Promise<T> {
  return invokeWorkspaceTools<T>("run_workspace_library_command", { workspaceRoot, input });
}
