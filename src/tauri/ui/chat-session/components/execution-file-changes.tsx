import {
  ChevronDown,
  FileDiff,
  GitBranch,
  TriangleAlert,
} from "lucide-react";
import { type JSX, useState } from "react";
import type {
  TaskExecutionFileChange,
  TaskExecutionFileChanges,
} from "../../../../core/types.js";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";

const formatLineSpan = (start: number, lines: number): string => {
  return lines <= 1 ? `${start}` : `${start}-${start + lines - 1}`;
};

const getFileKindLabel = (file: TaskExecutionFileChange): string => {
  if (file.kind === "added") {
    return "Added";
  }

  if (file.kind === "deleted") {
    return "Deleted";
  }

  return "Modified";
};

const getFileRangeSummary = (file: TaskExecutionFileChange): string => {
  if (file.binary) {
    return "Binary file";
  }

  const ranges = (file.ranges ?? []).slice(0, 2).map((range) => {
    if (range.newLines === 0) {
      return `removed ${formatLineSpan(range.oldStart, range.oldLines)}`;
    }

    if (range.oldLines === 0) {
      return `lines ${formatLineSpan(range.newStart, range.newLines)}`;
    }

    return `lines ${formatLineSpan(range.newStart, range.newLines)}`;
  });

  if (ranges.length === 0) {
    return "Line ranges unavailable";
  }

  const remainingRanges = (file.ranges?.length ?? 0) - ranges.length;
  return `${ranges.join(", ")}${remainingRanges > 0 ? `, +${remainingRanges} more` : ""}`;
};

const createFileChangeTitle = (file: TaskExecutionFileChange): string => {
  const lineDelta = [
    file.additions !== undefined ? `+${file.additions}` : undefined,
    file.deletions !== undefined ? `\u2212${file.deletions}` : undefined,
  ].filter((entry): entry is string => entry !== undefined);

  return [
    `${getFileKindLabel(file)}: ${file.path}`,
    ...(file.binary ? ["binary"] : lineDelta),
    getFileRangeSummary(file),
  ].join(" \u2022 ");
};

const getFileKindClassName = (file: TaskExecutionFileChange): string => {
  if (file.kind === "added") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
  }

  if (file.kind === "deleted") {
    return "border-rose-500/25 bg-rose-500/10 text-rose-300";
  }

  return "border-sky-500/25 bg-sky-500/10 text-sky-300";
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

export interface ExecutionFileChangesProps {
  fileChanges: TaskExecutionFileChanges;
  onOpenWorkspaceFile: (relativePath: string) => void;
}

export const ExecutionFileChanges = ({
  fileChanges,
  onOpenWorkspaceFile,
}: ExecutionFileChangesProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const repositoryGroups = groupFilesByRepository(fileChanges.files);
  const repositoryCount = Math.max(
    repositoryGroups.length,
    fileChanges.repositoryCount ?? 0,
  );
  const hasMultipleRepositories = repositoryCount > 1;
  const showRepositoryHeaders =
    hasMultipleRepositories ||
    repositoryGroups.some((group) => group.repositoryPath !== ".");
  const warnings = Array.from(
    new Set([
      ...(fileChanges.warnings ?? []),
      ...(fileChanges.truncated
        ? ["The stored file or line-range list was truncated."]
        : []),
    ]),
  );
  const summaryLabel = `${fileChanges.totalFiles} file change${fileChanges.totalFiles === 1 ? "" : "s"}${
    hasMultipleRepositories
      ? ` across ${repositoryCount} repositories`
      : ""
  }`;
  const accessibilityLabel = [
    summaryLabel,
    `${fileChanges.additions} additions`,
    `${fileChanges.deletions} deletions`,
    "Open file changes",
  ].join(", ");

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
            fileChanges.coverage === "partial" &&
              "border-amber-500/30 bg-amber-500/10 text-amber-100 hover:border-amber-400/40 hover:bg-amber-500/15",
          )}
        >
          <FileDiff className="h-3.5 w-3.5" />
          <span>{summaryLabel}</span>
          {fileChanges.additions > 0 ? (
            <span className="text-emerald-300">{`+${fileChanges.additions}`}</span>
          ) : null}
          {fileChanges.deletions > 0 ? (
            <span className="text-rose-300">{`\u2212${fileChanges.deletions}`}</span>
          ) : null}
          <ChevronDown className="h-3 w-3 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[min(30rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border-slate-700/80 bg-slate-950/98 p-0 text-slate-100 shadow-2xl backdrop-blur-xl"
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
                fileChanges.coverage === "complete"
                  ? "border-sky-500/25 bg-sky-500/10 text-sky-200"
                  : "border-amber-500/25 bg-amber-500/10 text-amber-200",
              )}
            >
              {fileChanges.coverage === "complete" ? "Complete" : "Partial"}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
            <span className="text-slate-300">{summaryLabel}</span>
            <span className="text-emerald-300">{`+${fileChanges.additions}`}</span>
            <span className="text-rose-300">{`\u2212${fileChanges.deletions}`}</span>
            {fileChanges.binaryFiles > 0 ? (
              <span className="text-slate-400">{`${fileChanges.binaryFiles} binary`}</span>
            ) : null}
          </div>
        </div>

        {warnings.length > 0 ? (
          <div className="mx-3 mt-3 flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100/90">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span>{warnings.join(" ")}</span>
          </div>
        ) : null}

        <div
          aria-label="Changed files"
          className="max-h-80 overflow-y-auto overscroll-contain p-2"
        >
          {fileChanges.files.length > 0 ? (
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
                      {`${group.files.length} file${group.files.length === 1 ? "" : "s"}`}
                    </span>
                  </div>
                ) : null}

                {group.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    aria-label={`${getFileKindLabel(file)} ${file.path}, ${getFileRangeSummary(file)}`}
                    title={createFileChangeTitle(file)}
                    disabled={file.kind === "deleted"}
                    onClick={() => handleOpenFile(file.path)}
                    className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-slate-900 focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:cursor-default disabled:opacity-75"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold",
                        getFileKindClassName(file),
                      )}
                    >
                      {file.kind === "added"
                        ? "A"
                        : file.kind === "deleted"
                          ? "D"
                          : "M"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-slate-200 group-hover:text-white">
                        {getRepositoryRelativeFilePath(file)}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                        {getFileRangeSummary(file)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold">
                      {file.additions !== undefined && file.additions > 0 ? (
                        <span className="text-emerald-300">{`+${file.additions}`}</span>
                      ) : null}
                      {file.deletions !== undefined && file.deletions > 0 ? (
                        <span className="text-rose-300">{`\u2212${file.deletions}`}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </section>
            ))
          ) : (
            <p className="px-3 py-6 text-center text-xs text-slate-500">
              Stored file paths are unavailable for this task.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-500">
          <span>
            {fileChanges.lineCountsComplete
              ? "Line counts captured"
              : "Some line counts unavailable"}
          </span>
          {fileChanges.files.length < fileChanges.totalFiles ? (
            <span>{`Showing ${fileChanges.files.length} of ${fileChanges.totalFiles}`}</span>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};
