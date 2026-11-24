import type {
  WorkspaceGitBranchStatus,
  WorkspaceGitBranchSwitchTarget,
  WorkspaceGitRepositoryStatus,
} from "@machdoch/fleet-protocol/workspace-contract";

export interface BulkSkip {
  relativePath: string;
  reason: string;
}

export interface BulkPlan<T> {
  targets: T[];
  skipped: BulkSkip[];
}

const label = (relativePath: string): string => relativePath || ".";

const blocked = (repository: {
  operation?: string;
  error?: string;
  conflictedCount?: number;
  conflicts?: number;
}): string | null => {
  if (repository.error) return repository.error;
  if (repository.operation) return `${repository.operation} in progress`;
  if ((repository.conflictedCount ?? repository.conflicts ?? 0) > 0)
    return "has conflicts";
  return null;
};

export const planBulkPull = (
  repositories: readonly WorkspaceGitRepositoryStatus[],
): BulkPlan<WorkspaceGitRepositoryStatus> => {
  const plan: BulkPlan<WorkspaceGitRepositoryStatus> = {
    targets: [],
    skipped: [],
  };
  for (const repository of repositories) {
    const reason =
      blocked(repository) ??
      (repository.detached
        ? "detached HEAD"
        : !repository.upstream || repository.upstreamGone
          ? "no upstream"
          : null);
    if (reason)
      plan.skipped.push({
        relativePath: label(repository.relativePath),
        reason,
      });
    else plan.targets.push(repository);
  }
  return plan;
};

export const planBulkCommit = (
  repositories: readonly WorkspaceGitRepositoryStatus[],
): BulkPlan<WorkspaceGitRepositoryStatus> => {
  const plan: BulkPlan<WorkspaceGitRepositoryStatus> = {
    targets: [],
    skipped: [],
  };
  for (const repository of repositories) {
    if (repository.totalChanges === 0) continue;
    const reason = blocked(repository);
    if (reason)
      plan.skipped.push({
        relativePath: label(repository.relativePath),
        reason,
      });
    else plan.targets.push(repository);
  }
  return plan;
};

export const planBulkBranchSwitch = (
  status: WorkspaceGitBranchStatus,
  branchName: string,
): BulkPlan<WorkspaceGitBranchSwitchTarget> => {
  const plan: BulkPlan<WorkspaceGitBranchSwitchTarget> = {
    targets: [],
    skipped: [],
  };
  for (const repository of status.repositories) {
    if (repository.currentBranch === branchName) continue;
    const reason =
      blocked(repository) ??
      (repository.branchLocal || repository.branchRemote
        ? null
        : "branch not found");
    if (reason) {
      plan.skipped.push({
        relativePath: label(repository.relativePath),
        reason,
      });
      continue;
    }
    plan.targets.push({
      repositoryRoot: repository.repositoryRoot,
      branchName,
      create: false,
    });
  }
  return plan;
};

export const describeSkipped = (skipped: readonly BulkSkip[]): string =>
  skipped.map((entry) => `${entry.relativePath}: ${entry.reason}`).join("\n");
