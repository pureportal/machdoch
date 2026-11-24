import { describe, expect, it } from "vitest";
import {
  branchCleanupCandidates,
  branchNameForIssue,
  changeCountTooltip,
  commitAge,
  fuzzyBranchScore,
  groupBranches,
  issueKeyFromBranch,
  recentBranchesFromReflog,
} from "./workspace-git-branch-search";

const branch = (name: string, extra = {}) => ({
  name,
  remote: false,
  current: false,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  ...extra,
});

describe("branch picker search", () => {
  it("matches fuzzily and prefers word-boundary hits", () => {
    expect(fuzzyBranchScore("c2972", "cloud-2972-login")).not.toBeNull();
    expect(fuzzyBranchScore("xyz", "main")).toBeNull();
    expect(fuzzyBranchScore("login", "cloud-2972-login")!).toBeGreaterThan(
      fuzzyBranchScore("login", "cloudlogin-x")!,
    );
  });

  it("lists recent branches first and groups local and remote branches", () => {
    const groups = groupBranches(
      [
        branch("main", { current: true }),
        branch("feature/a"),
        branch("feature/b"),
        branch("origin/feature/a", { remote: true }),
      ],
      ["feature/b", "main", "feature/a"],
      "",
    );
    expect(groups.recent.map((entry) => entry.name)).toEqual([
      "feature/b",
      "feature/a",
    ]);
    expect(groups.local.map((entry) => entry.name)).toEqual(["main"]);
    expect(groups.remote.map((entry) => entry.name)).toEqual([
      "origin/feature/a",
    ]);
    expect(groupBranches([branch("feature/a")], [], "fa").local).toHaveLength(
      1,
    );
  });

  it("reads recently checked-out branches from the reflog", () => {
    expect(
      recentBranchesFromReflog([
        "checkout: moving from main to feature/b",
        "commit: change",
        "checkout: moving from feature/a to main",
        "checkout: moving from 1a2b3c4d to feature/a",
      ]),
    ).toEqual(["feature/b", "main", "feature/a"]);
  });

  it("formats commit age and explains change counts", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(commitAge("2026-11-24T11:30:00Z", now)).toBe("30m");
    expect(commitAge("2026-11-20T12:00:00Z", now)).toBe("4d");
    expect(commitAge(undefined, now)).toBeNull();
    expect(
      changeCountTooltip({
        staged: 2,
        unstaged: 1,
        untracked: 3,
        conflicted: 0,
      }),
    ).toBe("2 staged · 1 modified · 3 untracked");
  });

  it("previews merged, gone and stale branches for clean-up but never protected ones", () => {
    const now = Date.parse("2026-11-24T00:00:00Z");
    expect(
      branchCleanupCandidates(
        [
          branch("main", { merged: true }),
          branch("done", { merged: true }),
          branch("gone", { upstreamGone: true }),
          branch("old", { lastCommitAt: "2026-01-01T00:00:00Z" }),
          branch("fresh", { lastCommitAt: "2026-11-20T00:00:00Z" }),
          branch("current", { current: true, merged: true }),
        ],
        new Set(["main"]),
        now,
      ),
    ).toEqual([
      { name: "done", reason: "merged" },
      { name: "gone", reason: "gone" },
      { name: "old", reason: "stale" },
    ]);
  });

  it("links branches to issue keys and names branches after issues", () => {
    expect(issueKeyFromBranch("cloud-2972-fix-login")).toBe("CLOUD-2972");
    expect(issueKeyFromBranch("feature/CLOUD-12")).toBe("CLOUD-12");
    expect(issueKeyFromBranch("main")).toBeNull();
    expect(branchNameForIssue("CLOUD-2972", "Fix the Löwe sign-in flow!")).toBe(
      "cloud-2972-fix-the-lowe-sign-in-flow",
    );
  });
});
