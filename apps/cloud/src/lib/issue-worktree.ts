import type {
  WorkspaceGitOverview,
  WorkspaceGitRepositoryDiscovery,
} from "@machdoch/fleet-protocol/workspace-contract";

const pathKey = (path: string): string =>
  path.trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();

export function issueWorktreeRepository(
  discovery: Pick<WorkspaceGitRepositoryDiscovery, "repositories">,
): string {
  const repositories = discovery.repositories;
  const repository =
    repositories.find((entry) => entry.relativePath === ".") ??
    (repositories.length === 1 ? repositories[0] : undefined);
  if (!repository)
    throw new Error(
      repositories.length
        ? "This workspace has several Git repositories. Choose a workspace with one repository."
        : "This workspace has no Git repository.",
    );
  return repository.repositoryRoot;
}

export function worktreePathForBranch(
  overview: Pick<WorkspaceGitOverview, "worktrees">,
  branch: string,
): string | null {
  return (
    overview.worktrees.find(
      (worktree) => worktree.branch === branch && !worktree.prunable,
    )?.path ?? null
  );
}

export function matchingWorkspaceRoot(
  workspaces: { root: string }[],
  path: string,
): string | null {
  const key = pathKey(path);
  return (
    workspaces.find((workspace) => pathKey(workspace.root) === key)?.root ??
    null
  );
}
