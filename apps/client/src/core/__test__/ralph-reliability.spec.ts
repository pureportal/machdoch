import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicWrites from "../_helpers/write-file-atomically.helper.js";
import { RalphRunStore } from "../_helpers/ralph-run-store.helper.js";
import {
  createRalphRunLogger,
  readRalphRunRecord,
  runRalphFlow,
  type RalphRunRecord,
} from "../ralph.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";
import {
  lockWindowsFileReplacement,
  prepareWindowsFileLocker,
} from "./windows-file-lock.js";

const workspaces: string[] = [];
const createRun = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ralph-reliability-"));
  workspaces.push(workspace);
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
      },
      {
        id: "next",
        type: "UTILITY",
        title: "Next",
        utility: { type: "WRITE_FILE", path: "next.txt", content: "next" },
      },
      { id: "success", type: "END", title: "Success", status: "success" },
    ],
    edges: [
      {
        id: "start-append",
        from: "start",
        fromOutput: "SUCCESS",
        to: "append",
      },
      { id: "append-next", from: "append", fromOutput: "SUCCESS", to: "next" },
      {
        id: "next-success",
        from: "next",
        fromOutput: "SUCCESS",
        to: "success",
      },
    ],
  });
  const logger = await createRalphRunLogger(workspace, flow, {
    runId: "reliability",
  });
  return {
    workspace,
    flow,
    logger,
    config: { ...runtimeConfig, workspaceRoot: workspace },
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("RALPH durable execution recovery", () => {
  it("refuses to clear required durability when resuming without a run store", async () => {
    const { workspace, flow, config } = await createRun();
    const result = await runRalphFlow(flow, config, customizations, {
      checkpoint: {
        currentBlockId: "append",
        transitions: 1,
        variables: {},
        resultsByBlock: {},
        runLog: [],
        blockResults: [],
        events: [],
        errorCounts: {},
        repeatedFailures: {},
        durability: {
          status: "degraded",
          required: true,
          error: "old projection failure",
        },
      },
    });
    expect(result.status).toBe("crashed");
    expect(result.durability?.status).toBe("degraded");
    expect(result.summary).toContain("file-backed run store");
    await expect(
      readFile(join(workspace, "effects.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.runIf(process.platform === "win32")(
    "recovers a Windows record lock lasting beyond atomic replacement retries",
    async () => {
      await prepareWindowsFileLocker();
      const { workspace, flow, logger, config } = await createRun();
      const writeJson = atomicWrites.writeJsonAtomically;
      let releaseLock: (() => Promise<void>) | undefined;
      let failedReplacement = false;
      vi.spyOn(atomicWrites, "writeJsonAtomically").mockImplementation(
        async (path, value, options) => {
          const record = value as RalphRunRecord;
          if (
            !releaseLock &&
            !failedReplacement &&
            path === logger.paths!.recordPath &&
            record.status === "running" &&
            record.summary.includes("Persisted completion")
          ) {
            releaseLock = await lockWindowsFileReplacement(path);
          }
          try {
            await writeJson(path, value, options);
          } catch (error) {
            if (
              path === logger.paths!.recordPath &&
              ["EPERM", "EACCES", "EBUSY"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            ) {
              failedReplacement = true;
              const release = releaseLock;
              releaseLock = undefined;
              await release?.();
            }
            throw error;
          }
        },
      );
      try {
        const result = await runRalphFlow(flow, config, customizations, {
          logger,
        });
        expect(result.status, result.summary).toBe("completed");
        expect(failedReplacement, result.summary).toBe(true);
        expect(result.durability?.status).toBe("healthy");
        expect(await readFile(join(workspace, "effects.txt"), "utf8")).toBe(
          "once\n",
        );
      } finally {
        await releaseLock?.();
      }
    },
    60_000,
  );
  it("recovers run projection contention without replaying completed side effects", async () => {
    const { workspace, flow, logger, config } = await createRun();
    const writeJson = atomicWrites.writeJsonAtomically;
    let failures = 0;
    vi.spyOn(atomicWrites, "writeJsonAtomically").mockImplementation(
      async (path, value, options) => {
        const record = value as RalphRunRecord;
        if (
          path === logger.paths!.recordPath &&
          record.status === "running" &&
          record.summary.includes("Persisted completion") &&
          failures < 2
        ) {
          failures += 1;
          throw Object.assign(new Error("temporary Windows file lock"), {
            code: "EPERM",
          });
        }
        await writeJson(path, value, options);
      },
    );

    const result = await runRalphFlow(flow, config, customizations, { logger });

    expect(failures).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.durability?.status).toBe("healthy");
    expect(await readFile(join(workspace, "effects.txt"), "utf8")).toBe(
      "once\n",
    );
    expect(
      result.blockResults.filter((block) => block.blockId === "append"),
    ).toHaveLength(1);
    const record = JSON.parse(
      await readFile(logger.paths!.recordPath, "utf8"),
    ) as RalphRunRecord;
    expect(record.status).toBe("completed");
    expect(record.durability?.error).toBeUndefined();
  });

  it("immediately resumes a recently killed owner without replaying committed progress", async () => {
    const { workspace, flow, logger, config } = await createRun();
    const deadPid = Number(
      execFileSync(process.execPath, ["-e", "console.log(process.pid)"], {
        encoding: "utf8",
        timeout: 20_000,
      }),
    );
    const paused = await runRalphFlow(flow, config, customizations, {
      logger,
      maxTransitions: 2,
    });
    expect(paused.checkpoint?.currentBlockId).toBe("next");
    const now = new Date().toISOString();
    const checkpoint = {
      ...paused.checkpoint!,
      lease: {
        ownerId: `${deadPid}:${randomUUID()}`,
        generation: paused.checkpoint!.lease!.generation,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    };
    const record = JSON.parse(
      await readFile(logger.paths!.recordPath, "utf8"),
    ) as RalphRunRecord;
    await writeFile(
      logger.paths!.recordPath,
      JSON.stringify({ ...record, status: "running", checkpoint }),
      "utf8",
    );
    const store = new RalphRunStore(logger.paths!.directory);
    await store.initialize();
    await store.persistCheckpoint(
      checkpoint,
      "Retained checkpoint after abrupt owner exit.",
    );
    await store.acquireLease(
      {
        runId: logger.runId,
        flowId: flow.id,
        ownerId: checkpoint.lease.ownerId,
        generation: checkpoint.lease.generation,
        acquiredAt: now,
      },
      120_000,
    );
    expect((await store.readLease())?.active).toBe(false);
    expect(
      (await readRalphRunRecord(workspace, logger.runId)).effectiveStatus,
    ).toBe("abandoned");
    const resumeLogger = await createRalphRunLogger(workspace, flow, {
      runId: logger.runId,
      paths: logger.paths!,
      append: true,
    });
    const resumed = await runRalphFlow(flow, config, customizations, {
      logger: resumeLogger,
      checkpoint,
      maxTransitions: 10,
    });
    expect(resumed.status, resumed.summary).toBe("completed");
    expect(resumed.durability?.status).toBe("healthy");
    expect(await readFile(join(workspace, "effects.txt"), "utf8")).toBe(
      "once\n",
    );
    expect(await readFile(join(workspace, "next.txt"), "utf8")).toBe("next");
    expect(
      resumed.checkpoint?.totalTransitions ?? resumed.blockResults.length,
    ).toBeGreaterThanOrEqual(paused.checkpoint!.totalTransitions!);
  }, 30_000);

  it("refuses further side effects when a persistence retry loses ownership", async () => {
    const { workspace, flow, logger, config } = await createRun();
    const writeJson = atomicWrites.writeJsonAtomically;
    const store = new RalphRunStore(logger.paths!.directory);
    let replaced = false;
    vi.spyOn(atomicWrites, "writeJsonAtomically").mockImplementation(
      async (path, value, options) => {
        const record = value as RalphRunRecord;
        if (
          !replaced &&
          path === logger.paths!.recordPath &&
          record.status === "running" &&
          record.summary.includes("Persisted completion")
        ) {
          replaced = true;
          await store.acquireLease(
            {
              runId: logger.runId,
              flowId: flow.id,
              ownerId: "replacement",
              generation: 2,
              acquiredAt: new Date().toISOString(),
            },
            60_000,
          );
          throw Object.assign(new Error("locked during takeover"), {
            code: "EPERM",
          });
        }
        await writeJson(path, value, options);
      },
    );

    const result = await runRalphFlow(flow, config, customizations, { logger });

    expect(replaced).toBe(true);
    expect(result.status).toBe("crashed");
    expect(result.summary).toContain("replacement");
    expect(await readFile(join(workspace, "effects.txt"), "utf8")).toBe(
      "once\n",
    );
    await expect(readFile(join(workspace, "next.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await store.readLease())?.lease).toMatchObject({
      ownerId: "replacement",
      generation: 2,
    });
    expect((await store.readLease())?.lease.releasedAt).toBeUndefined();
  });

  it("stops before an unpersisted side effect on permanent storage failure", async () => {
    const { workspace, flow, logger, config } = await createRun();
    const writeJson = atomicWrites.writeJsonAtomically;
    vi.spyOn(atomicWrites, "writeJsonAtomically").mockImplementation(
      async (path, value, options) => {
        const record = value as RalphRunRecord;
        if (
          path === logger.paths!.recordPath &&
          record.status === "running" &&
          record.summary.includes("Persisted operation intent")
        ) {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        await writeJson(path, value, options);
      },
    );

    const result = await runRalphFlow(flow, config, customizations, { logger });

    expect(result.status).toBe("crashed");
    expect(result.durability).toMatchObject({
      status: "degraded",
      error: "disk full",
    });
    await expect(
      readFile(join(workspace, "effects.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a degraded resume boundary before continuing its routed operation", async () => {
    const { workspace, flow, logger, config } = await createRun();
    const paused = await runRalphFlow(flow, config, customizations, {
      logger,
      maxTransitions: 2,
    });
    expect(paused.status, paused.summary).toBe("crashed");
    expect(paused.checkpoint?.currentBlockId).toBe("next");
    const checkpoint = {
      ...paused.checkpoint!,
      durability: {
        status: "degraded" as const,
        required: true,
        error: "temporary Windows file lock",
      },
    };
    const record = JSON.parse(
      await readFile(logger.paths!.recordPath, "utf8"),
    ) as RalphRunRecord;
    await writeFile(
      logger.paths!.recordPath,
      JSON.stringify({ ...record, checkpoint }),
      "utf8",
    );
    const store = new RalphRunStore(logger.paths!.directory);
    await store.initialize();
    await store.persistCheckpoint(
      checkpoint,
      "Temporary projection failure retained for resume.",
    );
    const resumeLogger = await createRalphRunLogger(workspace, flow, {
      runId: logger.runId,
      paths: logger.paths!,
      append: true,
    });

    const resumed = await runRalphFlow(flow, config, customizations, {
      logger: resumeLogger,
      checkpoint,
      maxTransitions: 10,
    });

    expect(resumed.status, resumed.summary).toBe("completed");
    expect(resumed.durability?.status).toBe("healthy");
    expect(resumed.durability?.error).toBeUndefined();
    expect(await readFile(join(workspace, "effects.txt"), "utf8")).toBe(
      "once\n",
    );
    expect(await readFile(join(workspace, "next.txt"), "utf8")).toBe("next");
  });
});
