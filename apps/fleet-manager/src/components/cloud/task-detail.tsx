"use client";
import { executionTargetLabels } from "./execution-labels";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  terminalRunStates,
  type RunDetail,
} from "@machdoch/fleet-protocol/cloud-execution";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { TaskFiles } from "./task-files";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";

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
    async function poll() {
      try {
        if (!document.hidden) {
          const next = await cloudRequest<RunDetail>(`runs/${initial.id}`, {
            signal: abort.signal,
          });
          if (!abort.signal.aborted) {
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
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
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
          <Link className="text-muted-foreground" href="/cloud/tasks">
            AI tasks
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
      <div className="cloud-toolbar">
        <span className="cloud-task-state" data-state={run.state} role="status">
          {run.state.replaceAll("_", " ")}
        </span>
        {run.issueId ? (
          <Link className="underline" href={`/cloud/issues/${run.issueId}`}>
            Open issue
          </Link>
        ) : (
          <Link
            className="underline"
            href={`/cloud/projects#planning-${run.projectId}`}
          >
            Open project
          </Link>
        )}
      </div>
      {run.state === "queued" && (
        <p className="text-muted-foreground mb-6">
          Waiting for an available runner.
        </p>
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
        <p className="text-muted-foreground mb-6">
          Waiting for the runner to stop and confirm ongoing actions.
        </p>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <div className="cloud-task-content">
        <section className="cloud-card">
          {objective && (
            <>
              <h2>Objective</h2>
              <p>{objective}</p>
            </>
          )}
          <h2>Acceptance criteria</h2>
          <p>{run.manifest.acceptanceCriteria}</p>
        </section>
        {run.summary && (
          <section className="cloud-card">
            <h2>Result</h2>
            <p>{run.summary}</p>
          </section>
        )}
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
                  <span>{attempt.workerName}</span>
                  <span className="capitalize">{attempt.state}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <details className="cloud-card">
          <summary>Execution details</summary>
          <dl className="cloud-properties">
            <div>
              <dt>Profile</dt>
              <dd>{run.manifest.profile.name}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>{executionTargetLabels[run.manifest.profile.target]}</dd>
            </div>
            <div>
              <dt>Repository</dt>
              <dd>{run.manifest.profile.repository}</dd>
            </div>
            {run.manifest.profile.workspacePath && (
              <div>
                <dt>Directory</dt>
                <dd>{run.manifest.profile.workspacePath}</dd>
              </div>
            )}
            <div>
              <dt>Base commit</dt>
              <dd>{run.manifest.profile.baseCommit}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{run.manifest.provider.name}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{run.manifest.profile.model}</dd>
            </div>
            <div>
              <dt>Token limit</dt>
              <dd>{run.manifest.profile.maxTokens.toLocaleString()}</dd>
            </div>
            {run.usage.requests > 0 && (
              <div>
                <dt>Tokens used</dt>
                <dd>{run.usage.usedTokens.toLocaleString()}</dd>
              </div>
            )}
            {run.usage.reservedTokens > 0 && (
              <div>
                <dt>Tokens reserved</dt>
                <dd>{run.usage.reservedTokens.toLocaleString()}</dd>
              </div>
            )}
            <div>
              <dt>Deadline</dt>
              <dd>{new Date(run.deadlineAt).toLocaleString()}</dd>
            </div>
          </dl>
        </details>
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
