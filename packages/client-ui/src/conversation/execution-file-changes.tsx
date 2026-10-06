import { ChevronDown, FileDiff, GitBranch, LoaderCircle, TriangleAlert } from 'lucide-react';
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@machdoch/media-studio/tauri/ui/lib/utils.js';
import type { TaskExecutionFileChanges, TaskFileChangeReader } from '@machdoch/fleet-protocol/task-file-changes';
import { Button } from '@machdoch/media-studio/tauri/ui/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@machdoch/media-studio/tauri/ui/components/ui/popover.js';
import { FileChangeRow } from './execution-file-change-row';
import { type StoredFileChange, groupFilesByRepository, getRepositoryLabel, normalizeFileChangePageFiles, normalizePageCursor, validateFilePage, mergeFileChangePages } from './execution-file-change-model';

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
  reader: TaskFileChangeReader;
  fileChanges: TaskExecutionFileChanges;
  onOpenWorkspaceFile: (relativePath: string) => void;
}

export const ExecutionFileChanges = ({
  reader,
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
    hasMultipleRepositories ? ` across ${repositoryCount} repositories` : ""
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
    void reader
      .getFiles(fileChanges.changeSetId)
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
    reader,
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
      const page = await reader.getFiles(fileChanges.changeSetId, nextCursor);
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
                    reader={reader}
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
