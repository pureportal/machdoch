import {
  ChevronDown,
  FileDiff,
  GitBranch,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import type {
  TaskExecutionFileChange,
  TaskExecutionFileChanges,
  TaskExecutionChangedLineRange,
} from "../../../../core/types.js";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import {
  normalizeTaskExecutionChangedLineRange,
  normalizeTaskExecutionFileChange,
} from "../../chat-session.model";
import { cn } from "../../lib/utils";
import {
  getTaskFileChangeFiles,
  getTaskFileChangeHunks,
} from "../../runtime";

type StoredFileChange = TaskExecutionFileChange & {
  storedId: number;
  hunkCount: number;
};

const normalizeFileChangePageFiles = (
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

const normalizeFileChangePageRanges = (
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

const normalizePageCursor = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error("Stored file-change cursor is invalid.");
  }

  return value;
};

const mergeFileChangePages = (
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

const validateFilePage = (
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

const getFileOperationLabel = (file: TaskExecutionFileChange): string => {
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

const getFileRangeSummary = (file: TaskExecutionFileChange): string => {
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

const getLineDelta = (
  file: TaskExecutionFileChange,
): { additions: number; deletions: number } | undefined => {
  return file.lineAnalysis.state === "complete"
    ? {
        additions: file.lineAnalysis.additions,
        deletions: file.lineAnalysis.deletions,
      }
    : undefined;
};

const createFileChangeTitle = (
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

const getFileOperationClassName = (
  file: TaskExecutionFileChange,
): string => {
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

const getFileOperationSymbol = (file: TaskExecutionFileChange): string => {
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

const groupFilesByRepository = (
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

const getRepositoryLabel = (repositoryPath: string): string => {
  return repositoryPath === "." ? "Workspace repository" : repositoryPath;
};

const getRepositoryRelativeFilePath = (
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

const getExpandedRangeLabel = (
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

interface FileChangeRowProps {
  changeSetId?: string;
  file: TaskExecutionFileChange;
  onOpenFile: (path: string) => void;
}

const FileChangeRow = ({
  changeSetId,
  file,
  onOpenFile,
}: FileChangeRowProps): JSX.Element => {
  const previewRanges = file.ranges ?? [];
  const hunkCount = file.hunkCount ?? previewRanges.length;
  const canPageHunks =
    changeSetId !== undefined &&
    file.storedId !== undefined &&
    hunkCount > previewRanges.length;
  const [expanded, setExpanded] = useState(false);
  const [ranges, setRanges] = useState(previewRanges);
  const [nextCursor, setNextCursor] = useState<number | null | undefined>(
    previewRanges.length > 0 ? previewRanges.length - 1 : undefined,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const loadInFlight = useRef(false);
  const lineDelta = getLineDelta(file);
  const rangeSummary = useMemo(() => getFileRangeSummary(file), [file]);
  const title = useMemo(
    () => createFileChangeTitle(file, rangeSummary),
    [file, rangeSummary],
  );

  const loadNextHunkPage = async (): Promise<void> => {
    if (
      !changeSetId ||
      file.storedId === undefined ||
      nextCursor === null ||
      loadInFlight.current
    ) {
      return;
    }

    loadInFlight.current = true;
    setIsLoading(true);
    setLoadError(undefined);
    const requestedCursor = nextCursor;

    try {
      const page = await getTaskFileChangeHunks(
        changeSetId,
        file.storedId,
        nextCursor,
      );
      const normalizedRanges = normalizeFileChangePageRanges(page.ranges);
      const normalizedNextCursor = normalizePageCursor(page.nextCursor);
      const loadedRangeCount = ranges.length + normalizedRanges.length;
      const expectedNextCursor =
        (requestedCursor ?? -1) + normalizedRanges.length;
      if (
        loadedRangeCount > hunkCount ||
        (normalizedNextCursor === null && loadedRangeCount !== hunkCount) ||
        (normalizedNextCursor !== null &&
          (normalizedNextCursor !== expectedNextCursor ||
            loadedRangeCount >= hunkCount))
      ) {
        throw new Error("Stored changed-line page is inconsistent.");
      }
      setRanges((current) => [...current, ...normalizedRanges]);
      setNextCursor(normalizedNextCursor);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      loadInFlight.current = false;
      setIsLoading(false);
    }
  };

  const handleToggleRanges = (): void => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (willExpand && canPageHunks && ranges.length === previewRanges.length) {
      void loadNextHunkPage();
    }
  };

  return (
    <div>
      <button
        type="button"
        aria-label={`${getFileOperationLabel(file)} ${file.path}, ${rangeSummary}`}
        title={title}
        disabled={file.operation === "deleted"}
        onClick={() => onOpenFile(file.path)}
        className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-slate-900 focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:cursor-default disabled:opacity-75"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold",
            getFileOperationClassName(file),
          )}
        >
          {getFileOperationSymbol(file)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-slate-200 group-hover:text-white">
            {file.oldPath
              ? `${file.oldPath} → ${getRepositoryRelativeFilePath(file)}`
              : getRepositoryRelativeFilePath(file)}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-slate-500">
            {rangeSummary}
          </span>
        </span>
        {lineDelta ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold">
            {lineDelta.additions > 0 ? (
              <span className="text-emerald-300">{`+${lineDelta.additions}`}</span>
            ) : null}
            {lineDelta.deletions > 0 ? (
              <span className="text-rose-300">{`−${lineDelta.deletions}`}</span>
            ) : null}
          </span>
        ) : null}
      </button>

      {canPageHunks ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={handleToggleRanges}
          className="ml-12 rounded px-1 py-0.5 text-[10px] font-medium text-sky-400 outline-none hover:text-sky-300 focus-visible:ring-2 focus-visible:ring-sky-500/50"
        >
          {expanded ? "Hide line ranges" : `Show all ${hunkCount} line ranges`}
        </button>
      ) : null}

      {expanded ? (
        <div className="ml-12 mr-2 mt-1 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-2 text-[10px] text-slate-400">
          <ol className="space-y-1" aria-label={`${file.path} changed line ranges`}>
            {ranges.map((range, index) => (
              <li key={`${range.oldStart}:${range.newStart}:${index}`}>
                {getExpandedRangeLabel(range)}
              </li>
            ))}
          </ol>
          {loadError ? (
            <p className="mt-1 text-amber-300">{loadError}</p>
          ) : null}
          {nextCursor !== null && ranges.length < hunkCount ? (
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void loadNextHunkPage()}
              className="mt-1 rounded text-sky-400 outline-none hover:text-sky-300 focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:text-slate-600"
            >
              {isLoading ? "Loading line ranges…" : "Load more line ranges"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const getStatusLabel = (status: TaskExecutionFileChanges["status"]): string => {
  if (status === "complete") {
    return "Complete";
  }

  if (status === "failed") {
    return "Failed";
  }

  return "Partial";
};

export interface ExecutionFileChangesProps {
  fileChanges: TaskExecutionFileChanges;
  onOpenWorkspaceFile: (relativePath: string) => void;
}

export const ExecutionFileChanges = ({
  fileChanges,
  onOpenWorkspaceFile,
}: ExecutionFileChangesProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [pagedFiles, setPagedFiles] = useState<StoredFileChange[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [loadedChangeSetId, setLoadedChangeSetId] = useState<string>();
  const loadMoreInFlight = useRef(false);
  const files = fileChanges.files.length > 0 ? fileChanges.files : pagedFiles;
  const repositoryGroups = useMemo(
    () => groupFilesByRepository(files),
    [files],
  );
  const repositoryCount = Math.max(
    repositoryGroups.length,
    fileChanges.repositoryCount,
  );
  const hasMultipleRepositories = repositoryCount > 1;
  const showRepositoryHeaders =
    hasMultipleRepositories ||
    repositoryGroups.some((group) => group.repositoryPath !== ".");
  const issueMessages = useMemo(
    () =>
      Array.from(
        new Set(
          fileChanges.issues.map((issue) =>
            issue.repositoryPath && issue.repositoryPath !== "."
              ? `${issue.repositoryPath}: ${issue.message}`
              : issue.message,
          ),
        ),
      ),
    [fileChanges.issues],
  );
  const issueSummary = [
    ...issueMessages.slice(0, 3),
    ...(issueMessages.length > 3
      ? [`${issueMessages.length - 3} additional tracking issues.`]
      : []),
    ...(loadError ? [loadError] : []),
  ].join(" ");
  const summaryLabel = `${fileChanges.totalFiles} path change${fileChanges.totalFiles === 1 ? "" : "s"}${
    hasMultipleRepositories
      ? ` across ${repositoryCount} repositories`
      : ""
  }`;
  const accessibilityLabel = [
    summaryLabel,
    `${fileChanges.additions} additions`,
    `${fileChanges.deletions} deletions`,
    `${fileChanges.gitlinkFiles} submodule references`,
    "Open file changes",
  ].join(", ");

  useEffect(() => {
    setPagedFiles([]);
    setNextCursor(null);
    setLoadError(undefined);
    setLoadedChangeSetId(undefined);
  }, [fileChanges.changeSetId]);

  useEffect(() => {
    if (
      !open ||
      !fileChanges.changeSetId ||
      fileChanges.files.length > 0 ||
      loadedChangeSetId === fileChanges.changeSetId
    ) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(undefined);
    void getTaskFileChangeFiles(fileChanges.changeSetId)
      .then((page) => {
        if (cancelled) {
          return;
        }

        const normalizedFiles = normalizeFileChangePageFiles(page.files);
        const normalizedNextCursor = normalizePageCursor(page.nextCursor);
        validateFilePage(
          normalizedFiles,
          normalizedNextCursor,
          0,
          0,
          fileChanges.totalFiles,
        );
        setPagedFiles(normalizedFiles);
        setNextCursor(normalizedNextCursor);
        setIsLoading(false);
        setLoadedChangeSetId(fileChanges.changeSetId);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    fileChanges.changeSetId,
    fileChanges.files.length,
    loadedChangeSetId,
    open,
  ]);

  const handleLoadMore = async (): Promise<void> => {
    if (
      !fileChanges.changeSetId ||
      nextCursor === null ||
      loadMoreInFlight.current
    ) {
      return;
    }

    loadMoreInFlight.current = true;
    setIsLoading(true);
    setLoadError(undefined);
    const requestedCursor = nextCursor;

    try {
      const page = await getTaskFileChangeFiles(
        fileChanges.changeSetId,
        nextCursor,
      );
      const normalizedFiles = normalizeFileChangePageFiles(page.files);
      const normalizedNextCursor = normalizePageCursor(page.nextCursor);
      validateFilePage(
        normalizedFiles,
        normalizedNextCursor,
        requestedCursor,
        pagedFiles.length,
        fileChanges.totalFiles,
      );
      setPagedFiles((current) =>
        mergeFileChangePages(current, normalizedFiles),
      );
      setNextCursor(normalizedNextCursor);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      loadMoreInFlight.current = false;
      setIsLoading(false);
    }
  };

  const handleOpenFile = (path: string): void => {
    setOpen(false);
    onOpenWorkspaceFile(path);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={accessibilityLabel}
          className={cn(
            "app-file-changes-trigger group h-7 rounded-lg border-sky-500/25 bg-sky-500/10 px-2 text-[11px] font-semibold text-sky-100 shadow-none hover:border-sky-400/35 hover:bg-sky-500/15 hover:text-white",
            fileChanges.status !== "complete" &&
              "border-amber-500/30 bg-amber-500/10 text-amber-100 hover:border-amber-400/40 hover:bg-amber-500/15",
          )}
        >
          <FileDiff className="h-3.5 w-3.5" />
          <span>{summaryLabel}</span>
          {fileChanges.additions > 0 ? (
            <span className="text-emerald-300">{`+${fileChanges.additions}`}</span>
          ) : null}
          {fileChanges.deletions > 0 ? (
            <span className="text-rose-300">{`−${fileChanges.deletions}`}</span>
          ) : null}
          <ChevronDown className="h-3 w-3 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border-slate-700/80 bg-slate-950/98 p-0 text-slate-100 shadow-2xl backdrop-blur-xl"
      >
        <div className="border-b border-slate-800 px-4 py-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-100">
                File changes
              </p>
              <p className="mt-0.5 text-xs leading-5 text-slate-400">
                {hasMultipleRepositories
                  ? `Workspace changes observed across ${repositoryCount} Git repositories.`
                  : "Workspace changes observed while this task was running."}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                fileChanges.status === "complete"
                  ? "border-sky-500/25 bg-sky-500/10 text-sky-200"
                  : "border-amber-500/25 bg-amber-500/10 text-amber-200",
              )}
            >
              {getStatusLabel(fileChanges.status)}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
            <span className="text-slate-300">{summaryLabel}</span>
            <span className="text-emerald-300">{`+${fileChanges.additions}`}</span>
            <span className="text-rose-300">{`−${fileChanges.deletions}`}</span>
            {fileChanges.binaryFiles > 0 ? (
              <span className="text-slate-400">{`${fileChanges.binaryFiles} binary`}</span>
            ) : null}
            {fileChanges.gitlinkFiles > 0 ? (
              <span className="text-violet-300">{`${fileChanges.gitlinkFiles} submodule ref${fileChanges.gitlinkFiles === 1 ? "" : "s"}`}</span>
            ) : null}
          </div>
        </div>

        {issueMessages.length > 0 || loadError ? (
          <div className="mx-3 mt-3 flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100/90">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span>{issueSummary}</span>
          </div>
        ) : null}

        <div
          aria-label="Changed files"
          className="max-h-80 overflow-y-auto overscroll-contain p-2"
        >
          {files.length > 0 ? (
            repositoryGroups.map((group) => (
              <section
                key={group.repositoryPath}
                aria-label={`${getRepositoryLabel(group.repositoryPath)} changes`}
                className="py-0.5"
              >
                {showRepositoryHeaders ? (
                  <div className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-[11px] font-semibold text-slate-400">
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
                    <span className="min-w-0 flex-1 truncate">
                      {getRepositoryLabel(group.repositoryPath)}
                    </span>
                    <span className="shrink-0 font-medium text-slate-600">
                      {`${group.files.length} path${group.files.length === 1 ? "" : "s"}`}
                    </span>
                  </div>
                ) : null}

                {group.files.map((file) => (
                  <FileChangeRow
                    key={
                      file.storedId === undefined
                        ? `inline\0${file.oldPath ?? ""}\0${file.path}`
                        : `stored\0${file.storedId}`
                    }
                    changeSetId={fileChanges.changeSetId}
                    file={file}
                    onOpenFile={handleOpenFile}
                  />
                ))}
              </section>
            ))
          ) : isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-slate-400">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading changed paths…
            </div>
          ) : (
            <p className="px-3 py-6 text-center text-xs text-slate-500">
              {fileChanges.totalFiles === 0
                ? "No changed paths were captured."
                : "Changed paths could not be loaded."}
            </p>
          )}

          {nextCursor !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoading}
              onClick={() => void handleLoadMore()}
              className="mt-1 w-full text-xs text-slate-400"
            >
              {isLoading ? "Loading…" : "Load more changed paths"}
            </Button>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-500">
          <span>
            {fileChanges.failedFiles === 0
              ? "All applicable line counts captured"
              : `${fileChanges.failedFiles} line analysis failure${fileChanges.failedFiles === 1 ? "" : "s"}`}
          </span>
          {files.length < fileChanges.totalFiles ? (
            <span>{`Loaded ${files.length} of ${fileChanges.totalFiles}`}</span>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};
