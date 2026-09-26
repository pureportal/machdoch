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

const OPTIONS: { value: ParallelAgentMode; label: string }[] = [
  { value: "disabled", label: "Disabled" },
  { value: "read-only", label: "Read Only" },
  { value: "machdoch", label: "Full Mode" },
];

export const SessionParallelAgentPicker = ({
  mode,
  available,
  onChange,
}: {
  mode: ParallelAgentMode;
  available: boolean;
  onChange: (mode: ParallelAgentMode) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const label =
    OPTIONS.find((option) => option.value === mode)?.label ?? "Disabled";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ControlTooltip
        content={
          available
            ? `Parallel agents: ${label}`
            : "Parallel agents require an API provider"
        }
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={`Parallel agents: ${label}`}
            disabled={!available}
            className="h-8 gap-1.5 rounded-full border-slate-800 bg-slate-950/70 px-2.5 text-xs text-slate-300"
          >
            <GitFork className="h-3.5 w-3.5" />
            <span>{label}</span>
          </Button>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent
        align="start"
        className="w-44 rounded-xl border-slate-800 bg-slate-950 p-1 shadow-xl"
      >
        {OPTIONS.map((option) => (
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
        ))}
      </PopoverContent>
    </Popover>
  );
};
