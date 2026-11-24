import type {
  WorkspaceGitBlame,
  WorkspaceGitBranchList,
  WorkspaceGitComparison,
  WorkspaceGitConflictVersions,
  WorkspaceGitFileHistory,
  WorkspaceGitUndoPreview,
  WorkspacePullRequestChecks,
} from "@machdoch/fleet-protocol/workspace-contract";
import {
  repositoryFor,
  resolvePreviewWorkspaceGitRevision,
} from "./workspace-preview-git";

const PREVIEW_CLOUD_ISSUES = [
  {
    identifier: "CLOUD-2972",
    title: "Sign-in redirect loses the open workspace",
    statusName: "In Progress",
    state: "active",
  },
  {
    identifier: "CLOUD-3011",
    title: "Show issue titles on branches",
    statusName: "Ready",
    state: "ready",
  },
  {
    identifier: "CLOUD-3020",
    title: "Speed up repository status",
    statusName: "Backlog",
    state: "backlog",
  },
];

export const PREVIEW_MCP_SERVERS = [{ id: "machdoch-cloud", enabled: true }];

export const searchPreviewCloudIssues = (
  workspaceRoot: string,
  query: string,
): unknown => {
  const needle = query.toLowerCase();
  const issues = PREVIEW_CLOUD_ISSUES.filter((issue) =>
    `${issue.identifier} ${issue.title}`.toLowerCase().includes(needle),
  );
  return {
    workspaceRoot,
    result: { content: [{ type: "text", text: JSON.stringify(issues) }] },
  };
};

export const loadPreviewWorkspaceGitBranchList = (
  workspaceRoot: string,
  repositoryRoot: string,
): WorkspaceGitBranchList => {
  const repository = repositoryFor(workspaceRoot, repositoryRoot);
  return {
    repositoryRoot,
    currentBranch: repository.branch,
    detached: false,
    localBranches: repository.localBranches.map((entry) => ({
      ...entry,
      current: entry.name === repository.branch,
    })),
    remoteBranches: repository.remoteBranches.map((entry) => ({ ...entry })),
    recentBranches: repository.localBranches
      .map((entry) => entry.name)
      .filter((name) => name !== repository.branch)
      .slice(0, 5),
  };
};

export const loadPreviewWorkspaceGitFileHistory = (
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
): WorkspaceGitFileHistory => ({
  relativePath,
  commits: repositoryFor(workspaceRoot, repositoryRoot).recentCommits.map(
    (entry) => ({ ...entry, path: relativePath }),
  ),
  truncated: false,
});

export const loadPreviewWorkspaceGitUndo = (
  workspaceRoot: string,
  repositoryRoot: string,
): WorkspaceGitUndoPreview | null => {
  const [latest, previous] = repositoryFor(
    workspaceRoot,
    repositoryRoot,
  ).recentCommits;
  if (!latest || !previous) return null;
  return {
    kind: "commit",
    description: `Undo commit "${latest.subject}"`,
    currentHead: latest.hash,
    target: previous.hash,
    files: [
      {
        path: "src/tauri/ui/runtime.ts",
        status: "M",
        additions: 1,
        deletions: 0,
      },
    ],
    filesTruncated: false,
  };
};

export const loadPreviewWorkspaceGitBlame = (
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
): WorkspaceGitBlame => {
  const commits = repositoryFor(workspaceRoot, repositoryRoot).recentCommits;
  return {
    relativePath,
    ranges: commits.slice(0, 3).map((entry, index) => ({
      startLine: index * 4 + 1,
      lineCount: 4,
      commit: entry.hash,
      shortHash: entry.shortHash,
      author: entry.author,
      authoredAt: entry.authoredAt,
      summary: entry.subject,
      uncommitted: false,
    })),
  };
};

export const loadPreviewWorkspaceGitComparison = (
  workspaceRoot: string,
  repositoryRoot: string,
  base: string,
  head: string,
): WorkspaceGitComparison => {
  const repository = repositoryFor(workspaceRoot, repositoryRoot);
  return {
    base: resolvePreviewWorkspaceGitRevision(
      workspaceRoot,
      repositoryRoot,
      base,
    ),
    head: resolvePreviewWorkspaceGitRevision(
      workspaceRoot,
      repositoryRoot,
      head,
    ),
    ahead: Math.min(2, repository.recentCommits.length),
    behind: 0,
    commits: repository.recentCommits
      .slice(0, 2)
      .map((entry) => ({ ...entry })),
    commitsTruncated: false,
    files: repository.changes
      .filter((entry) => !entry.untracked)
      .map((entry) => ({ path: entry.path, status: entry.status.trim() })),
    filesTruncated: false,
  };
};

export const loadPreviewWorkspaceGitConflict = (
  relativePath: string,
): WorkspaceGitConflictVersions => ({
  relativePath,
  base: 'export const greeting = "hello";\n',
  ours: 'export const greeting = "hello there";\n',
  theirs: 'export const greeting = "hi";\n',
  result:
    '<<<<<<< HEAD\nexport const greeting = "hello there";\n=======\nexport const greeting = "hi";\n>>>>>>> feature\n',
  binary: false,
});

export const loadPreviewWorkspacePullRequestChecks = (
  workspaceRoot: string,
  repositoryRoot: string,
  number: number,
): WorkspacePullRequestChecks => {
  const pullRequest = repositoryFor(
    workspaceRoot,
    repositoryRoot,
  ).pullRequests.find((entry) => entry.number === number);
  return {
    number,
    url: pullRequest?.url ?? "",
    ...(pullRequest?.reviewDecision
      ? { reviewDecision: pullRequest.reviewDecision }
      : {}),
    checks: [
      { name: "lint", state: "success", workflow: "CI" },
      { name: "test", state: pullRequest?.checks ?? "pending", workflow: "CI" },
    ],
  };
};
