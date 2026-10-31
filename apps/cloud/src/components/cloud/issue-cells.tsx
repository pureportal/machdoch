"use client";

import Link from "next/link";
import { Bot } from "lucide-react";
import type {
  CloudIssueSummary,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import { IssuePriority } from "./issue-priority";
import {
  assigneeOptions,
  estimateOptions,
  noValue,
  priorityOptions,
  referenceValue,
  stateNames,
  StateIcon,
  statusChange,
  statusOptions,
} from "./issue-properties";
import { PersonAvatar } from "./person-avatar";
import { PropertyMenu } from "./property-menu";

export type ApplyChange = (
  issues: CloudIssueSummary[],
  changes: IssueChangeSet,
) => void;

export function StatusCell({
  issue,
  workspace,
  writable,
  apply,
}: {
  issue: CloudIssueSummary;
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ApplyChange;
}) {
  const icon = (
    <span className="cloud-state" data-state={issue.state}>
      <span className="sr-only">{issue.statusName}</span>
    </span>
  );
  if (!writable) return <span title={issue.statusName}>{icon}</span>;
  return (
    <PropertyMenu
      label="Status"
      options={statusOptions(workspace, [issue.teamId])}
      value={JSON.stringify(issue.status)}
      onSelect={(value) => apply([issue], statusChange(value))}
    >
      <button
        type="button"
        className="cloud-cell-button"
        title={issue.statusName}
        aria-label={`Status of ${issue.identifier}: ${issue.statusName}`}
      >
        {icon}
      </button>
    </PropertyMenu>
  );
}

export function PriorityCell({
  issue,
  writable,
  apply,
}: {
  issue: CloudIssueSummary;
  writable: boolean;
  apply: ApplyChange;
}) {
  const icon = <IssuePriority priority={issue.priority} compact />;
  if (!writable) return icon;
  return (
    <PropertyMenu
      label="Priority"
      options={priorityOptions}
      value={issue.priority}
      onSelect={(value) =>
        apply([issue], { priority: value as CloudIssueSummary["priority"] })
      }
    >
      <button
        type="button"
        className="cloud-cell-button"
        aria-label={`Priority of ${issue.identifier}: ${issue.priority}`}
      >
        {icon}
      </button>
    </PropertyMenu>
  );
}

export function AssigneeCell({
  issue,
  workspace,
  writable,
  apply,
}: {
  issue: CloudIssueSummary;
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ApplyChange;
}) {
  const assignee = workspace.members.find(
    (member) => member.id === issue.assigneeId,
  );
  const avatar = assignee ? (
    <span title={assignee.name}>
      <PersonAvatar name={assignee.name} className="cloud-avatar-small" />
    </span>
  ) : (
    <span className="cloud-avatar-empty" title="Unassigned" />
  );
  if (!writable) return avatar;
  return (
    <PropertyMenu
      label="Assignee"
      align="end"
      options={assigneeOptions(workspace)}
      value={issue.assigneeId ?? noValue}
      onSelect={(value) =>
        apply([issue], { assigneeId: referenceValue(value) })
      }
    >
      <button
        type="button"
        className="cloud-cell-button"
        aria-label={`Assignee of ${issue.identifier}: ${assignee?.name ?? "Unassigned"}`}
      >
        {avatar}
      </button>
    </PropertyMenu>
  );
}

export function EstimateCell({
  issue,
  workspace,
  writable,
  apply,
}: {
  issue: CloudIssueSummary;
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ApplyChange;
}) {
  if (!writable && !issue.estimate) return null;
  const content = issue.estimate ?? "–";
  if (!writable)
    return (
      <span className="cloud-issue-estimate" title="Estimate">
        {content}
      </span>
    );
  return (
    <PropertyMenu
      label="Estimate"
      align="end"
      options={estimateOptions(
        workspace.teams.find((team) => team.id === issue.teamId),
        issue.estimate,
      )}
      value={issue.estimate ?? noValue}
      onSelect={(value) => apply([issue], { estimate: referenceValue(value) })}
    >
      <button
        type="button"
        className="cloud-issue-estimate"
        data-empty={!issue.estimate || undefined}
        aria-label={`Estimate of ${issue.identifier}: ${issue.estimate ?? "not estimated"}`}
      >
        {content}
      </button>
    </PropertyMenu>
  );
}

export function RunIndicator({ issue }: { issue: CloudIssueSummary }) {
  if (!issue.activeRun) return null;
  return (
    <Link
      className="cloud-run-indicator"
      data-state={issue.activeRun.state}
      href={`/cloud/tasks/${issue.activeRun.id}`}
      prefetch={false}
      title={`AI task ${issue.activeRun.state.replaceAll("_", " ")}`}
      aria-label={`AI task for ${issue.identifier}`}
      onClick={(event) => event.stopPropagation()}
    >
      <Bot size={13} aria-hidden="true" />
    </Link>
  );
}

export { StateIcon, stateNames };
