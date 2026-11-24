import { FolderTree, GitBranch, Play, SquareTerminal } from "lucide-react";
import { useSyncExternalStore, type JSX, type ReactNode } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { useWorkspaceRunActivity } from "./use-workspace-run-activity";
import { describeWorkspaceGitSync } from "./workspace-git-model";
import { useWorkspaceGitSummary } from "./workspace-git-summary-store";
import { getWorkspaceTerminalStore } from "./workspace-terminal-store";

export type WorkspaceStatusFeature = "git" | "files" | "terminal" | "run";

const StripButton = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className="flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-slate-400 hover:bg-slate-900 hover:text-slate-100"
  >
    {children}
  </button>
);

export const WorkspaceStatusStrip = ({
  workspaceRoot,
  onOpen,
  className,
}: {
  workspaceRoot: string;
  onOpen: (feature: WorkspaceStatusFeature) => void;
  className?: string;
}): JSX.Element => {
  const summary = useWorkspaceGitSummary(workspaceRoot)?.summary;
  const terminals = getWorkspaceTerminalStore(workspaceRoot);
  const terminalSnapshot = useSyncExternalStore(
    terminals.subscribe,
    terminals.getSnapshot,
    terminals.getSnapshot,
  );
  const runningTerminals = terminalSnapshot.terminals.filter(
    (terminal) => terminal.sessionActive,
  ).length;
  const { activeRuns, healthCheckFailed } =
    useWorkspaceRunActivity(workspaceRoot);
  const sync = summary ? describeWorkspaceGitSync(summary) : null;

  return (
    <div
      role="toolbar"
      aria-label="Workspace status"
      className={cn("flex min-w-0 items-center gap-0.5", className)}
    >
      {summary ? (
        <StripButton
          label={`Git: ${summary.branch}, ${summary.changes} changes${summary.conflicts ? `, ${summary.conflicts} conflict${summary.conflicts === 1 ? "" : "s"}` : ""}, ${sync}`}
          onClick={() => onOpen("git")}
        >
          <GitBranch
            aria-hidden="true"
            className="size-3 shrink-0 text-sky-300"
          />
          <span className="min-w-0 max-w-40 truncate">{summary.branch}</span>
          {summary.changes ? (
            <span
              className={summary.conflicts ? "text-red-300" : "text-amber-200"}
            >
              {summary.changes}
            </span>
          ) : null}
          <span className="text-slate-500">{sync}</span>
        </StripButton>
      ) : null}
      <StripButton label="Files" onClick={() => onOpen("files")}>
        <FolderTree aria-hidden="true" className="size-3 shrink-0" />
      </StripButton>
      <StripButton
        label={`Terminal${runningTerminals ? `: ${runningTerminals} running` : ""}`}
        onClick={() => onOpen("terminal")}
      >
        <SquareTerminal aria-hidden="true" className="size-3 shrink-0" />
        {runningTerminals ? (
          <span className="text-emerald-300">{runningTerminals}</span>
        ) : null}
      </StripButton>
      <StripButton
        label={`Run${activeRuns.length ? `: ${activeRuns.length} running` : ""}`}
        onClick={() => onOpen("run")}
      >
        <Play aria-hidden="true" className="size-3 shrink-0" />
        {activeRuns.length ? (
          <span
            className={healthCheckFailed ? "text-red-300" : "text-emerald-300"}
          >
            {activeRuns.length}
          </span>
        ) : null}
      </StripButton>
    </div>
  );
};
