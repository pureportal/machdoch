import {
  formatTimestamp,
  formatSchedule,
  getStatusBadgeClassName,
  getRunIcon,
} from "./scheduler-display";
import {
  SchedulerPanelTab,
  SchedulerRalphVariable,
  SchedulerRalphReadinessView,
  SchedulerRalphFlowOption,
  SCHEDULER_PANEL_REFRESH_INTERVAL_MS,
  SchedulerFormState,
  createDefaultFormState,
  terminalRunStatuses,
  splitLines,
  parseRalphParams,
  setSchedulerRalphParam,
  buildSchedulerCreateInput,
} from "./scheduler-form-model";
import { SchedulerJobForm } from "./scheduler-job-form";
import { useSchedulerCommands } from "./use-scheduler-commands";
import {
  CalendarClock,
  History,
  Loader2,
  Pause,
  Play,
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
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import type { CommandScope } from "@machdoch/media-studio/tauri/ui/commands/command-types.js";

import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  SchedulerJobSummary,
  SchedulerRunSummary,
} from "@machdoch/fleet-protocol/scheduler-contract";
import type { SchedulerRuntime } from "./scheduler-runtime";

export interface SchedulerPanelProps {
  workspaceRoot: string | null | undefined;
  runtime: SchedulerRuntime;
  commandScope: CommandScope;
}

export const SchedulerPanel = ({
  workspaceRoot,
  runtime,
  commandScope,
}: SchedulerPanelProps): JSX.Element => {
  const {
    cancelSchedulerRun,
    createSchedulerJob,
    deleteSchedulerJob,
    inspectSchedulerRalphFlow,
    listRalphFlows,
    listSchedulerJobs,
    listSchedulerRuns,
    pauseSchedulerJob,
    resumeSchedulerJob,
    retrySchedulerRun,
    runDueSchedulerJobs,
    triggerSchedulerJob,
    subscribeToSettingsImport,
    getReasoningModesForProvider,
    normalizeReasoningModeForProvider,
    reasoningLabels: REASONING_LABELS,
  } = runtime;
  const [jobs, setJobs] = useState<SchedulerJobSummary[]>([]);
  const [runs, setRuns] = useState<SchedulerRunSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [tab, setTab] = useState<SchedulerPanelTab>("jobs");
  const [form, setForm] = useState<SchedulerFormState>(createDefaultFormState);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deletingJob, setDeletingJob] = useState<SchedulerJobSummary | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ralphFlowOptions, setRalphFlowOptions] = useState<
    SchedulerRalphFlowOption[]
  >([]);
  const [ralphImportVersion, setRalphImportVersion] = useState(0);
  const [ralphVariables, setRalphVariables] = useState<
    SchedulerRalphVariable[]
  >([]);
  const [ralphReadiness, setRalphReadiness] =
    useState<SchedulerRalphReadinessView>({
      ready: false,
      loading: false,
      errors: [],
      warnings: [],
    });
  const refreshInFlightRef = useRef(false);

  const activeWorkspace = workspaceRoot?.trim() || null;
  const selectedReasoningProvider = form.provider || null;
  const selectedReasoningModel = form.model.trim() || null;
  const reasoningOptions = getReasoningModesForProvider(
    selectedReasoningProvider,
    selectedReasoningModel,
  );
  const reasoningValue = form.reasoning
    ? normalizeReasoningModeForProvider(
        form.reasoning,
        selectedReasoningProvider,
        selectedReasoningModel,
      )
    : "";
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
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError),
      );
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [activeWorkspace, selectedJobId, listSchedulerJobs, listSchedulerRuns]);

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

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    if (!subscribeToSettingsImport) return;

    void subscribeToSettingsImport((event) => {
      if (!disposed && event.categories.includes("ralph.flows-global")) {
        setRalphImportVersion((current) => current + 1);
      }
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unsubscribe = cleanup;
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [subscribeToSettingsImport]);

  useEffect(() => {
    if (!activeWorkspace || form.targetType !== "ralph-flow") {
      setRalphFlowOptions([]);
      return;
    }

    let cancelled = false;

    void listRalphFlows(activeWorkspace, form.ralphFlowScope)
      .then((result) => {
        if (!cancelled) {
          setRalphFlowOptions(result.flows);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setRalphFlowOptions([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspace,
    form.ralphFlowScope,
    form.targetType,
    ralphImportVersion,
    listRalphFlows,
  ]);

  useEffect(() => {
    const flowId = form.ralphFlowId.trim();

    if (!activeWorkspace || form.targetType !== "ralph-flow" || !flowId) {
      setRalphVariables([]);
      setRalphReadiness({
        ready: false,
        loading: false,
        errors: flowId ? [] : ["Choose a Ralph flow."],
        warnings: [],
      });
      return;
    }

    let cancelled = false;
    setRalphReadiness((current) => ({ ...current, loading: true }));
    const timer = window.setTimeout(() => {
      let params: Record<string, string>;

      try {
        params = parseRalphParams(form.ralphParams);
      } catch (caughtError) {
        setRalphVariables([]);
        setRalphReadiness({
          ready: false,
          loading: false,
          errors: [
            caughtError instanceof Error
              ? caughtError.message
              : String(caughtError),
          ],
          warnings: [],
        });
        return;
      }

      void inspectSchedulerRalphFlow(activeWorkspace, {
        id: flowId,
        scope: form.ralphFlowScope,
        params,
        runLogScope: form.ralphRunLogScope,
        ...(form.ralphUnattended
          ? {
              executionProfile: "unattended" as const,
              resumePolicy: "recoverable" as const,
            }
          : {}),
        permissions: {
          allowedRoots:
            splitLines(form.ralphAllowedRoots).length > 0
              ? splitLines(form.ralphAllowedRoots)
              : [activeWorkspace],
          allowCommands: form.ralphAllowCommands,
          allowWrites: form.ralphAllowWrites,
          allowNetwork: form.ralphAllowNetwork,
          allowMcpTools: form.ralphAllowMcpTools,
        },
      })
        .then((result) => {
          if (cancelled) {
            return;
          }

          setRalphVariables(result.variables);
          setRalphReadiness({
            ready: result.ready,
            loading: false,
            errors: result.errors,
            warnings: result.warnings,
          });
        })
        .catch((caughtError) => {
          if (!cancelled) {
            setRalphVariables([]);
            setRalphReadiness({
              ready: false,
              loading: false,
              errors: [
                caughtError instanceof Error
                  ? caughtError.message
                  : String(caughtError),
              ],
              warnings: [],
            });
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeWorkspace,
    form.ralphFlowId,
    form.ralphFlowScope,
    form.ralphParams,
    form.ralphRunLogScope,
    form.ralphAllowedRoots,
    form.ralphAllowCommands,
    form.ralphAllowWrites,
    form.ralphAllowNetwork,
    form.ralphAllowMcpTools,
    form.ralphUnattended,
    form.targetType,
    inspectSchedulerRalphFlow,
  ]);

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
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const updateForm = (patch: Partial<SchedulerFormState>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const updateRalphParam = (name: string, value: string): void => {
    updateForm({
      ralphParams: setSchedulerRalphParam(form.ralphParams, name, value),
    });
  };

  const createJob = async (): Promise<void> => {
    if (
      busyAction ||
      (form.targetType === "ralph-flow" &&
        (!ralphReadiness.ready || ralphReadiness.loading))
    )
      return;
    await runAction("create", async () => {
      const result = await createSchedulerJob(
        activeWorkspace,
        buildSchedulerCreateInput(form, reasoningValue, activeWorkspace),
      );

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

  const toggleJobPaused = (job: SchedulerJobSummary): void => {
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
  };

  const triggerJob = (job: SchedulerJobSummary): void => {
    void runAction(`trigger-${job.id}`, async () => {
      const result = await triggerSchedulerJob(activeWorkspace, job.id);
      setMessage(`Triggered ${job.name}: ${result.runs.length} run.`);
    });
  };

  const removeJob = (job: SchedulerJobSummary): void => {
    setError(null);
    setDeletingJob(job);
  };

  const confirmDeleteJob = (): void => {
    const job = deletingJob;
    if (!job || busyAction) return;
    void runAction(`delete-${job.id}`, async () => {
      await deleteSchedulerJob(activeWorkspace, job.id);
      setMessage(`Deleted ${job.name}.`);
      setDeletingJob(null);
    });
  };

  const retryRun = (run: SchedulerRunSummary): void => {
    void runAction(`retry-${run.id}`, async () => {
      const result = await retrySchedulerRun(activeWorkspace, run.id);
      setMessage(`Retry queued as ${result.handle.runId}.`);
    });
  };

  const cancelRun = (run: SchedulerRunSummary): void => {
    void runAction(`cancel-${run.id}`, async () => {
      await cancelSchedulerRun(activeWorkspace, run.id);
      setMessage(`Cancelled ${run.id}.`);
    });
  };

  const actionButtonBusy = (actionId: string): boolean => {
    return busyAction === actionId;
  };

  const visibleRuns = runs;

  useSchedulerCommands({
    commandScope,
    activeWorkspace,
    jobs,
    runs,
    selectedJobId,
    tab,
    form,
    busyAction,
    ralphFlowOptions,
    ralphReadiness,
    reasoningOptions,
    reasoningValue,
    refresh,
    runDue,
    createJob,
    toggleJobPaused,
    triggerJob,
    removeJob,
    retryRun,
    cancelRun,
    setSelectedJobId,
    setTab,
    updateForm,
    reasoningLabels: REASONING_LABELS,
  });

  return (
    <section
      data-command-owner="scheduler"
      className="app-scheduler-panel h-full min-h-0 overflow-hidden text-slate-100"
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <header className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-white">
            <CalendarClock className="h-5 w-5 text-emerald-300" />
            Smart Scheduler
          </h1>
        </header>

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
                  disabled={Boolean(busyAction) || !activeWorkspace}
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

            {message || (error && !deletingJob) ? (
              <div className="border-b border-slate-800/70 px-5 py-3">
                {message ? (
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
                    {message}
                  </div>
                ) : null}
                {error && !deletingJob ? (
                  <div
                    role="alert"
                    className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
                  >
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
                      <article
                        key={job.id}
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
                              <button
                                type="button"
                                className="truncate text-left text-sm font-medium text-white"
                                onClick={() => {
                                  setSelectedJobId(job.id);
                                  setTab("runs");
                                }}
                              >
                                {job.name}
                              </button>
                              <Badge
                                variant="outline"
                                className={getStatusBadgeClassName(job.status)}
                              >
                                {job.status}
                              </Badge>
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
                              tooltip={
                                job.status === "paused"
                                  ? "Resume scheduled job"
                                  : "Pause scheduled job"
                              }
                              disabled={Boolean(busyAction)}
                              onClick={() => toggleJobPaused(job)}
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
                              tooltip="Run scheduled job now"
                              disabled={Boolean(busyAction)}
                              onClick={() => triggerJob(job)}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                            >
                              <Zap className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete scheduled job"
                              tooltip="Delete scheduled job"
                              disabled={Boolean(busyAction)}
                              onClick={() => removeJob(job)}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
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
                          {job.queue.concurrencyKey !== job.id ? (
                            <div>
                              <div className="text-slate-600">Queue</div>
                              <div className="truncate text-slate-300">
                                {job.queue.concurrencyKey}
                              </div>
                            </div>
                          ) : null}
                          <div>
                            <div className="text-slate-600">Target</div>
                            <div className="text-slate-300">
                              {job.ralphFlow
                                ? job.ralphFlow.id
                                : "Prompt"}
                            </div>
                          </div>
                        </div>
                      </article>
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
                                  className={getStatusBadgeClassName(
                                    run.status,
                                  )}
                                >
                                  {run.status.replaceAll("_", " ")}
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
                              tooltip="Retry scheduled run"
                              disabled={
                                Boolean(busyAction) ||
                                run.status === "succeeded" ||
                                !terminalRunStatuses.has(run.status)
                              }
                              onClick={() => retryRun(run)}
                              className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Cancel scheduled run"
                              tooltip="Cancel scheduled run"
                              disabled={
                                Boolean(busyAction) ||
                                terminalRunStatuses.has(run.status)
                              }
                              onClick={() => cancelRun(run)}
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

          <SchedulerJobForm
            activeWorkspace={activeWorkspace}
            form={form}
            busyAction={busyAction}
            ralphReadiness={ralphReadiness}
            ralphFlowOptions={ralphFlowOptions}
            ralphVariables={ralphVariables}
            reasoningOptions={reasoningOptions}
            reasoningValue={reasoningValue}
            reasoningLabels={REASONING_LABELS}
            normalizeReasoningModeForProvider={
              normalizeReasoningModeForProvider
            }
            updateForm={updateForm}
            updateRalphParam={updateRalphParam}
            createJob={createJob}
          />
        </div>
      </div>
      <Dialog
        open={Boolean(deletingJob)}
        onOpenChange={(open) => {
          if (!open && !busyAction) setDeletingJob(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogTitle>Delete {deletingJob?.name}?</DialogTitle>
          <DialogDescription>
            Future runs of this job will stop.
          </DialogDescription>
          {error ? (
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={Boolean(busyAction)}
              onClick={() => setDeletingJob(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busyAction)}
              onClick={confirmDeleteJob}
            >
              Delete job
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
