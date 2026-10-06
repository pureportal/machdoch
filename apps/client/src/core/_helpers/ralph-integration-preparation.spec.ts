import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrateRalphRunWorktree } from "./ralph-run-integration.helper.js";
import type { RalphRunWorktree } from "./ralph-run-worktree.helper.js";
import {
  runRalphWorktreeGit,
  snapshotRalphWorktree,
} from "./ralph-worktree-git.helper.js";
import { applyRalphTreeDifference } from "./ralph-worktree-patch.helper.js";
import { readRalphIntegrationState } from "./ralph-integration-state.helper.js";

const gitObjects = vi.hoisted(() => ({
  baseCommit: "a".repeat(40),
  sourceHead: "b".repeat(40),
  sourceTree: "c".repeat(40),
  runTree: "d".repeat(40),
  mergedTree: "e".repeat(40),
  baseTree: "f".repeat(40),
  mergedCommit: "1".repeat(40),
}));

vi.mock("./ralph-worktree-git.helper.js", () => ({
  runRalphWorktreeGit: vi.fn(),
  snapshotRalphWorktree: vi.fn(),
  commitRalphSnapshot: vi.fn(async () => gitObjects.mergedCommit),
  stageRalphSourceChanges: vi.fn(),
}));
vi.mock("./ralph-worktree-patch.helper.js", () => ({
  applyRalphTreeDifference: vi.fn(async () => undefined),
}));

const roots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-integration-preparation-"));
  roots.push(root);
  const repository = join(root, "repository");
  const runDirectory = join(repository, ".machdoch", "ralph", "runs", "run");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(repository, "source.txt"), "original\n");
  const worktree: RalphRunWorktree = {
    sourceWorkspaceRoot: repository,
    executionWorkspaceRoot: join(root, "worktree"),
    repositoryRoot: repository,
    worktreeRoot: join(root, "worktree"),
    branch: "ralph/run",
    sourceBranch: "main",
    baseCommit: gitObjects.baseCommit,
  };
  const candidates = new Map<string, "detached" | "branch">();
  const checkouts: string[] = [];
  const removals: string[] = [];
  let prepare: (candidate: string) => Promise<void> = async () => undefined;
  let remove: (candidate: string) => Promise<void> = async () => undefined;

  vi.mocked(snapshotRalphWorktree).mockImplementation(async (path) => {
    if (path === repository) return gitObjects.sourceTree;
    if (path === worktree.worktreeRoot) return gitObjects.runTree;
    return gitObjects.mergedTree;
  });
  vi.mocked(runRalphWorktreeGit).mockImplementation(async (_cwd, args) => {
    if (args.includes("--git-common-dir")) return join(repository, ".git");
    if (args.includes("--show-current")) return "main";
    if (args[0] === "ls-files") return "";
    if (args[0] === "rev-parse")
      return args[1] === "HEAD" ? gitObjects.sourceHead : gitObjects.baseTree;
    if (args[0] === "worktree" && args[1] === "list") {
      return [...candidates]
        .map(
          ([path, mode]) =>
            `worktree ${path.replace(/\\/gu, "/")}\0HEAD ${gitObjects.mergedCommit}\0${mode === "detached" ? "detached" : "branch refs/heads/foreign"}\0locked\0\0`,
        )
        .join("");
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const candidate = args[3]!;
      checkouts.push(candidate);
      candidates.set(candidate, "detached");
      await prepare(candidate);
      return "";
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      const candidate = args.at(-1)!;
      expect(args.filter((argument) => argument === "--force")).toHaveLength(2);
      removals.push(candidate);
      await remove(candidate);
      candidates.delete(candidate);
      return "";
    }
    if (args[0] === "write-tree") return gitObjects.mergedTree;
    if (args[0] === "diff" && args.includes("--name-only"))
      return "source.txt\0";
    return "";
  });
  return {
    repository,
    runDirectory,
    worktree,
    candidates,
    checkouts,
    removals,
    failPreparation: (operation: typeof prepare) => {
      prepare = operation;
    },
    failRemoval: (operation: typeof remove) => {
      remove = operation;
    },
  };
};

const timeout = () =>
  Object.assign(new Error("Command timed out after 120000ms."), {
    code: "ETIMEDOUT",
  });
const unexpectedRepair = async () => {
  throw new Error("A checkout failure must not invoke model repair");
};

describe("RALPH integration preparation recovery", () => {
  it("cleans a registered interrupted checkout before retrying and publishes once", async () => {
    const fixture = await createFixture();
    fixture.failPreparation(async () => {
      if (fixture.checkouts.length === 1) throw timeout();
      expect(fixture.removals).toEqual(fixture.checkouts.slice(0, -1));
    });
    const verify = vi.fn(async () => undefined);
    const beforePublish = vi.fn(async () => undefined);
    const result = await integrateRalphRunWorktree(
      fixture.worktree,
      fixture.runDirectory,
      { verify, repair: unexpectedRepair, beforePublish },
    );

    expect(result.status).toBe("merged");
    expect(fixture.checkouts).toHaveLength(2);
    expect(fixture.removals).toEqual(fixture.checkouts);
    expect(fixture.candidates.size).toBe(0);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(applyRalphTreeDifference)
        .mock.calls.filter(([path]) => path === fixture.repository),
    ).toHaveLength(1);
    expect(
      await readRalphIntegrationState(
        join(fixture.runDirectory, "workspace-integration.json"),
        fixture.worktree.baseCommit,
      ),
    ).toMatchObject({
      baseCommit: gitObjects.mergedCommit,
      last: { status: "merged", changedPaths: ["source.txt"] },
    });
  });

  it("bounds persistent preparation timeouts and retains source files", async () => {
    const fixture = await createFixture();
    const failure = timeout();
    fixture.failPreparation(async () => {
      throw failure;
    });
    const verify = vi.fn(async () => undefined);

    await expect(
      integrateRalphRunWorktree(fixture.worktree, fixture.runDirectory, {
        verify,
        repair: unexpectedRepair,
      }),
    ).rejects.toBe(failure);
    expect(fixture.checkouts).toHaveLength(3);
    expect(fixture.removals).toEqual(fixture.checkouts);
    expect(fixture.candidates.size).toBe(0);
    expect(verify).not.toHaveBeenCalled();
    expect(applyRalphTreeDifference).not.toHaveBeenCalled();
    expect(await readFile(join(fixture.repository, "source.txt"), "utf8")).toBe(
      "original\n",
    );
  });

  it("preserves preparation and cleanup failures without retrying unsafe state", async () => {
    const fixture = await createFixture();
    const failure = timeout();
    const cleanupFailure = new Error("Candidate removal failed");
    fixture.failPreparation(async () => {
      throw failure;
    });
    fixture.failRemoval(async () => {
      throw cleanupFailure;
    });
    const result = integrateRalphRunWorktree(
      fixture.worktree,
      fixture.runDirectory,
      { verify: async () => undefined, repair: unexpectedRepair },
    );
    await expect(result).rejects.toMatchObject({
      errors: [failure, cleanupFailure],
    });
    await expect(result).rejects.toThrow(failure.message);
    await expect(result).rejects.toThrow(cleanupFailure.message);
    expect(fixture.checkouts).toHaveLength(1);
    expect(fixture.candidates.size).toBe(1);
    expect(applyRalphTreeDifference).not.toHaveBeenCalled();
  });

  it("retains a permanent setup failure without repeating checkout", async () => {
    const fixture = await createFixture();
    const failure = new Error("Checkout rejected by Git");
    fixture.failPreparation(async () => {
      throw failure;
    });
    await expect(
      integrateRalphRunWorktree(fixture.worktree, fixture.runDirectory, {
        verify: async () => undefined,
        repair: unexpectedRepair,
      }),
    ).rejects.toBe(failure);
    expect(fixture.checkouts).toHaveLength(1);
    expect(fixture.candidates.size).toBe(0);
    expect(applyRalphTreeDifference).not.toHaveBeenCalled();
  });

  it("preserves an unregistered filesystem candidate after rejected checkout", async () => {
    const fixture = await createFixture();
    const candidate = `${fixture.worktree.worktreeRoot}-integration-0`;
    await mkdir(candidate);
    await writeFile(join(candidate, "foreign.txt"), "preserve\n");
    const failure = new Error("Candidate path already exists");
    fixture.failPreparation(async () => {
      fixture.candidates.delete(candidate);
      throw failure;
    });
    await expect(
      integrateRalphRunWorktree(fixture.worktree, fixture.runDirectory, {
        verify: async () => undefined,
        repair: unexpectedRepair,
      }),
    ).rejects.toBe(failure);
    expect(fixture.checkouts).toHaveLength(1);
    expect(fixture.removals).toHaveLength(0);
    expect(await readFile(join(candidate, "foreign.txt"), "utf8")).toBe(
      "preserve\n",
    );
  });

  it("refuses to remove a candidate reassigned to another branch", async () => {
    const fixture = await createFixture();
    fixture.candidates.set(
      `${fixture.worktree.worktreeRoot}-integration-0`,
      "branch",
    );
    await expect(
      integrateRalphRunWorktree(fixture.worktree, fixture.runDirectory, {
        verify: async () => undefined,
        repair: unexpectedRepair,
      }),
    ).rejects.toThrow("no longer a detached candidate");
    expect(fixture.checkouts).toHaveLength(0);
    expect(fixture.removals).toHaveLength(0);
    expect(fixture.candidates.size).toBe(1);
  });

  it("cleans cancelled preparation without retrying or passing cancellation into cleanup", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const failure = new Error("Cancelled integration preparation");
    fixture.failPreparation(async () => {
      controller.abort(failure);
      throw failure;
    });
    await expect(
      integrateRalphRunWorktree(fixture.worktree, fixture.runDirectory, {
        signal: controller.signal,
        verify: async () => undefined,
        repair: unexpectedRepair,
      }),
    ).rejects.toBe(failure);
    expect(fixture.checkouts).toHaveLength(1);
    expect(fixture.candidates.size).toBe(0);
    expect(
      vi
        .mocked(runRalphWorktreeGit)
        .mock.calls.find(
          ([, args]) => args[0] === "worktree" && args[1] === "add",
        )?.[2]?.signal,
    ).toBe(controller.signal);
    expect(
      vi
        .mocked(runRalphWorktreeGit)
        .mock.calls.filter(
          ([, args]) => args[0] === "worktree" && args[1] === "remove",
        )
        .every(([, , options]) => !options?.signal),
    ).toBe(true);
  });
});
