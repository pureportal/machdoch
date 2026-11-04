import { describe, expect, it } from "vitest";
import type {
  WorkspaceGitBranchRepository,
  WorkspaceGitBranchStatus,
} from "../../runtime";
import {
  describeSessionGitBranchBlocker,
  evaluateSessionGitBranch,
  planSessionGitBranchCreate,
  planSessionGitBranchSwitch,
  sessionGitBranchPrimaryPlan,
  sessionGitBranchSuggestions,
  sessionGitRepositoryName,
  summarizeSessionGitBranchSwitch,
} from "./session-git-branch";

const BRANCH = "feature/ABC-1";

const repository = (
  relativePath: string,
  overrides: Partial<WorkspaceGitBranchRepository> = {},
): WorkspaceGitBranchRepository => ({
  repositoryRoot: `C:\\work\\${relativePath}`,
  relativePath,
  currentBranch: "main",
  defaultBranch: "main",
  branchLocal: false,
  changes: 0,
  conflicts: 0,
  ...overrides,
});

const status = (
  ...repositories: WorkspaceGitBranchRepository[]
): WorkspaceGitBranchStatus => ({
  workspaceRoot: "C:\\work",
  branchName: BRANCH,
  repositories,
  branches: [],
  scanLimited: false,
  issues: [],
});

const evaluate = (...repositories: WorkspaceGitBranchRepository[]) =>
  evaluateSessionGitBranch(BRANCH, status(...repositories));

describe("session Git branch evaluation", () => {
  it("treats a single repository on its default branch as new work", () => {
    const evaluation = evaluate(repository("."));
    expect(evaluation.status).toBe("new");
    expect(evaluation.repositories[0]).toMatchObject({
      state: "on-default",
      expectedBranch: "main",
    });
  });

  it("flags a different branch in a single repository as a mismatch", () => {
    const evaluation = evaluate(
      repository(".", { currentBranch: "feature/OTHER-2", branchLocal: true }),
    );
    expect(evaluation.status).toBe("mismatch");
    expect(evaluation.repositories[0]).toMatchObject({
      state: "other-branch",
      expectedBranch: BRANCH,
    });
  });

  it("matches when the assigned branch is checked out", () => {
    expect(
      evaluate(
        repository(".", { currentBranch: BRANCH, branchLocal: true }),
      ).status,
    ).toBe("matched");
  });

  it("matches when untouched repositories stay on their default branch", () => {
    const evaluation = evaluate(
      repository("ui", { currentBranch: BRANCH, branchLocal: true }),
      repository("api"),
    );
    expect(evaluation.status).toBe("matched");
    expect(evaluation.repositories.map((entry) => entry.state)).toEqual([
      "on-branch",
      "on-default",
    ]);
  });

  it("reports not switched when the branch exists locally or remotely but the default is checked out", () => {
    const evaluation = evaluate(
      repository("ui", { currentBranch: BRANCH, branchLocal: true }),
      repository("api", { branchRemote: `origin/${BRANCH}` }),
    );
    expect(evaluation.status).toBe("not-switched");
    expect(evaluation.repositories[1]).toMatchObject({
      state: "not-switched",
      expectedBranch: BRANCH,
    });
  });

  it("reports a mismatch when any repository is on another ticket's branch", () => {
    const evaluation = evaluate(
      repository("ui", { currentBranch: BRANCH, branchLocal: true }),
      repository("api", { currentBranch: "feature/OTHER-2" }),
      repository("docs", { branchRemote: `origin/${BRANCH}` }),
    );
    expect(evaluation.status).toBe("mismatch");
    expect(evaluation.repositories[1]).toMatchObject({
      state: "other-branch",
      expectedBranch: "main",
    });
  });

  it("treats detached HEAD as a mismatch", () => {
    const evaluation = evaluate(
      repository(".", { currentBranch: undefined, branchLocal: true }),
    );
    expect(evaluation.status).toBe("mismatch");
    expect(evaluation.repositories[0]?.state).toBe("detached");
  });

  it("expects the default branch everywhere when it is the assigned branch", () => {
    const evaluation = evaluateSessionGitBranch(
      "main",
      status(
        repository("ui", { branchLocal: true }),
        repository("api", { currentBranch: "feature/x", branchLocal: true }),
      ),
    );
    expect(evaluation.status).toBe("mismatch");
    expect(evaluation.repositories[0]?.state).toBe("on-branch");
    expect(evaluation.repositories[1]?.expectedBranch).toBe("main");
  });

  it("reports unknown when a repository is unreadable or none exist", () => {
    expect(
      evaluate(
        repository("ui", { currentBranch: BRANCH, branchLocal: true }),
        repository("api", { error: "git failed" }),
      ).status,
    ).toBe("unknown");
    expect(evaluate().status).toBe("unknown");
    expect(
      evaluate(
        repository("ui", { currentBranch: "feature/x" }),
        repository("api", { error: "git failed" }),
      ).status,
    ).toBe("mismatch");
  });

  it("has no expected branch when no default branch is known", () => {
    const evaluation = evaluate(
      repository(".", { currentBranch: "trunk", defaultBranch: undefined }),
    );
    expect(evaluation.repositories[0]).toMatchObject({
      state: "other-branch",
      expectedBranch: null,
    });
  });
});

describe("session Git branch plans", () => {
  it("switches every misaligned repository to its expected branch", () => {
    const evaluation = evaluate(
      repository("ui", { branchLocal: true, changes: 2 }),
      repository("api", { currentBranch: "feature/OTHER-2" }),
      repository("docs"),
      repository("web", { currentBranch: BRANCH, branchLocal: true }),
    );
    const plan = planSessionGitBranchSwitch(evaluation);
    expect(plan).toEqual({
      kind: "switch",
      targets: [
        {
          repositoryRoot: "C:\\work\\ui",
          branchName: BRANCH,
          create: false,
        },
        { repositoryRoot: "C:\\work\\api", branchName: "main", create: false },
      ],
      dirtyRepositories: ["ui"],
      blockers: [],
    });
    expect(sessionGitBranchPrimaryPlan(evaluation)).toEqual(plan);
  });

  it("limits a plan to one repository", () => {
    const evaluation = evaluate(
      repository("ui", { branchLocal: true }),
      repository("api", { currentBranch: "feature/OTHER-2" }),
    );
    expect(
      planSessionGitBranchSwitch(evaluation, "C:\\work\\api").targets,
    ).toEqual([
      { repositoryRoot: "C:\\work\\api", branchName: "main", create: false },
    ]);
  });

  it("blocks switching during conflicts, operations, or without a target", () => {
    const evaluation = evaluate(
      repository("ui", { branchLocal: true, conflicts: 1, changes: 1 }),
      repository("api", {
        currentBranch: undefined,
        branchLocal: true,
        operation: "rebase",
      }),
      repository("docs", { currentBranch: "trunk", defaultBranch: undefined }),
    );
    const plan = planSessionGitBranchSwitch(evaluation);
    expect(plan.targets).toEqual([]);
    expect(plan.blockers).toEqual([
      { relativePath: "ui", reason: "conflicts" },
      { relativePath: "api", reason: "operation", operation: "rebase" },
      { relativePath: "docs", reason: "no-default-branch" },
    ]);
    expect(
      plan.blockers.map((blocker) =>
        describeSessionGitBranchBlocker(blocker, blocker.relativePath),
      ),
    ).toEqual([
      "Resolve the conflicts in ui first.",
      "Finish the rebase in api first.",
      "docs has no default branch to switch to.",
    ]);
    expect(sessionGitBranchPrimaryPlan(evaluation)).toEqual(plan);
  });

  it("creates the branch only in repositories that lack it", () => {
    const evaluation = evaluate(
      repository("ui", { currentBranch: BRANCH, branchLocal: true }),
      repository("api", { changes: 3 }),
      repository("docs", { branchRemote: `origin/${BRANCH}` }),
    );
    expect(planSessionGitBranchCreate(evaluation)).toEqual({
      kind: "create",
      targets: [
        { repositoryRoot: "C:\\work\\api", branchName: BRANCH, create: true },
      ],
      dirtyRepositories: [],
      blockers: [],
    });
  });

  it("offers one-click creation only for single-repository new work", () => {
    expect(
      sessionGitBranchPrimaryPlan(evaluate(repository(".", { changes: 1 }))),
    ).toMatchObject({
      kind: "create",
      targets: [{ repositoryRoot: "C:\\work\\.", create: true }],
    });
    expect(
      sessionGitBranchPrimaryPlan(evaluate(repository("ui"), repository("api"))),
    ).toBeNull();
    expect(
      sessionGitBranchPrimaryPlan(
        evaluate(repository("ui", { currentBranch: BRANCH, branchLocal: true })),
      ),
    ).toBeNull();
  });
});

describe("session Git branch helpers", () => {
  it("summarizes stashes and failures with readable repository names", () => {
    const name = (relativePath: string) =>
      sessionGitRepositoryName("\\\\?\\C:\\work\\shop", relativePath);
    expect(
      summarizeSessionGitBranchSwitch(
        [
          {
            repositoryRoot: "C:\\work\\shop",
            relativePath: ".",
            branchName: BRANCH,
            switched: true,
            stashed: true,
          },
          {
            repositoryRoot: "C:\\work\\shop\\api",
            relativePath: "api",
            branchName: "main",
            switched: false,
            stashed: false,
            error: "already used by worktree",
          },
        ],
        name,
      ),
    ).toEqual({
      stashed: ["shop"],
      failures: ["api: already used by worktree"],
    });
  });

  it("suggests checked-out feature branches before recent branches", () => {
    expect(
      sessionGitBranchSuggestions({
        ...status(
          repository("ui", { currentBranch: "feature/current" }),
          repository("api"),
        ),
        branches: ["feature/recent", "feature/current", "main"],
      }),
    ).toEqual(["feature/current", "feature/recent", "main"]);
  });
});
