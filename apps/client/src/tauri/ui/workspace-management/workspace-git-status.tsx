import {
  Check,
  ChevronRight,
  GitCommitHorizontal,
  LoaderCircle,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { cn } from "../lib/utils";
import {
  loadWorkspaceGitDiff,
  type WorkspaceGitChange,
  type WorkspaceGitOverview,
  type WorkspaceGitPatch,
} from "../runtime";
import {
  workspaceDiffLineTone,
  workspaceGitChangeLabel,
} from "./workspace-git-model";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const patchLabel = (patch: WorkspaceGitPatch): string => {
  switch (patch.kind) {
    case "staged":
      return "Staged";
    case "unstaged":
      return "Working tree";
    case "untracked":
      return "Untracked";
  }
};

const DiffPatch = ({ patch }: { patch: WorkspaceGitPatch }): JSX.Element => (
  <section className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70">
    <header className="flex h-9 items-center gap-2 border-b border-slate-800 px-3">
      <h5 className="text-xs font-medium text-slate-300">
        {patchLabel(patch)}
      </h5>
      {patch.binary ? (
        <span className="text-[10px] text-slate-500">Binary</span>
      ) : null}
    </header>
    <pre
      tabIndex={0}
      aria-label={`${patchLabel(patch)} diff`}
      className="max-h-96 overflow-auto py-2 text-[11px] leading-5 text-slate-400 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500/70"
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

const ChangeRow = ({
  change,
  selected,
  onSelect,
}: {
  change: WorkspaceGitChange;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element => {
  const label = workspaceGitChangeLabel(change);
  return (
    <button
      type="button"
      aria-expanded={selected}
      aria-label={`View diff for ${change.path}, ${label}`}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 border-b border-slate-900 px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-slate-900/70 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500/70",
        selected && "bg-sky-950/30",
      )}
    >
      <code
        className={cn(
          "w-7 shrink-0 whitespace-pre text-xs",
          change.conflicted ? "text-red-300" : "text-sky-300",
        )}
        aria-hidden="true"
      >
        {change.status}
      </code>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-slate-300">
          {change.path}
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-slate-500">
          {change.originalPath ? `${change.originalPath} → ${label}` : label}
        </span>
      </span>
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 text-slate-600 transition-transform",
          selected && "rotate-90 text-sky-400",
        )}
      />
    </button>
  );
};

export const WorkspaceGitStatus = ({
  workspaceRoot,
  repositoryRoot,
  overview,
}: {
  workspaceRoot: string;
  repositoryRoot: string;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<Awaited<
    ReturnType<typeof loadWorkspaceGitDiff>
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);

  const selectedChange =
    overview.changes.find((change) => change.path === selectedPath) ?? null;

  useEffect(() => {
    requestIdRef.current += 1;
    setSelectedPath(null);
    setDiff(null);
    setError(null);
    setLoading(false);
    setReloadKey(0);
  }, [repositoryRoot, workspaceRoot]);

  useEffect(() => {
    if (selectedPath && !selectedChange) {
      requestIdRef.current += 1;
      setSelectedPath(null);
      setDiff(null);
      setError(null);
      setLoading(false);
    }
  }, [selectedChange, selectedPath]);

  useEffect(() => {
    if (!selectedChange) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    void loadWorkspaceGitDiff(
      workspaceRoot,
      repositoryRoot,
      selectedChange.path,
    )
      .then((nextDiff) => {
        if (requestId === requestIdRef.current) setDiff(nextDiff);
      })
      .catch((failure: unknown) => {
        if (requestId === requestIdRef.current) {
          setDiff(null);
          setError(errorMessage(failure));
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [overview, reloadKey, repositoryRoot, selectedChange, workspaceRoot]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Staged", overview.stagedCount],
          ["Changed", overview.unstagedCount],
          ["Untracked", overview.untrackedCount],
          ["Conflicts", overview.conflictedCount],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"
          >
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-semibold text-slate-100">{value}</p>
          </div>
        ))}
      </div>
      {overview.headCommit ? (
        <div className="flex min-w-0 items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/45 p-3">
          <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-slate-500" />
          <div className="min-w-0">
            <p className="truncate text-sm text-slate-200">
              {overview.headCommit.subject}
            </p>
            <p className="mt-1 truncate text-xs text-slate-500">
              {overview.headCommit.shortHash} · {overview.headCommit.author} ·{" "}
              {new Date(overview.headCommit.authoredAt).toLocaleString()}
            </p>
          </div>
        </div>
      ) : null}
      {overview.changes.length === 0 ? (
        <EmptyState icon={Check} title="Working tree clean" size="compact" />
      ) : (
        <div
          className={cn(
            "grid gap-3",
            selectedChange &&
              "lg:grid-cols-[minmax(14rem,0.75fr)_minmax(0,1.25fr)]",
          )}
        >
          <div className="overflow-hidden rounded-lg border border-slate-800">
            <div className="max-h-96 overflow-y-auto">
              {overview.changes.map((change) => (
                <ChangeRow
                  key={`${change.status}:${change.path}`}
                  change={change}
                  selected={selectedPath === change.path}
                  onSelect={() =>
                    setSelectedPath((current) =>
                      current === change.path ? null : change.path,
                    )
                  }
                />
              ))}
            </div>
            {overview.changesTruncated ? (
              <p className="border-t border-slate-800 px-3 py-2 text-xs text-slate-500">
                Showing {overview.changes.length} of {overview.totalChanges}{" "}
                changes
              </p>
            ) : null}
          </div>

          {selectedChange ? (
            <section
              className="min-w-0 space-y-3"
              aria-label={`Diff for ${selectedChange.path}`}
            >
              <header className="flex min-h-9 min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="truncate font-mono text-xs text-slate-200">
                    {selectedChange.path}
                  </h4>
                  {selectedChange.originalPath ? (
                    <p className="truncate font-mono text-[10px] text-slate-500">
                      {selectedChange.originalPath}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Close diff"
                  onClick={() => setSelectedPath(null)}
                >
                  <X className="size-3.5" />
                </Button>
              </header>
              {loading ? (
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
              ) : diff?.patches.length ? (
                diff.patches.map((patch) => (
                  <DiffPatch key={patch.kind} patch={patch} />
                ))
              ) : null}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
};
