import {
  Ban,
  Check,
  CircleDashed,
  CircleX,
  Clock3,
  LoaderCircle,
  MessageSquareText,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import type { MediaRunRecord } from "../../../../core/media/contracts.js";
import { cn } from "../../lib/utils";
import { isRuntimeRun } from "../media-run-presentation";

export const MEDIA_RUN_STATES: Record<
  MediaRunRecord["status"],
  {
    label: string;
    icon: LucideIcon;
    color: string;
  }
> = {
  draft: { label: "Draft", icon: CircleDashed, color: "text-slate-400" },
  ready: { label: "Ready", icon: Check, color: "text-slate-300" },
  blocked: { label: "Blocked", icon: ShieldAlert, color: "text-rose-300" },
  queued: { label: "Queued", icon: Clock3, color: "text-amber-300" },
  running: { label: "Running", icon: LoaderCircle, color: "text-cyan-300" },
  canceling: {
    label: "Canceling",
    icon: LoaderCircle,
    color: "text-amber-300",
  },
  "needs-review": {
    label: "Needs review",
    icon: ShieldAlert,
    color: "text-amber-300",
  },
  "waiting-for-review": {
    label: "Waiting for review",
    icon: MessageSquareText,
    color: "text-violet-300",
  },
  completed: { label: "Completed", icon: Check, color: "text-emerald-300" },
  failed: { label: "Failed", icon: CircleX, color: "text-rose-300" },
  canceled: { label: "Canceled", icon: Ban, color: "text-slate-400" },
};

export const MediaRunState = ({
  run,
}: {
  run: MediaRunRecord;
}): JSX.Element => {
  const { label, icon: Icon, color } = MEDIA_RUN_STATES[run.status];
  const active =
    isRuntimeRun(run) && ["running", "canceling"].includes(run.status);
  const progress = active
    ? Math.round(Math.min(1, Math.max(0, run.progress)) * 100)
    : null;
  const step =
    active && run.currentStep.toLocaleLowerCase() !== label.toLocaleLowerCase()
      ? run.currentStep
      : null;
  return (
    <span className="block min-w-0 text-xs">
      <span className={cn("flex items-center gap-1.5", color)}>
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0",
            active && "motion-safe:animate-spin",
          )}
        />
        <span>{label}</span>
        {progress !== null ? (
          <span className="ml-auto pl-2 tabular-nums">{progress}%</span>
        ) : null}
      </span>
      {progress !== null ? (
        <span
          role="progressbar"
          aria-label={`${run.flowName} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="mt-2 block h-1 overflow-hidden rounded-full bg-slate-800"
        >
          <span
            className={cn(
              "block h-full rounded-full bg-current motion-safe:transition-[width]",
              color,
            )}
            style={{ width: `${progress}%` }}
          />
        </span>
      ) : null}
      {step ? (
        <span className="mt-1.5 block truncate text-slate-400" title={step}>
          {step}
        </span>
      ) : null}
    </span>
  );
};
