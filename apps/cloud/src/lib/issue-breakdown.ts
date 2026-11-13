import type { CloudIssueSummary } from "./cloud-contract";

export const breakdownKinds = {
  assignee: "Assignees",
  label: "Labels",
  project: "Projects",
} as const;
export type BreakdownKind = keyof typeof breakdownKinds;

export interface BreakdownEntry {
  id: string | null;
  total: number;
  completed: number;
  points: number;
}

type BreakdownIssue = Pick<
  CloudIssueSummary,
  "state" | "assigneeId" | "projectId" | "labels" | "estimatePoints"
>;

function keys(issue: BreakdownIssue, kind: BreakdownKind): (string | null)[] {
  if (kind === "assignee") return [issue.assigneeId ?? null];
  if (kind === "project") return [issue.projectId ?? null];
  return issue.labels.length ? issue.labels.map((label) => label.id) : [null];
}

export function issueBreakdown(
  issues: BreakdownIssue[],
  kind: BreakdownKind,
): BreakdownEntry[] {
  const entries = new Map<string | null, BreakdownEntry>();
  for (const issue of issues) {
    if (issue.state === "canceled") continue;
    for (const id of keys(issue, kind)) {
      const entry = entries.get(id) ?? {
        id,
        total: 0,
        completed: 0,
        points: 0,
      };
      entry.total += 1;
      entry.points += issue.estimatePoints ?? 0;
      if (issue.state === "complete") entry.completed += 1;
      entries.set(id, entry);
    }
  }
  return [...entries.values()].sort(
    (left, right) =>
      Number(left.id === null) - Number(right.id === null) ||
      right.total - left.total,
  );
}
