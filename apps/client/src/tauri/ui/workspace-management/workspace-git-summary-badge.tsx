import { GitBranch } from "lucide-react";
import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceGitSummary } from "../runtime";

export const WorkspaceGitSummaryBadge = ({
  summary,
  className,
}: {
  summary: WorkspaceGitSummary;
  className?: string;
}): JSX.Element => (
  <span
    className={cn("flex min-w-0 items-center gap-1.5 text-[11px]", className)}
  >
    <GitBranch aria-hidden="true" className="size-3 shrink-0 text-slate-500" />
    <span className="min-w-0 truncate text-slate-400">
      {summary.detached ? `${summary.branch} (detached)` : summary.branch}
    </span>
    {summary.ahead ? (
      <span className="text-emerald-300">↑{summary.ahead}</span>
    ) : null}
    {summary.behind ? (
      <span className="text-amber-300">↓{summary.behind}</span>
    ) : null}
    {summary.changes ? (
      <span
        aria-label={`${summary.changes} changed`}
        className={cn(
          "rounded-full px-1.5 leading-4",
          summary.conflicts
            ? "bg-red-500/15 text-red-300"
            : "bg-amber-500/15 text-amber-200",
        )}
      >
        {summary.changes}
      </span>
    ) : null}
  </span>
);
