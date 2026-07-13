import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverWorkspaceGitRepositories } from "./task-file-change-repository-discovery.ts";

const workspacesToClean: string[] = [];

const runGit = async (cwd: string, args: readonly string[]): Promise<void> => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", windowsHide: true },
      (error) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise();
      },
    );
  });
};

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-repositories-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const createRepository = async (repositoryRoot: string): Promise<void> => {
  await mkdir(repositoryRoot, { recursive: true });
  await runGit(repositoryRoot, ["init", "-q"]);
  await runGit(repositoryRoot, ["config", "user.name", "Machdoch Test"]);
  await runGit(repositoryRoot, [
    "config",
    "user.email",
    "machdoch-test@example.com",
  ]);
  await runGit(repositoryRoot, ["config", "commit.gpgSign", "false"]);
  await writeFile(join(repositoryRoot, "tracked.txt"), "initial\n", "utf8");
  await runGit(repositoryRoot, ["add", "--all"]);
  await runGit(repositoryRoot, ["commit", "-q", "-m", "Initial state"]);
};

afterEach(async () => {
  await Promise.all(
    workspacesToClean.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

describe("workspace Git repository discovery", () => {
  it("discovers sibling repositories beneath a non-Git workspace", async () => {
    const workspaceRoot = await createWorkspace();
    await Promise.all([
      createRepository(join(workspaceRoot, "api")),
      createRepository(join(workspaceRoot, "ui")),
    ]);

    const result = await discoverWorkspaceGitRepositories(workspaceRoot);

    expect(result.repositories.map((repository) => repository.workspacePath)).toEqual([
      "api",
      "ui",
    ]);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("supports linked worktrees that use a .git file", async () => {
    const workspaceRoot = await createWorkspace();
    const mainRepositoryRoot = join(workspaceRoot, "main");
    const linkedWorktreeRoot = join(workspaceRoot, "linked");
    await createRepository(mainRepositoryRoot);
    await runGit(mainRepositoryRoot, [
      "worktree",
      "add",
      "-q",
      "-b",
      "linked-test",
      linkedWorktreeRoot,
    ]);

    const result = await discoverWorkspaceGitRepositories(workspaceRoot);

    expect(result.repositories.map((repository) => repository.workspacePath)).toEqual([
      "linked",
      "main",
    ]);
  });

  it("uses a bounded depth and skips generated dependency trees", async () => {
    const workspaceRoot = await createWorkspace();
    await createRepository(join(workspaceRoot, "group", "api"));
    await createRepository(join(workspaceRoot, "node_modules", "ignored"));

    const defaultResult = await discoverWorkspaceGitRepositories(workspaceRoot);
    const shallowResult = await discoverWorkspaceGitRepositories(workspaceRoot, {
      maxDepth: 1,
    });

    expect(
      defaultResult.repositories.map((repository) => repository.workspacePath),
    ).toEqual(["group/api"]);
    expect(shallowResult.repositories).toEqual([]);
  });
});
