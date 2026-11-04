import { beforeEach, describe, expect, it } from "vitest";
import {
  discoverPreviewWorkspaceGitRepositories,
  loadPreviewWorkspaceGitDiff,
  loadPreviewWorkspaceGitOverview,
  loadPreviewWorkspaceGitSummary,
  loadPreviewWorkspacePullRequests,
  resetPreviewWorkspaceGit,
  runPreviewWorkspaceGitAction,
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
    ).toEqual([".", "packages/desktop"]);
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
});
