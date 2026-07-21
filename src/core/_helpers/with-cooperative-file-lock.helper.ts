import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_SUFFIX = ".machdoch.lock";
const OWNER_DIRECTORY_PREFIX = "owner.";
const OWNER_FILE_NAME = "owner.json";
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_AGE_MS = 120_000;
const TRANSIENT_WINDOWS_ERROR_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const LOCK_CLEANUP_RETRY_TIMEOUT_MS = 2_000;

interface FileLockOwner {
  token: string;
  pid: number;
  acquiredAt?: string;
  description?: string;
}

interface ObservedFileLockOwner extends FileLockOwner {
  ownerPath: string;
}

export interface CooperativeFileLockOptions {
  timeoutMs?: number;
  staleLockAgeMs?: number;
  ownerDescription?: string;
}

export interface CooperativeFileLockInspection {
  lockPath: string;
  state: "unlocked" | "initializing" | "active" | "orphaned" | "stale";
  staleAfterMs: number;
  ageMs?: number;
  owner?: {
    token: string;
    pid: number;
    processAlive: boolean;
    acquiredAt?: string;
    description?: string;
  };
}

const wait = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const getErrorCode = (error: unknown): string => {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
};

const loadOwnerRecord = async (ownerPath: string): Promise<FileLockOwner | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(join(ownerPath, OWNER_FILE_NAME), "utf8"),
    ) as Partial<FileLockOwner>;
    return typeof parsed.token === "string" &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0
      ? {
          token: parsed.token,
          pid: parsed.pid as number,
          ...(typeof parsed.acquiredAt === "string"
            ? { acquiredAt: parsed.acquiredAt }
            : {}),
          ...(typeof parsed.description === "string"
            ? { description: parsed.description }
            : {}),
        }
      : null;
  } catch {
    return null;
  }
};

const loadObservedOwner = async (
  lockPath: string,
): Promise<ObservedFileLockOwner | null> => {
  const entries = await readdir(lockPath, { withFileTypes: true }).catch(
    () => [],
  );

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(OWNER_DIRECTORY_PREFIX)) {
      continue;
    }

    const token = entry.name.slice(OWNER_DIRECTORY_PREFIX.length);
    const ownerPath = join(lockPath, entry.name);
    const owner = await loadOwnerRecord(ownerPath);
    if (owner?.token === token) {
      return { ...owner, ownerPath };
    }
  }

  // Versions before the token-directory protocol wrote owner.json directly
  // inside the canonical lock directory. Keep recognizing that layout so an
  // abandoned lock from an older binary cannot block startup forever.
  const legacyOwner = await loadOwnerRecord(lockPath);
  return legacyOwner ? { ...legacyOwner, ownerPath: lockPath } : null;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === "EPERM";
  }
};

const createQuarantinePath = (lockPath: string, token: string): string => {
  return `${lockPath}.quarantine.${process.pid}.${token}.${randomUUID()}`;
};

const createOwnedDirectoryCandidate = async (
  targetPath: string,
  token: string,
  description?: string,
): Promise<string> => {
  const candidatePath = `${targetPath}.candidate.${process.pid}.${token}.${randomUUID()}`;
  await mkdir(candidatePath);
  try {
    await populateOwnedDirectory(candidatePath, token, description);
    return candidatePath;
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
};

const populateOwnedDirectory = async (
  parentPath: string,
  token: string,
  description?: string,
): Promise<void> => {
  const ownerPath = join(parentPath, `${OWNER_DIRECTORY_PREFIX}${token}`);
  await mkdir(ownerPath);
  await writeFile(
    join(ownerPath, OWNER_FILE_NAME),
    JSON.stringify({
      token,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      ...(description ? { description } : {}),
    } satisfies FileLockOwner),
    { encoding: "utf8", flag: "wx" },
  );
};

const targetExists = async (path: string): Promise<boolean> => {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if (getErrorCode(error) === "ENOENT") {
        return false;
      }
      if (TRANSIENT_WINDOWS_ERROR_CODES.has(getErrorCode(error))) {
        return true;
      }
      throw error;
    },
  );
};

const removeCanonicalIfEmpty = async (lockPath: string): Promise<boolean> => {
  const startedAt = Date.now();

  while (true) {
    try {
      await rmdir(lockPath);
      return true;
    } catch (error) {
      const code = getErrorCode(error);

      if (code === "ENOENT") {
        return true;
      }
      if (["ENOTEMPTY", "EEXIST"].includes(code)) {
        return false;
      }
      if (
        TRANSIENT_WINDOWS_ERROR_CODES.has(code) &&
        Date.now() - startedAt < LOCK_CLEANUP_RETRY_TIMEOUT_MS
      ) {
        await wait(LOCK_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
};

const quarantineStaleLock = async (
  lockPath: string,
  staleLockAgeMs: number,
): Promise<void> => {
  const owner = await loadObservedOwner(lockPath);
  if (!owner) {
    const entries = await readdir(lockPath, { withFileTypes: true }).catch(
      () => [],
    );
    const malformedOwnerEntries = entries.filter((entry) =>
      (entry.isDirectory() && entry.name.startsWith(OWNER_DIRECTORY_PREFIX)) ||
      (entry.isFile() && entry.name === OWNER_FILE_NAME)
    );

    for (const entry of malformedOwnerEntries) {
      const stalePath = join(lockPath, entry.name);
      const staleMetadata = await stat(
        entry.isDirectory()
          ? join(stalePath, OWNER_FILE_NAME)
          : stalePath,
      ).catch(() => stat(stalePath).catch(() => null));
      if (
        !staleMetadata ||
        Date.now() - staleMetadata.mtimeMs < staleLockAgeMs
      ) {
        continue;
      }

      const token = entry.name.startsWith(OWNER_DIRECTORY_PREFIX)
        ? entry.name.slice(OWNER_DIRECTORY_PREFIX.length)
        : "legacy-malformed-owner";
      const quarantinePath = createQuarantinePath(lockPath, token);
      try {
        // The exact malformed owner child is the compare-and-swap target. A
        // fresh valid owner has a different token-named path and cannot be
        // removed by a delayed stale-lock contender.
        await rename(stalePath, quarantinePath);
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") continue;
        if (TRANSIENT_WINDOWS_ERROR_CODES.has(getErrorCode(error))) continue;
        throw error;
      }
      await removeCanonicalIfEmpty(lockPath);
      await rm(quarantinePath, { recursive: true, force: true });
    }

    const metadata = await stat(lockPath).catch(() => null);
    if (metadata && Date.now() - metadata.mtimeMs >= staleLockAgeMs) {
      // Non-recursive removal reaps only a genuinely empty abandoned lock. It
      // leaves unknown contents untouched rather than treating them as ours.
      await removeCanonicalIfEmpty(lockPath);
    }
    return;
  }

  const metadata = await stat(join(owner.ownerPath, OWNER_FILE_NAME)).catch(
    () => null,
  );
  if (
    !metadata ||
    Date.now() - metadata.mtimeMs < staleLockAgeMs ||
    isProcessAlive(owner.pid)
  ) {
    return;
  }

  const quarantinePath = createQuarantinePath(lockPath, owner.token);
  try {
    // The token in the source path is the compare-and-swap condition. A
    // delayed contender for an old token cannot move a new owner's child.
    await rename(owner.ownerPath, quarantinePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }
    const currentOwner = await loadObservedOwner(lockPath);
    if (
      currentOwner?.token !== owner.token ||
      currentOwner.pid !== owner.pid
    ) {
      return;
    }
    if (["EACCES", "EPERM", "EBUSY"].includes(getErrorCode(error))) {
      return;
    }
    throw error;
  }

  await removeCanonicalIfEmpty(lockPath);
  await rm(quarantinePath, { recursive: true, force: true });
};

export const inspectCooperativeFileLock = async (
  destination: string,
  options: Pick<CooperativeFileLockOptions, "staleLockAgeMs"> = {},
): Promise<CooperativeFileLockInspection> => {
  const lockPath = `${destination}${LOCK_SUFFIX}`;
  const staleAfterMs = options.staleLockAgeMs ?? STALE_LOCK_AGE_MS;
  const lockMetadata = await stat(lockPath).catch((error: unknown) => {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!lockMetadata) {
    return { lockPath, state: "unlocked", staleAfterMs };
  }

  const owner = await loadObservedOwner(lockPath);
  if (!owner) {
    const ageMs = Math.max(0, Date.now() - lockMetadata.mtimeMs);
    return {
      lockPath,
      state: ageMs >= staleAfterMs ? "stale" : "initializing",
      staleAfterMs,
      ageMs,
    };
  }

  const ownerMetadata = await stat(join(owner.ownerPath, OWNER_FILE_NAME)).catch(
    () => null,
  );
  const ageMs = Math.max(
    0,
    Date.now() - (ownerMetadata?.mtimeMs ?? lockMetadata.mtimeMs),
  );
  const processAlive = isProcessAlive(owner.pid);
  return {
    lockPath,
    state: processAlive
      ? "active"
      : ageMs >= staleAfterMs
        ? "stale"
        : "orphaned",
    staleAfterMs,
    ageMs,
    owner: {
      token: owner.token,
      pid: owner.pid,
      processAlive,
      ...(owner.acquiredAt ? { acquiredAt: owner.acquiredAt } : {}),
      ...(owner.description ? { description: owner.description } : {}),
    },
  };
};

const formatLockTimeout = (
  inspection: CooperativeFileLockInspection,
  timeoutMs: number,
): string => {
  const prefix =
    `Timed out after ${timeoutMs}ms waiting for configuration lock ${inspection.lockPath}.`;
  const owner = inspection.owner;
  if (inspection.state === "active" && owner) {
    return `${prefix} Lock is actively owned by PID ${owner.pid}` +
      `${owner.description ? ` (${owner.description})` : ""}` +
      `${owner.acquiredAt ? ` since ${owner.acquiredAt}` : ""}; ` +
      "another Machdoch operation is still running.";
  }
  if (inspection.state === "orphaned" && owner) {
    const remainingMs = Math.max(
      0,
      inspection.staleAfterMs - (inspection.ageMs ?? 0),
    );
    return `${prefix} Owner PID ${owner.pid} is no longer running; ` +
      `the orphaned lock becomes eligible for safe recovery in about ${remainingMs}ms.`;
  }
  if (inspection.state === "stale") {
    return `${prefix} The lock appears stale but could not be quarantined; ` +
      "retry the operation and run `machdoch provider-sync doctor` if it persists.";
  }
  if (inspection.state === "initializing") {
    return `${prefix} Owner metadata is not available yet; the lock may be ` +
      "initializing or may have been abandoned by a process that exited during acquisition.";
  }
  return `${prefix} The lock was released while diagnostics were collected; retry the operation.`;
};

const releaseOwnedLock = async (
  lockPath: string,
  token: string,
): Promise<void> => {
  const owner = await loadObservedOwner(lockPath);
  if (owner?.token !== token || owner.pid !== process.pid) {
    return;
  }

  const quarantinePath = createQuarantinePath(lockPath, token);
  const startedAt = Date.now();

  while (true) {
    try {
      await rename(owner.ownerPath, quarantinePath);
      break;
    } catch (error) {
      const code = getErrorCode(error);

      if (code === "ENOENT") {
        return;
      }

      const currentOwner = await loadObservedOwner(lockPath);
      if (
        currentOwner?.token !== owner.token ||
        currentOwner.pid !== owner.pid
      ) {
        return;
      }

      if (
        TRANSIENT_WINDOWS_ERROR_CODES.has(code) &&
        Date.now() - startedAt < LOCK_CLEANUP_RETRY_TIMEOUT_MS
      ) {
        await wait(LOCK_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  await removeCanonicalIfEmpty(lockPath);
  await rm(quarantinePath, { recursive: true, force: true });
};

/**
 * Serializes a complete read-modify-write operation with the Rust runtime.
 * The sibling directory and token-named owner protocol must stay in sync with
 * `src-tauri/src/cooperative_file_lock.rs`.
 */
export const withCooperativeFileLock = async <T>(
  destination: string,
  operation: () => Promise<T>,
  options: CooperativeFileLockOptions = {},
): Promise<T> => {
  const lockPath = `${destination}${LOCK_SUFFIX}`;
  const token = randomUUID();
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleLockAgeMs = options.staleLockAgeMs ?? STALE_LOCK_AGE_MS;
  const ownerDescription = options.ownerDescription?.trim().slice(0, 500);

  await mkdir(dirname(destination), { recursive: true });
  // Populate a private candidate before the atomic rename election. This
  // keeps the canonical lock from ever being observable without owner
  // metadata, including when a Windows process exits during acquisition.
  const candidatePath = await createOwnedDirectoryCandidate(
    lockPath,
    token,
    ownerDescription,
  );
  let acquired = false;

  try {
    while (true) {
      try {
        await rename(candidatePath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (await targetExists(lockPath)) {
          await quarantineStaleLock(lockPath, staleLockAgeMs);
        } else if (!(await targetExists(candidatePath))) {
          throw error;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          const inspection = await inspectCooperativeFileLock(destination, {
            staleLockAgeMs,
          });
          throw new Error(
            formatLockTimeout(inspection, timeoutMs),
            { cause: error },
          );
        }
        await wait(LOCK_RETRY_DELAY_MS);
      }
    }
  } finally {
    if (!acquired) {
      await rm(candidatePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
};
