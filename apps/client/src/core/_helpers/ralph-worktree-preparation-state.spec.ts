import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commands from "./ralph-worktree-git.helper.js";
import {
  prepareRalphRunWorktree,
  type RalphRunWorktree,
} from "./ralph-run-worktree.helper.js";

const roots: string[] = [];
const createInterruptedRun = async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-worktree-state-"));
  roots.push(root);
  const repository = join(root, "repository");
  const directory = join(
    repository,
    ".machdoch",
    "ralph",
    "runs",
    "interrupted",
  );
  await mkdir(directory, { recursive: true });
  await mkdir(join(repository, ".git"));
  const key = createHash("sha256")
    .update(resolve(directory))
    .digest("hex")
    .slice(0, 20);
  const worktreeRoot = join(
    dirname(repository),
    ".machdoch-ralph-worktrees",
    key,
  );
  const worktree: RalphRunWorktree = {
    sourceWorkspaceRoot: repository,
    repositoryRoot: repository,
    executionWorkspaceRoot: worktreeRoot,
    worktreeRoot,
    branch: `ralph/${key}`,
    sourceBranch: "main",
    baseCommit: "a".repeat(40),
  };
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(worktreeRoot, "preserved.txt"), "owned candidate");
  const marker = join(directory, "workspace-preparation.json");
  await writeFile(marker, JSON.stringify(worktree));
  vi.spyOn(commands, "snapshotRalphWorktree").mockResolvedValue("b".repeat(40));
  vi.spyOn(commands, "commitRalphSnapshot").mockResolvedValue("b".repeat(40));
  let registered = true;
  let branch = worktree.branch;
  let branchHead = worktree.baseCommit;
  const git = vi
    .spyOn(commands, "runRalphWorktreeGit")
    .mockImplementation(async (cwd, args) => {
      if (args[0] === "rev-parse") {
        if (args.includes("--show-toplevel")) return repository;
        if (args.includes("--git-common-dir")) return join(repository, ".git");
        return worktree.baseCommit;
      }
      if (args[0] === "branch" && args[1] === "--show-current")
        return cwd === repository ? "main" : branch;
      if (args[0] === "branch" && args[1] === "-D") {
        branchHead = "";
        return "";
      }
      if (args[0] === "branch") {
        branchHead = worktree.baseCommit;
        return "";
      }
      if (args[0] === "for-each-ref")
        return args.includes("--format=%(objectname)")
          ? branchHead
          : branchHead
            ? `refs/heads/${worktree.branch}`
            : "";
      if (args[0] === "worktree" && args[1] === "list")
        return registered
          ? `worktree ${worktreeRoot.replace(/\\/gu, "/")}\0branch refs/heads/${branch}\0locked initializing\0\0`
          : "";
      if (args[0] === "worktree" && args[1] === "remove") {
        registered = false;
        await rm(worktreeRoot, { recursive: true, force: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "add") {
        registered = true;
        await mkdir(worktreeRoot, { recursive: true });
        return "";
      }
      if (args[0] === "write-tree" || args[0] === "commit-tree")
        return "b".repeat(40);
      return "";
    });
  return {
    repository,
    directory,
    worktreeRoot,
    marker,
    git,
    setRegistered: (value: boolean) => {
      registered = value;
    },
    setBranch: (value: string) => {
      branch = value;
    },
    setBranchHead: (value: string) => {
      branchHead = value;
    },
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RALPH interrupted preparation ownership", () => {
  it("reconciles its registered locked checkout before allocating a new one", async () => {
    const { repository, directory, marker, git } = await createInterruptedRun();
    const worktree = await prepareRalphRunWorktree(repository, directory);
    const calls = git.mock.calls.map(([, args]) => args);
    const removal = calls.findIndex(
      (args) => args[0] === "worktree" && args[1] === "remove",
    );
    const allocation = calls.findIndex(
      (args) => args[0] === "worktree" && args[1] === "add",
    );
    expect(removal).toBeGreaterThan(0);
    expect(allocation).toBeGreaterThan(removal);
    expect(calls[removal]).toContain("--force");
    expect(calls[removal]!.filter((arg) => arg === "--force")).toHaveLength(2);
    expect(
      JSON.parse(
        await readFile(join(directory, "workspace-isolation.json"), "utf8"),
      ),
    ).toEqual(worktree);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an unregistered filesystem candidate", async () => {
    const { repository, directory, worktreeRoot, git, setRegistered } =
      await createInterruptedRun();
    setRegistered(false);
    await expect(
      prepareRalphRunWorktree(repository, directory),
    ).rejects.toThrow("without ownership metadata");
    expect(await readFile(join(worktreeRoot, "preserved.txt"), "utf8")).toBe(
      "owned candidate",
    );
    expect(
      git.mock.calls.some(
        ([, args]) => args[0] === "worktree" && args[1] === "remove",
      ),
    ).toBe(false);
    expect(
      git.mock.calls.some(
        ([, args]) => args[0] === "branch" && args[1] === "-D",
      ),
    ).toBe(false);
  });

  it("preserves a candidate assigned to a foreign branch", async () => {
    const { repository, directory, worktreeRoot, git, setBranch } =
      await createInterruptedRun();
    setBranch("foreign");
    await expect(
      prepareRalphRunWorktree(repository, directory),
    ).rejects.toThrow("does not own");
    expect(await readFile(join(worktreeRoot, "preserved.txt"), "utf8")).toBe(
      "owned candidate",
    );
    expect(
      git.mock.calls.some(
        ([, args]) => args[0] === "worktree" && args[1] === "remove",
      ),
    ).toBe(false);
  });

  it("checks a changed branch before removing the checkout", async () => {
    const { repository, directory, worktreeRoot, git, setBranchHead } =
      await createInterruptedRun();
    setBranchHead("c".repeat(40));
    await expect(
      prepareRalphRunWorktree(repository, directory),
    ).rejects.toThrow("branch changed");
    expect(await readFile(join(worktreeRoot, "preserved.txt"), "utf8")).toBe(
      "owned candidate",
    );
    expect(
      git.mock.calls.some(
        ([, args]) => args[0] === "worktree" && args[1] === "remove",
      ),
    ).toBe(false);
  });

  it("rejects preparation metadata for another path", async () => {
    const { repository, directory, marker, git } = await createInterruptedRun();
    const state = JSON.parse(await readFile(marker, "utf8"));
    state.worktreeRoot = repository;
    await writeFile(marker, JSON.stringify(state));
    await expect(
      prepareRalphRunWorktree(repository, directory),
    ).rejects.toThrow("metadata does not match");
    expect(
      git.mock.calls.some(
        ([, args]) => args[0] === "worktree" && args[1] === "remove",
      ),
    ).toBe(false);
  });
});
