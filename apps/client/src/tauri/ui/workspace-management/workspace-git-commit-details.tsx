import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceGitCommitFile,
  WorkspaceGitGraphCommit,
  WorkspaceGitOverview,
} from "../runtime";
import {
  loadCachedWorkspaceGitCommit,
  useWorkspaceGitCommit,
} from "./use-workspace-git-graph";
import { WorkspaceGitPatchView } from "./workspace-git-diff";
import { WorkspaceGitLineStats } from "./workspace-git-line-stats";
import { formatWorkspaceGitTime } from "./workspace-git-time";

const FILE_TONES: Record<string, string> = {
  A: "text-emerald-300",
  D: "text-rose-300",
  M: "text-amber-300",
  T: "text-violet-300",
};

const Loading = ({ label }: { label: string }): JSX.Element => (
  <div role="status" aria-label={label} className="py-2">
    <LoaderCircle className="size-4 animate-spin text-slate-500" />
  </div>
);

const FileRow = ({
  file,
  selected,
  onSelect,
  onPrefetch,
}: {
  file: WorkspaceGitCommitFile;
  selected: boolean;
  onSelect: () => void;
  onPrefetch: () => void;
}): JSX.Element => (
  <li>
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-(--app-hover) focus-visible:ring-1 focus-visible:ring-sky-500/70",
        selected && "bg-sky-500/15 hover:bg-sky-500/20",
      )}
    >
      <code
        aria-hidden="true"
        className={cn(
          "w-3 shrink-0 text-center text-xs font-semibold",
          FILE_TONES[file.status] ?? "text-slate-400",
        )}
      >
        {file.status}
      </code>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">
        {file.path}
      </span>
      <WorkspaceGitLineStats
        additions={file.additions}
        deletions={file.deletions}
        blocks
      />
    </button>
  </li>
);

export const WorkspaceGitChangedFiles = ({
  overview,
  commit,
  base,
}: {
  overview: WorkspaceGitOverview;
  commit: string;
  base?: string;
}): JSX.Element => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const { detail, error } = useWorkspaceGitCommit(overview, commit, { base });
  const file = useWorkspaceGitCommit(overview, selectedPath ? commit : null, {
    base,
    relativePath: selectedPath ?? undefined,
  });
  const prefetch = (relativePath: string): void => {
    void loadCachedWorkspaceGitCommit(
      overview.workspaceRoot,
      overview.repositoryRoot,
      commit,
      { base, relativePath },
    ).catch(() => undefined);
  };
  if (error) {
    return (
      <p role="alert" className="text-xs text-red-300">
        {error}
      </p>
    );
  }
  if (!detail) return <Loading label="Loading changed files" />;
  return (
    <div className="space-y-3">
      <ul aria-label="Changed files" className="space-y-px">
        {detail.files.map((entry) => (
          <FileRow
            key={entry.path}
            file={entry}
            selected={entry.path === selectedPath}
            onSelect={() =>
              setSelectedPath((current) =>
                current === entry.path ? null : entry.path,
              )
            }
            onPrefetch={() => prefetch(entry.path)}
          />
        ))}
        {detail.filesTruncated ? (
          <li className="px-2 text-[11px] text-slate-500">
            Showing {detail.files.length} files
          </li>
        ) : null}
      </ul>
      {selectedPath ? (
        file.error ? (
          <p role="alert" className="text-xs text-red-300">
            {file.error}
          </p>
        ) : file.detail?.patch ? (
          <WorkspaceGitPatchView
            patch={file.detail.patch}
            label={selectedPath}
          />
        ) : file.detail ? null : (
          <Loading label="Loading diff" />
        )
      ) : null}
    </div>
  );
};

export const WorkspaceGitCommitDetails = ({
  overview,
  commit,
  resetBranch,
  busy,
  onReset,
}: {
  overview: WorkspaceGitOverview;
  commit: WorkspaceGitGraphCommit;
  resetBranch: string | null;
  busy: boolean;
  onReset: () => void;
}): JSX.Element => {
  const { detail } = useWorkspaceGitCommit(overview, commit.hash);
  const body = detail?.message.split("\n").slice(1).join("\n").trim();
  return (
    <div className="min-w-0 flex-1 space-y-3 py-2 pr-2 pl-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <CopyContextMenu
          values={[
            { label: "Copy commit hash", value: commit.hash },
            { label: "Copy subject", value: commit.subject },
          ]}
        >
          <code className="text-sky-300">{commit.hash.slice(0, 12)}</code>
        </CopyContextMenu>
        <span>{commit.author}</span>
        <time
          dateTime={commit.authoredAt}
          title={new Date(commit.authoredAt).toLocaleString()}
        >
          {formatWorkspaceGitTime(commit.authoredAt)}
        </time>
        {commit.parents.length > 1 ? <span>Merge</span> : null}
        <span className="flex-1" />
        {resetBranch ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={onReset}
          >
            <RotateCcw />
            Reset {resetBranch} here
          </Button>
        ) : null}
      </div>
      {body ? (
        <p className="whitespace-pre-wrap text-xs text-slate-300">{body}</p>
      ) : null}
      <WorkspaceGitChangedFiles overview={overview} commit={commit.hash} />
    </div>
  );
};
