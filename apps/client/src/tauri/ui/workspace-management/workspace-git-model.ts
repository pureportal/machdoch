import type {
  WorkspaceGitAction,
  WorkspaceGitChange,
  WorkspaceGitOverview,
  WorkspaceGitRepository,
} from "../runtime";

export type WorkspaceDiffLineTone =
  | "addition"
  | "deletion"
  | "header"
  | "hunk"
  | "context";

export const workspaceGitActionChangesFiles = (
  action: WorkspaceGitAction,
): boolean =>
  action === "pull" || action === "checkout" || action === "checkout-remote";

export const workspaceGitChangeLabel = (change: WorkspaceGitChange): string => {
  if (change.conflicted) return "Conflict";
  if (change.untracked) return "Untracked";
  if (change.staged && change.unstaged) return "Staged + modified";
  if (change.staged) return "Staged";
  if (change.unstaged) return "Modified";
  return "Changed";
};

export const workspaceGitRepositoryLabel = (
  repository: WorkspaceGitRepository,
): string =>
  repository.relativePath === "." ? "Workspace root" : repository.relativePath;

export const selectWorkspaceGitRepository = (
  repositories: readonly WorkspaceGitRepository[],
  currentRoot: string | null,
): WorkspaceGitRepository | null =>
  repositories.find(
    (repository) => repository.repositoryRoot === currentRoot,
  ) ??
  repositories[0] ??
  null;

export const workspaceGitOverviewForSelection = (
  overview: WorkspaceGitOverview | null,
  overviewWorkspaceRoot: string | null,
  workspaceRoot: string | null,
  repositoryRoot: string | null,
): WorkspaceGitOverview | null =>
  overviewWorkspaceRoot === workspaceRoot &&
  overview?.repositoryRoot === repositoryRoot
    ? overview
    : null;

export const workspaceDiffLineTone = (line: string): WorkspaceDiffLineTone => {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "header";
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file ") ||
    line.startsWith("deleted file ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("Binary files ")
  ) {
    return "header";
  }
  return "context";
};
