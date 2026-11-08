import { ArrowRight, Layers } from "lucide-react";
import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { workspaceGitBranchTarget } from "./workspace-git-model";

export const WorkspaceGitBranchTarget = ({
  branchName,
  parent,
  trunk,
  className,
}: {
  branchName: string;
  parent: string | undefined;
  trunk: string | undefined;
  className?: string;
}): JSX.Element | null => {
  const { base, nested } = workspaceGitBranchTarget(branchName, parent, trunk);
  if (!base) return null;
  return nested ? (
    <span
      aria-label={`Nested on ${base}`}
      title={`Nested on ${base}`}
      className={cn(
        "inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 text-[10px] leading-4 text-violet-200",
        className,
      )}
    >
      <Layers aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{base}</span>
    </span>
  ) : (
    <span
      aria-label={`Targets ${base}`}
      title={`Targets ${base}`}
      className={cn(
        "inline-flex min-w-0 shrink items-center gap-0.5 text-[10px] leading-4 text-slate-500",
        className,
      )}
    >
      <ArrowRight aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{base}</span>
    </span>
  );
};
