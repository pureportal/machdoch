import Link from "next/link";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  type LucideIcon,
} from "lucide-react";
import type {
  CloudPullRequestDetails,
  GitCheckRun,
} from "@/lib/cloud-git-contract";
import { StateIcon } from "./issue-properties";
import { PullRequestStack } from "./pull-request-stack";

const runIcons: Record<GitCheckRun["state"], LucideIcon> = {
  success: CircleCheck,
  failure: CircleX,
  pending: CircleDashed,
  skipped: CircleMinus,
};

export function hasConflicts(details: CloudPullRequestDetails): boolean {
  return (
    details.pullRequest.state === "open" &&
    (details.pullRequest.mergeableState === "dirty" ||
      details.mergeable === false)
  );
}

function mergeSummary(details: CloudPullRequestDetails): string {
  const { pullRequest } = details;
  if (pullRequest.state === "merged") return "Merged";
  if (pullRequest.state === "closed") return "Closed";
  if (hasConflicts(details)) return `Conflicts with ${pullRequest.baseRef}`;
  if (pullRequest.draft) return "Draft";
  if (pullRequest.mergeableState === "behind")
    return `Behind ${pullRequest.baseRef}`;
  if (pullRequest.mergeableState === "blocked")
    return "Blocked by branch rules";
  if (
    ["clean", "has_hooks", "unstable"].includes(
      pullRequest.mergeableState ?? "",
    )
  )
    return "Mergeable";
  return "Checking";
}

export function PullRequestOverview({
  details,
}: {
  details: CloudPullRequestDetails;
}) {
  const runs = [...details.checks.runs].sort(
    (left, right) =>
      ["failure", "pending", "success", "skipped"].indexOf(left.state) -
      ["failure", "pending", "success", "skipped"].indexOf(right.state),
  );
  return (
    <div className="cloud-pull-request-overview">
      <dl className="cloud-pull-request-status">
        <div>
          <dt>Merge</dt>
          <dd data-tone={hasConflicts(details) ? "danger" : undefined}>
            {mergeSummary(details)}
          </dd>
        </div>
      </dl>
      {runs.length > 0 && (
        <section aria-labelledby="pull-request-checks">
          <h3 id="pull-request-checks" className="cloud-pull-request-heading">
            Checks
          </h3>
          <ul className="cloud-pull-request-checks">
            {runs.map((run, index) => {
              const Icon = runIcons[run.state];
              return (
                <li key={`${run.name}-${index}`} data-state={run.state}>
                  <Icon size={14} aria-label={run.state} role="img" />
                  {run.url ? (
                    <a href={run.url} target="_blank" rel="noreferrer">
                      {run.name}
                    </a>
                  ) : (
                    <span>{run.name}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <PullRequestStack pullRequest={details.pullRequest} />
      {details.issues.length > 0 && (
        <section aria-labelledby="pull-request-issues">
          <h3 id="pull-request-issues" className="cloud-pull-request-heading">
            Issues
          </h3>
          <ul className="cloud-pull-request-issues">
            {details.issues.map((issue) => (
              <li key={issue.id}>
                <StateIcon state={issue.state} />
                <Link href={`/cloud/issues/${issue.id}`} prefetch={false}>
                  <span className="cloud-issue-key">{issue.identifier}</span>
                  <span>{issue.title}</span>
                </Link>
                <span className="cloud-pull-request-muted">
                  {issue.statusName}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
