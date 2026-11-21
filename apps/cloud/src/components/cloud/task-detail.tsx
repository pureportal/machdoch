"use client";

import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import { holderCan } from "@/lib/cloud-permissions";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  terminalRunStates,
  type RunDetail,
} from "@machdoch/fleet-protocol/cloud-execution";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskFiles } from "./task-files";
import { TaskState } from "./task-state";
import { TaskExecution } from "./task-execution";
import { TaskTimeline } from "./task-timeline";
import { TaskStages } from "./task-stages";
import { TaskOutcome } from "./task-outcome";
import { TaskReport } from "./task-report";
import { TaskReview } from "./task-review";
import { TaskChanges } from "./task-changes";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";

const activePollMs = 3000;
const settledPollMs = 30_000;

function settled(run: RunDetail): boolean {
  return (
    terminalRunStates.some((state) => state === run.state) &&
    (!run.delivery ||
      ["merged", "closed", "failed", "needs_person", "open"].includes(
        run.delivery.state,
      ))
  );
}

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
  const refresh = useCallback(async () => {
    const next = await cloudRequest<RunDetail>(`runs/${initial.id}`);
    setRun(next);
  }, [initial.id]);
  useEffect(() => {
    const abort = new AbortController();
    let delay = activePollMs;
    async function poll() {
      try {
        const next = await cloudRequest<RunDetail>(`runs/${initial.id}`, {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) {
          delay = settled(next) ? settledPollMs : activePollMs;
          setRun((previous) =>
            previous &&
            previous.revision > next.revision &&
            previous.delivery?.updatedAt === next.delivery?.updatedAt
              ? previous
              : next,
          );
          setError("");
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
    }
    const stop = pollWhileVisible(poll, () => delay);
    return () => {
      abort.abort();
      stop();
    };
  }, [initial.id]);
  if (!run)
    return (
      <p role="alert" className="cloud-error">
        {error}
      </p>
    );
  const terminal = terminalRunStates.some((state) => state === run.state);
  const latestReview = run.reviews.at(-1);
  const findings =
    latestReview && latestReview.candidateCommit === run.candidateCommit
      ? latestReview.findings
      : [];
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-back-link" href="/cloud/tasks">
            <ArrowLeft size={14} aria-hidden="true" /> AI tasks
          </Link>
          <h1>{run.title}</h1>
        </div>
        {holderCan(workspace.actor, "ai.tasks") &&
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
        <Link href={`/cloud/activity?run=${run.id}`}>
          AI activity <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
      <TaskOutcome
        run={run}
        canMerge={holderCan(workspace.actor, "git.act")}
        canPublish={holderCan(workspace.actor, "ai.tasks")}
        onChanged={refresh}
      />
      <TaskStages run={run} />
      {run.contextChanged && (
        <p role="status" className="cloud-error mb-6">
          Planning has changed since this task started. Review the current{" "}
          {run.issueId ? "issue" : "project"} before using the result.
        </p>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <div className="cloud-task-layout">
        <Tabs defaultValue="overview" className="cloud-task-content">
          <TabsList aria-label="Task">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="changes">
              Changes
              {run.changes.length > 0 && (
                <span className="cloud-tab-count">{run.changes.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="review">
              Review
              {run.reviews.length > 0 && (
                <span className="cloud-tab-count">{run.reviews.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <TaskReport run={run} />
          </TabsContent>
          <TabsContent value="changes">
            <TaskChanges
              runId={run.id}
              candidateCommit={run.candidateCommit}
              findings={findings}
            />
          </TabsContent>
          <TabsContent value="review">
            <TaskReview reviews={run.reviews} />
          </TabsContent>
          <TabsContent value="activity">
            <TaskTimeline entries={run.timeline} live={!terminal} />
          </TabsContent>
          <TabsContent value="files">
            <TaskFiles
              runId={run.id}
              files={run.artifacts}
              candidateCommit={run.candidateCommit}
            />
            {run.attempts.length > 0 && (
              <section className="cloud-card mt-5">
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
          </TabsContent>
        </Tabs>
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
          await refresh();
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
