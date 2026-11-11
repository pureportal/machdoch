import type { CloudIssueSummary } from "@/lib/cloud-contract";

export function mergeRefreshedIssues<Issue extends CloudIssueSummary>(
  refreshed: Issue[],
  current: Issue[],
  appended: ReadonlySet<string>,
): Issue[] {
  const known = new Set(refreshed.map((issue) => issue.id));
  return [
    ...refreshed,
    ...current.filter(
      (issue) => appended.has(issue.id) && !known.has(issue.id),
    ),
  ];
}
