import { describe, expect, it } from "vitest";
import type {
  WorkspaceGitChange,
  WorkspaceGitOverview,
  WorkspaceGitRepository,
} from "../runtime";
import {
  selectWorkspaceGitRepository,
  workspaceDiffLineTone,
  workspaceGitActionChangesFiles,
  workspaceGitChangeLabel,
  workspaceGitOverviewForSelection,
  workspaceGitRepositoryLabel,
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

describe("workspace Git presentation", () => {
  it("preserves a discovered repository selection and falls back predictably", () => {
    const repositories: WorkspaceGitRepository[] = [
      { repositoryRoot: "C:\\work\\api", relativePath: "apps/api" },
      { repositoryRoot: "C:\\work\\web", relativePath: "apps/web" },
    ];
    expect(selectWorkspaceGitRepository(repositories, "C:\\work\\web")).toBe(
      repositories[1],
    );
    expect(
      selectWorkspaceGitRepository(repositories, "C:\\work\\missing"),
    ).toBe(repositories[0]);
    expect(selectWorkspaceGitRepository([], null)).toBeNull();
    expect(workspaceGitRepositoryLabel(repositories[0]!)).toBe("apps/api");
    expect(
      workspaceGitRepositoryLabel({
        repositoryRoot: "C:\\work",
        relativePath: ".",
      }),
    ).toBe("Workspace root");
  });

  it("identifies actions that can replace workspace files", () => {
    expect(workspaceGitActionChangesFiles("pull")).toBe(true);
    expect(workspaceGitActionChangesFiles("checkout")).toBe(true);
    expect(workspaceGitActionChangesFiles("checkout-remote")).toBe(true);
    expect(workspaceGitActionChangesFiles("fetch")).toBe(false);
    expect(workspaceGitActionChangesFiles("create-branch")).toBe(false);
    expect(workspaceGitActionChangesFiles("add-remote")).toBe(false);
  });

  it("never presents an overview for a different repository selection", () => {
    const overview = {
      repositoryRoot: "C:\\work\\api",
    } as WorkspaceGitOverview;
    expect(
      workspaceGitOverviewForSelection(
        overview,
        "C:\\work",
        "C:\\work",
        "C:\\work\\api",
      ),
    ).toBe(overview);
    expect(
      workspaceGitOverviewForSelection(
        overview,
        "C:\\work",
        "C:\\work",
        "C:\\work\\web",
      ),
    ).toBeNull();
    expect(
      workspaceGitOverviewForSelection(
        overview,
        "C:\\other",
        "C:\\work",
        "C:\\work\\api",
      ),
    ).toBeNull();
    expect(
      workspaceGitOverviewForSelection(
        null,
        "C:\\work",
        "C:\\work",
        "C:\\work\\api",
      ),
    ).toBeNull();
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
});
