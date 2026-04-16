import type { JSX } from "react";
import { Button } from "../../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";

export interface MemoryShortcutButtonProps {
  label: string;
  description: string;
  pressed: boolean;
  disabled?: boolean;
  icon: JSX.Element;
  onClick: () => void;
  className?: string;
}

export const MemoryShortcutButton = ({
  label,
  description,
  pressed,
  disabled = false,
  icon,
  onClick,
  className,
}: MemoryShortcutButtonProps): JSX.Element => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={label}
          aria-pressed={pressed}
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) {
              onClick();
            }
          }}
          className={cn(
            "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
            disabled &&
              "cursor-not-allowed border-dashed bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600",
            className,
          )}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
      >
        <div className="grid gap-1">
          <p className="text-xs font-semibold text-slate-100">{label}</p>
          <p className="text-xs leading-5 text-slate-400">{description}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
};