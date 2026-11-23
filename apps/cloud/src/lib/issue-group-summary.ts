import type { CloudIssueSummary } from "./cloud-contract";

export interface IssueGroupSummary {
  count: number;
  estimate: number;
}

export function issueGroupSummary(
  issues: Pick<CloudIssueSummary, "estimatePoints">[],
): IssueGroupSummary {
  return {
    count: issues.length,
    estimate: issues.reduce(
      (total, issue) => total + (issue.estimatePoints ?? 0),
      0,
    ),
  };
}
