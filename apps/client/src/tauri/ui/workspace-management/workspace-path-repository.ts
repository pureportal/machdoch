import type { WorkspaceGitRepository } from "@machdoch/fleet-protocol/workspace-contract";

export interface WorkspacePathInRepository {
  repositoryRoot: string;
  relativePath: string;
}

const normalize = (path: string): string =>
  path
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");

export const repositoryForWorkspacePath = (
  repositories: readonly WorkspaceGitRepository[],
  workspacePath: string,
): WorkspacePathInRepository | null => {
  const path = normalize(workspacePath);
  let match: { repository: WorkspaceGitRepository; prefix: string } | null =
    null;
  for (const repository of repositories) {
    const prefix =
      repository.relativePath === "." ? "" : normalize(repository.relativePath);
    const contains =
      prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
    if (contains && (!match || prefix.length > match.prefix.length)) {
      match = { repository, prefix };
    }
  }
  if (!match || path === match.prefix) return null;
  return {
    repositoryRoot: match.repository.repositoryRoot,
    relativePath: match.prefix ? path.slice(match.prefix.length + 1) : path,
  };
};
