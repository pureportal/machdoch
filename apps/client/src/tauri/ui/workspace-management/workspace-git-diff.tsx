import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { ExternalLink, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import type {
  WorkspaceGitChange,
  WorkspaceGitDiff,
  WorkspaceGitPatch,
} from "../runtime";
import { loadCachedWorkspaceGitDiff } from "./workspace-git-diff-cache";
import {
  parseWorkspaceGitPatch,
  workspaceGitPatchStats,
  type WorkspaceGitDiffLine,
} from "./workspace-git-diff-model";
import { WorkspaceGitLineStats } from "./workspace-git-line-stats";

const PATCH_LABELS: Record<WorkspaceGitPatch["kind"], string> = {
  staged: "Staged",
  unstaged: "Working tree",
  untracked: "Untracked",
  commit: "Commit",
};

const LINE_TONES: Record<WorkspaceGitDiffLine["kind"], string> = {
  addition: "bg-emerald-500/10 text-emerald-200",
  deletion: "bg-red-500/10 text-rose-200",
  hunk: "bg-sky-500/10 text-sky-300",
  note: "text-slate-500 italic",
  context: "text-slate-400",
};

export const WorkspaceGitPatchView = ({
  patch,
  label = PATCH_LABELS[patch.kind],
}: {
  patch: WorkspaceGitPatch;
  label?: string;
}): JSX.Element => {
  const lines = useMemo(
    () => parseWorkspaceGitPatch(patch.content),
    [patch.content],
  );
  const stats = workspaceGitPatchStats(lines);
  return (
    <section className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70">
      <header className="flex h-8 items-center gap-2 border-b border-slate-800 px-3">
        <h5 className="text-[11px] font-medium text-slate-400">{label}</h5>
        <WorkspaceGitLineStats
          additions={stats.additions}
          deletions={stats.deletions}
        />
        {patch.binary ? (
          <span className="text-[10px] text-slate-500">Binary</span>
        ) : null}
      </header>
      <CopyContextMenu values={[{ label: "Copy diff", value: patch.content }]}>
        <div
          tabIndex={0}
          role="region"
          aria-label={`${label} diff`}
          className="max-h-[32rem] overflow-auto py-1 font-mono text-[11px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500/70"
        >
          {lines.length === 0 ? (
            <p className="px-3 text-slate-500">No textual diff available.</p>
          ) : (
            <table className="min-w-full border-collapse">
              <tbody>
                {lines.map((line, index) => (
                  <tr
                    key={`${index}:${line.text.slice(0, 24)}`}
                    className={LINE_TONES[line.kind]}
                  >
                    <td className="w-10 min-w-10 select-none border-r border-slate-800 pr-2 text-right text-slate-600 tabular-nums">
                      {line.oldLine ?? ""}
                    </td>
                    <td className="w-10 min-w-10 select-none border-r border-slate-800 pr-2 text-right text-slate-600 tabular-nums">
                      {line.newLine ?? ""}
                    </td>
                    <td className="whitespace-pre px-3">{line.text || " "}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
};

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
  revision: object;
  onOpenFile: () => void;
  onRevealFile: () => void;
}): JSX.Element => {
  const requestKey = `${repositoryRoot}\n${change.path}`;
  const [state, setState] = useState<{
    requestKey: string;
    revision: object;
    diff: WorkspaceGitDiff | null;
    error: string | null;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    loadCachedWorkspaceGitDiff(
      workspaceRoot,
      repositoryRoot,
      change.path,
      revision,
    )
      .then((diff) => {
        if (active) setState({ requestKey, revision, diff, error: null });
      })
      .catch((failure: unknown) => {
        if (active) {
          setState({
            requestKey,
            revision,
            diff: null,
            error: failure instanceof Error ? failure.message : String(failure),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [
    change.path,
    reloadKey,
    repositoryRoot,
    requestKey,
    revision,
    workspaceRoot,
  ]);

  const current = state?.requestKey === requestKey ? state : null;
  const loading = current?.revision !== revision;
  const diff = current?.diff ?? null;
  const error = current?.error ?? null;

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col gap-3"
      aria-label={`Diff for ${change.path}`}
      aria-busy={loading}
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
        {loading && diff ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 animate-spin text-slate-500"
          />
        ) : null}
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
      {loading && !diff && !error ? (
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
            onClick={() => {
              setState(null);
              setReloadKey((current) => current + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        diff?.patches.map((patch) => (
          <WorkspaceGitPatchView key={patch.kind} patch={patch} />
        ))
      )}
    </section>
  );
};
