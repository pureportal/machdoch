import { useMemo, useState, type JSX } from "react";
import type {
  AgentLiveLimit,
  AgentLiveState,
  AgentLiveTask,
} from "@machdoch/fleet-protocol/task-thinking";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { CompactDialog } from "../common/compact-dialog";
import {
  AgentTaskIcon,
  ContextGauge,
  FastTierIcon,
  MonitorTaskIcon,
  PlanStepIcon,
  ShellTaskIcon,
  SteerIcon,
  StopTaskIcon,
} from "./agent-live-icons";

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const formatTokens = (value: number | undefined): string =>
  value === undefined ? "–" : compactNumber.format(value);

export const formatLimitReset = (
  resetsAt: number | undefined,
  now: number,
): string | undefined => {
  if (!resetsAt) return undefined;
  const remainingMs = resetsAt - now;
  if (remainingMs <= 0) return "resetting";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `resets in ${hours} h`;
  return `resets ${new Date(resetsAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
};

export const limitTone = (limit: AgentLiveLimit): string =>
  limit.limited || limit.usedPercent >= 90
    ? "bg-rose-400"
    : limit.usedPercent >= 70
      ? "bg-amber-300"
      : "bg-sky-400";

export const getContextRatio = (
  usage: AgentLiveState["usage"],
): number | undefined =>
  usage?.contextUsedTokens && usage.contextWindowTokens
    ? usage.contextUsedTokens / usage.contextWindowTokens
    : undefined;

const TaskKindIcon = ({ kind }: { kind: AgentLiveTask["kind"] }) => {
  const className = "h-3 w-3";
  switch (kind) {
    case "agent":
      return <AgentTaskIcon className={className} />;
    case "monitor":
      return <MonitorTaskIcon className={className} />;
    default:
      return <ShellTaskIcon className={className} />;
  }
};

const TASK_STATUS_LABELS: Record<AgentLiveTask["status"], string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const groupFinishedTasks = (
  tasks: readonly AgentLiveTask[],
): Array<{ task: AgentLiveTask; count: number }> => {
  const groups = new Map<string, { task: AgentLiveTask; count: number }>();
  const sorted = [...tasks].sort((left, right) =>
    left.status === right.status ? 0 : left.status === "running" ? -1 : 1,
  );
  for (const task of sorted) {
    const key =
      task.status === "running"
        ? task.id
        : [task.kind, task.status, task.description, task.summary ?? ""].join("\0");
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { task, count: 1 });
  }
  return [...groups.values()];
};

const SECTION_HEADING_CLASS_NAME =
  "mb-1 text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase";

export const AgentSteeringList = ({
  steering,
  onResend,
}: {
  steering: NonNullable<AgentLiveState["steering"]>;
  onResend?: ((text: string) => void) | undefined;
}): JSX.Element => (
  <ul className="m-0 grid list-none gap-1 p-0">
    {steering.map((entry) => (
      <li key={entry.id} className="flex items-start gap-1.5 text-[11px]">
        <SteerIcon
          className={cn(
            "mt-0.5 h-3 w-3 shrink-0",
            entry.status === "failed" ? "text-rose-300" : "text-violet-300",
          )}
        />
        <span className="min-w-0 flex-1 wrap-break-word text-slate-300">
          <span className="text-slate-500">
            {entry.status === "failed" ? "Steering failed: " : entry.status === "pending" ? "Steering… " : "Steered: "}
          </span>
          {entry.text}
          {entry.error ? <span className="block text-rose-300">{entry.error}</span> : null}
        </span>
        {entry.status === "failed" && onResend ? (
          <button
            type="button"
            onClick={() => onResend(entry.text)}
            className="shrink-0 rounded-full border border-violet-400/30 px-2 text-[10px] leading-4 font-medium text-violet-200 transition-colors hover:bg-violet-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
          >
            Send again
          </button>
        ) : null}
      </li>
    ))}
  </ul>
);

export interface AgentLiveDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  live: AgentLiveState;
  running: boolean;
  /** Present when the run accepts stop requests for its background tasks. */
  onStopTask?: ((taskId: string) => Promise<void>) | undefined;
  /** Sends a steering message the agent never read as a new message. */
  onResendSteer?: ((text: string) => void) | undefined;
  now: number;
}

/** Everything the provider CLI reported live for a run. */
export const AgentLiveDetailsDialog = ({
  open,
  onOpenChange,
  live,
  running,
  onStopTask,
  onResendSteer,
  now,
}: AgentLiveDetailsDialogProps): JSX.Element => {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);
  const usage = live.usage;
  const contextRatio = getContextRatio(usage);
  const tasks = live.tasks ?? [];
  const plan = live.plan ?? [];
  const completedSteps = plan.filter((step) => step.status === "completed").length;
  const files = live.fileChanges ?? [];
  const steering = live.steering ?? [];
  const notices = live.notices ?? [];
  const limits = live.limits ?? [];
  const canStopTasks =
    running && Boolean(onStopTask) && live.capabilities.includes("stop-task");
  const taskGroups = useMemo(() => groupFinishedTasks(tasks), [tasks]);
  const hasTokens =
    usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined);

  const stopTask = async (taskId: string) => {
    if (!onStopTask) return;
    setStopError(null);
    setStopping((current) => new Set([...current, taskId]));
    try {
      await onStopTask(taskId);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "Could not stop the task.");
    } finally {
      // From here the task's own state decides whether it can still be stopped.
      setStopping((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  };

  return (
    <CompactDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run details"
      description="The agent's plan, background work, changed files, and usage for this run."
    >
      <div className="grid gap-3 text-xs text-slate-300">
        {contextRatio !== undefined || hasTokens || limits.length > 0 || live.fastMode ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
            {contextRatio !== undefined ? (
              <div className="flex items-center gap-1.5" title="Context window in use">
                <ContextGauge ratio={contextRatio} size={16} label={`Context ${Math.round(contextRatio * 100)}% full`} />
                <span className="font-semibold tabular-nums text-slate-100">{Math.round(contextRatio * 100)}%</span>
                <span className="tabular-nums text-slate-500">
                  {formatTokens(usage?.contextUsedTokens)} / {formatTokens(usage?.contextWindowTokens)}
                </span>
              </div>
            ) : null}
            {hasTokens ? (
              <div className="flex items-baseline gap-1 tabular-nums" title="Tokens used by this run">
                <span className="font-medium text-slate-200">{formatTokens(usage.inputTokens)}</span>
                <span className="text-slate-500">in</span>
                <span className="font-medium text-slate-200">{formatTokens(usage.outputTokens)}</span>
                <span className="text-slate-500">out</span>
                {usage.cachedInputTokens ? (
                  <span className="text-emerald-300/80">{formatTokens(usage.cachedInputTokens)} cached</span>
                ) : null}
                {usage.costUsd !== undefined && usage.costUsd > 0 ? (
                  <span className="text-slate-500" title="Estimated cost at list prices">
                    ≈ ${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {limits.map((limit) => {
              const reset = formatLimitReset(limit.resetsAt, now);
              return (
                <div key={limit.id} className="flex min-w-[8rem] flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">{limit.label}</span>
                    <span className="tabular-nums text-slate-300">{Math.round(limit.usedPercent)}%</span>
                  </div>
                  <div
                    role="meter"
                    aria-label={limit.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(Math.min(100, limit.usedPercent))}
                    className="h-1 w-full overflow-hidden rounded-full bg-slate-800"
                  >
                    <div
                      className={cn("h-full rounded-full transition-[width] duration-500", limitTone(limit))}
                      style={{ width: `${Math.min(100, Math.max(2, limit.usedPercent))}%` }}
                    />
                  </div>
                  {reset ? <span className="text-[10px] text-slate-500">{reset}</span> : null}
                </div>
              );
            })}
            {live.fastMode ? (
              <span className="inline-flex items-center gap-1 font-semibold text-amber-200">
                <FastTierIcon className="h-3 w-3" />
                Fast
              </span>
            ) : null}
          </div>
        ) : null}

        {plan.length > 0 ? (
          <div>
            <div className={SECTION_HEADING_CLASS_NAME}>
              Plan · {completedSteps}/{plan.length}
            </div>
            <ol className="m-0 grid list-none gap-0.5 p-0">
              {plan.map((step, index) => (
                <li key={`${index}-${step.text}`} className="flex items-start gap-1.5 leading-[1.125rem]">
                  <PlanStepIcon
                    status={step.status}
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      step.status === "completed"
                        ? "text-emerald-300"
                        : step.status === "in_progress"
                          ? "text-sky-300"
                          : "text-slate-600",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 wrap-break-word",
                      step.status === "completed" && "text-slate-500 line-through decoration-slate-700",
                      step.status === "in_progress" && "font-medium text-slate-100",
                    )}
                  >
                    {step.text}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {taskGroups.length > 0 ? (
          <div>
            <div className={SECTION_HEADING_CLASS_NAME}>
              {tasks.some((task) => task.background) ? "Background work" : "Commands & agents"}
            </div>
            <ul className="m-0 grid list-none gap-px p-0">
              {taskGroups.map(({ task, count }) => (
                <li key={task.id} className="flex min-h-6 min-w-0 items-center gap-1.5 rounded px-1 hover:bg-slate-900/60">
                  <span
                    className={cn(
                      "shrink-0",
                      task.status === "running"
                        ? "text-sky-200"
                        : task.status === "failed"
                          ? "text-rose-200"
                          : "text-slate-500",
                    )}
                  >
                    <TaskKindIcon kind={task.kind} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-200" title={task.description}>
                      {task.description}
                    </span>
                    {task.summary && task.summary !== task.description ? (
                      <span className="block truncate text-[10px] text-slate-500" title={task.summary}>
                        {task.summary}
                      </span>
                    ) : null}
                  </span>
                  {count > 1 ? (
                    <span className="shrink-0 text-[10px] tabular-nums text-slate-500">×{count}</span>
                  ) : null}
                  <span
                    className={cn(
                      "shrink-0 text-[10px]",
                      task.status === "running" ? "text-sky-300" : task.status === "failed" ? "text-rose-300" : "text-slate-500",
                    )}
                  >
                    {task.background && task.status === "running" ? "Background" : TASK_STATUS_LABELS[task.status]}
                  </span>
                  {canStopTasks && task.canStop && task.status === "running" ? (
                    <button
                      type="button"
                      aria-label={`Stop ${task.description}`}
                      disabled={stopping.has(task.id)}
                      onClick={() => void stopTask(task.id)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-rose-200/80 transition-colors hover:bg-rose-500/15 hover:text-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60 disabled:opacity-40"
                    >
                      <StopTaskIcon className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {stopError ? <p className="mt-1 text-[11px] text-rose-300">{stopError}</p> : null}
          </div>
        ) : null}

        {files.length > 0 ? (
          <div>
            <div className={SECTION_HEADING_CLASS_NAME}>Changed files · {files.length}</div>
            <ul className="m-0 grid list-none gap-px p-0 font-mono text-[11px]">
              {files.map((file) => (
                <li key={file.path} className="flex min-w-0 items-center gap-1.5 px-1 leading-5" title={file.path}>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      file.kind === "add" ? "bg-emerald-400" : file.kind === "delete" ? "bg-rose-400" : "bg-sky-400",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-slate-300">{file.path}</span>
                  {file.additions ? <span className="shrink-0 text-emerald-300">+{file.additions}</span> : null}
                  {file.deletions ? <span className="shrink-0 text-rose-300">−{file.deletions}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {steering.length > 0 ? (
          <AgentSteeringList steering={steering} onResend={onResendSteer} />
        ) : null}

        {notices.length > 0 ? (
          <ul className="m-0 grid list-none gap-0.5 p-0 text-[11px]">
            {notices.map((notice) => (
              <li
                key={notice.id}
                className={cn(
                  notice.tone === "danger"
                    ? "text-rose-300"
                    : notice.tone === "warning"
                      ? "text-amber-200"
                      : "text-slate-400",
                )}
              >
                {notice.text}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </CompactDialog>
  );
};
