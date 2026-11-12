import type {
  WorkspaceGitAction,
  WorkspaceGitBranch,
  WorkspaceGitChange,
  WorkspaceGitOverview,
  WorkspaceGitRepository,
  WorkspaceGitRepositoryStatus,
  WorkspaceGitWorktree,
} from "../runtime";
import { createWorkspaceRootKey } from "./workspace-management-model";

const FILE_CHANGING_ACTIONS = new Set<WorkspaceGitAction>([
  "pull",
  "checkout",
  "checkout-remote",
  "create-branch",
  "merge",
  "rebase",
  "restack",
  "reset",
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
  reset: ["Resetting branch", "Reset branch"],
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
  "add-worktree": ["Creating worktree", "Created worktree"],
  "remove-worktree": ["Removing worktree", "Removed worktree"],
  "lock-worktree": ["Locking worktree", "Locked worktree"],
  "unlock-worktree": ["Unlocking worktree", "Unlocked worktree"],
  "prune-worktrees": ["Pruning worktrees", "Pruned worktrees"],
};

export const workspaceGitWorktreeLabel = (
  worktree: WorkspaceGitWorktree,
): string => worktree.branch ?? `Detached at ${worktree.head.slice(0, 7)}`;

export const workspaceGitBranchWorktree = (
  overview: WorkspaceGitOverview,
  branchName: string,
): WorkspaceGitWorktree | undefined =>
  overview.worktrees.find((worktree) => worktree.branch === branchName);

export const workspaceGitWorktreeBranches = (
  overview: WorkspaceGitOverview,
): string[] => {
  const used = new Set(
    overview.worktrees.flatMap((worktree) =>
      worktree.branch ? [worktree.branch] : [],
    ),
  );
  return overview.localBranches
    .map((branch) => branch.name)
    .filter((name) => !used.has(name));
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

export type WorkspaceGitStagingAction =
  | "stage"
  | "unstage"
  | "stage-all"
  | "unstage-all";

export const isWorkspaceGitStagingAction = (
  action: WorkspaceGitAction,
): action is WorkspaceGitStagingAction =>
  action === "stage" ||
  action === "unstage" ||
  action === "stage-all" ||
  action === "unstage-all";

const stagedChange = (change: WorkspaceGitChange): WorkspaceGitChange => {
  if (change.untracked) {
    return {
      ...change,
      status: "A ",
      staged: true,
      unstaged: false,
      untracked: false,
    };
  }
  const index = change.status[0] ?? " ";
  const worktree = change.status[1] ?? " ";
  const code = change.conflicted || index === " " ? worktree : index;
  return {
    ...change,
    status: `${code === " " || code === "U" ? "M" : code} `,
    staged: true,
    unstaged: false,
    conflicted: false,
  };
};

const unstagedChange = (change: WorkspaceGitChange): WorkspaceGitChange => {
  if (!change.staged || change.conflicted) return change;
  const index = change.status[0] ?? " ";
  if (index === "A" || index === "R" || index === "C") {
    const { originalPath: _originalPath, ...rest } = change;
    return {
      ...rest,
      status: "??",
      staged: false,
      unstaged: false,
      untracked: true,
    };
  }
  const worktree = change.status[1] ?? " ";
  return {
    ...change,
    status: ` ${worktree === " " ? index : worktree}`,
    staged: false,
    unstaged: true,
  };
};

export const optimisticWorkspaceGitStaging = (
  overview: WorkspaceGitOverview,
  action: WorkspaceGitStagingAction,
  paths: readonly string[] = [],
): WorkspaceGitOverview => {
  const selected = new Set(paths);
  const everything = action === "stage-all" || action === "unstage-all";
  const stage = action === "stage" || action === "stage-all";
  const changes = overview.changes.map((change) =>
    everything || selected.has(change.path)
      ? stage
        ? stagedChange(change)
        : unstagedChange(change)
      : change,
  );
  return {
    ...overview,
    changes,
    stagedCount: changes.filter((change) => change.staged).length,
    unstagedCount: changes.filter((change) => change.unstaged).length,
    untrackedCount: changes.filter((change) => change.untracked).length,
    conflictedCount: changes.filter((change) => change.conflicted).length,
  };
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
    if (!root) continue;
    const key = createWorkspaceRootKey(root);
    const match = repositories.find(
      (repository) => createWorkspaceRootKey(repository.repositoryRoot) === key,
    );
    if (match) return match;
  }
  return repositories[0] ?? null;
};

export interface WorkspaceGitBranchTarget {
  base: string | null;
  nested: boolean;
}

export const workspaceGitBranchTarget = (
  branchName: string,
  parent: string | undefined,
  trunk: string | undefined,
): WorkspaceGitBranchTarget => {
  if (trunk && branchName === trunk) return { base: null, nested: false };
  if (parent && parent !== branchName) {
    return { base: parent, nested: parent !== trunk };
  }
  return { base: trunk ?? null, nested: false };
};

export interface WorkspaceGitBranchNode extends WorkspaceGitBranchTarget {
  branch: WorkspaceGitBranch;
  depth: number;
  guides: boolean[];
  last: boolean;
}

export const createWorkspaceGitBranchTree = (
  branches: readonly WorkspaceGitBranch[],
  trunk?: string,
): WorkspaceGitBranchNode[] => {
  const names = new Set(branches.map((branch) => branch.name));
  const trunkName = trunk && names.has(trunk) ? trunk : undefined;
  const parentOf = (branch: WorkspaceGitBranch): string | undefined => {
    if (branch.name === trunkName) return undefined;
    if (
      branch.parent &&
      names.has(branch.parent) &&
      branch.parent !== branch.name
    ) {
      return branch.parent;
    }
    return trunkName;
  };
  const children = new Map<string, WorkspaceGitBranch[]>();
  const roots: WorkspaceGitBranch[] = [];
  for (const branch of branches) {
    const parent = parentOf(branch);
    if (parent) {
      children.set(parent, [...(children.get(parent) ?? []), branch]);
    } else if (branch.name === trunkName) {
      roots.unshift(branch);
    } else {
      roots.push(branch);
    }
  }
  const nodes: WorkspaceGitBranchNode[] = [];
  const visited = new Set<string>();
  const visit = (
    branch: WorkspaceGitBranch,
    depth: number,
    guides: boolean[],
    last: boolean,
  ): void => {
    if (visited.has(branch.name)) return;
    visited.add(branch.name);
    nodes.push({
      branch,
      depth,
      guides,
      last,
      ...workspaceGitBranchTarget(
        branch.name,
        branch.parent && names.has(branch.parent) ? branch.parent : undefined,
        trunk,
      ),
    });
    const descendants = (children.get(branch.name) ?? []).filter(
      (child) => !visited.has(child.name),
    );
    descendants.forEach((child, index) =>
      visit(
        child,
        depth + 1,
        depth === 0 ? [] : [...guides, !last],
        index === descendants.length - 1,
      ),
    );
  };
  roots.forEach((root, index) =>
    visit(root, 0, [], index === roots.length - 1),
  );
  for (const branch of branches) visit(branch, 0, [], true);
  return nodes;
};

export const workspaceGitRepositoryStatusFromOverview = (
  overview: WorkspaceGitOverview,
  relativePath: string,
): WorkspaceGitRepositoryStatus => {
  const current = overview.localBranches.find((branch) => branch.current);
  return {
    repositoryRoot: overview.repositoryRoot,
    relativePath,
    branch: overview.branch,
    detached: overview.detached,
    ...(overview.upstream ? { upstream: overview.upstream } : {}),
    upstreamGone: current?.upstreamGone ?? false,
    ahead: overview.ahead,
    behind: overview.behind,
    ...(overview.defaultBranch
      ? { defaultBranch: overview.defaultBranch }
      : {}),
    ...(current?.parent ? { parentBranch: current.parent } : {}),
    stagedCount: overview.stagedCount,
    unstagedCount: overview.unstagedCount,
    untrackedCount: overview.untrackedCount,
    conflictedCount: overview.conflictedCount,
    totalChanges: overview.totalChanges,
    changes: overview.changes.slice(0, REPOSITORY_STATUS_CHANGE_LIMIT),
    changesTruncated: overview.totalChanges > REPOSITORY_STATUS_CHANGE_LIMIT,
    ...(overview.operation ? { operation: overview.operation } : {}),
  };
};

const REPOSITORY_STATUS_CHANGE_LIMIT = 100;

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
