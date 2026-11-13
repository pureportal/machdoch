"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type {
  CloudPullRequest,
  GitPullRequestFile,
} from "@/lib/cloud-git-contract";
import { cloudRequest } from "./api-client";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
} from "./pull-request-state";

const pollMs = 30_000;
const shownFiles = 8;

function ChangedFiles({ pullRequest }: { pullRequest: CloudPullRequest }) {
  const [files, setFiles] = useState<GitPullRequestFile[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<{ files: GitPullRequestFile[] }>(
      `pull-requests/${pullRequest.id}/files`,
      { signal: abort.signal },
    )
      .then((result) => setFiles(result.files))
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      });
    return () => abort.abort();
  }, [pullRequest.id, pullRequest.headSha]);
  if (error) return <p className="cloud-aside-changes-note">{error}</p>;
  if (!files) return <p className="cloud-aside-changes-note">Loading…</p>;
  const href = `/cloud/pull-requests/${pullRequest.id}?tab=files`;
  return (
    <ul className="cloud-aside-changes">
      {files.slice(0, shownFiles).map((file) => (
        <li key={file.filename}>
          <Link href={href} prefetch={false} title={file.filename}>
            <code>{file.filename.split("/").at(-1)}</code>
            <span className="cloud-diff-added">+{file.additions}</span>
            <span className="cloud-diff-removed">−{file.deletions}</span>
          </Link>
        </li>
      ))}
      {files.length > shownFiles && (
        <li>
          <Link href={href} prefetch={false} className="cloud-aside-more">
            {files.length - shownFiles} more files
          </Link>
        </li>
      )}
    </ul>
  );
}

function PullRequestItem({ pullRequest }: { pullRequest: CloudPullRequest }) {
  const [expanded, setExpanded] = useState(false);
  const changed = pullRequest.additions + pullRequest.deletions > 0;
  return (
    <li>
      <div className="cloud-aside-pull-request">
        <Link
          href={`/cloud/pull-requests/${pullRequest.id}`}
          prefetch={false}
          title={`${pullRequest.repository}#${pullRequest.number}: ${pullRequestStageLabels[pullRequest.stage]}`}
        >
          <PullRequestStageIcon stage={pullRequest.stage} />
          <span className="cloud-aside-pull-request-title">
            {pullRequest.title}
          </span>
          <span className="cloud-aside-pull-request-number">
            #{pullRequest.number}
          </span>
        </Link>
        {changed && (
          <button
            type="button"
            className="cloud-aside-diffstat"
            aria-expanded={expanded}
            aria-label={`Changes in #${pullRequest.number}`}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight size={12} aria-hidden="true" />
            <span className="cloud-diff-added">+{pullRequest.additions}</span>
            <span className="cloud-diff-removed">−{pullRequest.deletions}</span>
            <span>
              {pullRequest.changedFiles}{" "}
              {pullRequest.changedFiles === 1 ? "file" : "files"}
            </span>
          </button>
        )}
      </div>
      {expanded && <ChangedFiles pullRequest={pullRequest} />}
    </li>
  );
}

export function IssuePullRequests({ issueId }: { issueId: string }) {
  const [pullRequests, setPullRequests] = useState<CloudPullRequest[]>([]);
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
          <PullRequestItem key={pullRequest.id} pullRequest={pullRequest} />
        ))}
      </ul>
    </section>
  );
}
