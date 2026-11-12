import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { PullRequestStage } from "@/lib/github-automation";

export const pullRequestStageLabels: Record<PullRequestStage, string> = {
  attention: "Needs attention",
  ready: "Ready to merge",
  review: "In review",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

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
