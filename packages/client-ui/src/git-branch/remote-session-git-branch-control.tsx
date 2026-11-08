import { useCallback, type JSX } from "react";
import type {
  FleetOperationTransport,
  SessionHeaderAccessoryProps,
} from "@machdoch/product-ui";
import type {
  WorkspaceGitBranchStatus,
  WorkspaceGitBranchSwitchResult,
  WorkspaceGitBranchSwitchTarget,
} from "@machdoch/fleet-protocol/workspace-contract";
import {
  createWorkspaceGitBranchStatusStore,
  type WorkspaceGitBranchStatusStore,
} from "./branch-status-store";
import { SessionGitBranchControl } from "./session-git-branch-control";

const storesByTransport = new WeakMap<
  FleetOperationTransport,
  WorkspaceGitBranchStatusStore
>();

const branchStatusStoreFor = (
  transport: FleetOperationTransport,
): WorkspaceGitBranchStatusStore => {
  const existing = storesByTransport.get(transport);
  if (existing) return existing;
  const store = createWorkspaceGitBranchStatusStore({
    load: (workspaceRoot, branchName, fetch) =>
      transport.invoke<WorkspaceGitBranchStatus>(
        "get_workspace_git_branch_status",
        {
          request: {
            workspaceRoot,
            ...(branchName ? { branchName } : {}),
            ...(fetch ? { fetch: true } : {}),
          },
        },
      ),
    now: () => Date.now(),
    schedule: (task) => {
      window.setTimeout(task, 0);
    },
    maxConcurrent: 2,
    staleMs: 20_000,
  });
  storesByTransport.set(transport, store);
  return store;
};

export interface RemoteSessionGitBranchControlProps extends SessionHeaderAccessoryProps {
  workspaceTransport: FleetOperationTransport;
}

export function RemoteSessionGitBranchControl({
  session,
  onCommand,
  workspaceTransport,
}: RemoteSessionGitBranchControlProps): JSX.Element | null {
  const switchBranches = useCallback(
    (
      workspaceRoot: string,
      targets: readonly WorkspaceGitBranchSwitchTarget[],
      stashChanges: boolean,
    ) =>
      workspaceTransport.invoke<WorkspaceGitBranchSwitchResult[]>(
        "switch_workspace_git_branches",
        { request: { workspaceRoot, targets, stashChanges } },
      ),
    [workspaceTransport],
  );

  return (
    <SessionGitBranchControl
      sessionId={session.id}
      workspaceRoot={session.workspace}
      branchName={session.gitBranch}
      workspaceTaskRunning={session.runningTaskId !== undefined}
      store={branchStatusStoreFor(workspaceTransport)}
      switchBranches={switchBranches}
      onBranchChange={(branch) => {
        void onCommand(
          branch
            ? { kind: "set-session-git-branch", sessionId: session.id, branch }
            : { kind: "clear-session-git-branch", sessionId: session.id },
        );
      }}
    />
  );
}
