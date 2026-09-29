import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRalphRunWorktree } from "./ralph-run-worktree.helper.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    ),
  );
});

const createRepository = async (): Promise<{
  root: string;
  repository: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "ralph-isolated-runs-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "ralph@example.invalid"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "RALPH Test"], {
    cwd: repository,
  });
  await writeFile(join(repository, "source.txt"), "original\n");
  execFileSync("git", ["add", "source.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });
  return { root, repository };
};

describe("RALPH run worktrees", () => {
  it("creates independent worktrees for simultaneous runs and reuses one on resume", async () => {
    const { repository } = await createRepository();
    const firstDirectory = join(
      repository,
      ".machdoch",
      "ralph",
      "runs",
      "first",
    );
    const secondDirectory = join(
      repository,
      ".machdoch",
      "ralph",
      "runs",
      "second",
    );
    await Promise.all([
      mkdir(firstDirectory, { recursive: true }),
      mkdir(secondDirectory, { recursive: true }),
    ]);

    const [first, second] = await Promise.all([
      prepareRalphRunWorktree(repository, firstDirectory),
      prepareRalphRunWorktree(repository, secondDirectory),
    ]);
    expect(first.worktreeRoot).not.toBe(second.worktreeRoot);
    expect(first.executionWorkspaceRoot).toBe(first.worktreeRoot);
    await writeFile(
      join(first.executionWorkspaceRoot, "source.txt"),
      "first\n",
    );
    await writeFile(
      join(second.executionWorkspaceRoot, "source.txt"),
      "second\n",
    );
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(
      await readFile(join(first.executionWorkspaceRoot, "source.txt"), "utf8"),
    ).toBe("first\n");
    expect(
      await readFile(join(second.executionWorkspaceRoot, "source.txt"), "utf8"),
    ).toBe("second\n");
    expect(await prepareRalphRunWorktree(repository, firstDirectory)).toEqual(
      first,
    );
    await writeFile(
      join(firstDirectory, "workspace-isolation.json"),
      JSON.stringify(second),
    );
    await expect(
      prepareRalphRunWorktree(repository, firstDirectory),
    ).rejects.toThrow(/metadata does not match this run/u);
  }, 60_000);

  it("refuses to omit uncommitted source changes", async () => {
    const { repository } = await createRepository();
    const runDirectory = join(
      repository,
      ".machdoch",
      "ralph",
      "runs",
      "dirty",
    );
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(repository, "source.txt"), "changed\n");

    await expect(
      prepareRalphRunWorktree(repository, runDirectory),
    ).rejects.toThrow(/Commit or stash workspace changes/u);
  }, 60_000);
});
