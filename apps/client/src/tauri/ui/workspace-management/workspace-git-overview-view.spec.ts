import { describe, expect, it } from "vitest";
import type { WorkspaceGitOverview } from "@machdoch/fleet-protocol/workspace-contract";
import {
  mergeWorkspaceGitOverview,
  workspaceGitOverviewCovers,
  workspaceGitOverviewView,
} from "./workspace-git-overview-view";

const overview = (
  patch: Partial<WorkspaceGitOverview> = {},
): WorkspaceGitOverview => ({
  workspaceRoot: "C:/work",
  repositoryRoot: "C:/work",
  branch: "main",
  detached: false,
  ahead: 0,
  behind: 0,
  clean: true,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  totalChanges: 0,
  changes: [],
  changesTruncated: false,
  localBranches: [],
  remoteBranches: [],
  remotes: [],
  recentCommits: [],
  stashes: [],
  stashCount: 0,
  worktrees: [],
  sections: [],
  untrackedFiles: "normal",
  ...patch,
});

const stash = { reference: "stash@{0}", message: "wip", createdAt: "now" };

describe("workspace Git overview view", () => {
  it("loads only the data the visible section needs", () => {
    expect(workspaceGitOverviewView("changes")).toEqual({
      sections: ["branches", "numstat"],
      untrackedFiles: "all",
    });
    expect(workspaceGitOverviewView("stashes")).toEqual({
      sections: ["branches", "stashes"],
      untrackedFiles: "normal",
    });
    expect(workspaceGitOverviewView("pull-requests")).toEqual({
      sections: ["branches"],
      untrackedFiles: "normal",
    });
  });

  it("knows when a cached overview already covers a section", () => {
    const loaded = overview({
      sections: ["branches", "numstat"],
      untrackedFiles: "all",
    });
    expect(
      workspaceGitOverviewCovers(loaded, workspaceGitOverviewView("changes")),
    ).toBe(true);
    expect(
      workspaceGitOverviewCovers(loaded, workspaceGitOverviewView("branches")),
    ).toBe(true);
    expect(
      workspaceGitOverviewCovers(loaded, workspaceGitOverviewView("stashes")),
    ).toBe(false);
    expect(
      workspaceGitOverviewCovers(
        overview({ sections: ["branches", "numstat"] }),
        workspaceGitOverviewView("changes"),
      ),
    ).toBe(false);
  });

  it("keeps sections from the previous overview of the same branch", () => {
    const previous = overview({
      sections: ["branches", "stashes"],
      stashes: [stash],
      stashCount: 1,
    });
    const next = overview({ sections: ["branches", "numstat"], stashCount: 1 });
    const merged = mergeWorkspaceGitOverview(previous, next);
    expect(merged.stashes).toEqual([stash]);
    expect(merged.sections).toEqual(["branches", "numstat", "stashes"]);
    expect(next.sections).toEqual(["branches", "numstat"]);
  });

  it("drops section data after a branch switch", () => {
    const previous = overview({ sections: ["stashes"], stashes: [stash] });
    const next = overview({ branch: "feature", sections: ["branches"] });
    expect(mergeWorkspaceGitOverview(previous, next)).toBe(next);
  });
});
