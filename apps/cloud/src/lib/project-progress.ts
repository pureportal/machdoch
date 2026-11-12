import type { CloudIssue } from "./cloud-contract";

export const progressStates = [
  "complete",
  "review",
  "active",
  "blocked",
  "ready",
  "backlog",
  "triage",
] as const satisfies readonly CloudIssue["state"][];

export interface ProgressSegment {
  state: (typeof progressStates)[number];
  count: number;
}

export function projectStateBreakdown(
  issues: Pick<CloudIssue, "state" | "archived">[],
): { total: number; segments: ProgressSegment[] } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const issue of issues) {
    if (issue.archived || issue.state === "canceled") continue;
    total += 1;
    counts.set(issue.state, (counts.get(issue.state) ?? 0) + 1);
  }
  return {
    total,
    segments: progressStates
      .map((state) => ({ state, count: counts.get(state) ?? 0 }))
      .filter((segment) => segment.count > 0),
  };
}

export function daysUntil(target: string, today: string): number {
  return Math.round(
    (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86_400_000,
  );
}
