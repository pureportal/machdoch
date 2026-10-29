import { useMemo, useState, type JSX } from "react";
import type {
  AgentLiveLimit,
  AgentLiveState,
  AgentLiveTask,
} from "@machdoch/fleet-protocol/task-thinking";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
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

const formatTokens = (value: number | undefined): string =>
  value === undefined ? "–" : compactNumber.format(value);

const formatReset = (resetsAt: number | undefined, now: number): string | undefined => {
  if (!resetsAt) return undefined;
  const remainingMs = resetsAt - now;
  if (remainingMs <= 0) return "resetting";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `resets in ${hours} h`;
  return `resets ${new Date(resetsAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
};

const limitTone = (limit: AgentLiveLimit): string =>
  limit.limited || limit.usedPercent >= 90
    ? "bg-rose-400"
    : limit.usedPercent >= 70
      ? "bg-amber-300"
      : "bg-sky-400";

const PROVIDER_NAMES: Record<AgentLiveState["provider"], string> = {
  "claude-cli": "Claude",
  "codex-cli": "Codex",
  "copilot-cli": "Copilot",
};

const TaskKindIcon = ({ kind }: { kind: AgentLiveTask["kind"] }) => {
  const className = "h-3.5 w-3.5";
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
 * Shows what the provider CLI reported live for a run: context and plan
 * limits, the agent's plan, changed files and background work.
 */
export const AgentLivePanel = ({
  live,
  running,
  onStopTask,
  onResendSteer,
  now = Date.now(),
}: AgentLivePanelProps): JSX.Element | null => {
  // Undelivered steering stays visible so it can be sent again.
  const [expanded, setExpanded] = useState(
    () => running || (live.steering ?? []).some((steer) => steer.status === "failed"),
  );
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);
  const usage = live.usage;
  const contextRatio =
    usage?.contextUsedTokens && usage.contextWindowTokens
      ? usage.contextUsedTokens / usage.contextWindowTokens
      : undefined;
  const tasks = live.tasks ?? [];
  const runningTasks = tasks.filter((task) => task.status === "running");
  const plan = live.plan ?? [];
  const completedSteps = plan.filter((step) => step.status === "completed").length;
  const files = live.fileChanges ?? [];
  const steering = live.steering ?? [];
  const notices = live.notices ?? [];
  const canStopTasks =
    running && Boolean(onStopTask) && live.capabilities.includes("stop-task");
  const hasDetails =
    plan.length > 0 || files.length > 0 || tasks.length > 0 || steering.length > 0 || notices.length > 0;
  const hasSummary =
    Boolean(usage) || (live.limits?.length ?? 0) > 0 || live.fastMode === true;
  const visibleTasks = useMemo(
    () =>
      [...tasks]
        .sort((left, right) =>
          left.status === right.status ? 0 : left.status === "running" ? -1 : 1,
        )
        .slice(0, 12),
    [tasks],
  );

  if (!hasSummary && !hasDetails) return null;

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
    <section
      aria-label={`${PROVIDER_NAMES[live.provider]} live run details`}
      className="app-agent-live w-full min-w-0 rounded-2xl border border-slate-800/80 bg-slate-950/40 px-3 py-2 text-xs text-slate-300"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        {contextRatio !== undefined ? (
          <div className="flex items-center gap-2" title="Context window in use">
            <ContextGauge
              ratio={contextRatio}
              size={26}
              label={`Context ${Math.round(contextRatio * 100)}% full`}
            />
            <div className="leading-tight">
              <div className="font-semibold tabular-nums text-slate-100">
                {Math.round(contextRatio * 100)}%
              </div>
              <div className="tabular-nums text-[10px] text-slate-500">
                {formatTokens(usage?.contextUsedTokens)} / {formatTokens(usage?.contextWindowTokens)}
              </div>
            </div>
          </div>
        ) : null}

        {usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? (
          <div className="flex items-baseline gap-1.5 tabular-nums" title="Tokens used by this run">
            <span className="text-slate-500">Tokens</span>
            <span className="font-medium text-slate-200">{formatTokens(usage.inputTokens)}</span>
            <span className="text-slate-600">in</span>
            <span className="font-medium text-slate-200">{formatTokens(usage.outputTokens)}</span>
            <span className="text-slate-600">out</span>
            {usage.cachedInputTokens ? (
              <span className="text-[10px] text-emerald-300/80">
                {formatTokens(usage.cachedInputTokens)} cached
              </span>
            ) : null}
            {usage.costUsd !== undefined && usage.costUsd > 0 ? (
              <span className="text-[10px] text-slate-500" title="Estimated cost at list prices">
                ≈ ${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}
              </span>
            ) : null}
          </div>
        ) : null}

        {(live.limits ?? []).map((limit) => {
          const reset = formatReset(limit.resetsAt, now);
          return (
            <div
              key={limit.id}
              className="flex min-w-[8.5rem] flex-col gap-1"
              title={`${limit.label}: ${Math.round(limit.usedPercent)}% used${reset ? `, ${reset}` : ""}`}
            >
              <div className="flex items-center justify-between gap-2 text-[10px]">
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
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
            <FastTierIcon className="h-3 w-3" />
            Fast
          </span>
        ) : null}

        {running && runningTasks.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-sky-200">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
            </span>
            {runningTasks.length} running
          </span>
        ) : null}

        {hasDetails ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="ml-auto rounded-full border border-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
          >
            {expanded ? "Less" : `More${plan.length ? ` · plan ${completedSteps}/${plan.length}` : ""}${files.length ? ` · ${files.length} file${files.length === 1 ? "" : "s"}` : ""}`}
          </button>
        ) : null}
      </div>

      {expanded && hasDetails ? (
        <div className="mt-2.5 grid gap-3 border-t border-slate-800/70 pt-2.5">
          {plan.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Plan · {completedSteps}/{plan.length}
              </div>
              <ol className="m-0 grid list-none gap-1 p-0">
                {plan.map((step, index) => (
                  <li key={`${index}-${step.text}`} className="flex items-start gap-2">
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

          {visibleTasks.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {tasks.some((task) => task.background) ? "Background work" : "Commands & agents"}
              </div>
              <ul className="m-0 grid list-none gap-1 p-0">
                {visibleTasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex min-w-0 items-center gap-2 rounded-lg bg-slate-900/60 px-2 py-1"
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
                        task.status === "running"
                          ? "border-sky-500/30 text-sky-200"
                          : task.status === "failed"
                            ? "border-rose-500/30 text-rose-200"
                            : "border-slate-700 text-slate-400",
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
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-rose-200/80 transition-colors hover:bg-rose-500/15 hover:text-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60 disabled:opacity-40"
                      >
                        <StopTaskIcon className="h-4 w-4" />
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
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Changed files
              </div>
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {files.slice(0, 10).map((file) => (
                  <li
                    key={file.path}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/70 px-1.5 py-0.5 font-mono text-[10.5px]"
                    title={file.path}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        file.kind === "add" ? "bg-emerald-400" : file.kind === "delete" ? "bg-rose-400" : "bg-sky-400",
                      )}
                    />
                    <span className="truncate text-slate-300">{file.path.split(/[\\/]/u).slice(-2).join("/")}</span>
                    {file.additions ? <span className="text-emerald-300">+{file.additions}</span> : null}
                    {file.deletions ? <span className="text-rose-300">−{file.deletions}</span> : null}
                  </li>
                ))}
                {files.length > 10 ? (
                  <li className="px-1 py-0.5 text-[10.5px] text-slate-500">+{files.length - 10} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {steering.length > 0 ? (
            <ul className="m-0 grid list-none gap-1 p-0">
              {steering.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 text-[11px]">
                  <SteerIcon
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
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
                  {entry.status === "failed" && onResendSteer ? (
                    <button
                      type="button"
                      onClick={() => onResendSteer(entry.text)}
                      className="shrink-0 rounded-full border border-violet-400/30 px-2 py-0.5 text-[10px] font-medium text-violet-200 transition-colors hover:bg-violet-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
                    >
                      Send again
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {notices.length > 0 ? (
            <ul className="m-0 grid list-none gap-0.5 p-0 text-[11px]">
              {notices.slice(-4).map((notice) => (
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
      ) : null}
    </section>
  );
};
