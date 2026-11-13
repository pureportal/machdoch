"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { GitPullRequest, Search } from "lucide-react";
import type { CloudPullRequestList } from "@/lib/cloud-git-contract";
import { pullRequestStages, type PullRequestStage } from "@/lib/git-automation";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cloudRequest } from "./api-client";
import { PullRequestRow } from "./pull-request-row";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
} from "./pull-request-state";

const pollMs = 30_000;
const openStages: PullRequestStage[] = [
  "attention",
  "ready",
  "review",
  "draft",
];
const allRepositories = "";

type Scope = "open" | PullRequestStage;

function scopeFrom(value: string | null): Scope {
  return pullRequestStages.find((stage) => stage === value) ?? "open";
}

export function PullRequestList({
  initial,
  manageGit,
}: {
  initial: CloudPullRequestList;
  manageGit: boolean;
}) {
  const search = useSearchParams();
  const scope = scopeFrom(search.get("stage"));
  const [data, setData] = useState(initial);
  const [repository, setRepository] = useState(allRepositories);
  const [author, setAuthor] = useState(allRepositories);
  const [query, setQuery] = useState("");
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
  const authors = [
    ...new Set(
      data.pullRequests.flatMap((entry) =>
        entry.pullRequest.author ? [entry.pullRequest.author] : [],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const needle = query.trim().toLowerCase();
  const inRepository = data.pullRequests.filter(
    ({ pullRequest, issues }) =>
      (repository === allRepositories ||
        pullRequest.repository === repository) &&
      (author === allRepositories || pullRequest.author === author) &&
      (!needle ||
        pullRequest.title.toLowerCase().includes(needle) ||
        pullRequest.headRef.toLowerCase().includes(needle) ||
        String(pullRequest.number) === needle.replace(/^#/u, "") ||
        issues.some((issue) =>
          issue.identifier.toLowerCase().includes(needle),
        )),
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
          <div className="cloud-pull-request-filters">
            <label className="cloud-issue-search">
              <Search size={14} aria-hidden="true" />
              <Input
                aria-label="Search pull requests"
                placeholder="Search…"
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {authors.length > 1 && (
              <Select
                aria-label="Author"
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
              >
                <option value={allRepositories}>All authors</option>
                {authors.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            )}
            {repositories.length > 1 && (
              <Select
                aria-label="Repository"
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
          </div>
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
                    <PullRequestRow key={entry.pullRequest.id} entry={entry} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </section>
  );
}
