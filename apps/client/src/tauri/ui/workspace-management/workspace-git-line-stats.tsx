import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

const BLOCKS = 5;

export const WorkspaceGitLineStats = ({
  additions = 0,
  deletions = 0,
  blocks = false,
  className,
}: {
  additions?: number;
  deletions?: number;
  blocks?: boolean;
  className?: string;
}): JSX.Element | null => {
  const total = additions + deletions;
  if (total === 0) return null;
  const added = Math.round((additions / total) * BLOCKS);
  return (
    <span
      aria-label={`${additions} added, ${deletions} removed`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums",
        className,
      )}
    >
      {additions ? (
        <span aria-hidden="true" className="text-emerald-300">
          +{additions}
        </span>
      ) : null}
      {deletions ? (
        <span aria-hidden="true" className="text-rose-300">
          −{deletions}
        </span>
      ) : null}
      {blocks ? (
        <span aria-hidden="true" className="flex gap-px">
          {Array.from({ length: BLOCKS }, (_, index) => (
            <span
              key={index}
              className={cn(
                "size-1.5 rounded-[1px]",
                index < added ? "bg-emerald-400" : "bg-rose-400",
              )}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
};
