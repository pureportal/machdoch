import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { ExternalLink, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  loadWorkspaceGitDiff,
  type WorkspaceGitChange,
  type WorkspaceGitDiff,
  type WorkspaceGitPatch,
} from "../runtime";
import { workspaceDiffLineTone } from "./workspace-git-model";

const PATCH_LABELS: Record<WorkspaceGitPatch["kind"], string> = {
  staged: "Staged",
  unstaged: "Working tree",
  untracked: "Untracked",
};

const DiffPatch = ({ patch }: { patch: WorkspaceGitPatch }): JSX.Element => (
  <section className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70">
    <header className="flex h-8 items-center gap-2 border-b border-slate-800 px-3">
      <h5 className="text-[11px] font-medium text-slate-400">
        {PATCH_LABELS[patch.kind]}
      </h5>
      {patch.binary ? (
        <span className="text-[10px] text-slate-500">Binary</span>
      ) : null}
    </header>
    <CopyContextMenu values={[{ label: "Copy diff", value: patch.content }]}>
      <pre
        tabIndex={0}
        aria-label={`${PATCH_LABELS[patch.kind]} diff`}
        className="max-h-[32rem] overflow-auto py-2 font-mono text-[11px] leading-5 text-slate-400 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500/70"
      >
        <code>
          {(patch.content || "No textual diff available.")
            .split(/\r?\n/u)
            .map((line, index) => {
              const tone = workspaceDiffLineTone(line);
              return (
                <span
                  key={`${index}:${line.slice(0, 24)}`}
                  className={cn(
                    "block min-w-max px-3",
                    tone === "addition" && "bg-emerald-950/35 text-emerald-300",
                    tone === "deletion" && "bg-red-950/35 text-red-300",
                    tone === "hunk" && "text-sky-300",
                    tone === "header" && "text-slate-500",
                  )}
                >
                  {line || " "}
                </span>
              );
            })}
        </code>
      </pre>
    </CopyContextMenu>
    {patch.truncated ? (
      <p
        role="status"
        className="border-t border-slate-800 px-3 py-2 text-xs text-amber-300"
      >
        Diff truncated
      </p>
    ) : null}
  </section>
);

export const WorkspaceGitDiffView = ({
  workspaceRoot,
  repositoryRoot,
  change,
  revision,
  onOpenFile,
  onRevealFile,
}: {
  workspaceRoot: string;
  repositoryRoot: string;
  change: WorkspaceGitChange;
  revision: unknown;
  onOpenFile: () => void;
  onRevealFile: () => void;
}): JSX.Element => {
  const [diff, setDiff] = useState<WorkspaceGitDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    void loadWorkspaceGitDiff(workspaceRoot, repositoryRoot, change.path)
      .then((nextDiff) => {
        if (requestId === requestIdRef.current) setDiff(nextDiff);
      })
      .catch((failure: unknown) => {
        if (requestId === requestIdRef.current) {
          setDiff(null);
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [change.path, reloadKey, repositoryRoot, revision, workspaceRoot]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col gap-3"
      aria-label={`Diff for ${change.path}`}
    >
      <header className="flex min-h-8 min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <h4 className="truncate font-mono text-xs text-slate-200">
            {change.path}
          </h4>
          {change.originalPath ? (
            <p className="truncate font-mono text-[10px] text-slate-500">
              {change.originalPath}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Open file"
          disabled={change.status.includes("D")}
          onClick={onOpenFile}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Reveal in folder"
          onClick={onRevealFile}
        >
          <FolderOpen className="size-3.5" />
        </Button>
      </header>
      {loading && !diff ? (
        <div
          role="status"
          aria-label="Loading diff"
          className="grid h-28 place-items-center rounded-lg border border-slate-800"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-5 animate-spin text-slate-500"
          />
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/25 px-3 py-2 text-xs text-red-200"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setReloadKey((current) => current + 1)}
          >
            Retry
          </Button>
        </div>
      ) : (
        diff?.patches.map((patch) => (
          <DiffPatch key={patch.kind} patch={patch} />
        ))
      )}
    </section>
  );
};
