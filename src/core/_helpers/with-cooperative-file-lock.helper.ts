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
}

interface ObservedFileLockOwner extends FileLockOwner {
  ownerPath: string;
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
      ? { token: parsed.token, pid: parsed.pid as number }
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

  return null;
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
): Promise<string> => {
  const candidatePath = `${targetPath}.candidate.${process.pid}.${token}.${randomUUID()}`;
  await mkdir(candidatePath);
  try {
    await populateOwnedDirectory(candidatePath, token);
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
): Promise<void> => {
  const ownerPath = join(parentPath, `${OWNER_DIRECTORY_PREFIX}${token}`);
  await mkdir(ownerPath);
  await writeFile(
    join(ownerPath, OWNER_FILE_NAME),
    JSON.stringify({ token, pid: process.pid } satisfies FileLockOwner),
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

const quarantineStaleLock = async (lockPath: string): Promise<void> => {
  const owner = await loadObservedOwner(lockPath);
  if (!owner) {
    const metadata = await stat(lockPath).catch(() => null);
    if (metadata && Date.now() - metadata.mtimeMs >= STALE_LOCK_AGE_MS) {
      // Every current owner is a populated token directory. Non-recursive
      // removal can only reap an empty legacy lock and fails on a fresh owner.
      await removeCanonicalIfEmpty(lockPath);
    }
    return;
  }

  const metadata = await stat(join(owner.ownerPath, OWNER_FILE_NAME)).catch(
    () => null,
  );
  if (
    !metadata ||
    Date.now() - metadata.mtimeMs < STALE_LOCK_AGE_MS ||
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
): Promise<T> => {
  const lockPath = `${destination}${LOCK_SUFFIX}`;
  const token = randomUUID();
  const startedAt = Date.now();

  await mkdir(dirname(destination), { recursive: true });
  const useWindowsDirectoryCreation = process.platform === "win32";
  const candidatePath = useWindowsDirectoryCreation
    ? null
    : await createOwnedDirectoryCandidate(lockPath, token);
  let acquired = false;

  try {
    while (true) {
      if (useWindowsDirectoryCreation) {
        try {
          // Renaming a populated directory onto an existing directory reports
          // EPERM on Windows. Creating the canonical directory itself is the
          // atomic winner election there; Rust contenders cannot replace it on
          // Windows and wait through the short owner-population window.
          await mkdir(lockPath);
        } catch (error) {
          const code = getErrorCode(error);
          if (await targetExists(lockPath)) {
            await quarantineStaleLock(lockPath);
          } else if (
            code !== "EEXIST" &&
            !TRANSIENT_WINDOWS_ERROR_CODES.has(code)
          ) {
            throw error;
          }

          if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
            throw new Error(
              `Timed out waiting for configuration lock ${lockPath}.`,
              { cause: error },
            );
          }
          await wait(LOCK_RETRY_DELAY_MS);
          continue;
        }

        const ownerPath = join(
          lockPath,
          `${OWNER_DIRECTORY_PREFIX}${token}`,
        );
        try {
          await populateOwnedDirectory(lockPath, token);
          acquired = true;
          break;
        } catch (error) {
          await rm(ownerPath, { recursive: true, force: true }).catch(
            () => undefined,
          );
          await removeCanonicalIfEmpty(lockPath).catch(() => undefined);
          throw error;
        }
      }

      try {
        await rename(candidatePath as string, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (await targetExists(lockPath)) {
          await quarantineStaleLock(lockPath);
        } else if (!(await targetExists(candidatePath as string))) {
          throw error;
        }

        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for configuration lock ${lockPath}.`,
            { cause: error },
          );
        }
        await wait(LOCK_RETRY_DELAY_MS);
      }
    }
  } finally {
    if (!acquired && candidatePath) {
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
