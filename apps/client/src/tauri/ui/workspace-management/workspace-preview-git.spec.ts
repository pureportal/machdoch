import { beforeEach, describe, expect, it } from "vitest";
import {
  discoverPreviewWorkspaceGitRepositories,
  loadPreviewWorkspaceGitBranchStatus,
  loadPreviewWorkspaceGitDiff,
  loadPreviewWorkspaceGitOverview,
  loadPreviewWorkspaceGitSummary,
  loadPreviewWorkspacePullRequests,
  resetPreviewWorkspaceGit,
  runPreviewWorkspaceGitAction,
  switchPreviewWorkspaceGitBranches,
} from "./workspace-preview-git";

const workspaceRoot = "C:\\Projects\\machdoch";
const desktopRoot = "C:\\Projects\\machdoch\\packages\\desktop";
const cleanRoot = "C:\\Projects\\alphartis";

describe("workspace browser preview Git", () => {
  beforeEach(() => {
    resetPreviewWorkspaceGit();
  });

  it("covers status, renamed, binary, diff, and pull-request states", () => {
    expect(
      discoverPreviewWorkspaceGitRepositories(workspaceRoot).repositories.map(
        (repository) => repository.relativePath,
      ),
    ).toEqual([".", "packages/cloud", "packages/desktop"]);
    const overview = loadPreviewWorkspaceGitOverview(
      workspaceRoot,
      workspaceRoot,
    );
    expect(overview.totalChanges).toBe(overview.changes.length);
    expect(overview.conflictedCount).toBe(1);
    const renamed = overview.changes.find((change) => change.originalPath);
    expect(
      loadPreviewWorkspaceGitDiff(
        workspaceRoot,
        workspaceRoot,
        renamed?.path ?? "",
      ).originalPath,
    ).toBe("assets/old-logo.svg");
    expect(
      loadPreviewWorkspaceGitDiff(
        workspaceRoot,
        workspaceRoot,
        "assets/sample.bin",
      ).patches[0]?.binary,
    ).toBe(true);
    expect(
      loadPreviewWorkspacePullRequests(workspaceRoot, workspaceRoot).items[0]
        ?.number,
    ).toBe(128);
  });

  it("keeps repositories and workspaces isolated", () => {
    const desktop = loadPreviewWorkspaceGitOverview(workspaceRoot, desktopRoot);
    expect(desktop.branch).toBe("feature/desktop-shell");
    expect(() =>
      loadPreviewWorkspaceGitDiff(
        workspaceRoot,
        workspaceRoot,
        "src/window.ts",
      ),
    ).toThrow("This file is no longer changed.");
    expect(loadPreviewWorkspaceGitSummary(cleanRoot)).toEqual({
      branch: "develop",
      detached: false,
      upstream: "origin/develop",
      ahead: 0,
      behind: 2,
      changes: 0,
      conflicts: 0,
    });
  });

  it("stages, commits, and stashes changes", () => {
    let overview = runPreviewWorkspaceGitAction(
      workspaceRoot,
      desktopRoot,
      "stage",
      {
        paths: ["src/window.ts"],
      },
    );
    expect(overview.stagedCount).toBe(1);
    overview = runPreviewWorkspaceGitAction(
      workspaceRoot,
      desktopRoot,
      "commit",
      {
        message: "Update window",
      },
    );
    expect(overview.clean).toBe(true);
    expect(overview.recentCommits[0]?.subject).toBe("Update window");
    expect(overview.ahead).toBe(1);

    overview = runPreviewWorkspaceGitAction(
      workspaceRoot,
      workspaceRoot,
      "stash-push",
      {
        includeUntracked: true,
        message: "parking",
      },
    );
    expect(overview.stashes.map((stash) => stash.reference)).toEqual([
      "stash@{0}",
      "stash@{1}",
    ]);
    overview = runPreviewWorkspaceGitAction(
      workspaceRoot,
      workspaceRoot,
      "stash-pop",
      {
        stashRef: "stash@{0}",
      },
    );
    expect(overview.stashes).toHaveLength(1);
    expect(overview.changes.some((change) => change.untracked)).toBe(true);
  });

  it("tracks stacked branches and submits pull requests", () => {
    runPreviewWorkspaceGitAction(
      cleanRoot,
      cleanRoot,
      "create-stacked-branch",
      {
        branchName: "feature/api",
      },
    );
    let overview = runPreviewWorkspaceGitAction(
      cleanRoot,
      cleanRoot,
      "create-stacked-branch",
      { branchName: "feature/ui" },
    );
    expect(overview.branch).toBe("feature/ui");
    expect(
      overview.localBranches.find((branch) => branch.name === "feature/ui")
        ?.parent,
    ).toBe("feature/api");
    runPreviewWorkspaceGitAction(cleanRoot, cleanRoot, "submit-pull-requests", {
      draft: true,
    });
    expect(
      loadPreviewWorkspacePullRequests(cleanRoot, cleanRoot).items.map(
        (item) => [item.headBranch, item.baseBranch, item.draft],
      ),
    ).toEqual([
      ["feature/api", "develop", true],
      ["feature/ui", "feature/api", true],
    ]);

    runPreviewWorkspaceGitAction(cleanRoot, cleanRoot, "checkout", {
      branchName: "develop",
    });
    overview = runPreviewWorkspaceGitAction(
      cleanRoot,
      cleanRoot,
      "delete-branch",
      {
        branchName: "feature/api",
        force: true,
      },
    );
    expect(
      overview.localBranches.find((branch) => branch.name === "feature/ui")
        ?.parent,
    ).toBe("develop");
  });

  it("reports conflicted merges until the operation is resolved", () => {
    expect(() =>
      runPreviewWorkspaceGitAction(cleanRoot, cleanRoot, "merge", {
        branchName: "feature/conflict-demo",
      }),
    ).toThrow("conflicts");
    let overview = loadPreviewWorkspaceGitOverview(cleanRoot, cleanRoot);
    expect(overview.operation).toBe("merge");
    expect(() =>
      runPreviewWorkspaceGitAction(
        cleanRoot,
        cleanRoot,
        "continue-operation",
        {},
      ),
    ).toThrow("Resolve and stage");
    overview = runPreviewWorkspaceGitAction(
      cleanRoot,
      cleanRoot,
      "abort-operation",
      {},
    );
    expect(overview.operation).toBeUndefined();
    expect(overview.clean).toBe(true);
  });

  it("reports and aligns session branches across preview repositories", () => {
    const apiRoot = `${cleanRoot}\\api`;
    const appRoot = `${cleanRoot}\\app`;
    runPreviewWorkspaceGitAction(cleanRoot, appRoot, "create-branch", {
      branchName: "feature/ticket",
    });
    runPreviewWorkspaceGitAction(cleanRoot, appRoot, "push", {});
    runPreviewWorkspaceGitAction(cleanRoot, appRoot, "checkout", {
      branchName: "main",
    });

    const status = loadPreviewWorkspaceGitBranchStatus(
      cleanRoot,
      "feature/ticket",
    );
    expect(
      status.repositories.map((repository) => ({
        path: repository.relativePath,
        current: repository.currentBranch,
        defaultBranch: repository.defaultBranch,
        local: repository.branchLocal,
        remote: repository.branchRemote,
      })),
    ).toEqual([
      {
        path: ".",
        current: "develop",
        defaultBranch: "main",
        local: false,
        remote: undefined,
      },
      {
        path: "api",
        current: "develop",
        defaultBranch: "main",
        local: false,
        remote: undefined,
      },
      {
        path: "app",
        current: "main",
        defaultBranch: "main",
        local: true,
        remote: "origin/feature/ticket",
      },
    ]);
    expect(status.branches).toContain("feature/ticket");

    expect(() =>
      switchPreviewWorkspaceGitBranches(
        cleanRoot,
        [
          {
            repositoryRoot: apiRoot,
            branchName: "feature/ticket",
            create: false,
          },
        ],
        true,
      ),
    ).toThrow("Branch `feature/ticket` does not exist in api.");

    const results = switchPreviewWorkspaceGitBranches(
      cleanRoot,
      [
        { repositoryRoot: apiRoot, branchName: "main", create: false },
        {
          repositoryRoot: appRoot,
          branchName: "feature/ticket",
          create: false,
        },
      ],
      true,
    );
    expect(
      results.map((result) => [result.relativePath, result.switched]),
    ).toEqual([
      ["api", true],
      ["app", true],
    ]);
    expect(loadPreviewWorkspaceGitOverview(cleanRoot, apiRoot).branch).toBe(
      "main",
    );
    expect(loadPreviewWorkspaceGitOverview(cleanRoot, appRoot).branch).toBe(
      "feature/ticket",
    );
  });

  it("stashes changes before switching and refuses conflicted repositories", () => {
    const desktopStatus = loadPreviewWorkspaceGitBranchStatus(
      workspaceRoot,
      "feature/desktop-shell",
    );
    expect(desktopStatus.repositories[0]).toMatchObject({
      conflicts: 1,
      branchLocal: false,
    });
    expect(() =>
      switchPreviewWorkspaceGitBranches(
        workspaceRoot,
        [
          {
            repositoryRoot: workspaceRoot,
            branchName: "feature/workspace",
            create: false,
          },
        ],
        true,
      ),
    ).toThrow("Resolve the conflicts in machdoch first.");

    const [result] = switchPreviewWorkspaceGitBranches(
      workspaceRoot,
      [
        {
          repositoryRoot: desktopRoot,
          branchName: "feature/desktop-next",
          create: true,
        },
      ],
      true,
    );
    expect(result).toMatchObject({ switched: true, stashed: false });
    const created = loadPreviewWorkspaceGitOverview(workspaceRoot, desktopRoot);
    expect(created.branch).toBe("feature/desktop-next");
    expect(created.totalChanges).toBe(1);

    const [stashedResult] = switchPreviewWorkspaceGitBranches(
      workspaceRoot,
      [
        {
          repositoryRoot: desktopRoot,
          branchName: "feature/desktop-shell",
          create: false,
        },
      ],
      true,
    );
    expect(stashedResult).toMatchObject({ switched: true, stashed: true });
    const switched = loadPreviewWorkspaceGitOverview(
      workspaceRoot,
      desktopRoot,
    );
    expect(switched.totalChanges).toBe(0);
    expect(switched.stashes[0]?.message).toBe(
      "On feature/desktop-next: Before switching to feature/desktop-shell",
    );
  });

  it("opens, locks, and removes worktrees beside the repository", () => {
    const run = (
      action: Parameters<typeof runPreviewWorkspaceGitAction>[2],
      options: Parameters<typeof runPreviewWorkspaceGitAction>[3] = {},
    ) =>
      runPreviewWorkspaceGitAction(
        workspaceRoot,
        workspaceRoot,
        action,
        options,
      );
    const initial = loadPreviewWorkspaceGitOverview(
      workspaceRoot,
      workspaceRoot,
    );
    expect(
      initial.worktrees.map((entry) => [entry.branch, entry.main]),
    ).toEqual([
      ["main", true],
      ["feature/workspace", false],
    ]);
    const created = run("add-worktree", { branchName: "feature/PLAT-12" });
    const worktree = created.worktrees.find(
      (entry) => entry.branch === "feature/PLAT-12",
    );
    expect(worktree?.path).toBe(`${workspaceRoot}.worktrees\\feature-plat-12`);
    expect(created.branch).toBe("main");
    expect(
      created.localBranches.some((entry) => entry.name === "feature/PLAT-12"),
    ).toBe(true);
    expect(() =>
      run("add-worktree", { branchName: "feature/workspace" }),
    ).toThrow("already checked out");
    const path = worktree?.path ?? "";
    expect(
      run("lock-worktree", { worktreePath: path }).worktrees.find(
        (entry) => entry.path === path,
      )?.locked,
    ).toBe(true);
    expect(() => run("remove-worktree", { worktreePath: path })).toThrow(
      "Unlock",
    );
    run("unlock-worktree", { worktreePath: path });
    expect(
      run("remove-worktree", { worktreePath: path }).worktrees.some(
        (entry) => entry.path === path,
      ),
    ).toBe(false);
    const dirty = initial.worktrees[1]?.path ?? "";
    expect(() => run("remove-worktree", { worktreePath: dirty })).toThrow(
      "local changes",
    );
    expect(() =>
      run("remove-worktree", { worktreePath: workspaceRoot }),
    ).toThrow("main worktree");
  });
});
