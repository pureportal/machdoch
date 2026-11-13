import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { CloudPullRequest } from "@/lib/cloud-git-contract";
import type { PullRequestStage } from "@/lib/git-automation";

export const pullRequestStageLabels: Record<PullRequestStage, string> = {
  attention: "Needs attention",
  ready: "Ready to merge",
  review: "In review",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export function pullRequestStateLabel(
  pullRequest: Pick<CloudPullRequest, "state" | "draft">,
): string {
  if (pullRequest.state === "merged") return "Merged";
  if (pullRequest.state === "closed") return "Closed";
  return pullRequest.draft ? "Draft" : "Open";
}

const stageIcons = {
  attention: GitPullRequest,
  ready: GitPullRequest,
  review: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const;

export function PullRequestStageIcon({
  stage,
  size = 14,
  label = pullRequestStageLabels[stage],
}: {
  stage: PullRequestStage;
  size?: number;
  label?: string;
}) {
  const Icon = stageIcons[stage];
  return (
    <Icon
      size={size}
      className="cloud-pull-request-icon"
      data-stage={stage}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
    />
  );
}
