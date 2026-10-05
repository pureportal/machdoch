import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integrateRalphRunWorktree } from "./ralph-run-integration.helper.js";
import { prepareRalphRunWorktree } from "./ralph-run-worktree.helper.js";
import {
  commitRalphSnapshot,
  snapshotRalphWorktree,
} from "./ralph-worktree-git.helper.js";

const temporaryRoots: string[] = [];
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();

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
}, 60_000);

const createRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-integration-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.name", "RALPH Test");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "core.autocrlf", "false");
  await writeFile(join(repository, "source.txt"), "original\n");
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(repository, "deleted.txt"), "delete me\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  const createRun = async (id: string, workspace = repository) => {
    const directory = join(workspace, ".machdoch", "ralph", "runs", id);
    await mkdir(directory, { recursive: true });
    return {
      directory,
      worktree: await prepareRalphRunWorktree(workspace, directory),
    };
  };
  return { repository, createRun };
};

const noRepair = async (): Promise<void> => {
  throw new Error("Unexpected repair");
};
const noVerification = async (): Promise<void> => undefined;

describe("automatic RALPH integration", () => {
  it("integrates while ignored runtime data exists in the verification candidate", async () => {
    const { repository, createRun } = await createRepository();
    await writeFile(join(repository, ".gitignore"), ".machdoch\n");
    git(repository, "add", ".gitignore");
    git(repository, "commit", "-qm", "ignore runtime data");
    const { directory, worktree } = await createRun("ignored-runtime");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    const verify = vi.fn(async (candidate: string) => {
      await mkdir(join(candidate, ".machdoch"), { recursive: true });
      await writeFile(join(candidate, ".machdoch", "private.json"), "{}");
      await mkdir(join(candidate, "nested"), { recursive: true });
      await writeFile(join(candidate, "nested", ".machdoch"), "private");
    });

    const result = await integrateRalphRunWorktree(worktree, directory, {
      verify,
      repair: noRepair,
    });

    expect(result).toMatchObject({
      status: "merged",
      changedPaths: ["source.txt"],
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "candidate\n",
    );
    await expect(
      readFile(join(repository, "nested", ".machdoch")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(
        join(
          repository,
          ".machdoch",
          "ralph",
          "runs",
          "ignored-runtime",
          "workspace-isolation.json",
        ),
        "utf8",
      ),
    ).toContain(worktree.branch);
  }, 90_000);

  it("merges source files using Windows line endings", async () => {
    const { repository, createRun } = await createRepository();
    git(repository, "config", "core.autocrlf", "true");
    await writeFile(join(repository, "source.txt"), "original\r\n");
    const { directory, worktree } = await createRun("windows-line-endings");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\r\n");
    await integrateRalphRunWorktree(worktree, directory, {
      verify: noVerification,
      repair: noRepair,
    });
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "candidate\r\n",
    );
  }, 90_000);

  it("serializes parallel merges and preserves source edits, staging, binary changes and deletions", async () => {
    const { repository, createRun } = await createRepository();
    await writeFile(join(repository, "source.txt"), "staged\n");
    git(repository, "add", "source.txt");
    await writeFile(join(repository, "source.txt"), "local edit\n");
    const staged = git(repository, "diff", "--cached", "--binary");
    const head = git(repository, "rev-parse", "HEAD");
    const [first, second] = await Promise.all([
      createRun("first"),
      createRun("second"),
    ]);
    await writeFile(join(first.worktree.worktreeRoot, "first.txt"), "first\n");
    await writeFile(
      join(first.worktree.worktreeRoot, "binary.bin"),
      Buffer.from([0, 255, 3]),
    );
    await rm(join(first.worktree.worktreeRoot, "deleted.txt"));
    await writeFile(
      join(second.worktree.worktreeRoot, "second.txt"),
      "second\n",
    );
    await mkdir(join(second.worktree.worktreeRoot, ".machdoch"));
    await writeFile(
      join(second.worktree.worktreeRoot, ".machdoch", "private.json"),
      "{}",
    );
    let activeVerifications = 0;
    let maximumVerifications = 0;
    const verify = async () => {
      activeVerifications += 1;
      maximumVerifications = Math.max(
        maximumVerifications,
        activeVerifications,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      activeVerifications -= 1;
    };
    const results = await Promise.all(
      [first, second].map(({ worktree, directory }) =>
        integrateRalphRunWorktree(worktree, directory, {
          verify,
          repair: noRepair,
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      "merged",
      "merged",
    ]);
    expect(maximumVerifications).toBe(1);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "local edit\n",
    );
    expect(await readFile(join(repository, "first.txt"), "utf8")).toBe(
      "first\n",
    );
    expect(await readFile(join(repository, "second.txt"), "utf8")).toBe(
      "second\n",
    );
    expect(await readFile(join(repository, "binary.bin"))).toEqual(
      Buffer.from([0, 255, 3]),
    );
    await expect(
      readFile(join(repository, "deleted.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(repository, ".machdoch", "private.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(repository, "diff", "--cached", "--binary")).toBe(staged);
    expect(git(repository, "rev-parse", "HEAD")).toBe(head);
  }, 90_000);

  it("repairs merge conflicts autonomously and verifies before publishing", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("conflict");
    await writeFile(join(repository, "source.txt"), "source change\n");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "run change\n");
    const repair = vi.fn(async (candidate: string, reason: string) => {
      expect(reason).toContain("merge conflicts");
      expect(candidate).not.toBe(repository);
      expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
        "source change\n",
      );
      expect(await readFile(join(candidate, "source.txt"), "utf8")).toContain(
        "<<<<<<<",
      );
      await writeFile(
        join(candidate, "source.txt"),
        "source change and run change\n",
      );
    });
    const verify = vi.fn(async (candidate: string) => {
      expect(await readFile(join(candidate, "source.txt"), "utf8")).toBe(
        "source change and run change\n",
      );
    });
    const result = await integrateRalphRunWorktree(worktree, directory, {
      repair,
      verify,
    });
    expect(result).toMatchObject({
      status: "merged",
      changedPaths: ["source.txt"],
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "source change and run change\n",
    );
    expect(
      await readFile(join(worktree.worktreeRoot, "source.txt"), "utf8"),
    ).toBe("source change and run change\n");
    expect(git(repository, "worktree", "list", "--porcelain")).not.toContain(
      `${worktree.worktreeRoot.replace(/\\/gu, "/")}-integration-`,
    );
  }, 90_000);

  it("rechecks a candidate changed by verification before publishing it", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("changed-verification");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    let checks = 0;
    const verify = async (candidate: string) => {
      checks += 1;
      if (checks === 1)
        await writeFile(join(candidate, "source.txt"), "generated change\n");
    };
    const repair = vi.fn(async (_candidate: string, reason: string) => {
      expect(reason).toContain("Verification changed the candidate files");
    });
    await integrateRalphRunWorktree(worktree, directory, { verify, repair });
    expect(checks).toBe(2);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "generated change\n",
    );
  }, 90_000);

  it("keeps failed candidates out of the source and retains run changes for retry", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("failed");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    const repair = vi.fn(noVerification);
    await expect(
      integrateRalphRunWorktree(worktree, directory, {
        verify: async () => {
          throw new Error("Checks failed");
        },
        repair,
      }),
    ).rejects.toThrow("exhausted its repair attempts");
    expect(repair).toHaveBeenCalledTimes(2);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(
      await readFile(join(worktree.worktreeRoot, "source.txt"), "utf8"),
    ).toBe("candidate\n");
    expect(git(repository, "worktree", "list", "--porcelain")).not.toContain(
      `${worktree.worktreeRoot.replace(/\\/gu, "/")}-integration-`,
    );
    const result = await integrateRalphRunWorktree(worktree, directory, {
      verify: noVerification,
      repair: noRepair,
    });
    expect(result.status).toBe("merged");
  }, 90_000);

  it("merges successive continuous tasks using the last merged baseline", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("continuous");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "first task\n");
    const options = { verify: noVerification, repair: noRepair };
    const first = await integrateRalphRunWorktree(worktree, directory, options);
    await writeFile(join(repository, "external.txt"), "later source edit\n");
    await writeFile(join(worktree.worktreeRoot, "next.txt"), "second task\n");
    const second = await integrateRalphRunWorktree(
      worktree,
      directory,
      options,
    );
    expect(first.changedPaths).toEqual(["source.txt"]);
    expect(second.changedPaths).toEqual(["next.txt"]);
    expect(
      await readFile(join(worktree.worktreeRoot, "external.txt"), "utf8"),
    ).toBe("later source edit\n");
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "first task\n",
    );
    expect(
      await integrateRalphRunWorktree(worktree, directory, options),
    ).toEqual(second);
  }, 90_000);

  it("rebuilds and verifies against source edits made while verification runs", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("source-race");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    let checks = 0;
    await integrateRalphRunWorktree(worktree, directory, {
      repair: noRepair,
      verify: async (candidate) => {
        checks += 1;
        if (checks === 1)
          await writeFile(join(repository, "later.txt"), "external edit\n");
        else
          expect(await readFile(join(candidate, "later.txt"), "utf8")).toBe(
            "external edit\n",
          );
      },
    });
    expect(checks).toBe(2);
    expect(await readFile(join(repository, "later.txt"), "utf8")).toBe(
      "external edit\n",
    );
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "candidate\n",
    );
  }, 90_000);

  it.each([
    { published: false, sourceChanged: false },
    { published: true, sourceChanged: false },
    { published: false, sourceChanged: true },
    { published: true, sourceChanged: true },
  ])(
    "recovers a journaled integration after publication=$published with sourceChanged=$sourceChanged",
    async ({ published, sourceChanged }) => {
      const { repository, createRun } = await createRepository();
      const { directory, worktree } = await createRun(
        `interrupted-${published}`,
      );
      const sourceTree = await snapshotRalphWorktree(repository);
      await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
      const mergedTree = await snapshotRalphWorktree(worktree.worktreeRoot);
      const mergedCommit = await commitRalphSnapshot(repository, mergedTree, [
        worktree.baseCommit,
      ]);
      const result = {
        status: "merged",
        mergedAt: new Date().toISOString(),
        changedPaths: ["source.txt"],
      };
      await writeFile(
        join(directory, "workspace-integration.json"),
        JSON.stringify({
          baseCommit: worktree.baseCommit,
          pending: {
            sourceHead: git(repository, "rev-parse", "HEAD"),
            sourceTree,
            runTree: mergedTree,
            mergedTree,
            mergedCommit,
            result,
          },
        }),
      );
      if (published)
        await writeFile(join(repository, "source.txt"), "candidate\n");
      if (sourceChanged) {
        await writeFile(join(repository, "later.txt"), "later source edit\n");
        git(repository, "add", "later.txt");
        git(repository, "commit", "-qm", "later source edit");
      }
      const verify = vi.fn(noVerification);
      const recovered = await integrateRalphRunWorktree(worktree, directory, {
        verify,
        repair: noRepair,
      });
      expect(recovered.status).toBe("merged");
      expect(verify).toHaveBeenCalledTimes(sourceChanged ? 1 : 0);
      if (!sourceChanged) expect(recovered).toEqual(result);
      else
        expect(
          await readFile(join(worktree.worktreeRoot, "later.txt"), "utf8"),
        ).toBe("later source edit\n");
      expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
        "candidate\n",
      );
      const state = JSON.parse(
        await readFile(join(directory, "workspace-integration.json"), "utf8"),
      );
      expect(state.pending).toBeUndefined();
      if (!sourceChanged) expect(state.baseCommit).toBe(mergedCommit);
      expect(
        await integrateRalphRunWorktree(worktree, directory, {
          verify,
          repair: noRepair,
        }),
      ).toEqual(recovered);
    },
    90_000,
  );

  it("removes an interrupted detached candidate before retrying", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("orphaned-candidate");
    const candidate = `${worktree.worktreeRoot}-integration-0`;
    git(repository, "worktree", "add", "--detach", candidate, "HEAD");
    await writeFile(join(candidate, "source.txt"), "interrupted repair\n");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    await integrateRalphRunWorktree(worktree, directory, {
      verify: noVerification,
      repair: noRepair,
    });
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "candidate\n",
    );
    expect(git(repository, "worktree", "list", "--porcelain")).not.toContain(
      `${worktree.worktreeRoot.replace(/\\/gu, "/")}-integration-`,
    );
  }, 90_000);

  it("rejects changes outside a nested workspace", async () => {
    const { repository, createRun } = await createRepository();
    const project = join(repository, "project");
    await mkdir(project);
    await writeFile(join(project, "project.txt"), "project\n");
    const { directory, worktree } = await createRun("nested", project);
    await writeFile(
      join(worktree.worktreeRoot, "source.txt"),
      "outside workspace\n",
    );
    await expect(
      integrateRalphRunWorktree(worktree, directory, {
        verify: noVerification,
        repair: noRepair,
      }),
    ).rejects.toThrow("inside the active workspace");
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "original\n",
    );
  }, 90_000);

  it("rejects a source branch switch", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("branch-switch");
    git(repository, "switch", "-qc", "other");
    await expect(
      integrateRalphRunWorktree(worktree, directory, {
        verify: noVerification,
        repair: noRepair,
      }),
    ).rejects.toThrow("source branch changed");
  }, 90_000);

  it("stops an aborted verification without publishing or attempting repairs", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("aborted");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    const controller = new AbortController();
    const repair = vi.fn(noRepair);
    await expect(
      integrateRalphRunWorktree(worktree, directory, {
        signal: controller.signal,
        repair,
        verify: async () => {
          controller.abort(new Error("Stopped integration"));
          controller.signal.throwIfAborted();
        },
      }),
    ).rejects.toThrow("Stopped integration");
    expect(repair).not.toHaveBeenCalled();
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "original\n",
    );
  }, 90_000);

  it("retries a failed model repair and publishes after a successful repair and verification", async () => {
    const { repository, createRun } = await createRepository();
    const { directory, worktree } = await createRun("repair-retry");
    await writeFile(join(repository, "source.txt"), "source change\n");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "run change\n");
    let repairs = 0;
    await integrateRalphRunWorktree(worktree, directory, {
      repair: async (candidate) => {
        repairs += 1;
        if (repairs === 1) throw new Error("Temporary model failure");
        await writeFile(
          join(candidate, "source.txt"),
          "source change and run change\n",
        );
      },
      verify: noVerification,
    });
    expect(repairs).toBe(2);
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "source change and run change\n",
    );
  }, 90_000);
});
