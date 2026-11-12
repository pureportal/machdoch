import {
  issueStates,
  type CloudIssue,
  type CloudIssueSummary,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import type { IssueSort } from "@/lib/cloud-contract";
import { sortIssues } from "@/lib/issue-sorting";
import { priorityNames, stateNames } from "./issue-properties";

export const issueGroupings = {
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  project: "Project",
  cycle: "Cycle",
  label: "Label",
  team: "Team",
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
  kind:
    | "state"
    | "priority"
    | "assignee"
    | "project"
    | "cycle"
    | "label"
    | "team"
    | "none";
  category?: CloudIssue["state"];
  priority?: CloudIssue["priority"];
  change?: IssueChangeSet;
  issues: CloudIssueSummary[];
}

const stateDisplayOrder: CloudIssue["state"][] = [
  "triage",
  "active",
  "review",
  "blocked",
  "ready",
  "backlog",
  "complete",
  "canceled",
];

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
  sort: IssueSort,
  reversed: boolean,
  includeEmpty: boolean,
): IssueGroup[] {
  const sorted = sortIssues(issues, sort, reversed);
  if (grouping === "none")
    return [{ id: "all", name: "All issues", kind: "none", issues: sorted }];
  if (grouping === "status") {
    const workflow = workspace.workflows.find(
      (entry) => entry.teamId === teamId,
    );
    if (workflow) {
      const buckets = bucket(sorted, (issue) => issue.status.id);
      return workflow.statuses
        .filter(
          (status) =>
            buckets.has(status.id) ||
            (!status.archived && status.category !== "triage"),
        )
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
  if (grouping === "team") {
    const buckets = bucket(sorted, (issue) => issue.teamId);
    return workspace.teams
      .filter((team) => buckets.has(team.id) || includeEmpty)
      .map((team) => ({
        id: team.id,
        name: team.name,
        kind: "team" as const,
        issues: buckets.get(team.id) ?? [],
      }));
  }
  if (grouping === "label") {
    const labels = new Map<
      string,
      { name: string; issues: CloudIssueSummary[] }
    >();
    const unlabeled: CloudIssueSummary[] = [];
    for (const issue of sorted) {
      if (!issue.labels.length) unlabeled.push(issue);
      for (const label of issue.labels) {
        const entry = labels.get(label.id);
        if (entry) entry.issues.push(issue);
        else labels.set(label.id, { name: label.name, issues: [issue] });
      }
    }
    return [
      ...[...labels]
        .sort(([, left], [, right]) => left.name.localeCompare(right.name))
        .map(([id, entry]) => ({ id, kind: "label" as const, ...entry })),
      {
        id: unset,
        name: "No label",
        kind: "label" as const,
        issues: unlabeled,
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
