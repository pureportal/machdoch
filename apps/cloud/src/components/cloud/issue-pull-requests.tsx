"use client";

import { useCallback, useEffect, useState } from "react";
import type { CloudPullRequest } from "@/lib/cloud-github-contract";
import { cloudRequest } from "./api-client";
import { PullRequestDialog } from "./pull-request-dialog";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
} from "./pull-request-state";

const pollMs = 30_000;
const calledOutStages = new Set(["attention", "ready"]);

export function IssuePullRequests({
  issueId,
  launch,
}: {
  issueId: string;
  launch: boolean;
}) {
  const [pullRequests, setPullRequests] = useState<CloudPullRequest[]>([]);
  const [selected, setSelected] = useState<CloudPullRequest | null>(null);
  const load = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<{ pullRequests: CloudPullRequest[] }>(
        `issues/${issueId}/pull-requests`,
        { signal },
      )
        .then((result) => {
          if (!signal?.aborted) setPullRequests(result.pullRequests);
        })
        .catch(() => undefined),
    [issueId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    const timer = setInterval(() => {
      if (!document.hidden) void load(abort.signal);
    }, pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [load]);
  if (!pullRequests.length) return null;
  return (
    <section className="cloud-aside-section" aria-label="Pull requests">
      <header>
        <h2>Pull requests</h2>
      </header>
      <ul className="cloud-aside-pull-requests">
        {pullRequests.map((pullRequest) => (
          <li key={pullRequest.id}>
            <button
              type="button"
              title={`${pullRequest.repository}#${pullRequest.number}: ${pullRequestStageLabels[pullRequest.stage]}`}
              onClick={() => setSelected(pullRequest)}
            >
              <PullRequestStageIcon stage={pullRequest.stage} />
              <span className="cloud-aside-pull-request-title">
                {pullRequest.title}
              </span>
              {calledOutStages.has(pullRequest.stage) ? (
                <span
                  className="cloud-aside-pull-request-stage"
                  data-stage={pullRequest.stage}
                >
                  {pullRequestStageLabels[pullRequest.stage]}
                </span>
              ) : (
                <span className="cloud-aside-pull-request-number">
                  #{pullRequest.number}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <PullRequestDialog
        pullRequest={selected}
        launch={launch}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onChanged={() => void load()}
      />
    </section>
  );
}
