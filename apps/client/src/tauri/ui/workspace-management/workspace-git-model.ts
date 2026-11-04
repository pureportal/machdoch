import type {
  WorkspaceGitAction,
  WorkspaceGitBranch,
  WorkspaceGitChange,
  WorkspaceGitRepository,
} from "../runtime";

export type WorkspaceDiffLineTone =
  | "addition"
  | "deletion"
  | "header"
  | "hunk"
  | "context";

const FILE_CHANGING_ACTIONS = new Set<WorkspaceGitAction>([
  "pull",
  "checkout",
  "checkout-remote",
  "create-branch",
  "merge",
  "rebase",
  "restack",
  "continue-operation",
  "abort-operation",
  "skip-operation",
  "stash-push",
  "stash-apply",
  "stash-pop",
]);

export const workspaceGitActionChangesFiles = (
  action: WorkspaceGitAction,
): boolean => FILE_CHANGING_ACTIONS.has(action);

const REMOTE_ACTIONS = new Set<WorkspaceGitAction>([
  "fetch",
  "pull",
  "push",
  "submit-pull-requests",
  "add-remote",
  "remove-remote",
]);

export const workspaceGitActionUsesRemote = (
  action: WorkspaceGitAction,
): boolean => REMOTE_ACTIONS.has(action);

const INVALID_BRANCH_CHARACTERS = /[~^:?*[\\]/u;

const hasControlOrSpaceCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });

export const isValidGitBranchName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 255 &&
  name !== "@" &&
  name !== "HEAD" &&
  !name.startsWith("-") &&
  !name.endsWith(".") &&
  !name.includes("..") &&
  !name.includes("@{") &&
  !INVALID_BRANCH_CHARACTERS.test(name) &&
  !hasControlOrSpaceCharacter(name) &&
  name
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    );

const ACTION_LABELS: Record<WorkspaceGitAction, [string, string]> = {
  fetch: ["Fetching", "Fetched"],
  pull: ["Pulling", "Pulled"],
  push: ["Pushing", "Pushed"],
  checkout: ["Switching branch", "Switched branch"],
  "checkout-remote": ["Checking out", "Checked out"],
  "create-branch": ["Creating branch", "Created branch"],
  "create-stacked-branch": [
    "Creating stacked branch",
    "Created stacked branch",
  ],
  "stack-branch": ["Stacking branch", "Stacked branch"],
  "unstack-branch": ["Unstacking branch", "Unstacked branch"],
  "delete-branch": ["Deleting branch", "Deleted branch"],
  restack: ["Restacking", "Restacked"],
  "submit-pull-requests": ["Submitting pull requests", "Pull requests updated"],
  merge: ["Merging", "Merged"],
  rebase: ["Rebasing", "Rebased"],
  "continue-operation": ["Continuing", "Continued"],
  "abort-operation": ["Aborting", "Aborted"],
  "skip-operation": ["Skipping commit", "Skipped commit"],
  stage: ["Staging", "Staged"],
  unstage: ["Unstaging", "Unstaged"],
  "stage-all": ["Staging all", "Staged all changes"],
  "unstage-all": ["Unstaging all", "Unstaged all changes"],
  commit: ["Committing", "Committed"],
  "stash-push": ["Stashing", "Stashed changes"],
  "stash-apply": ["Applying stash", "Applied stash"],
  "stash-pop": ["Popping stash", "Popped stash"],
  "stash-drop": ["Dropping stash", "Dropped stash"],
  "add-remote": ["Adding remote", "Added remote"],
  "remove-remote": ["Removing remote", "Removed remote"],
};

export const workspaceGitActionProgressLabel = (
  action: WorkspaceGitAction,
): string => `${ACTION_LABELS[action][0]}…`;

export const workspaceGitActionDoneLabel = (
  action: WorkspaceGitAction,
): string => ACTION_LABELS[action][1];

export const workspaceGitChangeLabel = (change: WorkspaceGitChange): string => {
  if (change.conflicted) return "Conflict";
  if (change.untracked) return "Untracked";
  if (change.staged && change.unstaged) return "Staged + modified";
  if (change.staged) return "Staged";
  if (change.unstaged) return "Modified";
  return "Changed";
};

export interface WorkspaceGitChangeGroups {
  conflicts: WorkspaceGitChange[];
  staged: WorkspaceGitChange[];
  unstaged: WorkspaceGitChange[];
}

export const groupWorkspaceGitChanges = (
  changes: readonly WorkspaceGitChange[],
): WorkspaceGitChangeGroups => {
  const groups: WorkspaceGitChangeGroups = {
    conflicts: [],
    staged: [],
    unstaged: [],
  };
  for (const change of changes) {
    if (change.conflicted) {
      groups.conflicts.push(change);
      continue;
    }
    if (change.staged) groups.staged.push(change);
    if (change.unstaged || change.untracked) groups.unstaged.push(change);
  }
  return groups;
};

export const workspaceGitRepositoryLabel = (
  repository: WorkspaceGitRepository,
): string =>
  repository.relativePath === "." ? "Workspace root" : repository.relativePath;

export const workspaceGitPathInWorkspace = (
  repository: WorkspaceGitRepository | null,
  path: string,
): string =>
  !repository || repository.relativePath === "."
    ? path
    : `${repository.relativePath.replace(/[\\/]+$/u, "")}/${path}`;

export const selectWorkspaceGitRepository = (
  repositories: readonly WorkspaceGitRepository[],
  ...preferredRoots: readonly (string | null | undefined)[]
): WorkspaceGitRepository | null => {
  for (const root of preferredRoots) {
    const match = repositories.find(
      (repository) => repository.repositoryRoot === root,
    );
    if (match) return match;
  }
  return repositories[0] ?? null;
};

export interface WorkspaceGitBranchNode {
  branch: WorkspaceGitBranch;
  depth: number;
  stacked: boolean;
}

export const createWorkspaceGitBranchTree = (
  branches: readonly WorkspaceGitBranch[],
): WorkspaceGitBranchNode[] => {
  const names = new Set(branches.map((branch) => branch.name));
  const children = new Map<string, WorkspaceGitBranch[]>();
  const roots: WorkspaceGitBranch[] = [];
  for (const branch of branches) {
    if (
      branch.parent &&
      names.has(branch.parent) &&
      branch.parent !== branch.name
    ) {
      children.set(branch.parent, [
        ...(children.get(branch.parent) ?? []),
        branch,
      ]);
    } else {
      roots.push(branch);
    }
  }
  const nodes: WorkspaceGitBranchNode[] = [];
  const visited = new Set<string>();
  const visit = (branch: WorkspaceGitBranch, depth: number): void => {
    if (visited.has(branch.name)) return;
    visited.add(branch.name);
    const descendants = children.get(branch.name) ?? [];
    nodes.push({
      branch,
      depth,
      stacked: depth > 0 || descendants.length > 0,
    });
    for (const child of descendants) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const branch of branches) visit(branch, 0);
  return nodes;
};

export const workspaceGitStackMembers = (
  branches: readonly WorkspaceGitBranch[],
  branchName: string,
): string[] => {
  const byName = new Map(branches.map((branch) => [branch.name, branch]));
  let trunk = branchName;
  const seen = new Set<string>();
  while (!seen.has(trunk)) {
    seen.add(trunk);
    const parent = byName.get(trunk)?.parent;
    if (!parent || !byName.has(parent)) break;
    trunk = parent;
  }
  const members: string[] = [];
  const queue = [trunk];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const branch of branches) {
      if (branch.parent === parent && !members.includes(branch.name)) {
        members.push(branch.name);
        queue.push(branch.name);
      }
    }
  }
  return members;
};

export const filterWorkspaceGitBranches = (
  branches: readonly WorkspaceGitBranch[],
  query: string,
): WorkspaceGitBranch[] => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...branches];
  return branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(normalized),
  );
};

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
