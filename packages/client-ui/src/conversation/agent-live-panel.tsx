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

const PROVIDER_NAMES: Record<AgentLiveState["provider"], string> = {
  "claude-cli": "Claude",
  "codex-cli": "Codex",
  "copilot-cli": "Copilot",
};

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
          "h-3 w-3 shrink-0",
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
        className="flex h-5 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-[11px] transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
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

export interface AgentLivePanelProps {
  live: AgentLiveState;
  running: boolean;
  /** Present when the run accepts stop requests for its background tasks. */
  onStopTask?: (taskId: string) => Promise<void>;
  /** Sends a steering message the agent never read as a new message. */
  onResendSteer?: (text: string) => void;
  now?: number;
}

/**
 * Shows what the provider CLI reported live for a run in one line: context,
 * plan limits and the current plan step. The rest opens in a dialog; only
 * problems that need attention stay visible below the line.
 */
export const AgentLivePanel = ({
  live,
  running,
  onStopTask,
  onResendSteer,
  now = Date.now(),
}: AgentLivePanelProps): JSX.Element | null => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const usage = live.usage;
  const contextRatio = getContextRatio(usage);
  const tasks = live.tasks ?? [];
  const runningTasks = tasks.filter((task) => task.status === "running");
  const plan = live.plan ?? [];
  const files = live.fileChanges ?? [];
  const steering = live.steering ?? [];
  const notices = live.notices ?? [];
  const limits = live.limits ?? [];
  const hasDetails =
    plan.length > 0 || files.length > 0 || tasks.length > 0 || steering.length > 0 || notices.length > 0;
  const hasSummary = Boolean(usage) || limits.length > 0 || live.fastMode === true;

  if (!hasSummary && !hasDetails) return null;

  const failedSteering = steering.filter((entry) => entry.status === "failed");
  const latestAlert = notices
    .filter((notice) => notice.tone === "danger" || notice.tone === "warning")
    .at(-1);

  return (
    <section
      aria-label={`${PROVIDER_NAMES[live.provider]} live run details`}
      className="app-agent-live @container w-full min-w-0 rounded-lg border border-slate-800/70 bg-slate-950/40 px-2 py-0.5 text-[11px] text-slate-300"
    >
      <div className="flex h-6 min-w-0 flex-nowrap items-center gap-2.5">
        {contextRatio !== undefined ? (
          <div
            className="flex shrink-0 items-center gap-1"
            title={`Context window: ${formatTokens(usage?.contextUsedTokens)} / ${formatTokens(usage?.contextWindowTokens)}`}
          >
            <ContextGauge
              ratio={contextRatio}
              size={14}
              label={`Context ${Math.round(contextRatio * 100)}% full`}
            />
            <span className="font-medium tabular-nums text-slate-200">
              {Math.round(contextRatio * 100)}%
            </span>
          </div>
        ) : null}

        {usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? (
          <div
            className="flex shrink-0 items-baseline gap-1 tabular-nums @max-[36rem]:hidden"
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
              className="flex shrink-0 items-center gap-1 @max-[48rem]:hidden"
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
            className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-amber-200 @max-[28rem]:hidden"
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
          <span className="shrink-0 text-slate-500 @max-[28rem]:hidden">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        ) : null}

        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setDetailsOpen(true)}
          className="shrink-0 rounded px-1.5 text-[10px] leading-5 font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        >
          Details
        </button>
      </div>

      {failedSteering.length > 0 ? (
        <div className="py-1">
          <AgentSteeringList steering={failedSteering} onResend={onResendSteer} />
        </div>
      ) : null}

      {latestAlert ? (
        <p
          className={cn(
            "m-0 truncate pb-0.5",
            latestAlert.tone === "danger" ? "text-rose-300" : "text-amber-200",
          )}
          title={latestAlert.text}
        >
          {latestAlert.text}
        </p>
      ) : null}

      <AgentLiveDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        live={live}
        running={running}
        onStopTask={onStopTask}
        onResendSteer={onResendSteer}
        now={now}
      />
    </section>
  );
};
