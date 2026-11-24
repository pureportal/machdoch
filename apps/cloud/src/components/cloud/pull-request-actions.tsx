"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  CirclePlus,
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
  pullRequestConflictPrompt,
  pullRequestConflictSessionTitle,
  type PromptIssue,
} from "@/lib/pull-request-prompts";
import type { PullRequestFixTask } from "@/lib/pull-request-fixes";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cloudRequest, createCommandSender } from "./api-client";
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
  const router = useRouter();
  const [startingFix, setStartingFix] = useState<PullRequestFixTask | null>(
    null,
  );
  const fixSender = useRef(createCommandSender());
  const [method, setMethod] = useState<GitMergeMethod>(
    details.mergeMethods[0] ?? "squash",
  );
  const [updating, setUpdating] = useState(false);
  const [retargeting, setRetargeting] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
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
  const conflictTask = agent && conflicts;
  const fixTasks = [
    details.fixable &&
      failed.length > 0 && {
        task: "checks" as const,
        label: "Fix checks",
        icon: <Wrench />,
      },
    details.fixable &&
      details.comments.length > 0 && {
        task: "review" as const,
        label: "Address comments",
        icon: <MessageSquareCode />,
      },
  ].filter((entry) => entry !== false);
  const startFix = (task: PullRequestFixTask) => {
    setStartingFix(task);
    void fixSender
      .current<{ id: string }>(`pull-requests/${pullRequest.id}/fix`, { task })
      .then(({ id }) => router.push(`/cloud/tasks/${id}`))
      .catch((reason: Error) => {
        toast(reason.message, "error");
        setStartingFix(null);
      });
  };
  const updatable =
    details.canMerge &&
    pullRequest.mergeableState === "behind" &&
    !conflicts &&
    !updateRequested;
  const retargetTo = details.canMerge ? pullRequest.stack?.retargetTo : null;
  if (
    !conflictTask &&
    !fixTasks.length &&
    !details.canMerge &&
    !details.issueSuggestion
  )
    return null;
  return (
    <div className="cloud-pull-request-actions">
      {details.issueSuggestion && (
        <Button
          variant="outline"
          size="sm"
          aria-busy={creatingIssue}
          disabled={creatingIssue}
          onClick={() => {
            setCreatingIssue(true);
            void cloudRequest(`pull-requests/${pullRequest.id}/issue`, {
              method: "POST",
              body: {},
            })
              .then(onUpdated)
              .catch((reason: Error) => toast(reason.message, "error"))
              .finally(() => setCreatingIssue(false));
          }}
        >
          <CirclePlus />
          Create issue
        </Button>
      )}
      {conflictTask && (
        <ClientLaunch
          label="Resolve conflicts"
          icon={<GitMerge />}
          variant="outline"
          branch={pullRequest.headRef}
          worktreeByDefault
          startByDefault
          draft={() => ({
            title: pullRequestConflictSessionTitle(pullRequest, issues()),
            prompt: pullRequestConflictPrompt(pullRequest, issues()),
          })}
        />
      )}
      {fixTasks.map((entry) => (
        <Button
          key={entry.task}
          variant="outline"
          size="sm"
          aria-busy={startingFix === entry.task}
          disabled={startingFix !== null}
          onClick={() => startFix(entry.task)}
        >
          {entry.icon}
          {entry.label}
        </Button>
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
    </div>
  );
}
