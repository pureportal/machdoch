import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  readOpenedFileExactly,
  readOpenedFileExactlySync,
} from "./read-opened-file-exactly.helper.js";
import { sameFileSnapshotIdentity } from "./same-file-identity.helper.js";

const STABLE_READ_RETRY_DELAYS_MS = [0, 5, 20, 50] as const;

export interface StableRegularFileReadMessages {
  invalid: (path: string, maxBytes: number) => string;
  changedBeforeOpen: (path: string) => string;
  changedWhileReading: (path: string) => string;
}

export interface StableRegularFileReadOptions {
  maxBytes: number;
  messages?: StableRegularFileReadMessages;
}

const DEFAULT_MESSAGES: StableRegularFileReadMessages = {
  invalid: (path, maxBytes) =>
    `${path} must be a regular, unlinked file no larger than ${maxBytes} bytes.`,
  changedBeforeOpen: (path) =>
    `${path} changed before it could be opened safely.`,
  changedWhileReading: (path) =>
    `${path} changed while it was being read.`,
};

export class StableFileIdentityRaceError extends Error {}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const assertValidRegularFile = (
  path: string,
  metadata: Stats,
  options: StableRegularFileReadOptions,
): void => {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > options.maxBytes
  ) {
    throw new Error(
      (options.messages ?? DEFAULT_MESSAGES).invalid(path, options.maxBytes),
    );
  }
};

const wait = async (delayMs: number): Promise<void> => {
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
};

export const retryStableFileIdentityRace = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  let lastRace: StableFileIdentityRaceError | undefined;
  for (const delayMs of STABLE_READ_RETRY_DELAYS_MS) {
    await wait(delayMs);
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof StableFileIdentityRaceError)) throw error;
      lastRace = error;
    }
  }
  throw lastRace;
};

export const retryStableFileIdentityRaceSync = <T>(
  operation: () => T,
): T => {
  let lastRace: StableFileIdentityRaceError | undefined;
  for (
    let attempt = 0;
    attempt < STABLE_READ_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof StableFileIdentityRaceError)) throw error;
      lastRace = error;
    }
  }
  throw lastRace;
};

const readStableRegularFileOnce = async (
  path: string,
  options: StableRegularFileReadOptions,
): Promise<Buffer | undefined> => {
  const messages = options.messages ?? DEFAULT_MESSAGES;
  let beforePath: Stats;
  try {
    beforePath = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  assertValidRegularFile(path, beforePath, options);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new StableFileIdentityRaceError(
          messages.changedBeforeOpen(path),
        );
      }
      throw error;
    }

    const beforeOpened = await handle.stat();
    if (!sameFileSnapshotIdentity(beforePath, beforeOpened)) {
      throw new StableFileIdentityRaceError(
        messages.changedBeforeOpen(path),
      );
    }
    const bytes = await readOpenedFileExactly(handle, beforeOpened.size);
    const afterOpened = await handle.stat();
    let afterPath: Stats;
    try {
      afterPath = await lstat(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new StableFileIdentityRaceError(
          messages.changedWhileReading(path),
        );
      }
      throw error;
    }
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileSnapshotIdentity(beforeOpened, afterOpened) ||
      !sameFileSnapshotIdentity(beforeOpened, afterPath)
    ) {
      throw new StableFileIdentityRaceError(
        messages.changedWhileReading(path),
      );
    }
    return bytes;
  } finally {
    await handle?.close();
  }
};

const readStableRegularFileOnceSync = (
  path: string,
  options: StableRegularFileReadOptions,
): Buffer | undefined => {
  const messages = options.messages ?? DEFAULT_MESSAGES;
  let beforePath: Stats;
  try {
    beforePath = lstatSync(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  assertValidRegularFile(path, beforePath, options);

  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new StableFileIdentityRaceError(
        messages.changedBeforeOpen(path),
      );
    }
    throw error;
  }

  try {
    const beforeOpened = fstatSync(descriptor);
    if (!sameFileSnapshotIdentity(beforePath, beforeOpened)) {
      throw new StableFileIdentityRaceError(
        messages.changedBeforeOpen(path),
      );
    }
    const bytes = readOpenedFileExactlySync(descriptor, beforeOpened.size);
    const afterOpened = fstatSync(descriptor);
    let afterPath: Stats;
    try {
      afterPath = lstatSync(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new StableFileIdentityRaceError(
          messages.changedWhileReading(path),
        );
      }
      throw error;
    }
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileSnapshotIdentity(beforeOpened, afterOpened) ||
      !sameFileSnapshotIdentity(beforeOpened, afterPath)
    ) {
      throw new StableFileIdentityRaceError(
        messages.changedWhileReading(path),
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

export const readStableRegularFile = async (
  path: string,
  options: StableRegularFileReadOptions,
): Promise<Buffer | undefined> =>
  // Atomic replacement is a valid internal write pattern. Re-run the entire
  // lstat/open/read/identity sequence so no unchecked generation is accepted.
  retryStableFileIdentityRace(() =>
    readStableRegularFileOnce(path, options),
  );

export const readStableRegularFileSync = (
  path: string,
  options: StableRegularFileReadOptions,
): Buffer | undefined =>
  retryStableFileIdentityRaceSync(() =>
    readStableRegularFileOnceSync(path, options),
  );
