export interface WorkspaceGitChange {
  status: string;
  path: string;
  originalPath?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export type WorkspaceGitPatchKind = "staged" | "unstaged" | "untracked";

export interface WorkspaceGitPatch {
  kind: WorkspaceGitPatchKind;
  content: string;
  binary: boolean;
  truncated: boolean;
}

export interface WorkspaceGitDiff {
  path: string;
  originalPath?: string;
  patches: WorkspaceGitPatch[];
}

export interface WorkspaceGitBranch {
  name: string;
  commit: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  parent?: string;
  needsRestack: boolean;
}

export interface WorkspaceGitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface WorkspaceGitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface WorkspaceGitStash {
  reference: string;
  message: string;
  createdAt: string;
}

export type WorkspaceGitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface WorkspaceGitSummary {
  branch: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: number;
  conflicts: number;
}

export interface WorkspacePullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  author?: string;
  updatedAt?: string;
}

export interface WorkspacePullRequestOverview {
  available: boolean;
  reason?: string;
  items: WorkspacePullRequest[];
}

export interface WorkspaceGitRepository {
  repositoryRoot: string;
  relativePath: string;
}

export interface WorkspaceGitRepositoryDiscovery {
  workspaceRoot: string;
  repositories: WorkspaceGitRepository[];
  scanLimited: boolean;
  issues: string[];
}

export interface WorkspaceGitOverview {
  workspaceRoot: string;
  repositoryRoot: string;
  branch: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  totalChanges: number;
  changes: WorkspaceGitChange[];
  changesTruncated: boolean;
  localBranches: WorkspaceGitBranch[];
  remoteBranches: WorkspaceGitBranch[];
  remotes: WorkspaceGitRemote[];
  recentCommits: WorkspaceGitCommit[];
  stashes: WorkspaceGitStash[];
  operation?: WorkspaceGitOperation;
}

export type WorkspaceGitAction =
  | "fetch"
  | "pull"
  | "push"
  | "checkout"
  | "checkout-remote"
  | "create-branch"
  | "create-stacked-branch"
  | "stack-branch"
  | "unstack-branch"
  | "delete-branch"
  | "restack"
  | "submit-pull-requests"
  | "merge"
  | "rebase"
  | "continue-operation"
  | "abort-operation"
  | "skip-operation"
  | "stage"
  | "unstage"
  | "stage-all"
  | "unstage-all"
  | "commit"
  | "stash-push"
  | "stash-apply"
  | "stash-pop"
  | "stash-drop"
  | "add-remote"
  | "remove-remote";

export interface WorkspaceGitActionOptions {
  branchName?: string;
  startPoint?: string;
  parentBranch?: string;
  remoteName?: string;
  remoteUrl?: string;
  paths?: string[];
  message?: string;
  stashRef?: string;
  includeUntracked?: boolean;
  force?: boolean;
  draft?: boolean;
}

export type WorkspaceEntryKind = "file" | "directory";

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  targetKind: "file" | "directory" | "other" | null;
  size: number | null;
  modifiedAt: number | null;
}

export interface WorkspaceDirectoryPage {
  path: string;
  entries: WorkspaceDirectoryEntry[];
  nextOffset: number | null;
  totalEntries: number;
  limitReached: boolean;
  omittedEntries: number;
}

export type WorkspaceFileKind = "text" | "media" | "binary" | "oversized";
export type WorkspaceFilePreviewKind =
  | "markdown"
  | "image"
  | "pdf"
  | "audio"
  | "video";

export interface WorkspaceFileDocument {
  path: string;
  name: string;
  size: number;
  modifiedAt: number | null;
  revision: string | null;
  kind: WorkspaceFileKind;
  previewKind: WorkspaceFilePreviewKind | null;
  language: string | null;
  content: string | null;
  editable: boolean;
  bom: boolean;
  reason: string | null;
}

export interface WorkspaceFileSaveResult {
  status: "saved" | "conflict";
  revision: string;
  modifiedAt: number | null;
  size: number;
}

export interface WorkspaceShell {
  id: string;
  label: string;
  kind: string;
}

export interface WorkspaceShellDiscovery {
  platform: string;
  shells: WorkspaceShell[];
  defaultShellId: string | null;
  externalTerminal: { id: string; label: string } | null;
}

export interface WorkspaceTerminalStarted {
  sessionId: string;
  shellId: string;
  processId: number | null;
}

export type WorkspaceTerminalEvent =
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

export interface WorkspaceTerminalEvents {
  cursor: number;
  events: WorkspaceTerminalEvent[];
}

export interface WorkspaceFilePreview {
  dataBase64: string;
  mediaType: string;
}
