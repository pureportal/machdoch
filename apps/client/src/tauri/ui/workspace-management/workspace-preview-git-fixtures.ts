import type {
  WorkspaceGitBranch,
  WorkspaceGitChange,
  WorkspaceGitCommit,
  WorkspaceGitDiff,
  WorkspaceGitOperation,
  WorkspaceGitRemote,
  WorkspaceGitStash,
  WorkspaceGitWorktree,
  WorkspacePullRequest,
} from "@machdoch/fleet-protocol/workspace-contract";

export interface PreviewStash extends WorkspaceGitStash {
  changes: WorkspaceGitChange[];
}

export interface PreviewRepository {
  workspaceRoot: string;
  repositoryRoot: string;
  branch: string;
  changes: WorkspaceGitChange[];
  localBranches: WorkspaceGitBranch[];
  remoteBranches: WorkspaceGitBranch[];
  remotes: WorkspaceGitRemote[];
  recentCommits: WorkspaceGitCommit[];
  stashes: PreviewStash[];
  worktrees: WorkspaceGitWorktree[];
  operation?: WorkspaceGitOperation;
  pullRequests: WorkspacePullRequest[];
  diffs: Map<string, WorkspaceGitDiff>;
  nextCommit: number;
}

const ORIGIN = (repository: string): WorkspaceGitRemote => ({
  name: "origin",
  fetchUrl: `https://github.com/example/${repository}.git`,
  pushUrl: `https://github.com/example/${repository}.git`,
});

export const change = (
  status: string,
  path: string,
  extra: Partial<WorkspaceGitChange> = {},
): WorkspaceGitChange => ({
  status,
  path,
  staged: status[0] !== " " && status[0] !== "?",
  unstaged: status[1] !== " " && status[1] !== "?",
  untracked: status === "??",
  conflicted: status === "UU",
  ...extra,
});

export const branch = (
  name: string,
  commit: string,
  extra: Partial<WorkspaceGitBranch> = {},
): WorkspaceGitBranch => ({
  name,
  commit,
  current: false,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  needsRestack: false,
  ...extra,
});

export const commit = (
  shortHash: string,
  subject: string,
  authoredAt: string,
): WorkspaceGitCommit => ({
  hash: shortHash.padEnd(40, "0"),
  shortHash,
  subject,
  author: "Machdoch",
  authoredAt,
});

const patch = (
  path: string,
  kind: "staged" | "unstaged" | "untracked",
  lines: string[],
  originalPath?: string,
): [string, WorkspaceGitDiff] => [
  path,
  {
    path,
    ...(originalPath ? { originalPath } : {}),
    patches: [
      {
        kind,
        content: lines.join("\n"),
        binary: lines.some((line) => line.startsWith("Binary files ")),
        truncated: false,
      },
    ],
  },
];

const machdochDiffs = (): Map<string, WorkspaceGitDiff> =>
  new Map([
    patch("src/tauri/ui/runtime.ts", "unstaged", [
      "diff --git a/src/tauri/ui/runtime.ts b/src/tauri/ui/runtime.ts",
      "index 19b7ae1..84d0f31 100644",
      "--- a/src/tauri/ui/runtime.ts",
      "+++ b/src/tauri/ui/runtime.ts",
      "@@ -41,6 +41,7 @@ export interface WorkspaceState {",
      "   root: string;",
      "+  revision: string;",
      " }",
    ]),
    patch("package.json", "staged", [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -61,6 +61,7 @@",
      '     "react": "^19.0.0",',
      '+    "@xterm/xterm": "^6.0.0",',
    ]),
    patch("docs/workspace-notes.md", "untracked", [
      "diff --git a/docs/workspace-notes.md b/docs/workspace-notes.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/workspace-notes.md",
      "@@ -0,0 +1,2 @@",
      "+# Workspace notes",
      "+Verify editor and terminal lifecycle behavior.",
    ]),
    patch(
      "assets/branding/machdoch.svg",
      "staged",
      [
        "diff --git a/assets/old-logo.svg b/assets/branding/machdoch.svg",
        "similarity index 100%",
        "rename from assets/old-logo.svg",
        "rename to assets/branding/machdoch.svg",
      ],
      "assets/old-logo.svg",
    ),
    patch("docs/removed.md", "unstaged", [
      "diff --git a/docs/removed.md b/docs/removed.md",
      "deleted file mode 100644",
      "--- a/docs/removed.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-Old workspace notes.",
    ]),
    patch("src/conflict.ts", "unstaged", [
      "diff --cc src/conflict.ts",
      "index 17ab31c,06f219d..0000000",
      "--- a/src/conflict.ts",
      "+++ b/src/conflict.ts",
      "@@@ -1,1 -1,1 +1,5 @@@",
      "++<<<<<<< HEAD",
      " +export const mode = 'local';",
      "++=======",
      "+ +export const mode = 'remote';",
      "++>>>>>>> remote",
    ]),
    patch("assets/sample.bin", "unstaged", [
      "diff --git a/assets/sample.bin b/assets/sample.bin",
      "Binary files a/assets/sample.bin and b/assets/sample.bin differ",
    ]),
  ]);

export const seedMachdoch = (
  workspaceRoot: string,
  repositoryRoot: string,
): PreviewRepository => ({
  workspaceRoot,
  repositoryRoot,
  branch: "main",
  worktrees: [
    {
      path: `${repositoryRoot}.worktrees\\feature-workspace`,
      branch: "feature/workspace",
      head: "a91d5e8",
      main: false,
      current: false,
      detached: false,
      locked: false,
      prunable: false,
      changes: 2,
    },
  ],
  changes: [
    change(" M", "src/tauri/ui/runtime.ts"),
    change("M ", "package.json"),
    change("??", "docs/workspace-notes.md"),
    change("R ", "assets/branding/machdoch.svg", {
      originalPath: "assets/old-logo.svg",
    }),
    change(" D", "docs/removed.md"),
    change("UU", "src/conflict.ts"),
    change(" M", "assets/sample.bin"),
  ],
  localBranches: [
    branch("main", "e4c72b1", {
      current: true,
      upstream: "origin/main",
      ahead: 1,
    }),
    branch("feature/workspace", "a91d5e8", {
      upstream: "origin/feature/workspace",
    }),
    branch("feature/workspace-api", "b17c0de", {
      parent: "feature/workspace",
      needsRestack: true,
    }),
    branch("feature/conflict-demo", "c0ffee1"),
  ],
  remoteBranches: [
    branch("origin/main", "7f84c2a"),
    branch("origin/feature/workspace", "a91d5e8"),
    branch("origin/release/1.4", "d4e5f60"),
  ],
  remotes: [ORIGIN("machdoch")],
  recentCommits: [
    commit("e4c72b1", "Refine workspace tools", "2026-08-03T16:42:00Z"),
    commit("7f84c2a", "Add workspace run inputs", "2026-08-02T11:05:00Z"),
    commit("5b1d9e0", "Speed up repository discovery", "2026-08-01T09:30:00Z"),
  ],
  stashes: [
    {
      reference: "stash@{0}",
      message: "On main: terminal experiments",
      createdAt: "2026-08-02T18:00:00Z",
      changes: [change(" M", "src/tauri/ui/terminal.ts")],
    },
  ],
  pullRequests: [
    {
      number: 128,
      title: "Refine workspace management",
      state: "OPEN",
      url: "https://github.com/example/machdoch/pull/128",
      headBranch: "feature/workspace",
      baseBranch: "main",
      draft: false,
      author: "machdoch",
      updatedAt: "2026-08-03T18:10:00Z",
    },
  ],
  diffs: machdochDiffs(),
  nextCommit: 1,
});

export const seedDesktop = (
  workspaceRoot: string,
  repositoryRoot: string,
): PreviewRepository => ({
  workspaceRoot,
  repositoryRoot,
  branch: "feature/desktop-shell",
  changes: [change(" M", "src/window.ts")],
  localBranches: [
    branch("main", "a7c3d21", { upstream: "origin/main" }),
    branch("feature/desktop-base", "b81f402", {
      upstream: "origin/feature/desktop-base",
    }),
    branch("feature/desktop-shell", "c32e910", {
      current: true,
      upstream: "origin/feature/desktop-shell",
      parent: "feature/desktop-base",
    }),
  ],
  remoteBranches: [
    branch("origin/main", "a7c3d21"),
    branch("origin/feature/desktop-base", "b81f402"),
    branch("origin/feature/desktop-shell", "c32e910"),
  ],
  remotes: [ORIGIN("machdoch-desktop")],
  recentCommits: [
    commit("c32e910", "Scope desktop workspace state", "2026-08-04T08:20:00Z"),
  ],
  stashes: [],
  worktrees: [],
  pullRequests: [
    {
      number: 42,
      title: "Scope desktop workspace state",
      state: "OPEN",
      url: "https://github.com/example/machdoch-desktop/pull/42",
      headBranch: "feature/desktop-shell",
      baseBranch: "main",
      draft: false,
      author: "machdoch",
      updatedAt: "2026-08-04T08:40:00Z",
    },
  ],
  diffs: new Map([
    patch("src/window.ts", "unstaged", [
      "diff --git a/src/window.ts b/src/window.ts",
      "--- a/src/window.ts",
      "+++ b/src/window.ts",
      "@@ -8,4 +8,5 @@ export const createWindow = () => ({",
      "   title: 'Machdoch',",
      "+  repository: 'packages/desktop',",
      " });",
    ]),
  ]),
  nextCommit: 1,
});

export const seedClean = (
  workspaceRoot: string,
  repositoryRoot: string,
  name: string,
): PreviewRepository => ({
  workspaceRoot,
  repositoryRoot,
  branch: "develop",
  changes: [],
  localBranches: [
    branch("develop", "9a8b7c6", {
      current: true,
      upstream: "origin/develop",
      behind: 2,
    }),
    branch("main", "1f2e3d4", { upstream: "origin/main" }),
  ],
  remoteBranches: [
    branch("origin/develop", "0b1c2d3"),
    branch("origin/main", "1f2e3d4"),
  ],
  remotes: [ORIGIN(name)],
  recentCommits: [
    commit("9a8b7c6", "Sync runtime configuration", "2026-08-05T10:00:00Z"),
  ],
  stashes: [],
  worktrees: [],
  pullRequests: [],
  diffs: new Map(),
  nextCommit: 1,
});
