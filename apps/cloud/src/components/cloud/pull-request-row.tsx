"use client";

import Link from "next/link";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import type {
  CloudPullRequest,
  CloudPullRequestListing,
} from "@/lib/cloud-git-contract";
import { attentionReasons, type AttentionReason } from "@/lib/git-automation";
import { PullRequestStageIcon } from "./pull-request-state";
import { RelativeTime } from "./relative-time";

const reasonLabels: Record<AttentionReason, string> = {
  conflicts: "Conflicts",
  checks: "Checks failing",
  changes: "Changes requested",
};

function Signals({ pullRequest }: { pullRequest: CloudPullRequest }) {
  const reasons = attentionReasons(pullRequest);
  return (
    <span className="cloud-pull-request-signals">
      {reasons.map((reason) => (
        <span key={reason} className="cloud-pull-request-reason">
          {reasonLabels[reason]}
        </span>
      ))}
      {pullRequest.state === "open" && pullRequest.checks === "success" && (
        <CircleCheck
          size={14}
          role="img"
          aria-label="Checks passed"
          data-tone="success"
        />
      )}
      {pullRequest.state === "open" && pullRequest.checks === "pending" && (
        <CircleDashed size={14} role="img" aria-label="Checks running" />
      )}
      {pullRequest.state === "open" &&
        pullRequest.checks === "failure" &&
        !reasons.length && (
          <CircleX
            size={14}
            role="img"
            aria-label="Checks failed"
            data-tone="danger"
          />
        )}
      {pullRequest.state === "open" && pullRequest.review === "approved" && (
        <UserRoundCheck
          size={14}
          role="img"
          aria-label="Approved"
          data-tone="success"
        />
      )}
      {pullRequest.state === "open" &&
        pullRequest.review === "changes_requested" &&
        !reasons.length && (
          <UserRoundX
            size={14}
            role="img"
            aria-label="Changes requested"
            data-tone="danger"
          />
        )}
    </span>
  );
}

export function PullRequestRow({ entry }: { entry: CloudPullRequestListing }) {
  const { pullRequest, issues } = entry;
  return (
    <li className="cloud-pull-request-row">
      <PullRequestStageIcon stage={pullRequest.stage} />
      <div className="cloud-pull-request-row-main">
        <Link href={`/cloud/pull-requests/${pullRequest.id}`} prefetch={false}>
          {pullRequest.title}
        </Link>
        <span className="cloud-pull-request-row-meta">
          <span>
            {pullRequest.repository}#{pullRequest.number}
          </span>
          <code title={`${pullRequest.headRef} → ${pullRequest.baseRef}`}>
            {pullRequest.headRef}
          </code>
          {pullRequest.stack?.parent && (
            <span className="cloud-pull-request-stacked">
              Stacked on #{pullRequest.stack.parent.number}
            </span>
          )}
          {pullRequest.author && <span>{pullRequest.author}</span>}
          {pullRequest.additions + pullRequest.deletions > 0 && (
            <span className="cloud-pull-request-diffstat">
              <span className="cloud-diff-added">+{pullRequest.additions}</span>
              <span className="cloud-diff-removed">
                −{pullRequest.deletions}
              </span>
            </span>
          )}
          <RelativeTime value={pullRequest.updatedAt} />
        </span>
      </div>
      <div className="cloud-pull-request-row-side">
        <span className="cloud-pull-request-row-issues">
          {issues.map((issue) => (
            <Link
              key={issue.id}
              href={`/cloud/issues/${issue.id}`}
              prefetch={false}
              title={`${issue.identifier} ${issue.title} · ${issue.statusName}`}
            >
              {issue.identifier}
            </Link>
          ))}
        </span>
        <Signals pullRequest={pullRequest} />
      </div>
    </li>
  );
}
