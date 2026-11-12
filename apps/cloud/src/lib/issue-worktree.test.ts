import { describe, expect, it } from "vitest";
import {
  issueWorktreeRepository,
  matchingWorkspaceRoot,
  worktreePathForBranch,
} from "./issue-worktree";

const repository = (relativePath: string, repositoryRoot: string) => ({
  relativePath,
  repositoryRoot,
});

describe("issue worktrees", () => {
  it("uses the workspace repository or the only nested one", () => {
    expect(
      issueWorktreeRepository({
        repositories: [
          repository("packages/ui", "C:\\work\\app\\packages\\ui"),
          repository(".", "C:\\work\\app"),
        ],
      }),
    ).toBe("C:\\work\\app");
    expect(
      issueWorktreeRepository({
        repositories: [repository("service", "/work/service")],
      }),
    ).toBe("/work/service");
    expect(() =>
      issueWorktreeRepository({
        repositories: [repository("a", "/a"), repository("b", "/b")],
      }),
    ).toThrow("several Git repositories");
    expect(() => issueWorktreeRepository({ repositories: [] })).toThrow(
      "no Git repository",
    );
  });

  it("reuses a live worktree for the issue branch", () => {
    const worktree = (branch: string, path: string, prunable = false) => ({
      path,
      branch,
      head: "abc1234",
      main: false,
      current: false,
      detached: false,
      locked: false,
      prunable,
    });
    expect(
      worktreePathForBranch(
        {
          worktrees: [
            worktree("plat-12-crash", "/gone", true),
            worktree("plat-12-crash", "/app.worktrees/plat-12-crash"),
          ],
        },
        "plat-12-crash",
      ),
    ).toBe("/app.worktrees/plat-12-crash");
    expect(worktreePathForBranch({ worktrees: [] }, "plat-12")).toBeNull();
  });

  it("matches the workspace root the device reports", () => {
    const workspaces = [{ root: "C:\\Work\\App.worktrees\\plat-12" }];
    expect(
      matchingWorkspaceRoot(workspaces, "c:/work/app.worktrees/plat-12/"),
    ).toBe("C:\\Work\\App.worktrees\\plat-12");
    expect(matchingWorkspaceRoot(workspaces, "C:\\Work\\App")).toBeNull();
  });
});
