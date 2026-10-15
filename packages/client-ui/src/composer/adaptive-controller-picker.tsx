import {
  AdaptiveControlIcon,
  WorkspaceDefaultIcon,
} from "@machdoch/product-ui";
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
} from "./adaptive-controller-command";

export const SessionAdaptiveControllerPicker = ({
  override,
  defaultEnabled = null,
  onChange,
  disabled = false,
  disabledReason,
}: {
  override: boolean | null;
  defaultEnabled?: boolean | null;
  onChange: (override: boolean | null) => void;
  disabled?: boolean;
  disabledReason?: string | null;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const value =
    override === null ? "default" : override ? "enabled" : "disabled";
  const enabled = override ?? defaultEnabled;
  const unavailable = disabled || Boolean(disabledReason);
  const label =
    enabled === null
      ? "Default"
      : `${enabled ? "Enabled" : "Disabled"}${override === null ? " (workspace default)" : ""}`;
  const commands = useMemo(
    () => [
      createAdaptiveControllerCommand(
        override,
        defaultEnabled,
        onChange,
        disabled,
        disabledReason ?? undefined,
      ),
    ],
    [defaultEnabled, disabled, disabledReason, onChange, override],
  );
  useOptionalRegisterCommands(commands);

  return (
    <Popover open={open && !unavailable} onOpenChange={setOpen}>
      <ControlTooltip
        content={disabledReason ?? `Adaptive context & compute: ${label}`}
      >
        <span
          className="inline-flex"
          role={unavailable ? "group" : undefined}
          tabIndex={unavailable ? 0 : undefined}
          aria-label={
            disabledReason
              ? `Adaptive context & compute: ${disabledReason}`
              : undefined
          }
          title={disabledReason ?? undefined}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              disabled={unavailable}
              variant="outline"
              size="icon-sm"
              tooltip={null}
              aria-label={`Adaptive context & compute: ${disabledReason ? "Unavailable" : label}`}
              aria-description={disabledReason ?? undefined}
              data-active={!disabledReason && enabled === true}
              className="app-composer-toolbar-icon-button app-composer-toolbar-control relative h-8 w-8 rounded-full p-0 shadow-none"
            >
              <AdaptiveControlIcon className="h-3.5 w-3.5" />
              {override === null ? (
                <WorkspaceDefaultIcon
                  aria-hidden="true"
                  className="app-composer-default-indicator pointer-events-none absolute right-0 top-0 size-2.5 fill-current text-sky-300"
                />
              ) : null}
            </Button>
          </PopoverTrigger>
        </span>
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
            disabled={unavailable}
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
