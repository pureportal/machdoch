import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEDULER_STATE_LOCK_RETRY_MS = 25;
const SCHEDULER_STATE_LOCK_STALE_MS = 5 * 60_000;
const SCHEDULER_STATE_LOCK_TRANSIENT_ACCESS_MS = 2_000;
const SCHEDULER_STATE_REPLACE_RETRY_DELAYS_MS = [
  0, 10, 25, 50, 100, 250,
] as const;

const sleep = async (durationMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
};

const isErrorWithCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

const isTransientStateReplaceError = (error: unknown): boolean =>
  ["EACCES", "EPERM", "EBUSY"].some((code) => isErrorWithCode(error, code));

const isSchedulerStateLockContentionError = (
  error: unknown,
  lockPath: string,
): boolean =>
  isErrorWithCode(error, "EEXIST") ||
  (["EACCES", "EPERM"].some((code) => isErrorWithCode(error, code)) &&
    existsSync(lockPath));

const getSchedulerStateLockPath = (statePath: string): string => {
  return `${statePath}.lock`;
};

const removeStaleSchedulerStateLock = async (
  lockPath: string,
): Promise<void> => {
  try {
    const metadata = await stat(lockPath);

    if (Date.now() - metadata.mtimeMs <= SCHEDULER_STATE_LOCK_STALE_MS) {
      return;
    }

    await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
};

const releaseSchedulerStateLock = async (
  lockPath: string,
  token: string,
): Promise<void> => {
  const tokenPath = join(lockPath, "owner");

  try {
    const currentToken = (await readFile(tokenPath, "utf8")).trim();

    if (currentToken === token) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
};

const acquireSchedulerStateLock = async (
  statePath: string,
): Promise<() => Promise<void>> => {
  const lockPath = getSchedulerStateLockPath(statePath);
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const startedAt = Date.now();

  await mkdir(dirname(statePath), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);

      try {
        await writeFile(join(lockPath, "owner"), token, "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      return () => releaseSchedulerStateLock(lockPath, token);
    } catch (error) {
      if (
        (isErrorWithCode(error, "EACCES") || isErrorWithCode(error, "EPERM")) &&
        !existsSync(lockPath) &&
        Date.now() - startedAt <= SCHEDULER_STATE_LOCK_TRANSIENT_ACCESS_MS
      ) {
        await sleep(SCHEDULER_STATE_LOCK_RETRY_MS);
        continue;
      }

      if (!isSchedulerStateLockContentionError(error, lockPath)) {
        throw error;
      }

      await removeStaleSchedulerStateLock(lockPath);
      await sleep(SCHEDULER_STATE_LOCK_RETRY_MS);
    }
  }
};

export const withSchedulerStateLock = async <T>(
  statePath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const releaseLock = await acquireSchedulerStateLock(statePath);
  let operationCompleted = false;

  try {
    const result = await operation();
    operationCompleted = true;
    await releaseLock();
    return result;
  } catch (error) {
    if (!operationCompleted) {
      try {
        await releaseLock();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Scheduler mutation and lock cleanup failed.",
        );
      }
    }

    throw error;
  }
};

const replaceSmartSchedulerStateFile = async (
  tempPath: string,
  statePath: string,
): Promise<void> => {
  let lastError: unknown;

  for (const delayMs of SCHEDULER_STATE_REPLACE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      await rename(tempPath, statePath);
      return;
    } catch (error) {
      if (!isTransientStateReplaceError(error)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const writeSchedulerFileDurably = async (
  tempPath: string,
  targetPath: string,
  content: string,
  beforeCommit?: () => Promise<void>,
): Promise<void> => {
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await beforeCommit?.();
  await replaceSmartSchedulerStateFile(tempPath, targetPath);

  if (process.platform !== "win32") {
    const directoryHandle = await open(dirname(targetPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
};
