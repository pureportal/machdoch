// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadWorkspaceGitOverview,
  loadWorkspaceGitRepositories,
  loadWorkspacePullRequests,
  runWorkspaceGitAction,
  type WorkspaceGitOverview,
} from "../runtime";
import { useWorkspaceGit } from "./use-workspace-git";

vi.mock("../runtime", () => ({
  loadWorkspaceGitOverview: vi.fn(),
  loadWorkspaceGitRepositories: vi.fn(),
  loadWorkspacePullRequests: vi.fn(),
  runWorkspaceGitAction: vi.fn(),
}));

const overview = (root: string, branch = "main"): WorkspaceGitOverview => ({
  workspaceRoot: root,
  repositoryRoot: root,
  branch,
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
});
beforeEach(() => {
  vi.mocked(loadWorkspaceGitRepositories).mockImplementation(async (root) => ({
    workspaceRoot: root,
    repositories: [{ repositoryRoot: root, relativePath: "." }],
    scanLimited: false,
    issues: [],
  }));
  vi.mocked(loadWorkspaceGitOverview).mockImplementation(async (root) =>
    overview(root),
  );
  vi.mocked(runWorkspaceGitAction).mockImplementation(async (root) =>
    overview(root, "updated"),
  );
  vi.mocked(loadWorkspacePullRequests).mockResolvedValue({
    available: true,
    items: [],
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("does not replace a new workspace with a late Git response", async () => {
  let finish: ((value: WorkspaceGitOverview) => void) | undefined;
  vi.mocked(loadWorkspaceGitOverview).mockImplementation(async (root) =>
    root === "C:\\first"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : overview(root),
  );
  const { result, rerender } = renderHook(
    ({ root }) => useWorkspaceGit(root, false, vi.fn()),
    { initialProps: { root: "C:\\first" } },
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  rerender({ root: "C:\\second" });
  await waitFor(() =>
    expect(result.current.selectedGitOverview?.workspaceRoot).toBe(
      "C:\\second",
    ),
  );
  await act(async () => finish?.(overview("C:\\first")));
  expect(result.current.selectedGitOverview?.workspaceRoot).toBe("C:\\second");
});

it("confirms Git actions that replace files and preserves the draft on cancellation", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const changed = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceGit("C:\\work", true, changed),
  );
  await waitFor(() =>
    expect(result.current.selectedGitOverview).not.toBeNull(),
  );
  await act(async () =>
    result.current.runGitAction("checkout", { branchName: "other" }),
  );
  expect(runWorkspaceGitAction).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  vi.mocked(window.confirm).mockReturnValue(true);
  await act(async () =>
    result.current.runGitAction("checkout", { branchName: "other" }),
  );
  expect(runWorkspaceGitAction).toHaveBeenCalledWith(
    "C:\\work",
    "C:\\work",
    "checkout",
    { branchName: "other" },
  );
  expect(changed).toHaveBeenCalledOnce();
});

it("runs one mutation at a time and ignores its result after a workspace change", async () => {
  let finish: ((value: WorkspaceGitOverview) => void) | undefined;
  vi.mocked(runWorkspaceGitAction).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const changed = vi.fn();
  const { result, rerender } = renderHook(
    ({ root }) => useWorkspaceGit(root, false, changed),
    { initialProps: { root: "C:\\first" } },
  );
  await waitFor(() =>
    expect(result.current.selectedGitOverview).not.toBeNull(),
  );
  let pending: Promise<void>;
  act(() => {
    pending = result.current.runGitAction("pull");
  });
  await act(async () => result.current.runGitAction("fetch"));
  expect(runWorkspaceGitAction).toHaveBeenCalledOnce();
  rerender({ root: "C:\\second" });
  await waitFor(() =>
    expect(result.current.selectedGitOverview?.workspaceRoot).toBe(
      "C:\\second",
    ),
  );
  await act(async () => {
    finish?.(overview("C:\\first", "updated"));
    await pending;
  });
  expect(result.current.selectedGitOverview?.workspaceRoot).toBe("C:\\second");
  expect(changed).not.toHaveBeenCalled();
});

it("loads pull requests only when their view opens", async () => {
  const { result } = renderHook(() =>
    useWorkspaceGit("C:\\work", false, vi.fn()),
  );
  await waitFor(() =>
    expect(result.current.selectedGitOverview).not.toBeNull(),
  );
  expect(loadWorkspacePullRequests).not.toHaveBeenCalled();
  act(() => result.current.setGitSection("pull-requests"));
  await waitFor(() =>
    expect(result.current.pullRequests?.available).toBe(true),
  );
  expect(loadWorkspacePullRequests).toHaveBeenCalledOnce();
});
