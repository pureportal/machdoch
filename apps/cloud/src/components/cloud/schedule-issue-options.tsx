"use client";

import type { RefObject } from "react";
import { issuePriorities, type CloudWorkspace } from "@/lib/cloud-contract";
import type { ScheduleIssue } from "@/lib/cloud-schedule-contract";
import { Field } from "@/components/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { WorkflowStatusField } from "./workflow-status-field";

export function ScheduleIssueOptions({
  workspace,
  teamId,
  issue,
  detailsRef,
  workflowReload,
}: {
  workspace: CloudWorkspace;
  teamId: string;
  issue?: ScheduleIssue;
  detailsRef: RefObject<HTMLDetailsElement | null>;
  workflowReload: number;
}) {
  const cards =
    workspace.teams
      .find((team) => team.id === teamId)
      ?.estimateScale.filter((card) => card.points !== null) ?? [];
  return (
    <details ref={detailsRef}>
      <summary className="cursor-pointer text-sm">Issue options</summary>
      <div className="grid min-w-0 gap-4 pt-4">
        {workspace.workflows.find((workflow) => workflow.teamId === teamId) && (
          <WorkflowStatusField
            key={teamId}
            id="schedule-status"
            initial={workspace.workflows.find(
              (workflow) => workflow.teamId === teamId,
            )!}
            current={
              issue?.status
                ? {
                    status: issue.status,
                    statusName: "Scheduled status changed",
                  }
                : undefined
            }
            reloadRequest={workflowReload}
          />
        )}
        <Field label="Priority" htmlFor="schedule-priority">
          <Select
            id="schedule-priority"
            name="priority"
            defaultValue={issue?.priority ?? "none"}
          >
            {issuePriorities.map((priority) => (
              <option key={priority} value={priority}>
                {priority[0]!.toUpperCase() + priority.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assignee" htmlFor="schedule-assignee">
          <Select
            key={teamId}
            id="schedule-assignee"
            name="assignee"
            defaultValue={issue?.assigneeId ?? ""}
          >
            <option value="">Unassigned</option>
            {issue?.assigneeId &&
              !workspace.members.some(
                (member) => member.id === issue.assigneeId,
              ) && <option value={issue.assigneeId}>Unavailable member</option>}
            {workspace.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Estimate" htmlFor="schedule-estimate">
          <Select
            key={teamId}
            id="schedule-estimate"
            name="estimate"
            defaultValue={issue?.estimate ?? ""}
          >
            <option value="">No estimate</option>
            {issue?.estimate &&
              !cards.some((card) => card.label === issue.estimate) && (
                <option value={issue.estimate}>
                  {issue.estimate} (unavailable)
                </option>
              )}
            {cards.map((card) => (
              <option key={card.label} value={card.label}>
                {card.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Acceptance criteria" htmlFor="schedule-acceptance">
          <Textarea
            id="schedule-acceptance"
            name="acceptanceCriteria"
            defaultValue={issue?.acceptanceCriteria}
            maxLength={20000}
            rows={3}
          />
        </Field>
      </div>
    </details>
  );
}
