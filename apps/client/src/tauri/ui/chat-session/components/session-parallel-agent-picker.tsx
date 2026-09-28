import {
  Check,
  CircleOff,
  Cpu,
  Eye,
  GitFork,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import type { ParallelAgentMode } from "../../../../core/types.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  createParallelAgentCommand,
  PARALLEL_AGENT_OPTIONS,
} from "../_helpers/session-toolbar-commands";

const MODE_ICONS: Record<ParallelAgentMode, LucideIcon> = {
  disabled: CircleOff,
  "read-only": Eye,
  machdoch: ShieldCheck,
  native: Cpu,
};

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
  const activeOption = PARALLEL_AGENT_OPTIONS.find(
    (option) => option.value === mode,
  );
  const label = activeOption?.label ?? "Disabled";
  const ActiveModeIcon = mode === "disabled" ? null : MODE_ICONS[mode];
  const available = availableModes.length > 1;
  const commands = useMemo(
    () => [createParallelAgentCommand(mode, availableModes, onChange)],
    [availableModes, mode, onChange],
  );
  useOptionalRegisterCommands(commands);
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
            data-active={mode !== "disabled"}
            className={cn(
              "app-parallel-agent-button app-composer-toolbar-control h-8 gap-0.5 rounded-full p-0 shadow-none",
              ActiveModeIcon ? "w-10" : "w-8",
            )}
          >
            <GitFork className="h-3.5 w-3.5" />
            {ActiveModeIcon ? (
              <ActiveModeIcon
                aria-hidden="true"
                className="app-composer-mode-icon h-3 w-3"
              />
            ) : null}
          </Button>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent
        align="start"
        className="w-44 rounded-xl border-slate-800 bg-slate-950 p-1 shadow-xl"
      >
        {PARALLEL_AGENT_OPTIONS.filter((option) =>
          availableModes.includes(option.value),
        ).map((option) => {
          const OptionIcon = MODE_ICONS[option.value];
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option.value}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800",
                mode === option.value &&
                  "bg-sky-500/10 text-sky-200 hover:bg-sky-500/15",
              )}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <OptionIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {option.label}
              {mode === option.value ? (
                <Check aria-hidden="true" className="ml-auto h-3 w-3" />
              ) : null}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};
