import {
  issueStates,
  type CloudIssue,
  type CloudIssueSummary,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import { priorityNames, stateNames } from "./issue-properties";

export const issueGroupings = {
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  project: "Project",
  cycle: "Cycle",
  none: "No grouping",
} as const;
export type IssueGrouping = keyof typeof issueGroupings;

export function parseGrouping(value: string | null): IssueGrouping {
  return value && Object.hasOwn(issueGroupings, value)
    ? (value as IssueGrouping)
    : "status";
}

export interface IssueGroup {
  id: string;
  name: string;
  kind: "state" | "priority" | "assignee" | "project" | "cycle" | "none";
  category?: CloudIssue["state"];
  priority?: CloudIssue["priority"];
  change?: IssueChangeSet;
  issues: CloudIssueSummary[];
}

const priorityRank: Record<CloudIssue["priority"], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
  none: 4,
};
const stateDisplayOrder: CloudIssue["state"][] = [
  "active",
  "review",
  "blocked",
  "ready",
  "backlog",
  "complete",
  "canceled",
];

export function sortIssues(
  issues: CloudIssueSummary[],
  sort: string | null,
): CloudIssueSummary[] {
  const byUpdated = (left: CloudIssueSummary, right: CloudIssueSummary) =>
    right.updatedAt.localeCompare(left.updatedAt);
  const compare =
    sort === "updated"
      ? byUpdated
      : sort === "created"
        ? (left: CloudIssueSummary, right: CloudIssueSummary) =>
            right.createdAt.localeCompare(left.createdAt)
        : sort === "due"
          ? (left: CloudIssueSummary, right: CloudIssueSummary) =>
              (left.dueOn ?? "9999").localeCompare(right.dueOn ?? "9999") ||
              byUpdated(left, right)
          : (left: CloudIssueSummary, right: CloudIssueSummary) =>
              priorityRank[left.priority] - priorityRank[right.priority] ||
              byUpdated(left, right);
  return [...issues].sort(compare);
}

function bucket<T extends string>(
  issues: CloudIssueSummary[],
  key: (issue: CloudIssueSummary) => T,
): Map<T, CloudIssueSummary[]> {
  const buckets = new Map<T, CloudIssueSummary[]>();
  for (const issue of issues) {
    const id = key(issue);
    const list = buckets.get(id);
    if (list) list.push(issue);
    else buckets.set(id, [issue]);
  }
  return buckets;
}

const unset = "none";

export function groupIssues(
  issues: CloudIssueSummary[],
  grouping: IssueGrouping,
  workspace: CloudWorkspace,
  teamId: string | null,
  sort: string | null,
  includeEmpty: boolean,
): IssueGroup[] {
  const sorted = sortIssues(issues, sort);
  if (grouping === "none")
    return [{ id: "all", name: "All issues", kind: "none", issues: sorted }];
  if (grouping === "status") {
    const workflow = workspace.workflows.find(
      (entry) => entry.teamId === teamId,
    );
    if (workflow) {
      const buckets = bucket(sorted, (issue) => issue.status.id);
      return workflow.statuses
        .filter((status) => !status.archived || buckets.has(status.id))
        .map((status) => ({
          id: status.id,
          name: status.name,
          kind: "state" as const,
          category: status.category,
          change: { status: { id: status.id, revision: status.revision } },
          issues: buckets.get(status.id) ?? [],
        }));
    }
    const buckets = bucket(sorted, (issue) => issue.state);
    return (includeEmpty ? issueStates : stateDisplayOrder).map((state) => ({
      id: state,
      name: stateNames[state],
      kind: "state" as const,
      category: state,
      change: { statusCategory: state },
      issues: buckets.get(state) ?? [],
    }));
  }
  if (grouping === "priority") {
    const buckets = bucket(sorted, (issue) => issue.priority);
    return (["urgent", "high", "normal", "low", "none"] as const).map(
      (priority) => ({
        id: priority,
        name: priorityNames[priority],
        kind: "priority" as const,
        priority,
        change: { priority },
        issues: buckets.get(priority) ?? [],
      }),
    );
  }
  if (grouping === "assignee") {
    const buckets = bucket(sorted, (issue) => issue.assigneeId ?? unset);
    return [
      ...workspace.members.map((member) => ({
        id: member.id,
        name: member.name,
        kind: "assignee" as const,
        change: { assigneeId: member.id },
        issues: buckets.get(member.id) ?? [],
      })),
      {
        id: unset,
        name: "Unassigned",
        kind: "assignee" as const,
        change: { assigneeId: null },
        issues: buckets.get(unset) ?? [],
      },
    ];
  }
  if (grouping === "project") {
    const buckets = bucket(sorted, (issue) => issue.projectId ?? unset);
    return [
      ...workspace.projects
        .filter((project) => !teamId || project.teamId === teamId)
        .map((project) => ({
          id: project.id,
          name: project.name,
          kind: "project" as const,
          change: { projectId: project.id },
          issues: buckets.get(project.id) ?? [],
        })),
      {
        id: unset,
        name: "No project",
        kind: "project" as const,
        change: { projectId: null },
        issues: buckets.get(unset) ?? [],
      },
    ];
  }
  const buckets = bucket(sorted, (issue) => issue.cycleId ?? unset);
  return [
    ...workspace.cycles
      .filter(
        (cycle) =>
          (!teamId || cycle.teamId === teamId) &&
          (cycle.status !== "closed" || buckets.has(cycle.id)),
      )
      .map((cycle) => ({
        id: cycle.id,
        name: cycle.name,
        kind: "cycle" as const,
        change: { cycleId: cycle.id },
        issues: buckets.get(cycle.id) ?? [],
      })),
    {
      id: unset,
      name: "No cycle",
      kind: "cycle" as const,
      change: { cycleId: null },
      issues: buckets.get(unset) ?? [],
    },
  ];
}

export function groupPoints(group: IssueGroup): number {
  return group.issues.reduce(
    (total, issue) => total + (issue.estimatePoints ?? 0),
    0,
  );
}
