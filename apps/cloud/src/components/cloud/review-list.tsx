"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";
import type { CloudReviewInbox } from "@/lib/cloud-git-contract";
import {
  reviewGroup,
  reviewGroupLabels,
  reviewGroups,
} from "@/lib/pull-request-reviews";
import { cloudRequest } from "./api-client";
import { PullRequestRow } from "./pull-request-row";

const pollMs = 30_000;

export function ReviewList({ initial }: { initial: CloudReviewInbox }) {
  const [data, setData] = useState(initial);
  const load = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<CloudReviewInbox>("pull-requests/reviews", { signal })
        .then((value) => {
          if (!signal?.aborted) setData(value);
        })
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    const abort = new AbortController();
    const timer = setInterval(() => {
      if (!document.hidden) void load(abort.signal);
    }, pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [load]);
  const groups = reviewGroups
    .map((group) => ({
      group,
      entries: data.pullRequests.filter(
        (entry) => reviewGroup(entry.pullRequest, data.accounts) === group,
      ),
    }))
    .filter((group) => group.entries.length);
  return (
    <section aria-labelledby="reviews-heading">
      <header className="cloud-page-header">
        <h1 id="reviews-heading">Reviews</h1>
      </header>
      {!data.accounts.length ? (
        <div className="cloud-empty">
          <GitPullRequest aria-hidden="true" />
          <p>
            <Link href="/cloud/account?tab=git">
              Link your GitHub or GitLab account
            </Link>{" "}
            to see your reviews.
          </p>
        </div>
      ) : !groups.length ? (
        <div className="cloud-empty">
          <GitPullRequest aria-hidden="true" />
          <p>Nothing needs you right now.</p>
        </div>
      ) : (
        groups.map(({ group, entries }) => (
          <section
            key={group}
            className="cloud-pull-request-group"
            aria-label={reviewGroupLabels[group]}
            data-group={group}
          >
            <h2>
              {reviewGroupLabels[group]}
              <span className="cloud-tab-count">{entries.length}</span>
            </h2>
            <ul>
              {entries.map((entry) => (
                <PullRequestRow key={entry.pullRequest.id} entry={entry} />
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
