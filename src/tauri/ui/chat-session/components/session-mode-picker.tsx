import { Check, CircleDashed } from "lucide-react";
import type { JSX } from "react";
import type { RunMode } from "../../../../core/runtime-contract.generated.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { RUN_MODE_META, RUN_MODE_ORDER } from "../_helpers/session-shell";

export interface SessionModePickerProps {
  activeRunMode: RunMode;
  activeRunModeMeta: (typeof RUN_MODE_META)[RunMode];
  defaultRunMode: RunMode;
  isUsingWorkspaceDefaultMode: boolean;
  onSessionModeSelection: (mode: RunMode | null) => void;
}

export const SessionModePicker = ({
  activeRunMode,
  activeRunModeMeta,
  defaultRunMode,
  isUsingWorkspaceDefaultMode,
  onSessionModeSelection,
}: SessionModePickerProps): JSX.Element => {
  const ActiveRunModeIcon = activeRunModeMeta.icon;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`Execution mode: ${activeRunModeMeta.label}`}
          className={cn(
            "app-mode-picker-button h-8 w-8 rounded-full border p-0 text-xs font-medium shadow-none",
            activeRunModeMeta.triggerClassName,
          )}
        >
          <ActiveRunModeIcon
            className={cn("h-3.5 w-3.5", activeRunModeMeta.iconClassName)}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 rounded-3xl border-slate-800 bg-slate-950/95 p-5 shadow-2xl backdrop-blur-xl"
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
              Execution mode
            </p>
            <p className="text-sm leading-6 text-slate-400">
              Switch between read-only Ask mode and full Machdoch mode without
              leaving the composer.
            </p>
          </div>

          <button
            type="button"
            aria-label="Use workspace default mode"
            onClick={() => onSessionModeSelection(null)}
            className={cn(
              "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
              isUsingWorkspaceDefaultMode
                ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-slate-300">
              <CircleDashed className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">
                  Workspace default
                </p>
                {isUsingWorkspaceDefaultMode ? (
                  <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-200">
                    Current
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                {`Currently ${RUN_MODE_META[defaultRunMode].label}. Use your workspace config or environment default.`}
              </p>
            </div>
          </button>

          <div className="grid gap-2">
            {RUN_MODE_ORDER.map((mode) => {
              const meta = RUN_MODE_META[mode];
              const ModeIcon = meta.icon;
              const isSelected =
                activeRunMode === mode && !isUsingWorkspaceDefaultMode;

              return (
                <button
                  key={mode}
                  type="button"
                  aria-label={`Choose ${meta.label}`}
                  onClick={() => onSessionModeSelection(mode)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
                    isSelected
                      ? meta.selectedClassName
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950",
                      meta.iconClassName,
                    )}
                  >
                    <ModeIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-100">
                        {meta.label}
                      </p>
                      {isSelected ? (
                        <Badge className="border-slate-700 bg-slate-950 text-slate-200">
                          <Check className="mr-1 h-3 w-3" />
                          Current
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      {meta.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
