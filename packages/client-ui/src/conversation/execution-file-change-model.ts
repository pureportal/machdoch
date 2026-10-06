import type { TaskExecutionFileChange, TaskExecutionChangedLineRange } from '@machdoch/fleet-protocol/task-file-changes';
import { normalizeTaskExecutionChangedLineRange, normalizeTaskExecutionFileChange } from '@machdoch/fleet-protocol/task-file-change-normalization';

export type StoredFileChange = TaskExecutionFileChange & {
  storedId: number;
  hunkCount: number;
};

export const normalizeFileChangePageFiles = (
  files: readonly unknown[],
): StoredFileChange[] => {
  const normalizedFiles: StoredFileChange[] = [];
  let previousId = 0;

  for (const file of files) {
    const normalizedFile = normalizeTaskExecutionFileChange(file);

    if (
      !normalizedFile ||
      normalizedFile.storedId === undefined ||
      normalizedFile.hunkCount === undefined ||
      normalizedFile.storedId <= previousId ||
      (normalizedFile.ranges?.length ?? 0) !==
        Math.min(normalizedFile.hunkCount, 2)
    ) {
      throw new Error("Stored changed-file data is invalid.");
    }

    previousId = normalizedFile.storedId;
    normalizedFiles.push({
      ...normalizedFile,
      storedId: normalizedFile.storedId,
      hunkCount: normalizedFile.hunkCount,
    });
  }

  return normalizedFiles;
};

export const normalizeFileChangePageRanges = (
  ranges: readonly unknown[],
): TaskExecutionChangedLineRange[] => {
  const normalizedRanges: TaskExecutionChangedLineRange[] = [];

  for (const range of ranges) {
    const normalizedRange = normalizeTaskExecutionChangedLineRange(range);

    if (!normalizedRange) {
      throw new Error("Stored changed-line data is invalid.");
    }

    normalizedRanges.push(normalizedRange);
  }

  return normalizedRanges;
};

export const normalizePageCursor = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Stored file-change cursor is invalid.");
  }

  return value;
};

export const mergeFileChangePages = (
  current: readonly StoredFileChange[],
  next: readonly StoredFileChange[],
): StoredFileChange[] => {
  const merged = new Map<number, StoredFileChange>();

  for (const file of current) {
    merged.set(file.storedId, file);
  }

  for (const file of next) {
    merged.set(file.storedId, file);
  }

  return Array.from(merged.values());
};

export const validateFilePage = (
  files: readonly StoredFileChange[],
  nextCursor: number | null,
  afterId: number,
  loadedCount: number,
  totalFiles: number,
): void => {
  if (files.some((file) => file.storedId <= afterId)) {
    throw new Error("Stored changed-file page did not advance.");
  }

  if (
    nextCursor !== null &&
    (files.length === 0 || nextCursor !== files.at(-1)?.storedId)
  ) {
    throw new Error("Stored changed-file cursor did not match its page.");
  }

  const nextLoadedCount = loadedCount + files.length;
  if (
    nextLoadedCount > totalFiles ||
    (nextCursor === null && nextLoadedCount !== totalFiles) ||
    (nextCursor !== null && nextLoadedCount >= totalFiles)
  ) {
    throw new Error("Stored changed-file page count is inconsistent.");
  }
};

const formatLineSpan = (start: number, lines: number): string => {
  return lines <= 1 ? `${start}` : `${start}-${start + lines - 1}`;
};

export const getFileOperationLabel = (file: TaskExecutionFileChange): string => {
  if (file.operation === "added") {
    return "Added";
  }

  if (file.operation === "deleted") {
    return "Deleted";
  }

  if (file.operation === "renamed") {
    return "Renamed";
  }

  if (file.operation === "type-changed") {
    return "Type changed";
  }

  return "Modified";
};

export const getFileRangeSummary = (file: TaskExecutionFileChange): string => {
  if (file.lineAnalysis.state === "failed") {
    return `Line analysis failed: ${file.lineAnalysis.message}`;
  }

  if (file.lineAnalysis.state === "not-applicable") {
    if (file.lineAnalysis.reason === "binary") {
      return "Binary content changed";
    }

    if (file.lineAnalysis.reason === "gitlink") {
      const oldCommit = file.oldCommit?.slice(0, 7) ?? "none";
      const newCommit = file.newCommit?.slice(0, 7) ?? "none";
      return `Submodule reference ${oldCommit} → ${newCommit}`;
    }

    if (file.lineAnalysis.reason === "symlink") {
      return "Symbolic link changed";
    }

    return "File mode changed; no content lines changed";
  }

  const ranges = (file.ranges ?? []).slice(0, 2).map((range) => {
    if (range.newLines === 0) {
      return `removed ${formatLineSpan(range.oldStart, range.oldLines)}`;
    }

    return `lines ${formatLineSpan(range.newStart, range.newLines)}`;
  });

  if (ranges.length === 0) {
    return file.lineAnalysis.additions === 0 &&
      file.lineAnalysis.deletions === 0
      ? "No content lines changed"
      : "Changed-line coordinates are unavailable";
  }

  const totalRanges = file.hunkCount ?? file.ranges?.length ?? 0;
  const remainingRanges = totalRanges - ranges.length;
  return `${ranges.join(", ")}${remainingRanges > 0 ? `, +${remainingRanges} more` : ""}`;
};

export const getLineDelta = (
  file: TaskExecutionFileChange,
): { additions: number; deletions: number } | undefined => {
  return file.lineAnalysis.state === "complete"
    ? {
        additions: file.lineAnalysis.additions,
        deletions: file.lineAnalysis.deletions,
      }
    : undefined;
};

export const createFileChangeTitle = (
  file: TaskExecutionFileChange,
  rangeSummary: string,
): string => {
  const lineDelta = getLineDelta(file);
  const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  return [
    `${getFileOperationLabel(file)}: ${path}`,
    ...(lineDelta
      ? [`+${lineDelta.additions}`, `−${lineDelta.deletions}`]
      : []),
    rangeSummary,
  ].join(" • ");
};

export const getFileOperationClassName = (file: TaskExecutionFileChange): string => {
  if (file.operation === "added") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
  }

  if (file.operation === "deleted") {
    return "border-rose-500/25 bg-rose-500/10 text-rose-300";
  }

  if (file.entryType === "gitlink") {
    return "border-violet-500/25 bg-violet-500/10 text-violet-300";
  }

  return "border-sky-500/25 bg-sky-500/10 text-sky-300";
};

export const getFileOperationSymbol = (file: TaskExecutionFileChange): string => {
  if (file.operation === "added") {
    return "A";
  }

  if (file.operation === "deleted") {
    return "D";
  }

  if (file.operation === "renamed") {
    return "R";
  }

  if (file.operation === "type-changed") {
    return "T";
  }

  return file.entryType === "gitlink" ? "S" : "M";
};

interface RepositoryFileChangeGroup {
  repositoryPath: string;
  files: TaskExecutionFileChange[];
}

export const groupFilesByRepository = (
  files: readonly TaskExecutionFileChange[],
): RepositoryFileChangeGroup[] => {
  const filesByRepository = new Map<string, TaskExecutionFileChange[]>();

  for (const file of files) {
    const repositoryPath = file.repositoryPath ?? ".";
    const repositoryFiles = filesByRepository.get(repositoryPath) ?? [];
    repositoryFiles.push(file);
    filesByRepository.set(repositoryPath, repositoryFiles);
  }

  return Array.from(filesByRepository, ([repositoryPath, repositoryFiles]) => ({
    repositoryPath,
    files: repositoryFiles,
  })).sort((left, right) => {
    if (left.repositoryPath === ".") {
      return -1;
    }

    if (right.repositoryPath === ".") {
      return 1;
    }

    return left.repositoryPath.localeCompare(right.repositoryPath);
  });
};

export const getRepositoryLabel = (repositoryPath: string): string => {
  return repositoryPath === "." ? "Workspace repository" : repositoryPath;
};

export const getRepositoryRelativeFilePath = (
  file: TaskExecutionFileChange,
): string => {
  if (
    !file.repositoryPath ||
    file.repositoryPath === "." ||
    !file.path.startsWith(`${file.repositoryPath}/`)
  ) {
    return file.path;
  }

  return file.path.slice(file.repositoryPath.length + 1);
};

export const getExpandedRangeLabel = (
  range: TaskExecutionChangedLineRange,
): string => {
  if (range.oldLines === 0) {
    return `Added lines ${formatLineSpan(range.newStart, range.newLines)}`;
  }

  if (range.newLines === 0) {
    return `Removed lines ${formatLineSpan(range.oldStart, range.oldLines)}`;
  }

  return `Old lines ${formatLineSpan(range.oldStart, range.oldLines)} → new lines ${formatLineSpan(range.newStart, range.newLines)}`;
};

