import { GitCommitVertical, LoaderCircle } from "lucide-react";
import { useState, type JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import type { WorkspaceGitFileHistory } from "@machdoch/fleet-protocol/workspace-contract";
import { formatWorkspaceGitTime } from "./workspace-git-time";
import { loadWorkspaceGitFileHistory } from "./workspace-tools-runtime";

export interface FileHistoryRevision {
  revision: string;
  path: string;
  label: string;
}

export const WorkspaceFileHistoryMenu = ({
  workspaceRoot,
  repositoryRoot,
  relativePath,
  onCompare,
}: {
  workspaceRoot: string;
  repositoryRoot: string;
  relativePath: string;
  onCompare: (revision: FileHistoryRevision) => void;
}): JSX.Element => {
  const [history, setHistory] = useState<WorkspaceGitFileHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setError(null);
    void loadWorkspaceGitFileHistory(
      workspaceRoot,
      repositoryRoot,
      relativePath,
    )
      .then(setHistory)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      );
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="File history"
          tooltip="File history"
        >
          <GitCommitVertical className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-96 w-80 overflow-y-auto"
      >
        {error ? (
          <p role="alert" className="px-2 py-1.5 text-xs text-red-300">
            {error}
          </p>
        ) : !history || history.relativePath !== relativePath ? (
          <div
            role="status"
            aria-label="Loading history"
            className="grid h-16 place-items-center"
          >
            <LoaderCircle className="size-4 animate-spin text-slate-500" />
          </div>
        ) : history.commits.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-slate-500">No commits</p>
        ) : (
          history.commits.map((commit) => (
            <DropdownMenuItem
              key={commit.hash}
              className="flex-col items-start gap-0.5"
              onSelect={() =>
                onCompare({
                  revision: commit.hash,
                  path: commit.path,
                  label: commit.shortHash,
                })
              }
            >
              <span className="w-full truncate text-xs text-slate-200">
                {commit.subject}
              </span>
              <span className="flex w-full gap-2 text-[10px] text-slate-500">
                <code className="text-sky-300">{commit.shortHash}</code>
                <span className="truncate">{commit.author}</span>
                <span className="ml-auto shrink-0">
                  {formatWorkspaceGitTime(commit.authoredAt)}
                </span>
                {commit.path !== relativePath ? (
                  <span className="truncate">{commit.path}</span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
