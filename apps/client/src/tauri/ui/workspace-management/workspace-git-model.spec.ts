import { describe, expect, it } from "vitest";
import type {
  WorkspaceGitBranch,
  WorkspaceGitChange,
  WorkspaceGitRepository,
} from "../runtime";
import {
  createWorkspaceGitBranchTree,
  filterWorkspaceGitBranches,
  groupWorkspaceGitChanges,
  isValidGitBranchName,
  selectWorkspaceGitRepository,
  workspaceDiffLineTone,
  workspaceGitActionChangesFiles,
  workspaceGitActionChangesPullRequests,
  workspaceGitActionDoneLabel,
  workspaceGitActionProgressLabel,
  workspaceGitChangeLabel,
  workspaceGitPathInWorkspace,
  workspaceGitRepositoryLabel,
  workspaceGitStackMembers,
} from "./workspace-git-model";

const change = (
  overrides: Partial<WorkspaceGitChange>,
): WorkspaceGitChange => ({
  status: " M",
  path: "src/file.ts",
  staged: false,
  unstaged: true,
  untracked: false,
  conflicted: false,
  ...overrides,
});

const branch = (
  name: string,
  overrides: Partial<WorkspaceGitBranch> = {},
): WorkspaceGitBranch => ({
  name,
  commit: "abc1234",
  current: false,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  needsRestack: false,
  ...overrides,
});

describe("workspace Git presentation", () => {
  it("selects the first available preferred repository", () => {
    const repositories: WorkspaceGitRepository[] = [
      { repositoryRoot: "C:\\work\\api", relativePath: "apps/api" },
      { repositoryRoot: "C:\\work\\web", relativePath: "apps/web" },
    ];
    expect(
      selectWorkspaceGitRepository(
        repositories,
        "C:\\missing",
        "C:\\work\\web",
      ),
    ).toBe(repositories[1]);
    expect(selectWorkspaceGitRepository(repositories, null, undefined)).toBe(
      repositories[0],
    );
    expect(selectWorkspaceGitRepository([], "C:\\work")).toBeNull();
    expect(workspaceGitRepositoryLabel(repositories[0]!)).toBe("apps/api");
    expect(
      workspaceGitRepositoryLabel({
        repositoryRoot: "C:\\work",
        relativePath: ".",
      }),
    ).toBe("Workspace root");
  });

  it("maps repository paths into the workspace", () => {
    expect(
      workspaceGitPathInWorkspace(
        { repositoryRoot: "C:\\work\\api", relativePath: "apps/api/" },
        "src/main.ts",
      ),
    ).toBe("apps/api/src/main.ts");
    expect(
      workspaceGitPathInWorkspace(
        { repositoryRoot: "C:\\work", relativePath: "." },
        "README.md",
      ),
    ).toBe("README.md");
    expect(workspaceGitPathInWorkspace(null, "README.md")).toBe("README.md");
  });

  it("identifies actions that rewrite files or pull requests", () => {
    for (const action of [
      "pull",
      "checkout",
      "merge",
      "rebase",
      "restack",
      "stash-pop",
      "abort-operation",
    ] as const) {
      expect(workspaceGitActionChangesFiles(action)).toBe(true);
    }
    for (const action of [
      "fetch",
      "commit",
      "stage",
      "create-stacked-branch",
    ] as const) {
      expect(workspaceGitActionChangesFiles(action)).toBe(false);
    }
    expect(workspaceGitActionChangesPullRequests("submit-pull-requests")).toBe(
      true,
    );
    expect(workspaceGitActionChangesPullRequests("commit")).toBe(false);
    expect(workspaceGitActionProgressLabel("push")).toBe("Pushing…");
    expect(workspaceGitActionDoneLabel("stash-push")).toBe("Stashed changes");
  });

  it("groups conflicts, staged, and working tree changes", () => {
    const both = change({ path: "both.ts", status: "MM", staged: true });
    const staged = change({
      path: "staged.ts",
      status: "M ",
      staged: true,
      unstaged: false,
    });
    const untracked = change({
      path: "new.ts",
      status: "??",
      unstaged: false,
      untracked: true,
    });
    const conflict = change({
      path: "conflict.ts",
      status: "UU",
      conflicted: true,
    });
    const groups = groupWorkspaceGitChanges([
      both,
      staged,
      untracked,
      conflict,
    ]);
    expect(groups.conflicts).toEqual([conflict]);
    expect(groups.staged).toEqual([both, staged]);
    expect(groups.unstaged).toEqual([both, untracked]);
  });

  it("orders stacked branches below their parents", () => {
    const branches = [
      branch("feature/api", { parent: "main" }),
      branch("feature/ui", { parent: "feature/api" }),
      branch("hotfix"),
      branch("main"),
      branch("orphan", { parent: "deleted" }),
    ];
    expect(
      createWorkspaceGitBranchTree(branches).map((node) => [
        node.branch.name,
        node.depth,
        node.stacked,
      ]),
    ).toEqual([
      ["hotfix", 0, false],
      ["main", 0, true],
      ["feature/api", 1, true],
      ["feature/ui", 2, true],
      ["orphan", 0, false],
    ]);
  });

  it("keeps cyclic stack metadata visible exactly once", () => {
    const branches = [
      branch("a", { parent: "b" }),
      branch("b", { parent: "a" }),
    ];
    expect(
      createWorkspaceGitBranchTree(branches).map((node) => node.branch.name),
    ).toEqual(["a", "b"]);
    expect(workspaceGitStackMembers(branches, "a").sort()).toEqual(["a", "b"]);
  });

  it("collects every stack member below the trunk", () => {
    const branches = [
      branch("main"),
      branch("feature/api", { parent: "main" }),
      branch("feature/ui", { parent: "feature/api" }),
      branch("feature/docs", { parent: "main" }),
      branch("other"),
    ];
    expect(workspaceGitStackMembers(branches, "feature/ui")).toEqual([
      "feature/api",
      "feature/docs",
      "feature/ui",
    ]);
    expect(workspaceGitStackMembers(branches, "other")).toEqual([]);
    expect(
      filterWorkspaceGitBranches(branches, " API ").map((item) => item.name),
    ).toEqual(["feature/api"]);
  });

  it("prioritizes actionable combined status labels", () => {
    expect(workspaceGitChangeLabel(change({ conflicted: true }))).toBe(
      "Conflict",
    );
    expect(workspaceGitChangeLabel(change({ untracked: true }))).toBe(
      "Untracked",
    );
    expect(
      workspaceGitChangeLabel(change({ staged: true, unstaged: true })),
    ).toBe("Staged + modified");
    expect(
      workspaceGitChangeLabel(change({ staged: true, unstaged: false })),
    ).toBe("Staged");
    expect(workspaceGitChangeLabel(change({}))).toBe("Modified");
  });

  it("classifies unified diff lines without mistaking file headers for edits", () => {
    expect(workspaceDiffLineTone("+++ b/file.ts")).toBe("header");
    expect(workspaceDiffLineTone("--- a/file.ts")).toBe("header");
    expect(workspaceDiffLineTone("@@ -1 +1 @@")).toBe("hunk");
    expect(workspaceDiffLineTone("+added")).toBe("addition");
    expect(workspaceDiffLineTone("-removed")).toBe("deletion");
    expect(workspaceDiffLineTone(" context")).toBe("context");
  });

  it("accepts only names Git allows for branches", () => {
    for (const name of [
      "main",
      "feature/ABC-123-checkout",
      "release/1.4",
      "user@host",
    ]) {
      expect(isValidGitBranchName(name)).toBe(true);
    }
    for (const name of [
      "",
      "HEAD",
      "@",
      "-feature",
      "feature branch",
      "feature..x",
      "feature/",
      "/feature",
      "feature//x",
      "feature.",
      "feature/.hidden",
      "feature/x.lock",
      "feature@{1}",
      "feature~1",
      "feature^",
      "feature:x",
      "feature?",
      "feature*",
      "feature[x",
      "feature\\x",
      "feature\tx",
      "x".repeat(256),
    ]) {
      expect(isValidGitBranchName(name)).toBe(false);
    }
  });
});
