"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  FileText,
  ListChecks,
  Target,
} from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  terminalRunStates,
  type RunDetail,
} from "@machdoch/fleet-protocol/cloud-execution";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { TaskFiles } from "./task-files";
import { TaskState } from "./task-state";
import { TaskExecution } from "./task-execution";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";

const activePollMs = 3000;
const settledPollMs = 30_000;

export function TaskDetail({
  initial,
  workspace,
}: {
  initial: RunDetail;
  workspace: CloudWorkspace;
}) {
  const [run, setRun] = useState<RunDetail | null>(initial);
  const [error, setError] = useState("");
  const [canceling, setCanceling] = useState(false);
  const sender = useRef(createCommandSender());
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let delay = activePollMs;
    async function poll() {
      try {
        if (!document.hidden) {
          const next = await cloudRequest<RunDetail>(`runs/${initial.id}`, {
            signal: abort.signal,
          });
          if (!abort.signal.aborted) {
            delay = terminalRunStates.some((state) => state === next.state)
              ? settledPollMs
              : activePollMs;
            setRun((previous) =>
              previous && previous.revision > next.revision ? previous : next,
            );
            setError("");
          }
        }
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [401, 403, 404].includes(reason.status)
        )
          setRun(null);
        setError((reason as Error).message);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [initial.id]);
  if (!run)
    return (
      <p role="alert" className="cloud-error">
        {error}
      </p>
    );
  const terminal = terminalRunStates.some((state) => state === run.state);
  const objective =
    run.manifest.objective === run.title
      ? ""
      : run.manifest.objective.startsWith(run.title + "\n")
        ? run.manifest.objective.slice(run.title.length).trimStart()
        : run.manifest.objective;
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-back-link" href="/cloud/tasks">
            <ArrowLeft size={14} aria-hidden="true" /> AI tasks
          </Link>
          <h1>{run.title}</h1>
        </div>
        {workspace.actor.role !== "viewer" &&
          !terminal &&
          !run.cancelRequested && (
            <Button
              variant="outline"
              onClick={() => {
                sender.current = createCommandSender();
                setCanceling(true);
              }}
            >
              Cancel task
            </Button>
          )}
      </header>
      <div className="cloud-task-context">
        <div role="status">
          <TaskState state={run.state} />
        </div>
        {run.issueId ? (
          <Link href={`/cloud/issues/${run.issueId}`}>
            Open issue <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        ) : (
          <Link href={`/cloud/projects/${run.projectId}`}>
            Open project <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
      {run.state === "queued" && (
        <p className="cloud-task-notice">Waiting for an available runner.</p>
      )}
      {run.contextChanged && (
        <p role="status" className="cloud-error mb-6">
          Planning has changed since this task started. Review the current{" "}
          {run.issueId ? "issue" : "project"} before using the result.
        </p>
      )}
      {run.reason &&
        ["failed", "timed_out", "reconciling"].includes(run.state) && (
          <p role="alert" className="cloud-error mb-6">
            {run.reason}
          </p>
        )}
      {["cancel_requested", "reconciling"].includes(run.state) && (
        <p className="cloud-task-notice">
          Waiting for the runner to stop and confirm ongoing actions.
        </p>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <div className="cloud-task-layout">
        <div className="cloud-task-content">
          {run.summary && (
            <section
              className="cloud-card cloud-task-result"
              data-state={run.state}
            >
              <h2>
                <FileText size={17} aria-hidden="true" />
                Result
              </h2>
              <p>{run.summary}</p>
            </section>
          )}
          <section className="cloud-card cloud-task-brief">
            {objective && (
              <div>
                <h2>
                  <Target size={17} aria-hidden="true" />
                  Objective
                </h2>
                <p>{objective}</p>
              </div>
            )}
            <div>
              <h2>
                <ListChecks size={17} aria-hidden="true" />
                Acceptance criteria
              </h2>
              <p>{run.manifest.acceptanceCriteria}</p>
            </div>
          </section>
          <TaskFiles
            runId={run.id}
            files={run.artifacts}
            candidateCommit={run.candidateCommit}
          />
          {run.attempts.length > 0 && (
            <section className="cloud-card">
              <h2>Attempts</h2>
              <ul className="cloud-attempt-list">
                {run.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    <div>
                      <span className="cloud-attempt-number">
                        {attempt.epoch}
                      </span>
                      <span>{attempt.workerName}</span>
                    </div>
                    <span className="capitalize">{attempt.state}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <TaskExecution run={run} />
      </div>
      <FormDialog
        open={canceling}
        onOpenChange={setCanceling}
        title="Cancel task"
        submitLabel="Cancel task"
        onSubmit={async () => {
          await sender.current(`runs/${run.id}/cancel`, {
            revision: run.revision,
          });
          setRun(await cloudRequest<RunDetail>(`runs/${run.id}`));
        }}
      >
        <p>
          {run.state === "queued"
            ? "This task will be removed from the queue."
            : "The runner will be asked to stop. Actions already in progress may still finish."}
        </p>
      </FormDialog>
    </>
  );
}
