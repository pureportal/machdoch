"use client";

import { useState } from "react";
import {
  GitMerge,
  GitPullRequestArrow,
  MessageSquareCode,
  Waypoints,
  Wrench,
} from "lucide-react";
import type {
  CloudPullRequest,
  CloudPullRequestDetails,
  GitMergeMethod,
} from "@/lib/cloud-git-contract";
import { gitProviderLabels } from "@/lib/git-providers";
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

const mergeLabels: Record<GitMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
};

function mergeConsequence(
  method: GitMergeMethod,
  details: CloudPullRequestDetails,
): string {
  const { headRef, baseRef, provider } = details.pullRequest;
  const where = `on ${gitProviderLabels[provider]} as ${details.actingAs}`;
  if (method === "rebase") return `Rebase ${headRef} onto ${baseRef} ${where}.`;
  return `${method === "squash" ? "Squash" : "Merge"} ${headRef} into ${baseRef} ${where}.`;
}

export function PullRequestActions({
  details,
  launch,
  onMerged,
  onUpdated,
  onRetargeted,
}: {
  details: CloudPullRequestDetails;
  launch: boolean;
  onMerged: (pullRequest: CloudPullRequest) => void;
  onUpdated: () => void;
  onRetargeted: (pullRequest: CloudPullRequest) => void;
}) {
  const toast = useToast();
  const [method, setMethod] = useState<GitMergeMethod>(
    details.mergeMethods[0] ?? "squash",
  );
  const [updating, setUpdating] = useState(false);
  const [retargeting, setRetargeting] = useState(false);
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
  const retargetTo = details.canMerge ? pullRequest.stack?.retargetTo : null;
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
          startByDefault
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
      {retargetTo && (
        <Button
          variant="outline"
          size="sm"
          aria-busy={retargeting}
          disabled={retargeting}
          onClick={() => {
            setRetargeting(true);
            void cloudRequest<CloudPullRequest>(
              `pull-requests/${pullRequest.id}/retarget`,
              { method: "POST", body: { baseRef: retargetTo } },
            )
              .then((retargeted) => {
                toast(`Retargeted onto ${retargetTo}`);
                onRetargeted(retargeted);
              })
              .catch((reason: Error) => toast(reason.message, "error"))
              .finally(() => setRetargeting(false));
          }}
        >
          <Waypoints />
          Retarget to {retargetTo}
        </Button>
      )}
      {details.canMerge && (
        <div className="cloud-pull-request-merge">
          <Select
            aria-label="Merge method"
            value={method}
            onChange={(event) =>
              setMethod(event.target.value as GitMergeMethod)
            }
          >
            {details.mergeMethods.map((entry) => (
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
            description={mergeConsequence(method, details)}
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
