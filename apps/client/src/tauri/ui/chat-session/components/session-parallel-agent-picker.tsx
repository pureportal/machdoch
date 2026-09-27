import { GitFork } from "lucide-react";
import { useState, type JSX } from "react";
import type { ParallelAgentMode } from "../../../../core/types.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

const OPTIONS: { value: ParallelAgentMode; label: string }[] = [
  { value: "disabled", label: "Disabled" },
  { value: "read-only", label: "Read Only" },
  { value: "machdoch", label: "Full Mode" },
  { value: "native", label: "Native" },
];

export const SessionParallelAgentPicker = ({
  mode,
  availableModes,
  onChange,
}: {
  mode: ParallelAgentMode;
  availableModes: readonly ParallelAgentMode[];
  onChange: (mode: ParallelAgentMode) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const label =
    OPTIONS.find((option) => option.value === mode)?.label ?? "Disabled";
  const available = availableModes.length > 1;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ControlTooltip
        content={
          available
            ? `Parallel agents: ${label}`
            : "Parallel agents unavailable"
        }
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            tooltip={null}
            aria-label={`Parallel agents: ${label}`}
            disabled={!available}
            className={cn(
              "app-composer-toolbar-icon-button h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 p-0 text-slate-400 shadow-none hover:bg-slate-900",
              mode === "read-only" &&
                "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:border-sky-500/40 hover:bg-sky-500/15",
              mode === "machdoch" &&
                "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:border-violet-500/40 hover:bg-violet-500/15",
              mode === "native" &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:border-emerald-500/40 hover:bg-emerald-500/15",
            )}
          >
            <GitFork className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent
        align="start"
        className="w-44 rounded-xl border-slate-800 bg-slate-950 p-1 shadow-xl"
      >
        {OPTIONS.filter((option) => availableModes.includes(option.value)).map(
          (option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option.value}
              className="flex w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ),
        )}
      </PopoverContent>
    </Popover>
  );
};
