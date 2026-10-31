import type { CloudIssueSummary } from "@/lib/cloud-contract";

export function mergeRefreshedIssues(
  refreshed: CloudIssueSummary[],
  current: CloudIssueSummary[],
  appended: ReadonlySet<string>,
): CloudIssueSummary[] {
  const known = new Set(refreshed.map((issue) => issue.id));
  return [
    ...refreshed,
    ...current.filter((issue) => appended.has(issue.id) && !known.has(issue.id)),
  ];
}
