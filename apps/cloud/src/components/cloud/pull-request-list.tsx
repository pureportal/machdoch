"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  GitPullRequest,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import type {
  CloudPullRequest,
  CloudPullRequestList,
  CloudPullRequestListing,
} from "@/lib/cloud-git-contract";
import {
  attentionReasons,
  pullRequestStages,
  type AttentionReason,
  type PullRequestStage,
} from "@/lib/git-automation";
import { Select } from "@/components/ui/select";
import { cloudRequest } from "./api-client";
import { PullRequestDialog } from "./pull-request-dialog";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
} from "./pull-request-state";
import { RelativeTime } from "./relative-time";

const pollMs = 30_000;
const openStages: PullRequestStage[] = [
  "attention",
  "ready",
  "review",
  "draft",
];
const reasonLabels: Record<AttentionReason, string> = {
  conflicts: "Conflicts",
  checks: "Checks failing",
  changes: "Changes requested",
};
const allRepositories = "";

type Scope = "open" | PullRequestStage;

function scopeFrom(value: string | null): Scope {
  return pullRequestStages.find((stage) => stage === value) ?? "open";
}

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

function Row({
  entry,
  onOpen,
}: {
  entry: CloudPullRequestListing;
  onOpen: () => void;
}) {
  const { pullRequest, issues } = entry;
  return (
    <li className="cloud-pull-request-row">
      <PullRequestStageIcon stage={pullRequest.stage} />
      <div className="cloud-pull-request-row-main">
        <button type="button" onClick={onOpen}>
          {pullRequest.title}
        </button>
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

export function PullRequestList({
  initial,
  manageGit,
  launch,
}: {
  initial: CloudPullRequestList;
  manageGit: boolean;
  launch: boolean;
}) {
  const search = useSearchParams();
  const scope = scopeFrom(search.get("stage"));
  const [data, setData] = useState(initial);
  const [repository, setRepository] = useState(allRepositories);
  const [selected, setSelected] = useState<CloudPullRequest | null>(null);
  const load = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<CloudPullRequestList>("pull-requests", { signal })
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
  const repositories = [
    ...new Set(data.pullRequests.map((entry) => entry.pullRequest.repository)),
  ].sort();
  const inRepository = data.pullRequests.filter(
    (entry) =>
      repository === allRepositories ||
      entry.pullRequest.repository === repository,
  );
  const counts = Object.fromEntries(
    pullRequestStages.map((stage) => [
      stage,
      inRepository.filter((entry) => entry.pullRequest.stage === stage).length,
    ]),
  ) as Record<PullRequestStage, number>;
  const stages = scope === "open" ? openStages : [scope];
  const groups = stages
    .map((stage) => ({
      stage,
      entries: inRepository.filter(
        (entry) => entry.pullRequest.stage === stage,
      ),
    }))
    .filter((group) => group.entries.length);
  const openCount = openStages.reduce((sum, stage) => sum + counts[stage], 0);
  const tabs: { scope: Scope; label: string; count: number }[] = [
    { scope: "open", label: "Open", count: openCount },
    ...pullRequestStages
      .filter((stage) => stage !== "closed" || counts.closed > 0)
      .map((stage) => ({
        scope: stage,
        label: pullRequestStageLabels[stage],
        count: counts[stage],
      })),
  ];
  return (
    <section aria-labelledby="pull-requests-heading">
      <header className="cloud-page-header">
        <h1 id="pull-requests-heading">Pull requests</h1>
        {repositories.length > 1 && (
          <Select
            aria-label="Repository"
            className="cloud-pull-request-repository"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
          >
            <option value={allRepositories}>All repositories</option>
            {repositories.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        )}
      </header>
      {!data.connected ? (
        <div className="cloud-empty">
          <GitPullRequest aria-hidden="true" />
          {manageGit ? (
            <p>
              <Link href="/cloud/settings?tab=git">
                Connect GitHub or GitLab
              </Link>{" "}
              to follow pull requests.
            </p>
          ) : (
            <p>No Git provider is connected.</p>
          )}
        </div>
      ) : (
        <>
          <nav className="cloud-scope-tabs" aria-label="Pull request stages">
            {tabs.map((tab) => (
              <Link
                key={tab.scope}
                href={
                  tab.scope === "open"
                    ? "/cloud/pull-requests"
                    : `/cloud/pull-requests?stage=${tab.scope}`
                }
                aria-current={tab.scope === scope ? "page" : undefined}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className="cloud-tab-count">{tab.count}</span>
                )}
              </Link>
            ))}
          </nav>
          {!groups.length ? (
            <div className="cloud-empty">
              <GitPullRequest aria-hidden="true" />
              <p>No pull requests.</p>
            </div>
          ) : (
            groups.map((group) => (
              <section
                key={group.stage}
                className="cloud-pull-request-group"
                aria-label={pullRequestStageLabels[group.stage]}
              >
                {scope === "open" && (
                  <h2>
                    <PullRequestStageIcon stage={group.stage} label="" />
                    {pullRequestStageLabels[group.stage]}
                    <span className="cloud-tab-count">
                      {group.entries.length}
                    </span>
                  </h2>
                )}
                <ul>
                  {group.entries.map((entry) => (
                    <Row
                      key={entry.pullRequest.id}
                      entry={entry}
                      onOpen={() => setSelected(entry.pullRequest)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
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
