import { useState, type JSX } from "react";
import type {
  AgentLivePlanStep,
  AgentLiveState,
} from "@machdoch/fleet-protocol/task-thinking";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  AgentLiveDetailsDialog,
  AgentSteeringList,
  formatLimitReset,
  formatTokens,
  getContextRatio,
  limitTone,
} from "./agent-live-details";
import { ContextGauge, FastTierIcon, PlanStepIcon } from "./agent-live-icons";

const RunningTasksIndicator = ({ count }: { count: number }): JSX.Element => (
  <span className="inline-flex shrink-0 items-center gap-1 text-sky-200">
    <span className="relative flex h-1.5 w-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400/60" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-400" />
    </span>
    {count} running
  </span>
);

const AgentPlanSummary = ({
  plan,
}: {
  plan: readonly AgentLivePlanStep[];
}): JSX.Element => {
  const completed = plan.filter((step) => step.status === "completed").length;
  const current =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status === "pending");
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={current?.text}>
      <PlanStepIcon
        status={current?.status ?? "completed"}
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          current ? "text-sky-300" : "text-emerald-300",
        )}
      />
      <span className="shrink-0 font-medium tabular-nums text-slate-200">
        Plan {completed}/{plan.length}
      </span>
      {current ? (
        <span className="min-w-0 truncate text-slate-400">{current.text}</span>
      ) : null}
    </span>
  );
};

export interface AgentRunStatusButtonProps {
  live: AgentLiveState;
  running: boolean;
  onStopTask?: ((taskId: string) => Promise<void>) | undefined;
  onResendSteer?: ((text: string) => void) | undefined;
}

/** The run's current plan step in one line, opening its full details. */
export const AgentRunStatusButton = ({
  live,
  running,
  onStopTask,
  onResendSteer,
}: AgentRunStatusButtonProps): JSX.Element | null => {
  const [open, setOpen] = useState(false);
  const plan = live.plan ?? [];
  const runningTasks = (live.tasks ?? []).filter(
    (task) => task.status === "running",
  ).length;
  if (plan.length === 0 && runningTasks === 0) return null;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label="Open run details"
        onClick={() => setOpen(true)}
        className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-xs transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
      >
        {plan.length > 0 ? <AgentPlanSummary plan={plan} /> : null}
        {plan.length === 0 ? <RunningTasksIndicator count={runningTasks} /> : null}
      </button>
      <AgentLiveDetailsDialog
        open={open}
        onOpenChange={setOpen}
        live={live}
        running={running}
        onStopTask={onStopTask}
        onResendSteer={onResendSteer}
        now={Date.now()}
      />
    </>
  );
};

/**
 * What the provider CLI reported live for a run, in one line: context, tokens,
 * plan limits and the current plan step.
 */
export const AgentLiveSummary = ({
  live,
  running,
  now,
}: {
  live: AgentLiveState;
  running: boolean;
  now: number;
}): JSX.Element | null => {
  const usage = live.usage;
  const contextRatio = getContextRatio(usage);
  const runningTasks = (live.tasks ?? []).filter((task) => task.status === "running");
  const plan = live.plan ?? [];
  const files = live.fileChanges ?? [];
  const limits = live.limits ?? [];
  const hasTokens =
    usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined);

  if (
    contextRatio === undefined &&
    !hasTokens &&
    limits.length === 0 &&
    !live.fastMode &&
    !(running && runningTasks.length > 0) &&
    plan.length === 0 &&
    files.length === 0
  ) {
    return null;
  }

  return (
    <div className="app-agent-live @container flex min-w-0 flex-1 flex-nowrap items-center gap-3 text-xs text-slate-300"
    >
      {contextRatio !== undefined ? (
        <div
          className="flex shrink-0 items-center gap-1"
          title={`Context window: ${formatTokens(usage?.contextUsedTokens)} / ${formatTokens(usage?.contextWindowTokens)}`}
        >
          <ContextGauge
            ratio={contextRatio}
            size={15}
            label={`Context ${Math.round(contextRatio * 100)}% full`}
          />
          <span className="font-medium tabular-nums text-slate-200">
            {Math.round(contextRatio * 100)}%
          </span>
        </div>
      ) : null}

      {hasTokens ? (
        <div
          className="flex shrink-0 items-baseline gap-1 tabular-nums @max-[30rem]:hidden"
          title={usage.cachedInputTokens ? `${formatTokens(usage.cachedInputTokens)} cached` : "Tokens used by this run"}
        >
          <span className="text-slate-200">{formatTokens(usage.inputTokens)}</span>
          <span className="text-slate-500">in</span>
          <span className="text-slate-200">{formatTokens(usage.outputTokens)}</span>
          <span className="text-slate-500">out</span>
        </div>
      ) : null}

      {limits.map((limit) => {
        const reset = formatLimitReset(limit.resetsAt, now);
        return (
          <div
            key={limit.id}
            className="flex shrink-0 items-center gap-1 @max-[42rem]:hidden"
            title={`${limit.label}: ${Math.round(limit.usedPercent)}% used${reset ? `, ${reset}` : ""}`}
          >
            <span className="h-1 w-6 overflow-hidden rounded-full bg-slate-800">
              <span
                className={cn("block h-full rounded-full", limitTone(limit))}
                style={{ width: `${Math.min(100, Math.max(2, limit.usedPercent))}%` }}
              />
            </span>
            <span className="tabular-nums text-slate-400">{Math.round(limit.usedPercent)}%</span>
          </div>
        );
      })}

      {live.fastMode ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-amber-200 @max-[24rem]:hidden"
          title="Fast tier"
        >
          <FastTierIcon className="h-3 w-3" />
          Fast
        </span>
      ) : null}

      {running && runningTasks.length > 0 ? (
        <RunningTasksIndicator count={runningTasks.length} />
      ) : null}

      <div className="min-w-0 flex-1">
        {plan.length > 0 ? <AgentPlanSummary plan={plan} /> : null}
      </div>

      {files.length > 0 ? (
        <span className="shrink-0 text-slate-500 @max-[24rem]:hidden">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
      ) : null}
    </div>
  );
};

/** Live run problems that stay visible while the run's details are closed. */
export const AgentLiveAlerts = ({
  live,
  onResendSteer,
}: {
  live: AgentLiveState;
  onResendSteer?: ((text: string) => void) | undefined;
}): JSX.Element | null => {
  const failedSteering = (live.steering ?? []).filter((entry) => entry.status === "failed");
  const latestAlert = (live.notices ?? [])
    .filter((notice) => notice.tone === "danger" || notice.tone === "warning")
    .at(-1);

  if (failedSteering.length === 0 && !latestAlert) return null;

  return (
    <div className="grid gap-1 px-3 pb-2 text-xs">
      {failedSteering.length > 0 ? (
        <AgentSteeringList steering={failedSteering} onResend={onResendSteer} />
      ) : null}
      {latestAlert ? (
        <p
          className={cn(
            "m-0 truncate",
            latestAlert.tone === "danger" ? "text-rose-300" : "text-amber-200",
          )}
          title={latestAlert.text}
        >
          {latestAlert.text}
        </p>
      ) : null}
    </div>
  );
};
