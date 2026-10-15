import { Check } from "lucide-react";
import {
  FullAccessIcon,
  ModelIcon,
  OffIcon,
  ParallelAgentsIcon,
  ReadOnlyIcon,
  getParallelAgentOptions,
  type ComposerIconProps,
} from "@machdoch/product-ui";
import { useId, useMemo, useState, type JSX } from "react";
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
import { createParallelAgentCommand } from "../_helpers/session-toolbar-commands";

const MODE_ICONS: Record<
  ParallelAgentMode,
  (props: ComposerIconProps) => JSX.Element
> = {
  disabled: OffIcon,
  "read-only": ReadOnlyIcon,
  machdoch: FullAccessIcon,
  native: ModelIcon,
};

export const SessionParallelAgentPicker = ({
  mode,
  availableModes,
  specialKind,
  onChange,
}: {
  mode: ParallelAgentMode;
  availableModes: readonly ParallelAgentMode[];
  specialKind?: string;
  onChange: (mode: ParallelAgentMode) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const options = getParallelAgentOptions(availableModes, specialKind);
  const selectedMode =
    options.find((option) => option.value === mode && !option.disabledReason)
      ?.value ?? "disabled";
  const activeOption = options.find((option) => option.value === selectedMode);
  const label = activeOption?.label ?? "Disabled";
  const ActiveModeIcon =
    selectedMode === "disabled" ? null : MODE_ICONS[selectedMode];
  const available = options.some(
    (option) => option.value !== "disabled" && !option.disabledReason,
  );
  const disabledReason = available ? null : options[1]!.disabledReason;
  const commands = useMemo(
    () => [
      createParallelAgentCommand(
        selectedMode,
        availableModes,
        onChange,
        specialKind,
      ),
    ],
    [availableModes, selectedMode, onChange, specialKind],
  );
  useOptionalRegisterCommands(commands);
  return (
    <Popover open={open && available} onOpenChange={setOpen}>
      <ControlTooltip
        content={available ? `Parallel agents: ${label}` : disabledReason}
      >
        <span
          className="inline-flex"
          role={available ? undefined : "group"}
          tabIndex={available ? undefined : 0}
          aria-label={
            disabledReason ? `Parallel agents: ${disabledReason}` : undefined
          }
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              tooltip={null}
              aria-label={`Parallel agents: ${label}`}
              aria-description={disabledReason ?? undefined}
              disabled={!available}
              data-active={selectedMode !== "disabled"}
              className={cn(
                "app-parallel-agent-button app-composer-toolbar-control h-8 gap-1 rounded-full p-0 shadow-none",
                ActiveModeIcon ? "w-12" : "w-8",
              )}
            >
              <ParallelAgentsIcon className="h-3.5 w-3.5" />
              {ActiveModeIcon ? (
                <ActiveModeIcon
                  aria-hidden="true"
                  className="app-composer-mode-icon h-3 w-3"
                />
              ) : null}
            </Button>
          </PopoverTrigger>
        </span>
      </ControlTooltip>
      <PopoverContent
        align="start"
        className="w-64 rounded-xl border-slate-800 bg-slate-950 p-1 shadow-xl"
      >
        {options.map((option) => {
          const OptionIcon = MODE_ICONS[option.value];
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={selectedMode === option.value}
              aria-label={option.label}
              disabled={Boolean(option.disabledReason)}
              aria-describedby={
                option.disabledReason
                  ? `${reasonId}-${option.value}`
                  : undefined
              }
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500 disabled:hover:bg-transparent",
                selectedMode === option.value &&
                  "bg-sky-500/10 text-sky-200 hover:bg-sky-500/15",
              )}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <OptionIcon aria-hidden="true" className="h-3.5 w-3.5" />
              <span>
                {option.label}
                {option.disabledReason ? (
                  <span
                    id={`${reasonId}-${option.value}`}
                    className="block text-xs"
                  >
                    {option.disabledReason}
                  </span>
                ) : null}
              </span>
              {selectedMode === option.value ? (
                <Check aria-hidden="true" className="ml-auto h-3 w-3" />
              ) : null}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};
