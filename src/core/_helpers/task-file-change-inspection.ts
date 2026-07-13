import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import type { TaskExecutionFileChange } from "../types.js";

const MAX_FILES_TO_INSPECT = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_INSPECTIONS = 8;

interface InspectableFile {
  path: string;
  size: number;
}

interface FileSelection {
  files: InspectableFile[];
  complete: boolean;
}

export interface FileFingerprintResult {
  fingerprints: Map<string, string>;
  complete: boolean;
}

const mapInBatches = async <Value>(
  paths: readonly string[],
  mapper: (path: string) => Promise<Value>,
): Promise<Value[]> => {
  const results: Value[] = [];

  for (
    let index = 0;
    index < paths.length;
    index += MAX_CONCURRENT_INSPECTIONS
  ) {
    const batch = paths.slice(index, index + MAX_CONCURRENT_INSPECTIONS);
    results.push(...(await Promise.all(batch.map(mapper))));
  }

  return results;
};

const selectInspectableFiles = async (
  paths: readonly string[],
  workspaceRoot: string,
): Promise<FileSelection> => {
  const boundedPaths = paths.slice(0, MAX_FILES_TO_INSPECT);
  const candidates = await mapInBatches(
    boundedPaths,
    async (path): Promise<InspectableFile | undefined> => {
      try {
        const fileStat = await lstat(resolve(workspaceRoot, path));

        if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
          return undefined;
        }

        return { path, size: fileStat.size };
      } catch {
        return undefined;
      }
    },
  );
  const files: InspectableFile[] = [];
  let selectedBytes = 0;
  let complete = paths.length <= boundedPaths.length;

  for (const candidate of candidates) {
    if (!candidate || selectedBytes + candidate.size > MAX_TOTAL_BYTES) {
      complete = false;
      continue;
    }

    files.push(candidate);
    selectedBytes += candidate.size;
  }

  return { files, complete };
};

const readBoundedFile = async (
  absolutePath: string,
): Promise<Buffer | undefined> => {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(absolutePath, "r");
    const content = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    const { bytesRead } = await fileHandle.read(
      content,
      0,
      content.length,
      0,
    );

    return bytesRead > MAX_FILE_BYTES
      ? undefined
      : content.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
};

const countBufferLines = (content: Buffer): number => {
  if (content.length === 0) {
    return 0;
  }

  let lines = 0;

  for (const byte of content) {
    if (byte === 10) {
      lines += 1;
    }
  }

  return content[content.length - 1] === 10 ? lines : lines + 1;
};

export const fingerprintUntrackedFiles = async (
  paths: readonly string[],
  workspaceRoot: string,
): Promise<FileFingerprintResult> => {
  const selection = await selectInspectableFiles(paths, workspaceRoot);
  const fingerprints = new Map<string, string>();
  const results = await mapInBatches(
    selection.files.map((file) => file.path),
    async (path): Promise<readonly [string, string] | undefined> => {
      const content = await readBoundedFile(resolve(workspaceRoot, path));

      return content
        ? [path, createHash("sha256").update(content).digest("base64url")]
        : undefined;
    },
  );

  for (const result of results) {
    if (result) {
      fingerprints.set(...result);
    }
  }

  return {
    fingerprints,
    complete:
      selection.complete && fingerprints.size === selection.files.length,
  };
};

export const inspectNewUntrackedFiles = async (
  paths: readonly string[],
  changes: Map<string, TaskExecutionFileChange>,
  workspaceRoot: string,
): Promise<void> => {
  const selection = await selectInspectableFiles(paths, workspaceRoot);
  const inspectedFiles = await mapInBatches(
    selection.files.map((file) => file.path),
    async (
      path,
    ): Promise<readonly [string, TaskExecutionFileChange] | undefined> => {
      const content = await readBoundedFile(resolve(workspaceRoot, path));
      const existing = changes.get(path);

      if (!content || !existing) {
        return undefined;
      }

      if (content.includes(0)) {
        return [path, { ...existing, binary: true }];
      }

      const lineCount = countBufferLines(content);
      return [
        path,
        {
          ...existing,
          additions: lineCount,
          deletions: 0,
          ...(content.length > 0
            ? {
                ranges: [
                  {
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: lineCount,
                  },
                ],
              }
            : {}),
        },
      ];
    },
  );

  for (const inspectedFile of inspectedFiles) {
    if (inspectedFile) {
      changes.set(...inspectedFile);
    }
  }
};
