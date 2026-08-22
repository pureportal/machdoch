import {
  AudioWaveform,
  LoaderCircle,
  Mic,
  Square,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export type VoiceInputOverlayStatusTone = "success" | "error" | "info" | null;

export interface VoiceInputOverlayProps {
  title: string;
  recording: boolean;
  transcribing: boolean;
  level: number;
  statusText: string | null;
  statusTone?: VoiceInputOverlayStatusTone;
  idleBadgeText?: string | null;
  showHeader?: boolean;
  showIdleStartAction?: boolean;
  primaryActionDisabled?: boolean;
  onPrimaryAction: () => void;
  headerActions?: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
}

const inferStatusTone = (
  statusText: string | null,
): VoiceInputOverlayStatusTone => {
  if (!statusText) {
    return null;
  }

  if (
    /failed|disabled|unavailable|required|no speech|no voice|error/i.test(
      statusText,
    )
  ) {
    return "error";
  }

  if (/sent|added/i.test(statusText)) {
    return "success";
  }

  return "info";
};

export const VoiceInputOverlay = ({
  title,
  recording,
  transcribing,
  level,
  statusText,
  statusTone,
  idleBadgeText,
  showHeader = true,
  showIdleStartAction = false,
  primaryActionDisabled = false,
  onPrimaryAction,
  headerActions,
  className,
  headerClassName,
  bodyClassName,
}: VoiceInputOverlayProps): JSX.Element => {
  const compactStatus =
    statusText ??
    (transcribing ? "Transcribing..." : recording ? "Listening..." : null);
  const compactStatusTone = statusTone ?? inferStatusTone(statusText);

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-slate-950/98 text-slate-100 shadow-none",
        className,
      )}
    >
      {showHeader ? (
        <header
          className={cn(
            "flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3",
            headerClassName,
          )}
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-sky-400" />
            <p className="text-sm font-semibold text-white">{title}</p>
          </div>

          {headerActions ? (
            <div className="flex items-center gap-2">{headerActions}</div>
          ) : null}
        </header>
      ) : null}

      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4 text-center",
          bodyClassName,
        )}
      >
        <button
          type="button"
          aria-label={recording ? "Stop recording" : "Start recording"}
          disabled={primaryActionDisabled}
          onClick={onPrimaryAction}
          className={cn(
            "relative flex h-24 w-24 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-sky-100 shadow-none outline-none transition-colors duration-150 focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-100",
            recording && "border-rose-500/40 bg-rose-500/10 text-rose-200",
            transcribing &&
              "border-amber-500/30 bg-amber-500/10 text-amber-100",
            !recording &&
              !transcribing &&
              "hover:border-sky-500/40 hover:bg-slate-800",
          )}
        >
          <span
            className={cn(
              "absolute h-full w-full rounded-full bg-sky-500/6 transition-transform duration-150",
              recording && "animate-ping",
            )}
          />
          <span
            className="absolute h-18 w-18 rounded-full bg-sky-500/10 transition-transform duration-150"
            style={{
              transform: `scale(${1 + Math.min(level, 0.2) * 1.9})`,
            }}
          />
          <span className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full bg-slate-950/90">
            {transcribing ? (
              <LoaderCircle className="h-6 w-6 animate-spin" />
            ) : recording ? (
              <Square className="h-5 w-5 fill-current" />
            ) : (
              <AudioWaveform className="h-6 w-6" />
            )}
          </span>
        </button>

        <div className="grid gap-2">
          <p className="text-base font-semibold text-white">
            {transcribing ? "Transcribing" : recording ? "Listening" : "Ready"}
          </p>

          {compactStatus ? (
            <p
              aria-live="polite"
              className={cn(
                "max-w-xs text-sm",
                compactStatusTone === "error"
                  ? "text-rose-300"
                  : compactStatusTone === "success"
                    ? "text-emerald-300"
                    : "text-slate-400",
              )}
            >
              {compactStatus}
            </p>
          ) : null}

          {!recording && !transcribing && idleBadgeText ? (
            <div className="flex items-center justify-center">
              <span className="rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1 text-xs text-slate-400">
                {idleBadgeText}
              </span>
            </div>
          ) : null}
        </div>

        {showIdleStartAction && !recording && !transcribing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onPrimaryAction}
            className="rounded-full border border-slate-800 bg-slate-900/70 px-4 text-slate-200 hover:bg-slate-800 hover:text-white"
          >
            <Mic className="h-4 w-4" />
            Start
          </Button>
        ) : null}
      </div>
    </div>
  );
};
