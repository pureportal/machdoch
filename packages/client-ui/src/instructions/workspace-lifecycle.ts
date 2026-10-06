import type { InstructionLibraryRuntime } from "./use-instruction-management";

export function createWorkspaceInstructionLifecycle(operations: {
  stopTerminals(workspaceRoot: string): Promise<void>;
  relinkWorkspace(previousRoot: string, nextRoot: string): Promise<void> | void;
}): Pick<InstructionLibraryRuntime, "beforeSave" | "afterSave"> {
  return {
    beforeSave: async (input, registry) => {
      if (
        input.operation !== "workspace-relink" &&
        input.operation !== "workspace-remove"
      )
        return;
      const previousRoot = registry?.workspaces.find(
        (workspace) => workspace.id === input.workspaceId,
      )?.root;
      if (previousRoot) await operations.stopTerminals(previousRoot);
    },
    afterSave: async (input, registry) => {
      if (input.operation !== "workspace-relink") return;
      const previousRoot = registry?.workspaces.find(
        (workspace) => workspace.id === input.workspaceId,
      )?.root;
      if (previousRoot)
        await operations.relinkWorkspace(previousRoot, input.root);
    },
  };
}
