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
import { integrateRalphRunWorktree } from "./ralph-run-integration.helper.js";
import { prepareRalphRunWorktree } from "./ralph-run-worktree.helper.js";
import {
  commitRalphSnapshot,
  snapshotRalphWorktree,
} from "./ralph-worktree-git.helper.js";
import * as atomicWrites from "./write-file-atomically.helper.js";

const roots: string[] = [];
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    ),
  );
}, 60_000);

const createRun = async (source = "original\n") => {
  const root = await mkdtemp(join(tmpdir(), "ralph-merge-edge-"));
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, "init", "-q");
  await appendFile(
    join(repository, ".git", "config"),
    "\n[user]\nname = Test\nemail = test@example.invalid\n[core]\nautocrlf = false\n",
  );
  await writeFile(join(repository, "source.txt"), source);
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 2]));
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  const directory = join(repository, ".machdoch", "ralph", "runs", "edge");
  await mkdir(directory, { recursive: true });
  const worktree = await prepareRalphRunWorktree(repository, directory);
  return { repository, directory, worktree };
};

const noVerification = async (): Promise<void> => undefined;
const noRepair = async (): Promise<void> => {
  throw new Error("Unexpected repair");
};

describe("RALPH merge edge cases", () => {
  it("preserves non-UTF-8 text bytes during publication and synchronization", async () => {
    const { repository, directory, worktree } = await createRun();
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await writeFile(join(worktree.worktreeRoot, "source.txt"), bytes);
    await writeFile(join(repository, "external.txt"), bytes);
    await integrateRalphRunWorktree(worktree, directory, {
      verify: noVerification,
      repair: noRepair,
    });
    expect(await readFile(join(repository, "source.txt"))).toEqual(bytes);
    expect(await readFile(join(worktree.worktreeRoot, "external.txt"))).toEqual(
      bytes,
    );
  }, 90_000);

  it("publishes with customized Git diff formatting", async () => {
    const { repository, directory, worktree } = await createRun(
      "first\nsecond\nthird\nfourth\nlast\n",
    );
    git(repository, "config", "diff.noprefix", "true");
    git(repository, "config", "diff.srcPrefix", "old/");
    git(repository, "config", "diff.dstPrefix", "new/");
    git(repository, "config", "diff.context", "0");
    git(repository, "config", "color.ui", "always");
    const contents = "first\nsecond\ncandidate\nfourth\nlast\n";
    await writeFile(join(worktree.worktreeRoot, "source.txt"), contents);
    await integrateRalphRunWorktree(worktree, directory, {
      verify: noVerification,
      repair: noRepair,
    });
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      contents,
    );
  }, 90_000);

  it("does not accept an untouched binary conflict as a successful repair", async () => {
    const { repository, directory, worktree } = await createRun();
    const source = Buffer.from([0, 3, 4]);
    const candidate = Buffer.from([0, 5, 6]);
    await writeFile(join(repository, "binary.bin"), source);
    await writeFile(join(worktree.worktreeRoot, "binary.bin"), candidate);
    const verify = vi.fn(noVerification);
    await expect(
      integrateRalphRunWorktree(worktree, directory, {
        verify,
        repair: noVerification,
      }),
    ).rejects.toThrow("exhausted its repair attempts");
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(join(repository, "binary.bin"))).toEqual(source);
    expect(await readFile(join(worktree.worktreeRoot, "binary.bin"))).toEqual(
      candidate,
    );
  }, 90_000);

  it("rebuilds and verifies when the run changes during verification", async () => {
    const { repository, directory, worktree } = await createRun();
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    let checks = 0;
    await integrateRalphRunWorktree(worktree, directory, {
      repair: noRepair,
      verify: async (candidate) => {
        checks += 1;
        if (checks === 1) {
          await writeFile(
            join(worktree.worktreeRoot, "later.txt"),
            "later run edit\n",
          );
        } else {
          expect(await readFile(join(candidate, "later.txt"), "utf8")).toBe(
            "later run edit\n",
          );
        }
      },
    });
    expect(checks).toBe(2);
    expect(await readFile(join(repository, "later.txt"), "utf8")).toBe(
      "later run edit\n",
    );
  }, 90_000);

  it.each(["replace", "stage"])(
    "accepts a binary conflict resolved by %s",
    async (resolution) => {
      const { repository, directory, worktree } = await createRun();
      const source = Buffer.from([0, 3, 4]);
      const resolved = resolution === "stage" ? source : Buffer.from([0, 7, 8]);
      await writeFile(join(repository, "binary.bin"), source);
      await writeFile(
        join(worktree.worktreeRoot, "binary.bin"),
        Buffer.from([0, 5, 6]),
      );
      const verify = vi.fn(async (candidate: string) => {
        expect(await readFile(join(candidate, "binary.bin"))).toEqual(resolved);
      });
      await integrateRalphRunWorktree(worktree, directory, {
        verify,
        repair: async (candidate) => {
          if (resolution === "stage") git(candidate, "add", "binary.bin");
          else await writeFile(join(candidate, "binary.bin"), resolved);
        },
      });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await readFile(join(repository, "binary.bin"))).toEqual(resolved);
    },
    90_000,
  );

  it("preserves an unresolved text conflict when a repair leaves the markers", async () => {
    const { repository, directory, worktree } = await createRun();
    await writeFile(join(repository, "source.txt"), "source\n");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    const verify = vi.fn(noVerification);
    await expect(
      integrateRalphRunWorktree(worktree, directory, {
        verify,
        repair: noVerification,
      }),
    ).rejects.toThrow("exhausted its repair attempts");
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "source\n",
    );
  }, 90_000);

  it("publishes renames and file-to-directory replacements", async () => {
    const { repository, directory, worktree } = await createRun();
    await rm(join(worktree.worktreeRoot, "source.txt"));
    await mkdir(join(worktree.worktreeRoot, "source.txt"));
    await writeFile(
      join(worktree.worktreeRoot, "source.txt", "child.txt"),
      "replacement\n",
    );
    await writeFile(
      join(worktree.worktreeRoot, " renamed file.txt"),
      Buffer.from([0, 1, 2]),
    );
    await rm(join(worktree.worktreeRoot, "binary.bin"));
    const result = await integrateRalphRunWorktree(worktree, directory, {
      verify: noVerification,
      repair: noRepair,
    });
    expect(result.changedPaths).toEqual([
      " renamed file.txt",
      "binary.bin",
      "source.txt",
      "source.txt/child.txt",
    ]);
    expect(
      await readFile(join(repository, "source.txt", "child.txt"), "utf8"),
    ).toBe("replacement\n");
    expect(await readFile(join(repository, " renamed file.txt"))).toEqual(
      Buffer.from([0, 1, 2]),
    );
  }, 90_000);

  it.each([false, true])(
    "validates run changes before replaying a pending publication with callbackEdit=%s",
    async (callbackEdit) => {
      const { repository, directory, worktree } = await createRun();
      const sourceTree = await snapshotRalphWorktree(repository);
      await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
      const mergedTree = await snapshotRalphWorktree(worktree.worktreeRoot);
      const mergedCommit = await commitRalphSnapshot(repository, mergedTree, [
        worktree.baseCommit,
      ]);
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
            result: {
              status: "merged",
              mergedAt: new Date().toISOString(),
              changedPaths: ["source.txt"],
            },
          },
        }),
      );
      const editRun = async () => {
        await writeFile(join(worktree.worktreeRoot, "later.txt"), "new work\n");
      };
      if (!callbackEdit) await editRun();
      await expect(
        integrateRalphRunWorktree(worktree, directory, {
          verify: noVerification,
          repair: noRepair,
          ...(callbackEdit ? { beforePublish: editRun } : {}),
        }),
      ).rejects.toThrow("run files changed");
      expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
        "original\n",
      );
      expect(
        await readFile(join(worktree.worktreeRoot, "later.txt"), "utf8"),
      ).toBe("new work\n");
    },
    90_000,
  );

  it("stops after cancellation during a successful repair", async () => {
    const { repository, directory, worktree } = await createRun();
    await writeFile(join(repository, "source.txt"), "source\n");
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    const controller = new AbortController();
    const verify = vi.fn(noVerification);
    await expect(
      integrateRalphRunWorktree(worktree, directory, {
        signal: controller.signal,
        verify,
        repair: async (candidate) => {
          await writeFile(join(candidate, "source.txt"), "resolved\n");
          controller.abort(new Error("Stopped repair"));
        },
      }),
    ).rejects.toThrow("Stopped repair");
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(join(repository, "source.txt"), "utf8")).toBe(
      "source\n",
    );
  }, 90_000);

  it("reverifies run edits made by the publication callback", async () => {
    const { repository, directory, worktree } = await createRun();
    await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
    let checks = 0;
    await integrateRalphRunWorktree(worktree, directory, {
      repair: noRepair,
      verify: async (candidate) => {
        checks += 1;
        if (checks > 1)
          expect(await readFile(join(candidate, "later.txt"), "utf8")).toBe(
            "new work\n",
          );
      },
      beforePublish: async () => {
        await writeFile(join(worktree.worktreeRoot, "later.txt"), "new work\n");
      },
    });
    expect(checks).toBe(2);
    expect(await readFile(join(repository, "later.txt"), "utf8")).toBe(
      "new work\n",
    );
  }, 90_000);

  it.each(["source", "run"])(
    "rebuilds when the %s changes while the publication journal is saved",
    async (target) => {
      const { repository, directory, worktree } = await createRun();
      await writeFile(join(worktree.worktreeRoot, "source.txt"), "candidate\n");
      const writeJson = atomicWrites.writeJsonAtomically;
      let edited = false;
      const journalWrite = vi
        .spyOn(atomicWrites, "writeJsonAtomically")
        .mockImplementation(async (path, value, options) => {
          await writeJson(path, value, options);
          if (
            !edited &&
            path === join(directory, "workspace-integration.json") &&
            typeof value === "object" &&
            value !== null &&
            "pending" in value
          ) {
            edited = true;
            await writeFile(
              join(
                target === "source" ? repository : worktree.worktreeRoot,
                "later.txt",
              ),
              "journal race\n",
            );
          }
        });
      let checks = 0;
      try {
        await integrateRalphRunWorktree(worktree, directory, {
          repair: noRepair,
          verify: async (candidate) => {
            checks += 1;
            if (checks > 1)
              expect(await readFile(join(candidate, "later.txt"), "utf8")).toBe(
                "journal race\n",
              );
          },
        });
      } finally {
        journalWrite.mockRestore();
      }
      expect(checks).toBe(2);
      expect(await readFile(join(repository, "later.txt"), "utf8")).toBe(
        "journal race\n",
      );
      expect(
        await readFile(join(worktree.worktreeRoot, "later.txt"), "utf8"),
      ).toBe("journal race\n");
    },
    90_000,
  );
});
