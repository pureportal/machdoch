import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  acquireRalphFileMutationLock,
  type RalphFlow,
  type RalphRunCheckpoint,
  type RalphRunLogPaths,
} from "../ralph.js";
import { createRalphCheckpointFence } from "./create-ralph-checkpoint-fence.helper.js";
import { createRalphFlowFingerprint } from "./create-ralph-flow-fingerprint.helper.js";
import {
  createRalphRunRecord,
  isRalphRunRecord,
} from "./create-ralph-run-record.helper.js";
import { RalphRunStore } from "./ralph-run-store.helper.js";
import { publishRalphInitializationRecord } from "./ralph-run-initialization.helper.js";
import {
  prepareRalphRunWorktree,
  type RalphRunWorktree,
} from "./ralph-run-worktree.helper.js";
import {
  RALPH_FLOW_SCHEMA_VERSION,
  validateRalphFlow,
} from "./validate-ralph-flow.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export const prepareRalphIsolatedRun = async (
  flow: RalphFlow,
  workspaceRoot: string,
  paths: RalphRunLogPaths,
  options: {
    runId: string;
    startedAt: string;
    ownerId: string;
    checkpoint?: RalphRunCheckpoint;
    variableValues?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<{ checkpoint: RalphRunCheckpoint; worktree: RalphRunWorktree }> => {
  const fingerprint = createRalphFlowFingerprint(flow);
  const sourceRoot = await realpath(resolve(workspaceRoot));
  if (
    options.checkpoint &&
    (options.checkpoint.preparation?.kind !== "isolated-worktree" ||
      options.checkpoint.preparation.flowFingerprint !== fingerprint ||
      options.checkpoint.preparation.workspaceRoot !== sourceRoot ||
      options.checkpoint.runId !== options.runId ||
      options.checkpoint.flowId !== flow.id ||
      options.checkpoint.transitions !== 0 ||
      options.checkpoint.blockResults.length !== 0 ||
      Object.keys(options.checkpoint.operationLedger ?? {}).length !== 0)
  ) {
    throw new Error(
      "RALPH preparation checkpoint does not match this run or flow revision.",
    );
  }
  const lock = await acquireRalphFileMutationLock(
    paths.recordPath,
    `ralph-preparation:${options.ownerId}`,
    30_000,
    { reapLiveOwner: false, ownerGroupId: options.ownerId },
  );
  try {
    options.signal?.throwIfAborted();
    const store = new RalphRunStore(paths.directory);
    await store.initialize();
    const stored = await store.readLatestCheckpoint();
    const independentLease = await store.readLease();
    const currentRaw = await readFile(paths.recordPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    const current: unknown = currentRaw ? JSON.parse(currentRaw) : undefined;
    if (
      independentLease &&
      (independentLease.lease.runId !== options.runId ||
        independentLease.lease.flowId !== flow.id)
    )
      throw new Error("RALPH preparation lease belongs to another run.");
    if (
      independentLease?.active &&
      independentLease.lease.ownerId !== options.ownerId
    ) {
      throw new Error("RALPH preparation is owned by another live process.");
    }
    if (
      options.checkpoint
        ? !isRalphRunRecord(current, RALPH_FLOW_SCHEMA_VERSION) ||
          current.id !== options.runId ||
          current.flowId !== flow.id ||
          createRalphCheckpointFence(current.checkpoint) !==
            createRalphCheckpointFence(options.checkpoint) ||
          stored?.checkpoint.preparation?.flowFingerprint !== fingerprint ||
          stored.checkpoint.preparation.workspaceRoot !== sourceRoot ||
          stored.checkpoint.runId !== options.runId ||
          stored.checkpoint.flowId !== flow.id ||
          stored.checkpoint.transitions !== 0
        : current !== undefined ||
          stored !== undefined ||
          independentLease !== undefined
    ) {
      throw new Error(
        "RALPH preparation state changed; refusing to overwrite this run.",
      );
    }
    const start = flow.blocks.find((block) => block.type === "START");
    if (!start) throw new Error("RALPH preparation requires a start block.");
    const now = new Date().toISOString();
    const generation =
      Math.max(
        options.checkpoint?.lease?.generation ?? 0,
        independentLease?.lease.generation ?? 0,
      ) + 1;
    const checkpoint = {
      currentBlockId: start.id,
      transitions: 0,
      variables: options.checkpoint?.variables ?? options.variableValues ?? {},
      resultsByBlock: {},
      runLog: [],
      blockResults: [],
      events: [],
      errorCounts: {},
      repeatedFailures: {},
      runId: options.runId,
      startedAt: options.checkpoint?.startedAt ?? options.startedAt,
      flowId: flow.id,
      preparation: {
        kind: "isolated-worktree",
        flowFingerprint: fingerprint,
        workspaceRoot: sourceRoot,
      },
      durability: { status: "healthy", required: true },
      lease: {
        ownerId: options.ownerId,
        generation,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      },
    } satisfies RalphRunCheckpoint;
    await lock.assertOwnership();
    await store.acquireLease(
      {
        runId: options.runId,
        flowId: flow.id,
        ownerId: options.ownerId,
        generation,
        acquiredAt: now,
      },
      24 * 60 * 60 * 1_000,
    );
    await store.persistCheckpoint(
      checkpoint,
      "Preparing isolated RALPH workspace.",
      lock.assertOwnership,
    );
    const record = createRalphRunRecord(
      RALPH_FLOW_SCHEMA_VERSION,
      paths.id,
      checkpoint.startedAt,
      flow,
      {
        flow: flow.id,
        status: "running",
        summary: "Preparing isolated RALPH workspace.",
        events: [],
        blockResults: [],
        missingVariables: [],
        unknownVariables: [],
        validation: validateRalphFlow(flow),
        checkpoint,
        durability: checkpoint.durability,
      },
      checkpoint.variables,
      paths,
    );
    await publishRalphInitializationRecord(paths, flow.id, () =>
      writeJsonAtomically(paths.recordPath, record, {
        beforeCommit: lock.assertOwnership,
      }),
    );
    options.signal?.throwIfAborted();
    const worktree = await prepareRalphRunWorktree(
      workspaceRoot,
      paths.directory,
    );
    await lock.assertOwnership();
    return { checkpoint, worktree };
  } finally {
    await lock.release();
  }
};
