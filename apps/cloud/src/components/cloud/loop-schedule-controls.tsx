"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import type { CloudSchedule } from "@/lib/cloud-schedule-contract";
import { describeRecurrence } from "@/lib/schedule-summary";
import { cloudRequest } from "./api-client";
import { ScheduleEditor } from "./schedule-editor";
import { ScheduleHistory } from "./schedule-history";
import {
  ScheduleStateDialog,
  type ScheduleTransition,
} from "./schedule-state-dialog";
import { Timestamp } from "./timestamp";

function scheduleStatus(schedule: CloudSchedule): string {
  if (schedule.archived) return "Archived";
  if (schedule.error) return "Needs attention";
  if (!schedule.enabled) return "Paused";
  return schedule.waitingRunId ? "Waiting for task" : "Active";
}

export function LoopScheduleControls({
  workspace,
  schedule,
  workerAvailable,
}: {
  workspace: CloudWorkspace;
  schedule: CloudSchedule;
  workerAvailable: boolean;
}) {
  const router = useRouter();
  const [editor, setEditor] = useState<CloudSchedule | null>(null);
  const [transition, setTransition] = useState<ScheduleTransition | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const returnFocus = useRef<HTMLDivElement>(null);
  const owned =
    schedule.ownerId === workspace.actor.id &&
    holderCan(workspace.actor, "automations.edit");
  const canManage = owned || holderCan(workspace.actor, "teams.manage");
  const subject =
    schedule.action.kind === "create-issue"
      ? schedule.action.issue.title
      : schedule.action.run.subject.kind === "project"
        ? schedule.action.run.subject.objective.split("\n")[0]
        : "";

  async function openEditor() {
    setPending(true);
    setError("");
    try {
      const current = await cloudRequest<CloudSchedule>(
        `schedules/${schedule.id}`,
      );
      if (current.enabled || current.archived) {
        router.refresh();
        throw new Error(
          current.archived
            ? "Restore the schedule before editing it."
            : "Pause the schedule before editing it.",
        );
      }
      setEditor(current);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The schedule could not be loaded. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="cloud-release-actions" ref={returnFocus} tabIndex={-1}>
        <span
          className="cloud-task-state"
          data-state={
            schedule.error ? "failed" : schedule.enabled ? "active" : "paused"
          }
        >
          {scheduleStatus(schedule)}
        </span>
        {!schedule.archived && (schedule.enabled ? canManage : owned) && (
          <Button
            size="sm"
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
            {schedule.enabled ? "Pause" : "Enable"}
          </Button>
        )}
        {owned && !schedule.enabled && !schedule.archived && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void openEditor()}
          >
            Edit
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
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
            {schedule.archived ? "Restore" : "Archive"}
          </Button>
        )}
        <ScheduleHistory id={schedule.id} />
      </div>
      {error && <p role="alert">{error}</p>}
      {!workerAvailable && schedule.enabled && (
        <p role="alert">
          Scheduled work is delayed. The schedule worker is unavailable.
        </p>
      )}
      {schedule.error && <p role="alert">{schedule.error}</p>}
      <dl className="cloud-automation-facts">
        <dt>Action</dt>
        <dd>
          {schedule.action.kind === "create-issue"
            ? "Create issue"
            : "Run AI task"}
        </dd>
        {subject && subject !== schedule.name && (
          <>
            <dt>Subject</dt>
            <dd>{subject}</dd>
          </>
        )}
        {schedule.action.kind === "run-task" && (
          <>
            <dt>Usage</dt>
            <dd>
              {schedule.admittedRuns} of {schedule.action.maxRuns} tasks ·{" "}
              {schedule.usedTokens.toLocaleString()} of{" "}
              {schedule.action.maxTokens.toLocaleString()} tokens used
              {schedule.reservedTokens > 0
                ? ` · ${schedule.reservedTokens.toLocaleString()} reserved`
                : ""}
            </dd>
          </>
        )}
        <dt>Team</dt>
        <dd>
          {workspace.teams.find((team) => team.id === schedule.teamId)?.name ??
            ""}
        </dd>
        <dt>Owner</dt>
        <dd>{schedule.ownerName}</dd>
        <dt>Repeats</dt>
        <dd>{describeRecurrence(schedule.recurrence)}</dd>
        {schedule.enabled && schedule.nextAt !== null && (
          <>
            <dt>Next run</dt>
            <dd>
              <Timestamp value={schedule.nextAt} />
            </dd>
          </>
        )}
        {schedule.waitingRunId && (
          <>
            <dt>Waiting for</dt>
            <dd>
              <Link href={`/cloud/tasks/${schedule.waitingRunId}`}>
                Open task
              </Link>
            </dd>
          </>
        )}
      </dl>
      {editor && (
        <ScheduleEditor
          workspace={workspace}
          schedule={editor}
          onClose={() => setEditor(null)}
          onSaved={async () => router.refresh()}
        />
      )}
      {transition && (
        <ScheduleStateDialog
          transition={transition}
          workspace={workspace}
          onClose={() => setTransition(null)}
          onSaved={async () => router.refresh()}
          returnFocus={returnFocus}
        />
      )}
    </>
  );
}
