"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudSchedule } from "@/lib/cloud-schedule-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { ScheduleEditor } from "./schedule-editor";
import { ScheduleHistory } from "./schedule-history";
import {
  ScheduleStateDialog,
  type ScheduleTransition,
} from "./schedule-state-dialog";

export function ScheduleList({
  workspace: initialWorkspace,
  initial,
  available,
}: {
  workspace: CloudWorkspace;
  initial: CloudSchedule[];
  available: boolean;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [schedules, setSchedules] = useState(initial);
  const [editor, setEditor] = useState<CloudSchedule | "new" | null>(null);
  const [transition, setTransition] = useState<ScheduleTransition | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [workerAvailable, setWorkerAvailable] = useState(available),
    [offset, setOffset] = useState(0),
    [archived, setArchived] = useState(false);
  const busy = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  async function refresh(pageOffset = offset, showArchived = archived) {
    const [next, status, currentWorkspace] = await Promise.all([
      cloudRequest<CloudSchedule[]>(
        `schedules?offset=${pageOffset}&archived=${showArchived}`,
      ),
      cloudRequest<{ available: boolean }>("schedules/status"),
      cloudRequest<CloudWorkspace>("workspace"),
    ]);
    if (
      currentWorkspace.actor.id !== workspace.actor.id ||
      currentWorkspace.organization.id !== workspace.organization.id
    ) {
      setSchedules([]);
      throw new Error(
        "The signed-in account changed. Reload this page before changing schedules.",
      );
    }
    setSchedules(next);
    setOffset(pageOffset);
    setArchived(showArchived);
    setWorkerAvailable(status.available);
    setWorkspace(currentWorkspace);
  }
  async function load(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The schedule could not be loaded. Try again.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1 ref={heading} tabIndex={-1}>
          Schedules
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-pressed={archived}
            disabled={pending}
            onClick={() => void load(() => refresh(0, !archived))}
          >
            Archived
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void load(() => refresh())}
          >
            Refresh
          </Button>
          {workspace.actor.role !== "viewer" && workspace.teams.length > 0 && (
            <Button onClick={() => setEditor("new")}>New schedule</Button>
          )}
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {!workerAvailable && schedules.some((schedule) => schedule.enabled) && (
        <p role="alert">
          Scheduled work is delayed. The schedule worker is unavailable.
        </p>
      )}
      {!schedules.length ? (
        <div className="cloud-empty">
          <p>{archived ? "No archived schedules." : "No schedules yet."}</p>
          {!workspace.teams.length && (
            <Link href="/cloud/teams">Create a team</Link>
          )}
        </div>
      ) : (
        <div className="cloud-grid">
          {schedules.map((schedule) => {
            const owned =
              schedule.ownerId === workspace.actor.id &&
              workspace.actor.role !== "viewer";
            const canManage =
              owned || ["owner", "admin"].includes(workspace.actor.role);
            return (
              <section
                key={schedule.id}
                className="cloud-card"
                aria-label={schedule.name}
              >
                <div className="flex items-start justify-between gap-3">
                  <h2>{schedule.name}</h2>
                  <span>
                    {schedule.archived
                      ? "Archived"
                      : schedule.error
                        ? "Needs attention"
                        : schedule.enabled
                          ? schedule.waitingRunId
                            ? "Waiting for task"
                            : "Active"
                          : "Paused"}
                  </span>
                </div>
                <p>
                  {schedule.action.kind === "create-issue"
                    ? schedule.action.issue.title
                    : schedule.action.run.subject.kind === "project"
                      ? schedule.action.run.subject.objective.split("\n")[0]
                      : "Issue implementation"}
                </p>
                {schedule.action.kind === "run-task" && (
                  <p className="text-sm">
                    {schedule.admittedRuns} of {schedule.action.maxRuns} tasks ·{" "}
                    {schedule.usedTokens.toLocaleString()} of{" "}
                    {schedule.action.maxTokens.toLocaleString()} tokens used
                    {schedule.reservedTokens > 0
                      ? ` · ${schedule.reservedTokens.toLocaleString()} reserved`
                      : ""}
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  {
                    workspace.teams.find((team) => team.id === schedule.teamId)
                      ?.name
                  }{" "}
                  · {schedule.ownerName}
                </p>
                {schedule.enabled && schedule.nextAt !== null && (
                  <p className="text-sm">
                    Next:{" "}
                    <time dateTime={new Date(schedule.nextAt).toISOString()}>
                      {new Date(schedule.nextAt)
                        .toISOString()
                        .replace("T", " ")
                        .replace(".000Z", " UTC")}
                    </time>
                  </p>
                )}
                {schedule.waitingRunId && (
                  <Link
                    className="text-sm underline"
                    href={`/cloud/tasks/${schedule.waitingRunId}`}
                  >
                    Open task
                  </Link>
                )}
                {schedule.error && <p role="alert">{schedule.error}</p>}
                <div className="flex flex-wrap gap-2">
                  {owned && !schedule.enabled && !schedule.archived && (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void load(async () => {
                          const current = await cloudRequest<CloudSchedule>(
                            `schedules/${schedule.id}`,
                          );
                          if (current.enabled || current.archived) {
                            await refresh();
                            throw new Error(
                              current.archived
                                ? "Restore the schedule before editing it."
                                : "Pause the schedule before editing it.",
                            );
                          }
                          setEditor(current);
                        })
                      }
                    >
                      Edit schedule
                    </Button>
                  )}
                  {!schedule.archived &&
                    (schedule.enabled ? canManage : owned) && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          setTransition({
                            schedule,
                            field: "enabled",
                            target: !schedule.enabled,
                          })
                        }
                      >
                        {schedule.enabled
                          ? "Pause schedule"
                          : "Enable schedule"}
                      </Button>
                    )}
                  {canManage && (
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        setTransition({
                          schedule,
                          field: "archived",
                          target: !schedule.archived,
                        })
                      }
                    >
                      {schedule.archived
                        ? "Restore schedule"
                        : "Archive schedule"}
                    </Button>
                  )}
                </div>
                <ScheduleHistory id={schedule.id} />
              </section>
            );
          })}
        </div>
      )}
      {editor && (
        <ScheduleEditor
          workspace={workspace}
          schedule={editor === "new" ? undefined : editor}
          onClose={() => setEditor(null)}
          onSaved={() =>
            refresh(
              editor === "new" ? 0 : offset,
              editor === "new" ? false : archived,
            )
          }
        />
      )}
      {(offset > 0 || schedules.length === 200) && (
        <nav aria-label="Schedule pages" className="flex gap-2 mt-4">
          <Button
            variant="outline"
            disabled={pending || offset === 0}
            onClick={() => void load(() => refresh(offset - 200))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={pending || schedules.length < 200}
            onClick={() => void load(() => refresh(offset + 200))}
          >
            Next
          </Button>
        </nav>
      )}
      {transition && (
        <ScheduleStateDialog
          transition={transition}
          workspace={workspace}
          onClose={() => setTransition(null)}
          onSaved={() => refresh()}
          returnFocus={heading}
        />
      )}
    </>
  );
}
