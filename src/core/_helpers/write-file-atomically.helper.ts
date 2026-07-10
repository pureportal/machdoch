import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const ATOMIC_TEMPORARY_FILE_PATTERN = /^\..+\.\d+\.[0-9a-f-]+\.tmp$/iu;
const ATOMIC_REPLACE_RETRY_DELAYS_MS = [0, 5, 10, 25, 50, 100, 250] as const;

const isTransientAtomicReplaceError = (error: unknown): boolean => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";

  return code === "EBUSY" || code === "EACCES" || code === "EPERM";
};

const replaceFileAtomically = async (
  temporaryPath: string,
  path: string,
): Promise<void> => {
  let lastError: unknown;

  for (const delayMs of ATOMIC_REPLACE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await rename(temporaryPath, path);
      return;
    } catch (error) {
      if (!isTransientAtomicReplaceError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const scavengeAtomicTemporaryFiles = async (
  directory: string,
  options: { maxAgeMs?: number; now?: number } = {},
): Promise<number> => {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
  const now = options.now ?? Date.now();
  let removed = 0;

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !ATOMIC_TEMPORARY_FILE_PATTERN.test(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);
    const metadata = await stat(path).catch(() => undefined);
    if (!metadata || now - metadata.mtimeMs < maxAgeMs) {
      continue;
    }

    await rm(path, { force: true });
    removed += 1;
  }

  return removed;
};

export const writeFileAtomically = async (
  path: string,
  data: string | NodeJS.ArrayBufferView,
  encoding: BufferEncoding = "utf8",
): Promise<void> => {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true });

  try {
    const handle = await open(temporaryPath, "wx");
    try {
      if (typeof data === "string") {
        await handle.writeFile(data, encoding);
      } else {
        await handle.writeFile(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFileAtomically(temporaryPath, path);

    // Persist the directory entry where the platform supports directory fsync.
    // Windows rejects opening directories; the file itself is still flushed.
    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const writeJsonAtomically = async (
  path: string,
  value: unknown,
): Promise<void> => {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
