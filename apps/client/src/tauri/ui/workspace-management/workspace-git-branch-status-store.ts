import { createWorkspaceGitBranchStatusStore } from "@machdoch/client-ui/git-branch/branch-status-store";
import { loadWorkspaceGitBranchStatus } from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";

export const workspaceGitBranchStatusStore =
  createWorkspaceGitBranchStatusStore({
    load: (workspaceRoot, branchName, fetch) =>
      loadWorkspaceGitBranchStatus(workspaceRoot, branchName, { fetch }),
    now: () => Date.now(),
    schedule: (task) => {
      window.setTimeout(task, 0);
    },
    maxConcurrent: 2,
    staleMs: 20_000,
    keyOf: createWorkspaceRootKey,
  });
