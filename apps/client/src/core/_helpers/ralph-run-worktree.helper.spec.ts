import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRalphRunWorktree } from "./ralph-run-worktree.helper.js";
import * as worktreeGit from "./ralph-worktree-git.helper.js";

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
  await appendFile(
    join(repository, ".git", "config"),
    "\n[user]\nname = RALPH Test\nemail = ralph@example.invalid\n[core]\nautocrlf = false\n",
  );
  await writeFile(join(repository, "source.txt"), "original\n");
  execFileSync("git", ["add", "source.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });
  return { root, repository };
};

describe("RALPH run worktrees", () => {
  it("removes its interrupted checkout and automatically retries preparation", async () => {
    const { repository } = await createRepository();
    const runDirectory = join(
      repository,
      ".machdoch",
      "ralph",
      "runs",
      "interrupted",
    );
    await mkdir(runDirectory, { recursive: true });
    const runGit = worktreeGit.runRalphWorktreeGit;
    let interruptedRoot = "";
    let interruptedBranch = "";
    let interruptCheckout = true;
    vi.spyOn(worktreeGit, "runRalphWorktreeGit").mockImplementation(
      async (cwd, args, options) => {
        if (interruptCheckout && args[0] === "worktree" && args[1] === "add") {
          interruptCheckout = false;
          interruptedRoot = args[2]!;
          interruptedBranch = args[3]!;
          await runGit(cwd, [
            "worktree",
            "add",
            "--no-checkout",
            interruptedRoot,
            interruptedBranch,
          ]);
          await runGit(cwd, [
            "worktree",
            "lock",
            "--reason",
            "initializing",
            interruptedRoot,
          ]);
          throw new Error("Git checkout timed out");
        }
        return runGit(cwd, args, options);
      },
    );

    const worktree = await prepareRalphRunWorktree(repository, runDirectory);
    expect(interruptCheckout).toBe(false);
    expect(worktree.branch).toBe(interruptedBranch);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "original\n",
    );

    expect(worktree.worktreeRoot).toBe(interruptedRoot);
    expect(
      await readFile(
        join(worktree.executionWorkspaceRoot, "source.txt"),
        "utf8",
      ),
    ).toBe("original\n");
  }, 240_000);

  it("bounds preparation retries and removes every failed owned checkout", async () => {
    const { repository } = await createRepository();
    const runDirectory = join(
      repository,
      ".machdoch",
      "ralph",
      "runs",
      "timeout",
    );
    await mkdir(runDirectory, { recursive: true });
    const runGit = worktreeGit.runRalphWorktreeGit;
    let attempts = 0;
    let branch = "";
    vi.spyOn(worktreeGit, "runRalphWorktreeGit").mockImplementation(
      async (cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "add") {
          attempts += 1;
          branch = args[3]!;
          throw new Error("Git checkout timed out");
        }
        return runGit(cwd, args, options);
      },
    );

    await expect(
      prepareRalphRunWorktree(repository, runDirectory),
    ).rejects.toThrow("Git checkout timed out");
    expect(attempts).toBe(3);
    expect(await runGit(repository, ["branch", "--list", branch])).toBe("");
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "original\n",
    );
  }, 240_000);

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
  }, 240_000);

  it("snapshots staged, unstaged, untracked, binary and deleted files without changing the source or index", async () => {
    const { repository } = await createRepository();
    const runDirectory = join(
      repository,
      ".machdoch",
      "ralph",
      "runs",
      "dirty",
    );
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(repository, "deleted.txt"), "delete me\n");
    await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 2]));
    execFileSync("git", ["add", "deleted.txt", "binary.bin"], {
      cwd: repository,
    });
    execFileSync("git", ["commit", "-qm", "fixtures"], { cwd: repository });
    await writeFile(join(repository, "source.txt"), "staged\n");
    execFileSync("git", ["add", "source.txt"], { cwd: repository });
    await writeFile(join(repository, "source.txt"), "unstaged\n");
    await writeFile(join(repository, "binary.bin"), Buffer.from([0, 3, 255]));
    await rm(join(repository, "deleted.txt"));
    await mkdir(join(repository, "new files"));
    await writeFile(
      join(repository, "new files", " new file.txt"),
      "untracked\n",
    );
    const stagedBefore = execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: repository,
    });
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
    });

    const worktree = await prepareRalphRunWorktree(repository, runDirectory);

    expect(
      await readFile(
        join(worktree.executionWorkspaceRoot, "source.txt"),
        "utf8",
      ),
    ).toBe("unstaged\n");
    expect(
      await readFile(join(worktree.executionWorkspaceRoot, "binary.bin")),
    ).toEqual(Buffer.from([0, 3, 255]));
    expect(
      await readFile(
        join(worktree.executionWorkspaceRoot, "new files", " new file.txt"),
        "utf8",
      ),
    ).toBe("untracked\n");
    await expect(
      readFile(join(worktree.executionWorkspaceRoot, "deleted.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(
          worktree.executionWorkspaceRoot,
          ".machdoch",
          "ralph",
          "runs",
          "dirty",
          "workspace-isolation.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      execFileSync("git", ["diff", "--cached", "--binary"], {
        cwd: repository,
      }),
    ).toEqual(stagedBefore);
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository }),
    ).toEqual(headBefore);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "unstaged\n",
    );
    await writeFile(join(repository, "source.txt"), "later source edit\n");
    expect(await prepareRalphRunWorktree(repository, runDirectory)).toEqual(
      worktree,
    );
    expect(
      await readFile(
        join(worktree.executionWorkspaceRoot, "source.txt"),
        "utf8",
      ),
    ).toBe("unstaged\n");
  }, 240_000);

  it("preserves a workspace nested in the repository", async () => {
    const { repository } = await createRepository();
    const workspace = join(repository, "project");
    await mkdir(workspace);
    await writeFile(join(workspace, "file.txt"), "project\n");
    const runDirectory = join(
      workspace,
      ".machdoch",
      "ralph",
      "runs",
      "nested",
    );
    await mkdir(runDirectory, { recursive: true });

    const worktree = await prepareRalphRunWorktree(workspace, runDirectory);

    expect(worktree.executionWorkspaceRoot).toBe(
      join(worktree.worktreeRoot, "project"),
    );
    expect(
      await readFile(join(worktree.executionWorkspaceRoot, "file.txt"), "utf8"),
    ).toBe("project\n");
    expect(await prepareRalphRunWorktree(workspace, runDirectory)).toEqual(
      worktree,
    );
  }, 240_000);

  it("reports a missing Git repository without starting a shared run", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-without-git-"));
    temporaryRoots.push(root);
    const runDirectory = join(
      root,
      ".machdoch",
      "ralph",
      "runs",
      "missing-git",
    );
    await mkdir(runDirectory, { recursive: true });

    await expect(prepareRalphRunWorktree(root, runDirectory)).rejects.toThrow(
      /not a git repository/iu,
    );
  }, 240_000);
});
