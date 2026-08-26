import { LoaderCircle, WandSparkles, X } from "lucide-react";
import type { JSX } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

export interface PromptEnhancementPendingProps {
  className?: string;
  onCancel?: () => void;
}

export const PromptEnhancementPending = ({
  className,
  onCancel,
}: PromptEnhancementPendingProps): JSX.Element => {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      className={cn(
        "app-prompt-enhancement-pending flex min-w-0 items-center gap-3 overflow-hidden rounded-2xl border border-cyan-400/25 bg-slate-950/80 px-3.5 py-3 text-left shadow-lg shadow-slate-950/30",
        className,
      )}
    >
      <span
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-400/10 text-cyan-100"
        aria-hidden="true"
      >
        <span className="absolute inset-0 rounded-full border border-cyan-300/25 animate-ping" />
        <WandSparkles className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-cyan-50">
        Enhancing prompt
      </span>
      <LoaderCircle
        className="h-4 w-4 shrink-0 animate-spin text-cyan-100/75"
        aria-hidden="true"
      />
      {onCancel ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Cancel enhancement"
          tooltip="Cancel enhancement"
          onClick={onCancel}
          className="h-8 w-8 shrink-0 rounded-full text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
};
