import { LoaderCircle, WandSparkles } from "lucide-react";
import type { JSX } from "react";
import { cn } from "../../lib/utils";

export interface PromptEnhancementPendingProps {
  modeLabel: string;
  variant?: "panel" | "bubble";
  className?: string;
}

export const PromptEnhancementPending = ({
  modeLabel,
  variant = "panel",
  className,
}: PromptEnhancementPendingProps): JSX.Element => {
  const isBubble = variant === "bubble";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "app-prompt-enhancement-pending flex min-w-0 items-center gap-3 overflow-hidden border text-left shadow-lg",
        isBubble
          ? "max-w-[90%] rounded-2xl border-cyan-400/20 bg-cyan-400/10 px-3.5 py-2.5 text-xs shadow-slate-950/20"
          : "rounded-2xl border-cyan-400/25 bg-slate-900/90 px-4 py-3 shadow-slate-950/30",
        className,
      )}
    >
      <span
        className={cn(
          "relative flex shrink-0 items-center justify-center rounded-full bg-cyan-400/10 text-cyan-100",
          isBubble ? "h-8 w-8" : "h-10 w-10",
        )}
        aria-hidden="true"
      >
        <span className="absolute inset-0 rounded-full border border-cyan-300/25 animate-ping" />
        <WandSparkles className={cn(isBubble ? "h-4 w-4" : "h-5 w-5")} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate font-medium text-cyan-50",
            isBubble ? "text-xs" : "text-sm",
          )}
        >
          Enhancing prompt
        </span>
        <span
          className={cn(
            "mt-0.5 flex min-w-0 items-center gap-2 text-cyan-100/75",
            isBubble ? "text-[11px]" : "text-xs",
          )}
        >
          <span className="truncate">{modeLabel}</span>
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
        </span>
      </span>
    </div>
  );
};
