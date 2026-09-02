import type { ProductShell } from "@machdoch/fleet-protocol";
import {
  CalendarClock,
  CirclePause,
  CirclePlay,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useDialogFocusLifecycle } from "./dialog-focus-lifecycle";
import { formatTimestamp } from "./format";
import type { ProductCommandHandler } from "./product-runtime";

type Scheduler = NonNullable<ProductShell["scheduler"]>;

export function Scheduler({
  scheduler,
  pending,
  onCommand,
}: {
  scheduler: Scheduler;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [view, setView] = useState<"jobs" | "runs">("jobs");
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const deleteDialogCloseButtonRef = useRef<HTMLButtonElement>(null);
  const deletingJob =
    scheduler.jobs.find((job) => job.id === deletingJobId) ?? null;
  const workspaceRoot = scheduler.workspaceRoot;
  const closeDeleteDialog = useCallback(
    (): void => setDeletingJobId(null),
    [],
  );
  useDialogFocusLifecycle(
    Boolean(deletingJob && workspaceRoot),
    closeDeleteDialog,
    deleteDialogCloseButtonRef,
  );
  return (
    <section className="m-scheduler">
      <header className="m-feature-header">
        <div>
          <CalendarClock aria-hidden="true" />
          <h1>Smart Scheduler</h1>
        </div>
        <div className="m-feature-tabs">
          <button
            type="button"
            data-active={view === "jobs"}
            onClick={() => setView("jobs")}
          >
            Jobs
          </button>
          <button
            type="button"
            data-active={view === "runs"}
            onClick={() => setView("runs")}
          >
            Runs
          </button>
        </div>
      </header>
      {scheduler.error ? (
        <div className="m-media-error" role="alert">
          {scheduler.error}
        </div>
      ) : null}
      <div className="m-scheduler-body">
        {view === "jobs" ? (
          scheduler.jobs.length ? (
            <div className="m-scheduler-grid">
              {scheduler.jobs.map((job) => (
                <article key={job.id} className="m-scheduler-card">
                  <header>
                    <strong>{job.name}</strong>
                    <span data-state={job.status}>{job.status}</span>
                  </header>
                  <p>{job.promptPreview}</p>
                  <dl>
                    <div>
                      <dt>Schedule</dt>
                      <dd>{job.schedule}</dd>
                    </div>
                    <div>
                      <dt>Next run</dt>
                      <dd>{formatTimestamp(job.nextRunAt)}</dd>
                    </div>
                  </dl>
                  <footer>
                    <button
                      type="button"
                      disabled={pending || !scheduler.workspaceRoot}
                      onClick={() =>
                        void onCommand({
                          kind: "scheduler-trigger",
                          workspace: scheduler.workspaceRoot!,
                          jobId: job.id,
                        })
                      }
                    >
                      <CirclePlay aria-hidden="true" /> Run
                    </button>
                    <button
                      type="button"
                      disabled={pending || !scheduler.workspaceRoot}
                      onClick={() =>
                        void onCommand({
                          kind:
                            job.status === "paused"
                              ? "scheduler-resume"
                              : "scheduler-pause",
                          workspace: scheduler.workspaceRoot!,
                          jobId: job.id,
                        })
                      }
                    >
                      {job.status === "paused" ? (
                        <CirclePlay aria-hidden="true" />
                      ) : (
                        <CirclePause aria-hidden="true" />
                      )}
                      {job.status === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      type="button"
                      className="m-scheduler-danger"
                      disabled={pending || !scheduler.workspaceRoot}
                      onClick={() => setDeletingJobId(job.id)}
                    >
                      <Trash2 aria-hidden="true" /> Delete
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <div className="m-product-empty-small">No jobs</div>
          )
        ) : scheduler.runs.length ? (
          <div className="m-scheduler-run-list">
            {scheduler.runs.map((run) => {
              const active = ["queued", "running"].includes(run.status);
              return (
                <article key={run.id} className="m-scheduler-run">
                  <div>
                    <strong>{run.summary || run.jobId}</strong>
                    <span data-state={run.status}>{run.status}</span>
                  </div>
                  <p>{run.error || formatTimestamp(run.updatedAt)}</p>
                  <footer>
                    {active ? (
                      <button
                        type="button"
                        disabled={pending || !scheduler.workspaceRoot}
                        onClick={() =>
                          void onCommand({
                            kind: "scheduler-cancel-run",
                            workspace: scheduler.workspaceRoot!,
                            runId: run.id,
                          })
                        }
                      >
                        <Square aria-hidden="true" /> Cancel
                      </button>
                    ) : run.status === "failed" ? (
                      <button
                        type="button"
                        disabled={pending || !scheduler.workspaceRoot}
                        onClick={() =>
                          void onCommand({
                            kind: "scheduler-retry-run",
                            workspace: scheduler.workspaceRoot!,
                            runId: run.id,
                          })
                        }
                      >
                        <RotateCcw aria-hidden="true" /> Retry
                      </button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="m-product-empty-small">No runs</div>
        )}
      </div>
      {deletingJob && workspaceRoot ? (
        <div className="m-media-modal-backdrop" role="presentation">
          <div
            className="m-media-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="m-scheduler-delete-title"
          >
            <button
              type="button"
              className="m-media-modal-close"
              aria-label="Close"
              ref={deleteDialogCloseButtonRef}
              onClick={closeDeleteDialog}
            >
              <X aria-hidden="true" />
            </button>
            <h2 id="m-scheduler-delete-title">Delete {deletingJob.name}?</h2>
            <p>Future runs will stop.</p>
            <div>
              <button
                type="button"
                className="m-product-secondary-button"
                onClick={closeDeleteDialog}
              >
                Cancel
              </button>
              <button
                type="button"
                className="m-product-secondary-button m-product-danger-button"
                disabled={pending}
                onClick={() => {
                  void onCommand({
                    kind: "scheduler-delete",
                    workspace: workspaceRoot,
                    jobId: deletingJob.id,
                  }).then((deleted) => {
                    if (deleted) closeDeleteDialog();
                  });
                }}
              >
                <Trash2 aria-hidden="true" /> Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
