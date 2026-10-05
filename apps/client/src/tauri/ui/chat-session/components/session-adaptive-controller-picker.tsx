import { AdaptiveControlIcon } from "@machdoch/product-ui";
import { useMemo, useState, type JSX } from "react";
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
  ADAPTIVE_CONTROLLER_OPTIONS,
  createAdaptiveControllerCommand,
} from "../_helpers/session-toolbar-commands";
import { WorkspaceDefaultIndicator } from "./workspace-default-indicator";

export const SessionAdaptiveControllerPicker = ({
  override,
  defaultEnabled = null,
  onChange,
}: {
  override: boolean | null;
  defaultEnabled?: boolean | null;
  onChange: (override: boolean | null) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const value =
    override === null ? "default" : override ? "enabled" : "disabled";
  const enabled = override ?? defaultEnabled;
  const label =
    enabled === null
      ? "Default"
      : `${enabled ? "Enabled" : "Disabled"}${override === null ? " (workspace default)" : ""}`;
  const commands = useMemo(
    () => [createAdaptiveControllerCommand(override, defaultEnabled, onChange)],
    [defaultEnabled, onChange, override],
  );
  useOptionalRegisterCommands(commands);

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
            data-active={enabled === true}
            className="app-composer-toolbar-icon-button app-composer-toolbar-control relative h-8 w-8 rounded-full p-0 shadow-none"
          >
            <AdaptiveControlIcon className="h-3.5 w-3.5" />
            {override === null ? <WorkspaceDefaultIndicator /> : null}
          </Button>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent
        align="start"
        className="w-44 rounded-xl border-slate-800 bg-slate-950 p-1 shadow-xl"
      >
        {ADAPTIVE_CONTROLLER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={value === option.value}
            className={cn(
              "flex w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800",
              value === option.value &&
                enabled === true &&
                "bg-sky-500/10 text-sky-200",
            )}
            onClick={() => {
              onChange(option.override);
              setOpen(false);
            }}
          >
            {option.value === "default" && defaultEnabled !== null
              ? `Default (${defaultEnabled ? "Enabled" : "Disabled"})`
              : option.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
};
