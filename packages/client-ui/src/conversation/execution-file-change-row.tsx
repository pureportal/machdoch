import { type JSX, useMemo, useRef, useState } from 'react';
import type { TaskFileChangeReader, TaskExecutionFileChange } from '@machdoch/fleet-protocol/task-file-changes';
import { ControlTooltip } from '@machdoch/media-studio/tauri/ui/components/ui/tooltip.js';
import { cn } from '@machdoch/media-studio/tauri/ui/lib/utils.js';
import { getLineDelta, getFileRangeSummary, createFileChangeTitle, normalizeFileChangePageRanges, normalizePageCursor, getFileOperationLabel, getFileOperationClassName, getFileOperationSymbol, getRepositoryRelativeFilePath, getExpandedRangeLabel } from './execution-file-change-model';

interface FileChangeRowProps {
  reader: TaskFileChangeReader;
  changeSetId?: string;
  file: TaskExecutionFileChange;
  onOpenFile: (path: string) => void;
}

export const FileChangeRow = ({
  reader,
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
      const page = await reader.getHunks(
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
      <ControlTooltip content={title}>
        <button
          type="button"
          aria-label={`${getFileOperationLabel(file)} ${file.path}, ${rangeSummary}`}
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
      </ControlTooltip>

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
          <ol
            className="space-y-1"
            aria-label={`${file.path} changed line ranges`}
          >
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

