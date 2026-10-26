"use client";

import { useRef, useState } from "react";
import type { RecurrenceInput } from "@machdoch/recurrence";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type {
  CloudSchedule,
  ScheduleInput,
  ScheduleAction,
} from "@/lib/cloud-schedule-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  cloudRequest,
  CloudRequestError,
  createCommandSender,
  formText,
} from "./api-client";
import { ScheduleRecurrence } from "./schedule-recurrence";
import { ScheduleTaskFields } from "./schedule-task-fields";
import { ScheduleIssueOptions } from "./schedule-issue-options";
import { formIssueStatus, isWorkflowConflict } from "./workflow-status-field";

export function ScheduleEditor({
  workspace,
  schedule,
  onClose,
  onSaved,
}: {
  workspace: CloudWorkspace;
  schedule?: CloudSchedule;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(schedule);
  const [actionKind, setActionKind] = useState<ScheduleAction["kind"]>(
    schedule?.action.kind ?? "create-issue",
  );
  const [taskAction, setTaskAction] = useState<Extract<
    ScheduleAction,
    { kind: "run-task" }
  > | null>(schedule?.action.kind === "run-task" ? schedule.action : null);
  const initialIssue =
    current?.action.kind === "create-issue" ? current.action.issue : undefined;
  const [conflict, setConflict] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [taskNeedsReview, setTaskNeedsReview] = useState(false);
  const [taskReload, setTaskReload] = useState(0);
  const [workflowReload, setWorkflowReload] = useState(0);
  const [recurrence, setRecurrence] = useState<RecurrenceInput | null>(
    schedule?.recurrence ?? null,
  );
  const [teamId, setTeamId] = useState(
    schedule?.teamId ?? workspace.teams[0]?.id ?? "",
  );
  const [missed, setMissed] = useState<ScheduleInput["missed"]>(
    schedule?.missed ?? "skip",
  );
  const sender = useRef(createCommandSender());
  const issueOptions = useRef<HTMLDetailsElement | null>(null);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={current ? "Edit schedule" : "New schedule"}
      submitLabel={current ? "Save schedule" : "Create schedule"}
      submitDisabled={
        conflict ||
        loading ||
        !recurrence ||
        (actionKind === "run-task" && !taskAction)
      }
      onSubmit={async (form) => {
        const input = {
          account: {
            organizationId: workspace.organization.id,
            userId: workspace.actor.id,
          },
          name: formText(form, "name"),
          teamId,
          action:
            actionKind === "run-task"
              ? taskAction
              : {
                  kind: "create-issue",
                  issue: {
                    teamId,
                    title: formText(form, "title"),
                    description: formText(form, "description"),
                    acceptanceCriteria: formText(form, "acceptanceCriteria"),
                    status: formIssueStatus(form),
                    priority: formText(form, "priority"),
                    projectId: formText(form, "project") || null,
                    assigneeId: formText(form, "assignee") || null,
                    estimate: formText(form, "estimate") || null,
                  },
                },
          recurrence,
          missed,
          catchUpLimit: Number(formText(form, "catchUpLimit") || "1"),
          lookbackHours: Number(formText(form, "lookbackHours") || "24"),
          ...(current ? { revision: current.revision } : {}),
        };
        try {
          await sender.current(
            current ? `schedules/${current.id}` : "schedules",
            input,
            current ? "PATCH" : "POST",
          );
          await onSaved();
        } catch (error) {
          if (isWorkflowConflict(error)) {
            setWorkflowReload((previous) => previous + 1);
            if (issueOptions.current) issueOptions.current.open = true;
          }
          if (
            error instanceof CloudRequestError &&
            error.code === "revision_conflict" &&
            current
          )
            setConflict(true);
          if (
            error instanceof CloudRequestError &&
            [
              "schedule_profile_changed",
              "schedule_subject_changed",
              "profile_disabled",
              "model_unavailable",
              "acceptance_required",
              "issue_closed",
            ].includes(error.code)
          )
            setTaskNeedsReview(true);
          if (
            error instanceof CloudRequestError &&
            ["invalid_assignee", "invalid_estimate"].includes(error.code) &&
            issueOptions.current
          )
            issueOptions.current.open = true;
          throw error;
        }
      }}
    >
      {conflict && (
        <div className="grid gap-2">
          <p role="alert">
            The schedule changed. Load its current version to replace this
            draft.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setLoadError("");
              void cloudRequest<CloudSchedule>(`schedules/${current!.id}`)
                .then((next) => {
                  if (next.enabled)
                    throw new Error(
                      "The schedule is active. Pause it before editing.",
                    );
                  setCurrent(next);
                  setActionKind(next.action.kind);
                  setTaskAction(
                    next.action.kind === "run-task" ? next.action : null,
                  );
                  setTeamId(next.teamId);
                  setMissed(next.missed);
                  setRecurrence(next.recurrence);
                  setConflict(false);
                })
                .catch((error: Error) => setLoadError(error.message))
                .finally(() => setLoading(false));
            }}
          >
            Load current version
          </Button>
          {loadError && <p role="alert">{loadError}</p>}
        </div>
      )}
      <div key={current?.revision ?? "new"} className="grid min-w-0 gap-4">
        <Field label="Name" htmlFor="schedule-name">
          <Input
            id="schedule-name"
            name="name"
            defaultValue={current?.name}
            maxLength={120}
            required
          />
        </Field>
        <Field label="Team" htmlFor="schedule-team">
          <Select
            id="schedule-team"
            value={teamId}
            disabled={!!current}
            onChange={(event) => setTeamId(event.target.value)}
          >
            {workspace.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Action" htmlFor="schedule-action">
          <Select
            id="schedule-action"
            value={actionKind}
            onChange={(event) =>
              setActionKind(event.target.value as ScheduleAction["kind"])
            }
          >
            <option value="create-issue">Create an issue</option>
            <option value="run-task">Run an AI task</option>
          </Select>
        </Field>
        {actionKind === "create-issue" ? (
          <>
            <Field label="Project" htmlFor="schedule-project">
              <Select
                key={teamId}
                id="schedule-project"
                name="project"
                defaultValue={initialIssue?.projectId ?? ""}
              >
                <option value="">No project</option>
                {workspace.projects
                  .filter((project) => project.teamId === teamId)
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Issue title" htmlFor="schedule-title">
              <Input
                id="schedule-title"
                name="title"
                defaultValue={initialIssue?.title}
                maxLength={300}
                required
              />
            </Field>
            <Field label="Description" htmlFor="schedule-description">
              <Textarea
                id="schedule-description"
                name="description"
                defaultValue={initialIssue?.description}
                maxLength={30000}
                rows={3}
              />
            </Field>
            <ScheduleIssueOptions
              workflowReload={workflowReload}
              workspace={workspace}
              teamId={teamId}
              issue={initialIssue}
              detailsRef={issueOptions}
            />
          </>
        ) : (
          <div className="grid gap-4">
            {taskNeedsReview && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setTaskReload(taskReload + 1);
                  setTaskNeedsReview(false);
                }}
              >
                Reload task settings
              </Button>
            )}
            <ScheduleTaskFields
              workspace={workspace}
              teamId={teamId}
              initial={
                current?.action.kind === "run-task" ? current.action : undefined
              }
              onChange={setTaskAction}
              reloadRevision={taskReload}
            />
          </div>
        )}
        <ScheduleRecurrence
          waitingForTask={actionKind === "run-task" && !!current?.waitingRunId}
          completionLabel={
            actionKind === "run-task"
              ? "After task finishes"
              : "After issue creation"
          }
          initial={current?.recurrence}
          onChange={setRecurrence}
        />
        <Field label="Missed dates" htmlFor="schedule-missed">
          <Select
            id="schedule-missed"
            value={missed}
            onChange={(event) =>
              setMissed(event.target.value as ScheduleInput["missed"])
            }
          >
            <option value="skip">Skip missed dates</option>
            <option value="latest">
              {actionKind === "run-task"
                ? "Run the latest task"
                : "Create the latest issue"}
            </option>
            <option value="bounded-all">
              {actionKind === "run-task"
                ? "Run recent tasks"
                : "Create several recent issues"}
            </option>
          </Select>
        </Field>
        {missed !== "skip" && (
          <Field label="Lookback (hours)" htmlFor="schedule-lookback">
            <Input
              id="schedule-lookback"
              name="lookbackHours"
              type="number"
              min={1}
              max={168}
              defaultValue={current?.lookbackHours ?? 24}
              required
            />
          </Field>
        )}
        {missed === "bounded-all" && (
          <Field
            label="Maximum catch-up occurrences"
            htmlFor="schedule-catchup"
          >
            <Input
              id="schedule-catchup"
              name="catchUpLimit"
              type="number"
              min={1}
              max={20}
              defaultValue={current?.catchUpLimit ?? 5}
              required
            />
          </Field>
        )}
      </div>
    </FormDialog>
  );
}
