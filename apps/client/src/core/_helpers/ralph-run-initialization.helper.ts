import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RalphRunLogPaths } from "./create-ralph-storage-paths.helper.js";
import { isRalphRunOwnerAlive } from "./is-ralph-run-owner-alive.helper.js";
import { retryTransientFileOperation } from "./retry-transient-file-operation.helper.js";
import { withCooperativeFileLock } from "./with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export const RALPH_INITIALIZATION_ARTIFACT_PREFIX = ".ralph-initializing-";

interface InitializationClaim {
  schemaVersion: 1;
  runId: string;
  flowId: string;
  ownerId: string;
}

const claimPath = (paths: RalphRunLogPaths): string =>
  join(
    dirname(paths.directory),
    `${RALPH_INITIALIZATION_ARTIFACT_PREFIX}${basename(paths.directory)}.json`,
  );

const readClaim = async (path: string): Promise<InitializationClaim | null> => {
  let value: unknown;
  try {
    value = JSON.parse(
      await retryTransientFileOperation(() => readFile(path, "utf8")),
    ) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !("flowId" in value) ||
    typeof value.flowId !== "string" ||
    !("ownerId" in value) ||
    typeof value.ownerId !== "string" ||
    !/^[1-9]\d*:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(
      value.ownerId,
    )
  ) {
    throw new Error(`Invalid Ralph initialization ownership at ${path}.`);
  }
  return value as InitializationClaim;
};

const reservedRunError = (id: string): Error =>
  new Error(
    `Ralph run ${id} already has reserved artifacts; inspect it and resume instead of starting it again.`,
  );

export const reserveRalphRunInitialization = async (
  paths: RalphRunLogPaths,
  flowId: string,
): Promise<void> => {
  const path = claimPath(paths);
  await withCooperativeFileLock(`${path}.guard`, async () => {
    const previous = await readClaim(path);
    if (
      previous &&
      (previous.runId !== paths.id ||
        previous.flowId !== flowId ||
        isRalphRunOwnerAlive(previous.ownerId))
    ) {
      throw reservedRunError(paths.id);
    }
    const directory = await lstat(paths.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    const recordExists = await lstat(paths.recordPath)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (
      recordExists ||
      (directory && (!directory.isDirectory() || !previous))
    ) {
      throw reservedRunError(paths.id);
    }
    await writeJsonAtomically(path, {
      schemaVersion: 1,
      runId: paths.id,
      flowId,
      ownerId: `${process.pid}:${randomUUID()}`,
    } satisfies InitializationClaim);
    if (!directory) {
      try {
        await mkdir(paths.directory);
      } catch (error) {
        await unlink(path);
        throw error;
      }
    }
  });
};

export const publishRalphInitializationRecord = async (
  paths: RalphRunLogPaths,
  flowId: string,
  publish: () => Promise<void>,
): Promise<void> => {
  const path = claimPath(paths);
  await withCooperativeFileLock(`${path}.guard`, async () => {
    const claim = await readClaim(path);
    if (
      claim &&
      (claim.runId !== paths.id ||
        claim.flowId !== flowId ||
        (!claim.ownerId.startsWith(`${process.pid}:`) &&
          isRalphRunOwnerAlive(claim.ownerId)))
    ) {
      throw reservedRunError(paths.id);
    }
    await publish();
    if (claim) await unlink(path);
  });
};
