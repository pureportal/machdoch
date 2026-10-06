import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as worktrees from "../_helpers/ralph-run-worktree.helper.js";
import * as integration from "../_helpers/ralph-run-integration.helper.js";
import { RalphRunStore } from "../_helpers/ralph-run-store.helper.js";
import {
  createRalphRunLogger,
  readRalphRunRecord,
  runRalphFlow,
} from "../ralph.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

const roots: string[] = [];
const createRun = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-preparation-"));
  roots.push(workspace);
  const executionRoot = join(workspace, "candidate");
  await mkdir(executionRoot);
  const flow = createFlow({
    blocks: [
      { id: "start", type: "START", title: "Start" },
      {
        id: "append",
        type: "UTILITY",
        title: "Append",
        utility: {
          type: "WRITE_FILE",
          path: "effects.txt",
          content: "once\n",
          append: true,
        },
        settings: { workspace: { mode: "custom", path: workspace } },
      },
      { id: "end", type: "END", title: "End", status: "success" },
    ],
    edges: [
      { id: "a", from: "start", fromOutput: "SUCCESS", to: "append" },
      { id: "b", from: "append", fromOutput: "SUCCESS", to: "end" },
    ],
  });
  const logger = await createRalphRunLogger(workspace, flow, {
    runId: "preparation",
  });
  const config = { ...runtimeConfig, workspaceRoot: workspace };
  const worktree: worktrees.RalphRunWorktree = {
    sourceWorkspaceRoot: workspace,
    repositoryRoot: workspace,
    executionWorkspaceRoot: executionRoot,
    worktreeRoot: executionRoot,
    branch: "ralph/preparation",
    sourceBranch: "main",
    baseCommit: "a".repeat(40),
  };
  return { workspace, executionRoot, flow, logger, config, worktree };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RALPH preparation recovery", () => {
  it("persists preparation before checkout and resumes the same run without touching source files", async () => {
    const { workspace, executionRoot, flow, logger, config, worktree } =
      await createRun();
    assert(logger.paths);
    const prepare = vi
      .spyOn(worktrees, "prepareRalphRunWorktree")
      .mockImplementationOnce(async () => {
        const saved = JSON.parse(
          await readFile(logger.paths!.recordPath, "utf8"),
        );
        expect(saved).toMatchObject({
          status: "running",
          checkpoint: {
            transitions: 0,
            preparation: {
              kind: "isolated-worktree",
              workspaceRoot: workspace,
            },
          },
        });
        throw new Error("Git checkout timed out");
      });
    const failed = await runRalphFlow(flow, config, customizations, {
      logger,
      isolatedWorktree: true,
    });
    expect(failed.status).toBe("crashed");
    expect(failed.summary).toContain("Git checkout timed out");
    expect(failed.checkpoint).toMatchObject({
      currentBlockId: "start",
      transitions: 0,
      preparation: { kind: "isolated-worktree" },
    });
    const saved = await readRalphRunRecord(workspace, logger.runId);
    assert(saved.record.checkpoint);
    expect(saved.record.checkpoint?.preparation).toBeDefined();
    expect(saved.record.checkpoint?.lease?.releasedAt).toBeDefined();
    await expect(
      readFile(join(workspace, "effects.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    prepare.mockResolvedValueOnce(worktree);
    vi.spyOn(integration, "integrateRalphRunWorktree").mockResolvedValue({
      status: "merged",
      mergedAt: new Date().toISOString(),
      changedPaths: ["effects.txt"],
    });
    const resumedLogger = await createRalphRunLogger(workspace, flow, {
      runId: logger.runId,
      paths: logger.paths,
      append: true,
      deferWritesUntilActivated: true,
    });
    const resumed = await runRalphFlow(flow, config, customizations, {
      logger: resumedLogger,
      checkpoint: saved.record.checkpoint,
      leaseOwnerId: `${process.pid}:new-owner`,
    });
    expect(resumed.status, resumed.summary).toBe("completed");
    expect(resumed.runId).toBe(failed.runId);
    expect(resumed.durability?.status).toBe("healthy");
    expect(await readFile(join(executionRoot, "effects.txt"), "utf8")).toBe(
      "once\n",
    );
    expect(
      resumed.blockResults.filter((block) => block.blockId === "append"),
    ).toHaveLength(1);
    const final = await readRalphRunRecord(workspace, logger.runId);
    expect(final.record.status).toBe("completed");
    expect(final.record.checkpoint?.preparation).toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects a changed graph before retrying preparation", async () => {
    const { workspace, flow, logger, config } = await createRun();
    const prepare = vi
      .spyOn(worktrees, "prepareRalphRunWorktree")
      .mockRejectedValue(new Error("Unavailable Git"));
    const failed = await runRalphFlow(flow, config, customizations, {
      logger,
      isolatedWorktree: true,
    });
    assert(failed.checkpoint);
    const record = await readFile(logger.paths!.recordPath, "utf8");
    const revised = structuredClone(flow);
    revised.blocks[1]!.title = "Changed";
    const result = await runRalphFlow(revised, config, customizations, {
      logger,
      checkpoint: failed.checkpoint,
    });
    expect(result.summary).toContain("flow revision");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await readFile(logger.paths!.recordPath, "utf8")).toBe(record);
    await expect(
      readFile(join(workspace, "effects.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a preparation record held by a live foreign owner", async () => {
    const { workspace, flow, logger, config } = await createRun();
    const prepare = vi
      .spyOn(worktrees, "prepareRalphRunWorktree")
      .mockRejectedValue(new Error("Unavailable Git"));
    const failed = await runRalphFlow(flow, config, customizations, {
      logger,
      isolatedWorktree: true,
    });
    expect(failed.checkpoint?.preparation).toBeDefined();
    const saved = await readRalphRunRecord(workspace, logger.runId);
    assert(saved.record.checkpoint);
    const store = new RalphRunStore(logger.paths!.directory);
    await store.initialize();
    await store.acquireLease(
      {
        runId: logger.runId,
        flowId: flow.id,
        ownerId: `${process.pid}:foreign-owner`,
        generation: 20,
        acquiredAt: new Date().toISOString(),
      },
      60_000,
    );
    const record = await readFile(logger.paths!.recordPath, "utf8");
    const result = await runRalphFlow(flow, config, customizations, {
      logger,
      checkpoint: saved.record.checkpoint,
      leaseOwnerId: `${process.pid}:contender`,
    });
    expect(result.summary).toContain("another live process");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await readFile(logger.paths!.recordPath, "utf8")).toBe(record);
    expect((await store.readLease())?.lease.generation).toBe(20);
  });
});
