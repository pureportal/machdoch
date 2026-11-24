import { describe, expect, it } from "vitest";
import type {
  WorkspaceGitBranchRepository,
  WorkspaceGitRepositoryStatus,
} from "@machdoch/fleet-protocol/workspace-contract";
import {
  describeSkipped,
  planBulkBranchSwitch,
  planBulkCommit,
  planBulkPull,
} from "./workspace-git-bulk";

const repository = (
  relativePath: string,
  overrides: Partial<WorkspaceGitRepositoryStatus> = {},
): WorkspaceGitRepositoryStatus => ({
  repositoryRoot: `C:\\work\\${relativePath}`,
  relativePath,
  branch: "main",
  detached: false,
  upstream: "origin/main",
  upstreamGone: false,
  ahead: 0,
  behind: 0,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  totalChanges: 0,
  changes: [],
  changesTruncated: false,
  ...overrides,
});

const branchRepository = (
  relativePath: string,
  overrides: Partial<WorkspaceGitBranchRepository> = {},
): WorkspaceGitBranchRepository => ({
  repositoryRoot: `C:\\work\\${relativePath}`,
  relativePath,
  currentBranch: "main",
  branchLocal: true,
  changes: 0,
  conflicts: 0,
  ...overrides,
});

describe("bulk git actions", () => {
  it("pulls only repositories that track a live upstream and are not busy", () => {
    const plan = planBulkPull([
      repository("api"),
      repository("app", { upstream: undefined }),
      repository("infra", { operation: "rebase" }),
      repository("lambda", { detached: true }),
    ]);
    expect(plan.targets.map((target) => target.relativePath)).toEqual(["api"]);
    expect(describeSkipped(plan.skipped)).toBe(
      "app: no upstream\ninfra: rebase in progress\nlambda: detached HEAD",
    );
  });

  it("commits every repository with changes unless it has conflicts", () => {
    const plan = planBulkCommit([
      repository("api", { totalChanges: 2 }),
      repository("app"),
      repository("infra", { totalChanges: 1, conflictedCount: 1 }),
    ]);
    expect(plan.targets.map((target) => target.relativePath)).toEqual(["api"]);
    expect(plan.skipped).toEqual([
      { relativePath: "infra", reason: "has conflicts" },
    ]);
  });

  it("switches repositories that have the branch and skips the rest", () => {
    const plan = planBulkBranchSwitch(
      {
        workspaceRoot: "C:\\work",
        branchName: "cloud-1-fix",
        repositories: [
          branchRepository("api"),
          branchRepository("app", {
            branchLocal: false,
            branchRemote: "origin/cloud-1-fix",
          }),
          branchRepository("infra", { branchLocal: false }),
          branchRepository("lambda", { currentBranch: "cloud-1-fix" }),
        ],
        branches: [],
        scanLimited: false,
        issues: [],
      },
      "cloud-1-fix",
    );
    expect(plan.targets).toEqual([
      {
        repositoryRoot: "C:\\work\\api",
        branchName: "cloud-1-fix",
        create: false,
      },
      {
        repositoryRoot: "C:\\work\\app",
        branchName: "cloud-1-fix",
        create: false,
      },
    ]);
    expect(plan.skipped).toEqual([
      { relativePath: "infra", reason: "branch not found" },
    ]);
  });
});
