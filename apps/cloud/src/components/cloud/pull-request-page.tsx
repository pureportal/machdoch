"use client";

import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import { LoadingState } from "@machdoch/product-ui";
import { useCallback, useEffect, useState } from "react";
import type {
  CloudPullRequest,
  CloudPullRequestDetails,
} from "@/lib/cloud-git-contract";
import { pullRequestHeader } from "@/lib/pull-request-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cloudRequest } from "./api-client";
import { PullRequestActions } from "./pull-request-actions";
import { PullRequestComposer } from "./pull-request-composer";
import { PullRequestFiles } from "./pull-request-files";
import { PullRequestGuide, useReviewGuide } from "./pull-request-guide";
import { PullRequestHeader } from "./pull-request-header";
import { PullRequestOverview } from "./pull-request-overview";
import { PullRequestTimeline } from "./pull-request-timeline";
import { RelativeTime } from "./relative-time";

const pollMs = 30_000;
const pullRequestTabs = ["overview", "guide", "commits", "diff"] as const;
type PullRequestTab = (typeof pullRequestTabs)[number];

export function PullRequestPage({
  initial,
  initialTab,
  launch,
}: {
  initial: CloudPullRequest;
  initialTab: string | null;
  launch: boolean;
}) {
  const [details, setDetails] = useState<CloudPullRequestDetails | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<PullRequestTab>(
    pullRequestTabs.find((entry) => entry === initialTab) ?? "overview",
  );
  const id = initial.id;
  const load = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<CloudPullRequestDetails>(`pull-requests/${id}`, { signal })
        .then((value) => {
          if (!signal?.aborted) {
            setDetails(value);
            setError("");
          }
        })
        .catch((reason: Error) => {
          if (!signal?.aborted) setError(reason.message);
        }),
    [id],
  );
  useEffect(() => {
    const abort = new AbortController();
    const stop = pollWhileVisible(() => load(abort.signal), pollMs);
    return () => {
      abort.abort();
      stop();
    };
  }, [load]);
  const pullRequest = details?.pullRequest ?? initial;
  const guide = useReviewGuide(id, pullRequest.headSha);
  const showGuide = Boolean(
    guide.error || guide.state?.enabled || guide.state?.guide,
  );
  const activeTab = tab === "guide" && !showGuide ? "overview" : tab;
  return (
    <>
      <PullRequestHeader
        pullRequest={pullRequest}
        summary={details && pullRequestHeader(details)}
      />
      {error && !details ? (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      ) : !details ? (
        <LoadingState label="Loading pull request…" />
      ) : (
        <div className="cloud-pull-request-page">
          <Tabs
            value={activeTab}
            onValueChange={(value) => setTab(value as PullRequestTab)}
            className="cloud-pull-request-main"
          >
            <TabsList aria-label="Pull request">
              <TabsTrigger value="overview">
                Overview
                <span className="cloud-tab-count">
                  {details.conversation.length + details.comments.length}
                </span>
              </TabsTrigger>
              {showGuide && <TabsTrigger value="guide">Guide</TabsTrigger>}
              <TabsTrigger value="commits">
                Commits
                <span className="cloud-tab-count">
                  {details.commits.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="diff">
                Diff
                <span className="cloud-tab-count">
                  {pullRequest.changedFiles}
                </span>
                {pullRequest.additions + pullRequest.deletions > 0 && (
                  <span className="cloud-pull-request-diffstat">
                    <span className="cloud-diff-added">
                      +{pullRequest.additions}
                    </span>
                    <span className="cloud-diff-removed">
                      −{pullRequest.deletions}
                    </span>
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <PullRequestTimeline details={details} />
              {details.canMerge && (
                <PullRequestComposer
                  pullRequestId={pullRequest.id}
                  actingAs={details.actingAs}
                  onPosted={() => void load()}
                />
              )}
            </TabsContent>
            {showGuide && (
              <TabsContent value="guide">
                <PullRequestGuide
                  pullRequestId={pullRequest.id}
                  handle={guide}
                />
              </TabsContent>
            )}
            <TabsContent value="commits">
              {!details.commits.length ? (
                <p className="cloud-pull-request-muted">No commits.</p>
              ) : (
                <ol className="cloud-pull-request-commits">
                  {details.commits.map((commit) => (
                    <li key={commit.sha}>
                      <span className="cloud-commit-message">
                        {commit.message.split("\n", 1)[0]}
                      </span>
                      <span className="cloud-pull-request-muted">
                        {commit.author}
                      </span>
                      {commit.committedAt && (
                        <RelativeTime value={commit.committedAt} />
                      )}
                      {commit.url ? (
                        <a href={commit.url} target="_blank" rel="noreferrer">
                          <code>{commit.sha.slice(0, 7)}</code>
                        </a>
                      ) : (
                        <code>{commit.sha.slice(0, 7)}</code>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
            <TabsContent value="diff">
              <PullRequestFiles
                pullRequestId={pullRequest.id}
                url={pullRequest.url}
                provider={pullRequest.provider}
              />
            </TabsContent>
          </Tabs>
          <aside className="cloud-pull-request-aside" aria-label="Details">
            <PullRequestOverview details={details} />
            <PullRequestActions
              details={details}
              launch={launch}
              onMerged={(merged) =>
                setDetails({ ...details, pullRequest: merged, canMerge: false })
              }
              onUpdated={() => void load()}
              onRetargeted={(retargeted) =>
                setDetails({ ...details, pullRequest: retargeted })
              }
            />
          </aside>
        </div>
      )}
    </>
  );
}
