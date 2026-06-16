import { TerminalSquare } from "lucide-react";
import type { JSX, MouseEventHandler } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import {
  getProviderLabel,
  SUPPORTED_PROVIDER_ORDER,
} from "../../model-catalog";
import type { RuntimeProviderAvailability } from "../../runtime";

export interface ShellTitlebarProps {
  providerStatuses: RuntimeProviderAvailability[];
  onMinimizeWindow: MouseEventHandler<HTMLButtonElement>;
  onToggleMaximizeWindow: MouseEventHandler<HTMLButtonElement>;
  onCloseWindow: MouseEventHandler<HTMLButtonElement>;
}

export const ShellTitlebar = ({
  providerStatuses,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onCloseWindow,
}: ShellTitlebarProps): JSX.Element => {
  const runtimeProviderLookup = new Map(
    providerStatuses.map((entry) => [entry.provider, entry.configured]),
  );

  return (
    <div className="relative z-50 flex h-10 w-full shrink-0 select-none items-center border-b border-slate-900 bg-slate-950/90 px-3">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        data-tauri-drag-region
      />
      <div
        className="relative z-10 flex items-center gap-2"
        data-tauri-drag-region
      >
        <TerminalSquare
          className="h-4 w-4 text-sky-500"
          data-tauri-drag-region
        />
        <span
          className="text-[11px] font-bold tracking-[0.2em] text-slate-400 uppercase"
          data-tauri-drag-region
        >
          Machdoch
        </span>
      </div>
      <div className="min-w-0 flex-1" data-tauri-drag-region />
      <div className="relative z-10 flex items-center gap-1" data-tauri-no-drag>
        {SUPPORTED_PROVIDER_ORDER.map((provider) => {
          const configured = runtimeProviderLookup.get(provider) ?? false;

          return (
            <Tooltip key={provider}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "mx-1 h-2 w-2 rounded-full",
                    configured
                      ? "bg-emerald-500 shadow-[0_0_8px_rgba(63,137,117,0.32)]"
                      : "bg-slate-700",
                  )}
                  data-tauri-no-drag
                />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <span className="font-semibold text-slate-200">
                  {getProviderLabel(provider)}
                </span>
                : {configured ? "Connected" : "Unconfigured"}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <div className="mx-2 h-4 w-px bg-slate-800" />
        <button
          type="button"
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
          data-tauri-no-drag
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={onMinimizeWindow}
          tabIndex={-1}
        >
          <svg width="10" height="1" viewBox="0 0 10 1">
            <path fill="currentColor" d="M0 0h10v1H0z" />
          </svg>
        </button>
        <button
          type="button"
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
          data-tauri-no-drag
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={onToggleMaximizeWindow}
          tabIndex={-1}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M1 1h8v8H1V1zm1 1v6h6V2H2z"
            />
          </svg>
        </button>
        <button
          type="button"
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-500 hover:text-white"
          data-tauri-no-drag
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={onCloseWindow}
          tabIndex={-1}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M1.354 2.061l7.07 7.071-.707.707-7.071-7.071.708-.707z"
            />
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M8.425 1.354l.707.707-7.071 7.071-.707-.707 7.071-7.071z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};
