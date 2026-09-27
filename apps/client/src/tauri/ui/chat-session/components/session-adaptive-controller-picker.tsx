import { BrainCircuit } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

const OPTIONS = [
  { value: "default", label: "Default" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
] as const;

export const SessionAdaptiveControllerPicker = ({
  override,
  onChange,
}: {
  override: boolean | null;
  onChange: (override: boolean | null) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const value =
    override === null ? "default" : override ? "enabled" : "disabled";
  const label =
    OPTIONS.find((option) => option.value === value)?.label ?? "Default";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ControlTooltip content={`Adaptive context & compute: ${label}`}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            tooltip={null}
            aria-label={`Adaptive context & compute: ${label}`}
            className={cn(
              "app-composer-toolbar-icon-button h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 p-0 text-slate-400 shadow-none hover:bg-slate-900",
              override === true &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:border-emerald-500/40 hover:bg-emerald-500/15",
              override === false &&
                "border-amber-500/30 bg-amber-500/10 text-amber-100 hover:border-amber-500/40 hover:bg-amber-500/15",
            )}
          >
            <BrainCircuit className="h-3.5 w-3.5" />
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
            aria-checked={value === option.value}
            className="flex w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
            onClick={() => {
              onChange(
                option.value === "default" ? null : option.value === "enabled",
              );
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
