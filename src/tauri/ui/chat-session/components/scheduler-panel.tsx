import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  History,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import {
  cancelSchedulerRun,
  createSchedulerJob,
  deleteSchedulerJob,
  listSchedulerJobs,
  listSchedulerRuns,
  pauseSchedulerJob,
  resumeSchedulerJob,
  retrySchedulerRun,
  runDueSchedulerJobs,
  triggerSchedulerJob,
  type SchedulerCreateJobInput,
  type SchedulerJobSummary,
  type SchedulerMissedRunPolicy,
  type SchedulerRunStatus,
  type SchedulerRunSummary,
  type SchedulerScheduleSummary,
} from "../../runtime";

export interface SchedulerPanelProps {
  workspaceRoot: string | null | undefined;
}

type ScheduleType = "cron" | "interval" | "delay";
type SchedulerPanelTab = "jobs" | "runs";

const SCHEDULER_PANEL_REFRESH_INTERVAL_MS = 10_000;

interface SchedulerFormState {
  name: string;
  prompt: string;
  scheduleType: ScheduleType;
  cron: string;
  timezone: string;
  intervalMs: string;
  delayMs: string;
  runAtLocal: string;
  contextPaths: string;
  imagePaths: string;
  contextPackJson: string;
  macros: string;
  missedRunPolicy: SchedulerMissedRunPolicy;
  retryAttempts: string;
  retryMinMs: string;
  retryMaxMs: string;
  retryFactor: string;
  retryRandomize: boolean;
  ttlMs: string;
  maxDurationMs: string;
  dedupeKey: string;
  concurrencyKey: string;
  concurrencyLimit: string;
  historyLimit: string;
  maxCatchUpRuns: string;
  mode: "" | "ask" | "machdoch";
  profile: string;
  provider: "" | "openai" | "anthropic" | "google";
  model: string;
}

const createDefaultFormState = (): SchedulerFormState => ({
  name: "",
  prompt: "",
  scheduleType: "cron",
  cron: "0 9 * * *",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  intervalMs: "3600000",
  delayMs: "60000",
  runAtLocal: "",
  contextPaths: "",
  imagePaths: "",
  contextPackJson: "",
  macros: "",
  missedRunPolicy: "enqueue-latest",
  retryAttempts: "3",
  retryMinMs: "1000",
  retryMaxMs: "60000",
  retryFactor: "2",
  retryRandomize: true,
  ttlMs: "",
  maxDurationMs: "",
  dedupeKey: "",
  concurrencyKey: "",
  concurrencyLimit: "1",
  historyLimit: "100",
  maxCatchUpRuns: "100",
  mode: "",
  profile: "",
  provider: "",
  model: "",
});

const terminalRunStatuses = new Set<SchedulerRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
  "skipped",
]);

const formatTimestamp = (timestamp: number | null | undefined): string => {
  if (!timestamp) {
    return "none";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
};

const formatDuration = (milliseconds: number | null | undefined): string => {
  if (!milliseconds) {
    return "default";
  }

  if (milliseconds < 60_000) {
    return `${Math.round(milliseconds / 1_000)}s`;
  }

  if (milliseconds < 3_600_000) {
    return `${Math.round(milliseconds / 60_000)}m`;
  }

  return `${Math.round(milliseconds / 3_600_000)}h`;
};

const formatSchedule = (
  schedule: SchedulerScheduleSummary | null,
  triggerLabel?: string,
): string => {
  if (!schedule) {
    return triggerLabel || "Event triggered";
  }

  switch (schedule.type) {
    case "cron":
      return `${schedule.expression} | ${schedule.timezone}`;
    case "interval":
      return `every ${formatDuration(schedule.intervalMs)}`;
    case "delay":
      return `at ${formatTimestamp(schedule.runAt)}`;
  }
};

const splitLines = (value: string): string[] => {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
};

const parseOptionalPositiveInteger = (
  value: string,
  label: string,
): number | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
};

const parseOptionalPositiveNumber = (
  value: string,
  label: string,
): number | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return parsed;
};

const parseContextPacks = (
  value: string,
): NonNullable<SchedulerCreateJobInput["contextPacks"]> => {
  const normalized = value.trim();

  if (!normalized) {
    return [];
  }

  const parsed = JSON.parse(normalized) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];

  return entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("name" in entry) ||
      typeof entry.name !== "string"
    ) {
      throw new Error("Context pack JSON must include a name.");
    }

    const candidate = entry as {
      name: string;
      instructions?: unknown;
      prompt?: unknown;
      contextPaths?: unknown;
      variableValues?: unknown;
    };

    return {
      name: candidate.name,
      ...(typeof candidate.instructions === "string"
        ? { instructions: candidate.instructions }
        : {}),
      ...(typeof candidate.prompt === "string"
        ? { prompt: candidate.prompt }
        : {}),
      ...(Array.isArray(candidate.contextPaths)
        ? {
            contextPaths: candidate.contextPaths.filter(
              (path): path is string => typeof path === "string",
            ),
          }
        : {}),
      ...(candidate.variableValues &&
      typeof candidate.variableValues === "object" &&
      !Array.isArray(candidate.variableValues)
        ? {
            variableValues: Object.fromEntries(
              Object.entries(candidate.variableValues).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            ),
          }
        : {}),
    };
  });
};

const getStatusBadgeClassName = (status: string): string => {
  switch (status) {
    case "active":
    case "succeeded":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
    case "paused":
    case "queued":
      return "border-amber-500/30 bg-amber-500/10 text-amber-100";
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-100";
    case "failed":
    case "timed_out":
    case "expired":
      return "border-rose-500/30 bg-rose-500/10 text-rose-100";
    case "cancelled":
    case "deleted":
      return "border-slate-600 bg-slate-800 text-slate-300";
    default:
      return "border-slate-700 bg-slate-900 text-slate-300";
  }
};

const getRunIcon = (status: SchedulerRunStatus): JSX.Element => {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 text-emerald-300" />;
    case "failed":
    case "timed_out":
    case "expired":
      return <XCircle className="h-4 w-4 text-rose-300" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-sky-300" />;
    default:
      return <Clock3 className="h-4 w-4 text-slate-400" />;
  }
};

export const SchedulerPanel = ({
  workspaceRoot,
}: SchedulerPanelProps): JSX.Element => {
  const [jobs, setJobs] = useState<SchedulerJobSummary[]>([]);
  const [runs, setRuns] = useState<SchedulerRunSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [tab, setTab] = useState<SchedulerPanelTab>("jobs");
  const [form, setForm] = useState<SchedulerFormState>(createDefaultFormState);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef(false);

  const activeWorkspace = workspaceRoot?.trim() || null;
  const selectedJob = useMemo(() => {
    return jobs.find((job) => job.id === selectedJobId) ?? null;
  }, [jobs, selectedJobId]);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshInFlightRef.current) {
      return;
    }

    if (!activeWorkspace) {
      setJobs([]);
      setRuns([]);
      return;
    }

    refreshInFlightRef.current = true;
    setError(null);

    try {
      const [jobResult, runResult] = await Promise.all([
        listSchedulerJobs(activeWorkspace),
        listSchedulerRuns(activeWorkspace, selectedJobId),
      ]);

      setJobs(jobResult.jobs);
      setRuns(runResult.runs);

      if (
        selectedJobId &&
        !jobResult.jobs.some((job) => job.id === selectedJobId)
      ) {
        setSelectedJobId(null);
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [activeWorkspace, selectedJobId]);

  useEffect(() => {
    void refresh();

    if (!activeWorkspace) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refresh();
    }, SCHEDULER_PANEL_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [activeWorkspace, refresh]);

  const runAction = async (
    actionId: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (!activeWorkspace) {
      setError("Select a workspace before managing scheduled jobs.");
      return;
    }

    setBusyAction(actionId);
    setError(null);
    setMessage(null);

    try {
      await action();
      await refresh();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const updateForm = (
    patch: Partial<SchedulerFormState>,
  ): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const buildCreateInput = (): SchedulerCreateJobInput => {
    const prompt = form.prompt.trim();

    if (!prompt) {
      throw new Error("Prompt is required.");
    }

    const intervalMs = parseOptionalPositiveInteger(
      form.intervalMs,
      "Interval",
    );
    const delayMs = parseOptionalPositiveInteger(form.delayMs, "Delay");
    const hasRunAtLocal = form.runAtLocal.trim().length > 0;
    const runAt = hasRunAtLocal
      ? new Date(form.runAtLocal).getTime()
      : undefined;

    if (form.scheduleType === "delay" && hasRunAtLocal && !Number.isFinite(runAt)) {
      throw new Error("Run at must be a valid local date and time.");
    }

    if (
      form.scheduleType === "delay" &&
      delayMs === undefined &&
      runAt === undefined
    ) {
      throw new Error("Delay or run at is required.");
    }

    return {
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      schedule:
        form.scheduleType === "cron"
          ? {
              type: "cron",
              expression: form.cron.trim(),
              ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
            }
          : form.scheduleType === "interval"
            ? {
                type: "interval",
                intervalMs:
                  intervalMs ??
                  (() => {
                    throw new Error("Interval is required.");
                  })(),
              }
            : {
                type: "delay",
                ...(delayMs ? { delayMs } : {}),
                ...(runAt ? { runAt } : {}),
              },
      prompt,
      contextPaths: splitLines(form.contextPaths),
      imagePaths: splitLines(form.imagePaths),
      contextPacks: parseContextPacks(form.contextPackJson),
      macros: splitLines(form.macros),
      missedRunPolicy: form.missedRunPolicy,
      retryAttempts: parseOptionalPositiveInteger(
        form.retryAttempts,
        "Retry attempts",
      ),
      retryMinMs: parseOptionalPositiveInteger(
        form.retryMinMs,
        "Retry minimum",
      ),
      retryMaxMs: parseOptionalPositiveInteger(
        form.retryMaxMs,
        "Retry maximum",
      ),
      retryFactor: parseOptionalPositiveNumber(
        form.retryFactor,
        "Retry factor",
      ),
      retryRandomize: form.retryRandomize,
      ttlMs: parseOptionalPositiveInteger(form.ttlMs, "TTL"),
      maxDurationMs: parseOptionalPositiveInteger(
        form.maxDurationMs,
        "Max duration",
      ),
      ...(form.dedupeKey.trim() ? { dedupeKey: form.dedupeKey.trim() } : {}),
      ...(form.concurrencyKey.trim()
        ? { concurrencyKey: form.concurrencyKey.trim() }
        : {}),
      concurrencyLimit: parseOptionalPositiveInteger(
        form.concurrencyLimit,
        "Concurrency limit",
      ),
      historyLimit: parseOptionalPositiveInteger(
        form.historyLimit,
        "History limit",
      ),
      maxCatchUpRuns: parseOptionalPositiveInteger(
        form.maxCatchUpRuns,
        "Catch-up limit",
      ),
      ...(form.mode ? { mode: form.mode } : {}),
      ...(form.profile.trim() ? { profile: form.profile.trim() } : {}),
      ...(form.provider ? { provider: form.provider } : {}),
      ...(form.model.trim() ? { model: form.model.trim() } : {}),
    };
  };

  const createJob = async (): Promise<void> => {
    await runAction("create", async () => {
      const result = await createSchedulerJob(activeWorkspace, buildCreateInput());

      setSelectedJobId(result.job.id);
      setMessage(`Created ${result.job.name}.`);
      setForm(createDefaultFormState());
    });
  };

  const runDue = async (): Promise<void> => {
    await runAction("run-due", async () => {
      const result = await runDueSchedulerJobs(activeWorkspace);

      setMessage(`Queued ${result.queued.length}; ran ${result.runs.length}.`);
    });
  };

  const actionButtonBusy = (actionId: string): boolean => {
    return busyAction === actionId;
  };

  const visibleRuns = runs;

  return (
    <DialogContent className="app-scheduler-dialog max-h-[min(820px,calc(100vh-28px))] w-[min(1180px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
      <div className="flex max-h-[min(820px,calc(100vh-28px))] min-h-[560px] flex-col overflow-hidden">
        <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold text-white">
            <CalendarClock className="h-5 w-5 text-emerald-300" />
            Smart Scheduler
          </DialogTitle>
          <DialogDescription className="sr-only">
            Manage scheduled prompt, context pack, and macro jobs.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_25rem]">
          <section className="flex min-h-0 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/70 px-5 py-3">
              <div className="flex min-w-0 items-center gap-2">
                {(["jobs", "runs"] as const).map((item) => (
                  <Button
                    key={item}
                    type="button"
                    variant={tab === item ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setTab(item)}
                    className={cn(
                      "h-8 rounded-lg px-3 text-xs",
                      tab === item
                        ? "bg-slate-800 text-white hover:bg-slate-800"
                        : "text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                    )}
                  >
                    {item === "jobs" ? (
                      <CalendarClock className="h-3.5 w-3.5" />
                    ) : (
                      <History className="h-3.5 w-3.5" />
                    )}
                    {item === "jobs" ? "Jobs" : "Runs"}
                  </Button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(busyAction)}
                  onClick={() => void runDue()}
                  className="h-9 rounded-lg bg-sky-500 px-3 text-xs text-white hover:bg-sky-400"
                >
                  {actionButtonBusy("run-due") ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  Run due
                </Button>
              </div>
            </div>

            {message || error ? (
              <div className="border-b border-slate-800/70 px-5 py-3">
                {message ? (
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
                    {message}
                  </div>
                ) : null}
                {error ? (
                  <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
                    {error}
                  </div>
                ) : null}
              </div>
            ) : null}

            {tab === "jobs" ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="grid gap-3">
                  {jobs.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-500">
                      No scheduled jobs.
                    </div>
                  ) : (
                    jobs.map((job) => (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => {
                          setSelectedJobId(job.id);
                          setTab("runs");
                        }}
                        className={cn(
                          "grid gap-3 rounded-lg border bg-slate-900/45 p-4 text-left transition hover:border-slate-700 hover:bg-slate-900",
                          selectedJobId === job.id
                            ? "border-sky-500/40"
                            : "border-slate-800",
                        )}
                      >
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="truncate text-sm font-medium text-white">
                                {job.name}
                              </div>
                              <Badge
                                variant="outline"
                                className={getStatusBadgeClassName(job.status)}
                              >
                                {job.status}
                              </Badge>
                            </div>
                            <div className="mt-1 truncate font-mono text-xs text-slate-500">
                              {job.id}
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={
                                job.status === "paused"
                                  ? "Resume scheduled job"
                                  : "Pause scheduled job"
                              }
                              title={
                                job.status === "paused"
                                  ? "Resume scheduled job"
                                  : "Pause scheduled job"
                              }
                              disabled={Boolean(busyAction)}
                              onClick={(event) => {
                                event.stopPropagation();
                                void runAction(
                                  `${job.status === "paused" ? "resume" : "pause"}-${job.id}`,
                                  async () => {
                                    if (job.status === "paused") {
                                      await resumeSchedulerJob(activeWorkspace, job.id);
                                      setMessage(`Resumed ${job.name}.`);
                                      return;
                                    }

                                    await pauseSchedulerJob(activeWorkspace, job.id);
                                    setMessage(`Paused ${job.name}.`);
                                  },
                                );
                              }}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                            >
                              {job.status === "paused" ? (
                                <Play className="h-4 w-4" />
                              ) : (
                                <Pause className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Run scheduled job now"
                              title="Run scheduled job now"
                              disabled={Boolean(busyAction)}
                              onClick={(event) => {
                                event.stopPropagation();
                                void runAction(`trigger-${job.id}`, async () => {
                                  const result = await triggerSchedulerJob(
                                    activeWorkspace,
                                    job.id,
                                  );

                                  setMessage(
                                    `Triggered ${job.name}: ${result.runs.length} run.`,
                                  );
                                });
                              }}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                            >
                              <Zap className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete scheduled job"
                              title="Delete scheduled job"
                              disabled={Boolean(busyAction)}
                              onClick={(event) => {
                                event.stopPropagation();
                                void runAction(`delete-${job.id}`, async () => {
                                  await deleteSchedulerJob(activeWorkspace, job.id);
                                  setMessage(`Deleted ${job.name}.`);
                                });
                              }}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <div className="text-slate-600">Schedule</div>
                            <div className="truncate text-slate-300">
                              {formatSchedule(job.schedule, job.triggerLabel)}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-600">Next</div>
                            <div className="text-slate-300">
                              {formatTimestamp(job.nextRunAt)}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-600">Queue</div>
                            <div className="truncate text-slate-300">
                              {job.queue.concurrencyKey} |{" "}
                              {job.queue.concurrencyLimit}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-600">Retries</div>
                            <div className="text-slate-300">
                              {job.retry.maxAttempts} |{" "}
                              {formatDuration(job.maxDurationMs)}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-sm font-medium text-white">
                    {selectedJob ? selectedJob.name : "All runs"}
                  </div>
                  {selectedJobId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedJobId(null)}
                      className="h-8 rounded-lg px-2 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                    >
                      Clear filter
                    </Button>
                  ) : null}
                </div>

                <div className="grid gap-2">
                  {visibleRuns.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-500">
                      No run history.
                    </div>
                  ) : (
                    visibleRuns.map((run) => (
                      <div
                        key={run.id}
                        className="grid gap-2 rounded-lg border border-slate-800 bg-slate-900/45 p-3"
                      >
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            {getRunIcon(run.status)}
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <code className="truncate text-xs text-slate-300">
                                  {run.id}
                                </code>
                                <Badge
                                  variant="outline"
                                  className={getStatusBadgeClassName(run.status)}
                                >
                                  {run.status}
                                </Badge>
                              </div>
                              <div className="mt-1 truncate text-xs text-slate-600">
                                job {run.jobId}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Retry scheduled run"
                              title="Retry scheduled run"
                              disabled={
                                Boolean(busyAction) ||
                                run.status === "succeeded" ||
                                !terminalRunStatuses.has(run.status)
                              }
                              onClick={() => {
                                void runAction(`retry-${run.id}`, async () => {
                                  const result = await retrySchedulerRun(
                                    activeWorkspace,
                                    run.id,
                                  );

                                  setMessage(
                                    `Retry queued as ${result.handle.runId}.`,
                                  );
                                });
                              }}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Cancel scheduled run"
                              title="Cancel scheduled run"
                              disabled={
                                Boolean(busyAction) ||
                                terminalRunStatuses.has(run.status)
                              }
                              onClick={() => {
                                void runAction(`cancel-${run.id}`, async () => {
                                  await cancelSchedulerRun(activeWorkspace, run.id);
                                  setMessage(`Cancelled ${run.id}.`);
                                });
                              }}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"
                            >
                              <XCircle className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-2 text-xs text-slate-500 sm:grid-cols-4">
                          <div>
                            <div className="text-slate-600">Scheduled</div>
                            <div className="text-slate-300">
                              {formatTimestamp(run.scheduledFor)}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-600">Attempts</div>
                            <div className="text-slate-300">
                              {run.attempt}/{run.maxAttempts}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-600">Queue</div>
                            <div className="truncate text-slate-300">
                              {run.queueKey}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-600">Expires</div>
                            <div className="text-slate-300">
                              {formatTimestamp(run.expiresAt)}
                            </div>
                          </div>
                        </div>

                        {run.error || run.summary ? (
                          <div className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-400">
                            {run.error ?? run.summary}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </section>

          <aside className="min-h-0 overflow-y-auto border-t border-slate-800 bg-slate-950/80 px-5 py-5 lg:border-l lg:border-t-0">
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void createJob();
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <Plus className="h-4 w-4 text-sky-300" />
                  Create Job
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={Boolean(busyAction)}
                  className="h-8 rounded-lg bg-sky-500 px-3 text-xs text-white hover:bg-sky-400"
                >
                  {actionButtonBusy("create") ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  Create
                </Button>
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-medium text-slate-400" htmlFor="scheduler-name">
                  Name
                </label>
                <Input
                  id="scheduler-name"
                  value={form.name}
                  onChange={(event) => updateForm({ name: event.target.value })}
                  className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600"
                  placeholder="Workspace sweep"
                />
              </div>

              <div className="grid gap-2">
                <label className="text-xs font-medium text-slate-400" htmlFor="scheduler-prompt">
                  Prompt
                </label>
                <Textarea
                  id="scheduler-prompt"
                  value={form.prompt}
                  rows={4}
                  onChange={(event) => updateForm({ prompt: event.target.value })}
                  className="max-h-40 min-h-24 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600"
                  placeholder="/daily-review"
                />
              </div>

              <div className="grid gap-2">
                <div className="text-xs font-medium text-slate-400">Schedule</div>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
                  {(["cron", "interval", "delay"] as const).map((type) => (
                    <Button
                      key={type}
                      type="button"
                      variant={form.scheduleType === type ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => updateForm({ scheduleType: type })}
                      className={cn(
                        "h-8 rounded-md px-2 text-xs capitalize",
                        form.scheduleType === type
                          ? "bg-slate-700 text-white hover:bg-slate-700"
                          : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                      )}
                    >
                      {type}
                    </Button>
                  ))}
                </div>

                {form.scheduleType === "cron" ? (
                  <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                    <Input
                      value={form.cron}
                      onChange={(event) => updateForm({ cron: event.target.value })}
                      className="h-9 rounded-lg border-slate-800 bg-slate-900/70 font-mono text-sm text-slate-100"
                    />
                    <Input
                      value={form.timezone}
                      onChange={(event) =>
                        updateForm({ timezone: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                    />
                  </div>
                ) : null}

                {form.scheduleType === "interval" ? (
                  <Input
                    type="number"
                    min={1}
                    value={form.intervalMs}
                    onChange={(event) =>
                      updateForm({ intervalMs: event.target.value })
                    }
                    className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                  />
                ) : null}

                {form.scheduleType === "delay" ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      type="number"
                      min={1}
                      value={form.delayMs}
                      onChange={(event) =>
                        updateForm({ delayMs: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                    />
                    <Input
                      type="datetime-local"
                      value={form.runAtLocal}
                      onChange={(event) =>
                        updateForm({ runAtLocal: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-900/70 text-sm text-slate-100"
                    />
                  </div>
                ) : null}
              </div>

              <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
                <div className="text-xs font-medium text-slate-300">
                  Context
                </div>
                <Textarea
                  value={form.contextPaths}
                  rows={2}
                  onChange={(event) =>
                    updateForm({ contextPaths: event.target.value })
                  }
                  className="max-h-28 rounded-lg border-slate-800 bg-slate-950 text-xs text-slate-100 placeholder:text-slate-600"
                  placeholder="src/core"
                />
                <Textarea
                  value={form.contextPackJson}
                  rows={2}
                  onChange={(event) =>
                    updateForm({ contextPackJson: event.target.value })
                  }
                  className="max-h-28 rounded-lg border-slate-800 bg-slate-950 font-mono text-xs text-slate-100 placeholder:text-slate-600"
                  placeholder='{"name":"release-check"}'
                />
                <Textarea
                  value={form.macros}
                  rows={2}
                  onChange={(event) => updateForm({ macros: event.target.value })}
                  className="max-h-28 rounded-lg border-slate-800 bg-slate-950 text-xs text-slate-100 placeholder:text-slate-600"
                  placeholder="/triage --scope backend"
                />
              </div>

              <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
                <div className="text-xs font-medium text-slate-300">
                  Policies
                </div>
                <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                  <span>Missed Run Policy</span>
                  <select
                    value={form.missedRunPolicy}
                    onChange={(event) =>
                      updateForm({
                        missedRunPolicy: event.target
                          .value as SchedulerMissedRunPolicy,
                      })
                    }
                    className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                  >
                    <option value="enqueue-latest">Enqueue Latest</option>
                    <option value="enqueue-all">Enqueue All</option>
                    <option value="skip">Skip Missed Runs</option>
                  </select>
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Retry Attempts</span>
                    <Input
                      type="number"
                      min={1}
                      value={form.retryAttempts}
                      onChange={(event) =>
                        updateForm({ retryAttempts: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Attempts"
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Concurrency Limit</span>
                    <Input
                      type="number"
                      min={1}
                      value={form.concurrencyLimit}
                      onChange={(event) =>
                        updateForm({ concurrencyLimit: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Limit"
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Queue Key</span>
                    <Input
                      value={form.concurrencyKey}
                      onChange={(event) =>
                        updateForm({ concurrencyKey: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Shared queue key"
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Dedupe Key</span>
                    <Input
                      value={form.dedupeKey}
                      onChange={(event) =>
                        updateForm({ dedupeKey: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Stable job key"
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Queue TTL ms</span>
                    <Input
                      type="number"
                      min={1}
                      value={form.ttlMs}
                      onChange={(event) =>
                        updateForm({ ttlMs: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Optional"
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Max Duration ms</span>
                    <Input
                      type="number"
                      min={1}
                      value={form.maxDurationMs}
                      onChange={(event) =>
                        updateForm({ maxDurationMs: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Optional"
                    />
                  </label>
                </div>
              </div>

              <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/35 p-3">
                <div className="text-xs font-medium text-slate-300">
                  Runtime
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Run Mode</span>
                    <select
                      value={form.mode}
                      onChange={(event) =>
                        updateForm({
                          mode: event.target.value as SchedulerFormState["mode"],
                        })
                      }
                      className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                    >
                      <option value="">Default Mode</option>
                      <option value="ask">Ask</option>
                      <option value="machdoch">Machdoch</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Provider</span>
                    <select
                      value={form.provider}
                      onChange={(event) =>
                        updateForm({
                          provider: event.target
                            .value as SchedulerFormState["provider"],
                        })
                      }
                      className="h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-600"
                    >
                      <option value="">Default Provider</option>
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="google">Google</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Profile</span>
                    <Input
                      value={form.profile}
                      onChange={(event) =>
                        updateForm({ profile: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Workspace default"
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] font-medium text-slate-500">
                    <span>Model</span>
                    <Input
                      value={form.model}
                      onChange={(event) =>
                        updateForm({ model: event.target.value })
                      }
                      className="h-9 rounded-lg border-slate-800 bg-slate-950 text-sm text-slate-100"
                      placeholder="Workspace default"
                    />
                  </label>
                </div>
              </div>
            </form>
          </aside>
        </div>
      </div>
    </DialogContent>
  );
};
