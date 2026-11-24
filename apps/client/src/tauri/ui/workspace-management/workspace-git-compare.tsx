import { ArrowLeftRight, LoaderCircle } from "lucide-react";
import { useId, useState, type JSX } from "react";
import type { WorkspaceGitComparison } from "@machdoch/fleet-protocol/workspace-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import type { WorkspaceGitOverview } from "../runtime";
import { WorkspaceGitChangedFiles } from "./workspace-git-commit-details";
import { formatWorkspaceGitTime } from "./workspace-git-time";
import { compareWorkspaceGitRevisions } from "./workspace-tools-runtime";

export const WorkspaceGitCompare = ({
  overview,
}: {
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const listId = useId();
  const [base, setBase] = useState(overview.defaultBranch ?? "");
  const [head, setHead] = useState(overview.branch || "HEAD");
  const [comparison, setComparison] = useState<WorkspaceGitComparison | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const references = [
    ...overview.localBranches.map((branch) => branch.name),
    ...overview.remoteBranches.map((branch) => branch.name),
  ];

  const compare = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setComparison(
        await compareWorkspaceGitRevisions(
          overview.workspaceRoot,
          overview.repositoryRoot,
          base.trim(),
          head.trim(),
        ),
      );
    } catch (failure) {
      setComparison(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      aria-label="Compare"
      className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2"
    >
      <form
        className="flex flex-wrap items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          void compare();
        }}
      >
        <datalist id={listId}>
          {references.map((reference) => (
            <option key={reference} value={reference} />
          ))}
        </datalist>
        <Input
          value={base}
          list={listId}
          aria-label="Base"
          placeholder="main"
          onChange={(event) => setBase(event.target.value)}
          className="h-7 w-44 border-slate-800 bg-slate-950 font-mono text-xs"
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Swap"
          onClick={() => {
            setBase(head);
            setHead(base);
          }}
        >
          <ArrowLeftRight />
        </Button>
        <Input
          value={head}
          list={listId}
          aria-label="Compare with"
          onChange={(event) => setHead(event.target.value)}
          className="h-7 w-44 border-slate-800 bg-slate-950 font-mono text-xs"
        />
        <Button
          type="submit"
          size="xs"
          disabled={loading || !base.trim() || !head.trim()}
        >
          {loading ? <LoaderCircle className="animate-spin" /> : null}
          Compare
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
      {comparison ? (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-400">
            {comparison.ahead} ahead · {comparison.behind} behind
          </p>
          {comparison.commits.length > 0 ? (
            <ol aria-label="Commits" className="space-y-px">
              {comparison.commits.map((commit) => (
                <li
                  key={commit.hash}
                  className="flex min-w-0 items-center gap-2 px-1 text-xs"
                >
                  <code className="w-14 shrink-0 text-[11px] text-sky-300">
                    {commit.shortHash}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-slate-300">
                    {commit.subject}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-500">
                    {formatWorkspaceGitTime(commit.authoredAt)}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          <WorkspaceGitChangedFiles
            overview={overview}
            commit={comparison.head}
            base={comparison.mergeBase ?? comparison.base}
          />
        </div>
      ) : null}
    </section>
  );
};
