"use client";

import Link from "next/link";
import { LoadingState } from "@machdoch/product-ui";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Terminal,
} from "lucide-react";
import type {
  CloudPullRequest,
  CloudPullRequestDetails,
} from "@/lib/cloud-git-contract";
import { gitProviderLabels } from "@/lib/git-providers";
import {
  pullRequestReviewers,
  type ReviewerState,
} from "@/lib/pull-request-reviews";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cloudRequest } from "./api-client";
import { PersonAvatar } from "./person-avatar";
import { PullRequestActions } from "./pull-request-actions";
import { PullRequestComposer } from "./pull-request-composer";
import { PullRequestFiles } from "./pull-request-files";
import { PullRequestOverview } from "./pull-request-overview";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
  pullRequestStateLabel,
} from "./pull-request-state";
import { PullRequestTimeline } from "./pull-request-timeline";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

const pollMs = 30_000;
const pullRequestTabs = ["conversation", "commits", "files"] as const;
type PullRequestTab = (typeof pullRequestTabs)[number];

const reviewerLabels: Record<ReviewerState, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  pending: "Review requested",
};

function ReviewerIcon({ state }: { state: ReviewerState }) {
  const label = reviewerLabels[state];
  if (state === "approved")
    return (
      <CircleCheck
        size={14}
        role="img"
        aria-label={label}
        data-tone="success"
      />
    );
  if (state === "changes_requested")
    return (
      <CircleX size={14} role="img" aria-label={label} data-tone="danger" />
    );
  return <CircleDashed size={14} role="img" aria-label={label} />;
}

function Header({ pullRequest }: { pullRequest: CloudPullRequest }) {
  const toast = useToast();
  const checkout = `git fetch origin ${pullRequest.headRef} && git switch ${pullRequest.headRef}`;
  return (
    <header className="cloud-page-header cloud-pull-request-page-header">
      <div>
        <Link className="cloud-back-link" href="/cloud/pull-requests">
          <ArrowLeft size={14} aria-hidden="true" /> Pull requests
        </Link>
        <h1>
          {pullRequest.title}{" "}
          <span className="cloud-pull-request-number">
            #{pullRequest.number}
          </span>
        </h1>
        <div className="cloud-pull-request-meta">
          <span
            className="cloud-pull-request-state"
            data-state={pullRequest.draft ? "draft" : pullRequest.state}
          >
            <PullRequestStageIcon stage={pullRequest.stage} label="" />
            {pullRequestStateLabel(pullRequest)}
          </span>
          {pullRequest.state === "open" && !pullRequest.draft && (
            <span
              className="cloud-pull-request-stage"
              data-stage={pullRequest.stage}
            >
              {pullRequestStageLabels[pullRequest.stage]}
            </span>
          )}
          {pullRequest.author && <strong>{pullRequest.author}</strong>}
          <span className="cloud-pull-request-branch">
            <code>{pullRequest.headRef}</code>→
            <code>{pullRequest.baseRef}</code>
            {pullRequest.state === "open" && (
              <button
                type="button"
                className="cloud-pull-request-copy"
                aria-label="Copy checkout command"
                title={checkout}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(checkout)
                    .then(() => toast("Checkout command copied"))
                    .catch(() => toast("Copy failed", "error"))
                }
              >
                <Terminal size={13} aria-hidden="true" />
              </button>
            )}
          </span>
          <span>{pullRequest.repository}</span>
          <RelativeTime value={pullRequest.updatedAt} />
        </div>
      </div>
      <a
        className="cloud-pull-request-external"
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
      >
        {gitProviderLabels[pullRequest.provider]}
        <ArrowUpRight size={13} aria-hidden="true" />
      </a>
    </header>
  );
}

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
    pullRequestTabs.find((entry) => entry === initialTab) ?? "conversation",
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
    void load(abort.signal);
    const timer = setInterval(() => {
      if (!document.hidden) void load(abort.signal);
    }, pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [load]);
  const pullRequest = details?.pullRequest ?? initial;
  const reviewers = details
    ? pullRequestReviewers(pullRequest.requestedReviewers, details.reviews)
    : [];
  return (
    <>
      <Header pullRequest={pullRequest} />
      {error && !details ? (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      ) : !details ? (
        <LoadingState label="Loading pull request…" />
      ) : (
        <div className="cloud-pull-request-page">
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as PullRequestTab)}
            className="cloud-pull-request-main"
          >
            <TabsList aria-label="Pull request">
              <TabsTrigger value="conversation">
                Conversation
                <span className="cloud-tab-count">
                  {details.conversation.length + details.comments.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="commits">
                Commits
                <span className="cloud-tab-count">
                  {details.commits.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="files">
                Files changed
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
            <TabsContent value="conversation">
              <PullRequestTimeline details={details} />
              {details.canMerge && (
                <PullRequestComposer
                  pullRequestId={pullRequest.id}
                  actingAs={details.actingAs}
                  onPosted={() => void load()}
                />
              )}
            </TabsContent>
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
            <TabsContent value="files">
              <PullRequestFiles
                pullRequestId={pullRequest.id}
                url={pullRequest.url}
                provider={pullRequest.provider}
              />
            </TabsContent>
          </Tabs>
          <aside className="cloud-pull-request-aside" aria-label="Details">
            <section aria-labelledby="pull-request-reviewers">
              <h3
                id="pull-request-reviewers"
                className="cloud-pull-request-heading"
              >
                Reviewers
              </h3>
              {!reviewers.length ? (
                <p className="cloud-pull-request-muted">None</p>
              ) : (
                <ul className="cloud-pull-request-reviewers">
                  {reviewers.map((reviewer) => (
                    <li key={reviewer.login} data-state={reviewer.state}>
                      <PersonAvatar
                        name={reviewer.login}
                        className="cloud-avatar-tiny"
                      />
                      <span>{reviewer.login}</span>
                      <ReviewerIcon state={reviewer.state} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
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
