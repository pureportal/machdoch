import type { JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceRunStatePresentation } from "./workspace-run-model";

const STATE_TONE_CLASS = {
  idle: "bg-slate-500",
  progress: "bg-sky-400",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-red-400",
} as const;

export const WorkspaceRunStatusDot = ({
  presentation,
  active,
  className,
}: {
  presentation: WorkspaceRunStatePresentation;
  active: boolean;
  className?: string;
}): JSX.Element => (
  <span
    aria-hidden="true"
    className={cn("relative inline-flex size-2 shrink-0", className)}
  >
    {active ? (
      <span
        className={cn(
          "absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none",
          STATE_TONE_CLASS[presentation.tone],
        )}
      />
    ) : null}
    <span
      className={cn(
        "relative inline-flex size-2 rounded-full",
        STATE_TONE_CLASS[presentation.tone],
      )}
    />
  </span>
);
