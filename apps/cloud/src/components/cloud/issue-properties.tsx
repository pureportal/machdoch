"use client";

import { Calendar, CircleSlash, FolderKanban, UserRound } from "lucide-react";
import {
  issuePriorities,
  issueStates,
  type CloudIssue,
  type CloudIssueSummary,
  type CloudTeam,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import { IssuePriority } from "./issue-priority";
import { PersonAvatar } from "./person-avatar";
import type { PropertyOption } from "./property-menu";

export const stateNames: Record<CloudIssue["state"], string> = {
  backlog: "Backlog",
  ready: "Ready",
  active: "In progress",
  blocked: "Blocked",
  review: "In review",
  complete: "Done",
  canceled: "Canceled",
};
export const priorityNames: Record<CloudIssue["priority"], string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
  none: "No priority",
};
export const noValue = "none";

export function StateIcon({ state }: { state: CloudIssue["state"] }) {
  return <span className="cloud-state" data-state={state} aria-hidden="true" />;
}

export function statusOptions(
  workspace: CloudWorkspace,
  teamIds: string[],
): PropertyOption[] {
  const workflow =
    new Set(teamIds).size === 1
      ? workspace.workflows.find((entry) => entry.teamId === teamIds[0])
      : undefined;
  if (workflow)
    return workflow.statuses
      .filter((status) => !status.archived)
      .map((status) => ({
        value: JSON.stringify({ id: status.id, revision: status.revision }),
        label: status.name,
        icon: <StateIcon state={status.category} />,
      }));
  return issueStates.map((state) => ({
    value: state,
    label: stateNames[state],
    icon: <StateIcon state={state} />,
  }));
}

export function statusChange(value: string): IssueChangeSet {
  return value.startsWith("{")
    ? { status: JSON.parse(value) as IssueChangeSet["status"] }
    : { statusCategory: value as CloudIssue["state"] };
}

export const priorityOptions: PropertyOption[] = (
  ["urgent", "high", "normal", "low", "none"] as const
)
  .filter((priority) => issuePriorities.includes(priority))
  .map((priority) => ({
    value: priority,
    label: priorityNames[priority],
    icon: <IssuePriority priority={priority} compact />,
  }));

export function assigneeOptions(workspace: CloudWorkspace): PropertyOption[] {
  return [
    {
      value: noValue,
      label: "Unassigned",
      icon: <UserRound size={14} aria-hidden="true" />,
    },
    ...workspace.members.map((member) => ({
      value: member.id,
      label: member.name,
      icon: <PersonAvatar name={member.name} className="cloud-avatar-small" />,
    })),
  ];
}

export function projectOptions(
  workspace: CloudWorkspace,
  teamId?: string,
): PropertyOption[] {
  return [
    {
      value: noValue,
      label: "No project",
      icon: <CircleSlash size={14} aria-hidden="true" />,
    },
    ...workspace.projects
      .filter((project) => !teamId || project.teamId === teamId)
      .map((project) => ({
        value: project.id,
        label: project.name,
        icon: <FolderKanban size={14} aria-hidden="true" />,
      })),
  ];
}

export function cycleOptions(
  workspace: CloudWorkspace,
  teamId?: string,
  currentCycleId?: string | null,
): PropertyOption[] {
  return [
    {
      value: noValue,
      label: "No cycle",
      icon: <CircleSlash size={14} aria-hidden="true" />,
    },
    ...workspace.cycles
      .filter(
        (cycle) =>
          (!teamId || cycle.teamId === teamId) &&
          (cycle.status !== "closed" || cycle.id === currentCycleId),
      )
      .map((cycle) => ({
        value: cycle.id,
        label: cycle.name,
        icon: <Calendar size={14} aria-hidden="true" />,
      })),
  ];
}

export function estimateOptions(
  team: CloudTeam | undefined,
  current?: string | null,
): PropertyOption[] {
  const cards = team?.estimateScale.filter((card) => card.points !== null) ?? [];
  return [
    { value: noValue, label: "Not estimated" },
    ...(current && !cards.some((card) => card.label === current)
      ? [{ value: current, label: current }]
      : []),
    ...cards.map((card) => ({ value: card.label, label: card.label })),
  ];
}

export function referenceValue(value: string): string | null {
  return value === noValue ? null : value;
}

export function applyIssueChanges<T extends CloudIssueSummary | CloudIssue>(
  issue: T,
  changes: IssueChangeSet,
  workspace: CloudWorkspace,
): T {
  const next = { ...issue };
  if (changes.priority !== undefined) next.priority = changes.priority;
  if (changes.assigneeId !== undefined) next.assigneeId = changes.assigneeId;
  if (changes.projectId !== undefined) next.projectId = changes.projectId;
  if (changes.cycleId !== undefined) next.cycleId = changes.cycleId;
  if (changes.estimate !== undefined) next.estimate = changes.estimate;
  if (changes.dueOn !== undefined) next.dueOn = changes.dueOn;
  if (changes.archived !== undefined) next.archived = changes.archived;
  if (changes.title !== undefined) next.title = changes.title;
  const statuses = workspace.workflows.find(
    (workflow) => workflow.teamId === issue.teamId,
  )?.statuses;
  const status = changes.status
    ? statuses?.find((entry) => entry.id === changes.status!.id)
    : changes.statusCategory
      ? statuses?.find(
          (entry) =>
            entry.category === changes.statusCategory && !entry.archived,
        )
      : undefined;
  if (status) {
    next.status = { id: status.id, revision: status.revision };
    next.statusName = status.name;
    next.state = status.category;
  }
  return next;
}
