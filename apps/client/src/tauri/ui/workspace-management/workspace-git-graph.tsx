import {
  Cloud,
  GitCommitHorizontal,
  GitCompareArrows,
  GitFork,
  LoaderCircle,
  Tag,
} from "lucide-react";
import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceGitGraphBase,
  WorkspaceGitGraphRef,
  WorkspaceGitGraphScope,
  WorkspaceGitOverview,
} from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { useWorkspaceGitGraph } from "./use-workspace-git-graph";
import {
  WorkspaceGitChangedFiles,
  WorkspaceGitCommitDetails,
} from "./workspace-git-commit-details";
import {
  WorkspaceGitGraphCell,
  WorkspaceGitGraphContinuation,
} from "./workspace-git-graph-cell";
import {
  GRAPH_LANE_COLORS,
  GRAPH_ROW_HEIGHT,
} from "./workspace-git-graph-style";
import { layoutWorkspaceGitGraph } from "./workspace-git-graph-layout";
import {
  WorkspaceGitResetDialog,
  type WorkspaceGitResetTarget,
} from "./workspace-git-reset-dialog";
import { formatWorkspaceGitTime } from "./workspace-git-time";

const SCOPES: { value: WorkspaceGitGraphScope; label: string }[] = [
  { value: "current", label: "Current branch" },
  { value: "all", label: "All branches" },
];

const ROW_SELECTOR = "[data-git-commit-row]";

let rememberedScope: WorkspaceGitGraphScope = "current";

type ChipKind = "current" | "local" | "remote" | "tag" | "head";

interface RefChip {
  label: string;
  kind: ChipKind;
  remote?: string;
}

const CHIP_TONES: Record<ChipKind, string> = {
  current: "border-sky-500/60 bg-sky-500/15 font-medium text-sky-200",
  local: "border-slate-700 bg-slate-900 text-slate-200",
  remote: "border-slate-800 text-slate-500",
  tag: "border-amber-700/50 text-amber-200",
  head: "border-rose-500/50 text-rose-200",
};

const refChips = (
  refs: readonly WorkspaceGitGraphRef[],
  currentBranch: string | null,
): RefChip[] => {
  const remotes = refs.filter((reference) => reference.kind === "remote");
  const folded = new Set<string>();
  const chips: RefChip[] = [];
  if (!currentBranch && refs.some((reference) => reference.kind === "head")) {
    chips.push({ label: "HEAD", kind: "head" });
  }
  for (const local of refs.filter((reference) => reference.kind === "local")) {
    const remote = remotes.find(
      (candidate) =>
        candidate.name.slice(candidate.name.indexOf("/") + 1) === local.name,
    );
    if (remote) folded.add(remote.name);
    chips.push({
      label: local.name,
      kind: local.name === currentBranch ? "current" : "local",
      ...(remote ? { remote: remote.name } : {}),
    });
  }
  for (const remote of remotes) {
    if (!folded.has(remote.name)) {
      chips.push({ label: remote.name, kind: "remote" });
    }
  }
  for (const tag of refs.filter((reference) => reference.kind === "tag")) {
    chips.push({ label: tag.name, kind: "tag" });
  }
  return chips.sort(
    (left, right) =>
      Number(right.kind === "current") - Number(left.kind === "current"),
  );
};

const RefChipList = ({ chips }: { chips: readonly RefChip[] }) =>
  chips.length === 0 ? null : (
    <span className="flex max-w-[45%] shrink-0 items-center gap-1 overflow-hidden">
      {chips.map((chip) => (
        <span
          key={`${chip.kind}:${chip.label}`}
          title={chip.remote ? `${chip.label} · ${chip.remote}` : chip.label}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded border px-1.5 text-[10px] leading-4",
            CHIP_TONES[chip.kind],
          )}
        >
          {chip.kind === "tag" ? (
            <Tag aria-hidden="true" className="size-2.5 shrink-0" />
          ) : null}
          <span className="truncate">{chip.label}</span>
          {chip.remote ? (
            <Cloud
              aria-label={`Matches ${chip.remote}`}
              className="size-2.5 shrink-0 opacity-70"
            />
          ) : null}
        </span>
      ))}
    </span>
  );

const meterWidth = (value: number, maximum: number): string =>
  value === 0 ? "0%" : `${Math.max(8, (value / maximum) * 100)}%`;

const DivergenceMeter = ({
  ahead,
  behind,
}: {
  ahead: number;
  behind: number;
}): JSX.Element => {
  const maximum = Math.max(ahead, behind, 1);
  return (
    <span
      aria-label={`${ahead} ahead, ${behind} behind`}
      className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums"
    >
      <span aria-hidden="true" className="text-amber-300">
        ↓{behind}
      </span>
      <span aria-hidden="true" className="flex h-1.5 w-24 items-center">
        <span className="flex h-full flex-1 justify-end overflow-hidden rounded-l-full bg-slate-800">
          <span
            className="h-full rounded-l-full bg-amber-400"
            style={{ width: meterWidth(behind, maximum) }}
          />
        </span>
        <span className="h-3 w-px bg-slate-500" />
        <span className="flex h-full flex-1 overflow-hidden rounded-r-full bg-slate-800">
          <span
            className="h-full rounded-r-full bg-emerald-400"
            style={{ width: meterWidth(ahead, maximum) }}
          />
        </span>
      </span>
      <span aria-hidden="true" className="text-emerald-300">
        ↑{ahead}
      </span>
    </span>
  );
};

const BranchedFrom = ({
  base,
  comparing,
  onShowForkPoint,
  onToggleCompare,
}: {
  base: WorkspaceGitGraphBase;
  comparing: boolean;
  onShowForkPoint: () => void;
  onToggleCompare: () => void;
}): JSX.Element => (
  <div className="flex min-w-0 items-center gap-2 text-[11px] text-slate-400">
    <GitFork aria-hidden="true" className="size-3.5 shrink-0 text-amber-300" />
    <span className="truncate">
      Branched from{" "}
      <span className="font-mono text-slate-200">{base.branch}</span> at
    </span>
    <button
      type="button"
      onClick={onShowForkPoint}
      className="shrink-0 rounded font-mono text-sky-300 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-sky-500/70"
    >
      {base.mergeBase.slice(0, 7)}
    </button>
    <DivergenceMeter ahead={base.ahead} behind={base.behind} />
    {base.ahead > 0 ? (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-pressed={comparing}
        onClick={onToggleCompare}
        className={cn(comparing ? "text-slate-100" : "text-slate-400")}
      >
        <GitCompareArrows />
        Compare
      </Button>
    ) : null}
  </div>
);

const moveCommitFocus = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
  if (index === -1 || !next) return;
  event.preventDefault();
  next.focus();
};

export const WorkspaceGitGraphView = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const [scope, setScope] = useState(rememberedScope);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [resetTarget, setResetTarget] =
    useState<WorkspaceGitResetTarget | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const { graph, loading, error, reload } = useWorkspaceGitGraph(
    overview,
    scope,
  );
  const layout = useMemo(
    () =>
      layoutWorkspaceGitGraph(graph?.commits ?? [], GRAPH_LANE_COLORS.length),
    [graph],
  );
  const currentBranch = overview.detached ? null : overview.branch;
  const base = graph?.base;
  const headHash = graph?.commits.find((commit) =>
    commit.refs.some((reference) => reference.kind === "head"),
  )?.hash;

  const selectScope = (next: WorkspaceGitGraphScope): void => {
    rememberedScope = next;
    setScope(next);
  };
  const showCommit = (hash: string): void => {
    setSelectedHash(hash);
    listRef.current
      ?.querySelector(`[data-commit="${hash}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-slate-800 bg-slate-950 p-0.5">
          {SCOPES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={scope === option.value}
              onClick={() => selectScope(option.value)}
              className={cn(
                "rounded px-2 py-1 text-[11px]",
                scope === option.value
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-500 hover:text-slate-300",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {base ? (
          <BranchedFrom
            base={base}
            comparing={comparing}
            onShowForkPoint={() => showCommit(base.mergeBase)}
            onToggleCompare={() => setComparing((current) => !current)}
          />
        ) : null}
        <span className="flex-1" />
        {loading && graph ? (
          <LoaderCircle
            role="status"
            aria-label="Loading history"
            className="size-3.5 animate-spin text-slate-500"
          />
        ) : null}
      </div>
      {comparing && base && headHash && base.ahead > 0 ? (
        <section
          aria-label={`Changes since ${base.branch}`}
          className="rounded-lg border border-slate-800 bg-slate-950/40 p-2"
        >
          <WorkspaceGitChangedFiles
            overview={overview}
            commit={headHash}
            base={base.mergeBase}
          />
        </section>
      ) : null}
      {error && !graph ? (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-red-900/60 bg-red-950/25 px-3 py-2 text-xs text-red-200"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : !graph ? (
        <div
          role="status"
          aria-label="Loading history"
          className="grid h-40 place-items-center"
        >
          <LoaderCircle className="size-5 animate-spin text-slate-500" />
        </div>
      ) : graph.commits.length === 0 ? (
        <EmptyState
          icon={GitCommitHorizontal}
          title="No commits"
          size="compact"
        />
      ) : (
        <ol
          ref={listRef}
          aria-label="Commits"
          onKeyDown={moveCommitFocus}
          className="min-w-0"
        >
          {layout.rows.map((row) => {
            const { commit } = row;
            const selected = commit.hash === selectedHash;
            const head = commit.refs.some(
              (reference) => reference.kind === "head",
            );
            const forkPoint = commit.hash === base?.mergeBase;
            return (
              <li key={commit.hash} data-commit={commit.hash}>
                <button
                  type="button"
                  data-git-commit-row=""
                  aria-expanded={selected}
                  onClick={() =>
                    setSelectedHash((current) =>
                      current === commit.hash ? null : commit.hash,
                    )
                  }
                  style={{ height: GRAPH_ROW_HEIGHT }}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md pr-2 pl-1 text-left outline-none hover:bg-(--app-hover) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500/70",
                    selected && "bg-sky-500/15 hover:bg-sky-500/20",
                  )}
                >
                  <WorkspaceGitGraphCell
                    row={row}
                    lanes={layout.width}
                    head={head}
                    forkPoint={forkPoint}
                  />
                  <RefChipList chips={refChips(commit.refs, currentBranch)} />
                  {forkPoint ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-700/50 px-1.5 text-[10px] leading-4 text-amber-200">
                      <GitFork aria-hidden="true" className="size-2.5" />
                      branched here
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      head ? "text-slate-100" : "text-slate-300",
                    )}
                  >
                    {commit.subject}
                  </span>
                  <span className="hidden max-w-32 shrink-0 truncate text-[11px] text-slate-500 md:inline">
                    {commit.author}
                  </span>
                  <time
                    dateTime={commit.authoredAt}
                    title={new Date(commit.authoredAt).toLocaleString()}
                    className="shrink-0 whitespace-nowrap text-right text-[11px] text-slate-500"
                  >
                    {formatWorkspaceGitTime(commit.authoredAt)}
                  </time>
                  <code className="hidden w-14 shrink-0 text-[11px] text-sky-300 sm:inline">
                    {commit.shortHash}
                  </code>
                </button>
                {selected ? (
                  <div className="flex min-w-0 pl-1">
                    <WorkspaceGitGraphContinuation
                      row={row}
                      lanes={layout.width}
                    />
                    <WorkspaceGitCommitDetails
                      overview={overview}
                      commit={commit}
                      resetBranch={head ? null : currentBranch}
                      busy={controls.busy}
                      onReset={() =>
                        setResetTarget({
                          revision: commit.hash,
                          label: commit.shortHash,
                        })
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {graph?.truncated ? (
        <p className="px-2 text-[11px] text-slate-500">
          Showing the latest {graph.commits.length} commits
        </p>
      ) : null}
      {resetTarget && currentBranch ? (
        <WorkspaceGitResetDialog
          controls={controls}
          branch={currentBranch}
          target={resetTarget}
          onClose={() => setResetTarget(null)}
        />
      ) : null}
    </div>
  );
};
