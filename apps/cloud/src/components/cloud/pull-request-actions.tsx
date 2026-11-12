"use client";

import { useState } from "react";
import {
  GitMerge,
  GitPullRequestArrow,
  MessageSquareCode,
  Wrench,
} from "lucide-react";
import {
  githubMergeMethods,
  type CloudPullRequest,
  type CloudPullRequestDetails,
} from "@/lib/cloud-github-contract";
import {
  pullRequestChecksPrompt,
  pullRequestConflictPrompt,
  pullRequestReviewPrompt,
  pullRequestSessionTitle,
  type PromptIssue,
} from "@/lib/pull-request-prompts";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { cloudRequest } from "./api-client";
import { ClientLaunch } from "./client-launch";
import { hasConflicts } from "./pull-request-overview";
import { useToast } from "./toast";

type MergeMethod = (typeof githubMergeMethods)[number];

const mergeLabels: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
};

function mergeConsequence(
  method: MergeMethod,
  pullRequest: CloudPullRequest,
): string {
  const { headRef, baseRef } = pullRequest;
  if (method === "rebase")
    return `Rebase ${headRef} onto ${baseRef} on GitHub.`;
  return `${method === "squash" ? "Squash" : "Merge"} ${headRef} into ${baseRef} on GitHub.`;
}

export function PullRequestActions({
  details,
  launch,
  onMerged,
  onUpdated,
}: {
  details: CloudPullRequestDetails;
  launch: boolean;
  onMerged: (pullRequest: CloudPullRequest) => void;
  onUpdated: () => void;
}) {
  const toast = useToast();
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [updating, setUpdating] = useState(false);
  const [updateRequested, setUpdateRequested] = useState(false);
  const { pullRequest } = details;
  const open = pullRequest.state === "open";
  const conflicts = hasConflicts(details);
  const failed = details.checks.runs.filter((run) => run.state === "failure");
  const issues = (): PromptIssue[] =>
    details.issues.map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      url: `${location.origin}/cloud/issues/${issue.id}`,
    }));
  const agent = launch && open;
  const tasks = [
    agent &&
      conflicts && {
        task: "conflicts" as const,
        label: "Resolve conflicts",
        icon: <GitMerge />,
        prompt: () => pullRequestConflictPrompt(pullRequest, issues()),
      },
    agent &&
      failed.length > 0 && {
        task: "checks" as const,
        label: "Fix checks",
        icon: <Wrench />,
        prompt: () => pullRequestChecksPrompt(pullRequest, failed, issues()),
      },
    agent &&
      details.comments.length > 0 && {
        task: "review" as const,
        label: "Address comments",
        icon: <MessageSquareCode />,
        prompt: () =>
          pullRequestReviewPrompt(pullRequest, details.comments, issues()),
      },
  ].filter((entry) => entry !== false);
  const updatable =
    details.canMerge &&
    pullRequest.mergeableState === "behind" &&
    !conflicts &&
    !updateRequested;
  if (!tasks.length && !details.canMerge) return null;
  return (
    <DialogFooter className="cloud-pull-request-actions">
      {tasks.map((entry) => (
        <ClientLaunch
          key={entry.task}
          label={entry.label}
          icon={entry.icon}
          variant="outline"
          branch={pullRequest.headRef}
          worktreeByDefault
          draft={() => ({
            title: pullRequestSessionTitle(entry.task, pullRequest, issues()),
            prompt: entry.prompt(),
          })}
        />
      ))}
      {updatable && (
        <Button
          variant="outline"
          size="sm"
          aria-busy={updating}
          disabled={updating}
          onClick={() => {
            setUpdating(true);
            void cloudRequest(`pull-requests/${pullRequest.id}/update-branch`, {
              method: "POST",
              body: { headSha: pullRequest.headSha },
            })
              .then(() => {
                setUpdateRequested(true);
                toast(
                  `Updating ${pullRequest.headRef} with ${pullRequest.baseRef}`,
                );
                onUpdated();
              })
              .catch((reason: Error) => toast(reason.message, "error"))
              .finally(() => setUpdating(false));
          }}
        >
          <GitPullRequestArrow />
          Update branch
        </Button>
      )}
      {details.canMerge && (
        <div className="cloud-pull-request-merge">
          <Select
            aria-label="Merge method"
            value={method}
            onChange={(event) => setMethod(event.target.value as MergeMethod)}
          >
            {githubMergeMethods.map((entry) => (
              <option key={entry} value={entry}>
                {mergeLabels[entry]}
              </option>
            ))}
          </Select>
          <ConfirmButton
            trigger={
              <Button size="sm" disabled={conflicts || pullRequest.draft}>
                <GitMerge />
                Merge
              </Button>
            }
            title="Merge pull request"
            description={mergeConsequence(method, pullRequest)}
            actionLabel="Merge"
            destructive={false}
            onConfirm={async () => {
              onMerged(
                await cloudRequest<CloudPullRequest>(
                  `pull-requests/${pullRequest.id}/merge`,
                  {
                    method: "POST",
                    body: { method, headSha: pullRequest.headSha },
                  },
                ),
              );
            }}
          />
        </div>
      )}
    </DialogFooter>
  );
}
