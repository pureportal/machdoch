"use client";

import { LoadingState } from "@machdoch/product-ui";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Terminal } from "lucide-react";
import type {
  CloudPullRequest,
  CloudPullRequestDetails,
} from "@/lib/cloud-git-contract";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { gitProviderLabels } from "@/lib/git-providers";
import { cloudRequest } from "./api-client";
import { PullRequestActions } from "./pull-request-actions";
import { PullRequestComments } from "./pull-request-comments";
import { PullRequestFiles } from "./pull-request-files";
import { PullRequestOverview } from "./pull-request-overview";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
} from "./pull-request-state";
import { useToast } from "./toast";

function Header({ pullRequest }: { pullRequest: CloudPullRequest }) {
  const toast = useToast();
  const checkout = `git fetch origin ${pullRequest.headRef} && git switch ${pullRequest.headRef}`;
  return (
    <div className="cloud-pull-request-meta">
      <span className="cloud-pull-request-stage" data-stage={pullRequest.stage}>
        <PullRequestStageIcon stage={pullRequest.stage} label="" />
        {pullRequestStageLabels[pullRequest.stage]}
      </span>
      <span>
        {pullRequest.repository}#{pullRequest.number}
      </span>
      <span className="cloud-pull-request-branch">
        <code title={`${pullRequest.headRef} → ${pullRequest.baseRef}`}>
          {pullRequest.headRef} → {pullRequest.baseRef}
        </code>
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
      {pullRequest.additions + pullRequest.deletions > 0 && (
        <span>
          <span className="cloud-diff-added">+{pullRequest.additions}</span>{" "}
          <span className="cloud-diff-removed">−{pullRequest.deletions}</span>
        </span>
      )}
      {pullRequest.author && <span>{pullRequest.author}</span>}
      <a href={pullRequest.url} target="_blank" rel="noreferrer">
        {gitProviderLabels[pullRequest.provider]}
        <ArrowUpRight size={13} aria-hidden="true" />
      </a>
    </div>
  );
}

export function PullRequestDialog({
  pullRequest,
  launch,
  onOpenChange,
  onChanged,
}: {
  pullRequest: CloudPullRequest | null;
  launch: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [details, setDetails] = useState<CloudPullRequestDetails | null>(null);
  const [error, setError] = useState("");
  const id = pullRequest?.id ?? null;
  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!id) return;
      cloudRequest<CloudPullRequestDetails>(`pull-requests/${id}`, { signal })
        .then((value) => {
          if (!signal?.aborted) setDetails(value);
        })
        .catch((reason: Error) => {
          if (!signal?.aborted) setError(reason.message);
        });
    },
    [id],
  );
  useEffect(() => {
    setDetails(null);
    setError("");
    const abort = new AbortController();
    load(abort.signal);
    return () => abort.abort();
  }, [load]);
  const shown = details?.pullRequest ?? pullRequest;
  return (
    <Dialog open={pullRequest !== null} onOpenChange={onOpenChange}>
      <DialogContent className="cloud-pull-request-dialog max-w-3xl">
        <DialogTitle>{shown?.title}</DialogTitle>
        {shown && <Header pullRequest={shown} />}
        {error ? (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        ) : !details ? (
          <LoadingState label="Loading pull request…" />
        ) : (
          <>
            <Tabs defaultValue="overview" className="cloud-pull-request-tabs">
              <TabsList aria-label="Pull request">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="files">
                  Files
                  {details.pullRequest.changedFiles > 0 && (
                    <span className="cloud-tab-count">
                      {details.pullRequest.changedFiles}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="comments">
                  Comments
                  {details.comments.length > 0 && (
                    <span className="cloud-tab-count">
                      {details.comments.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                <PullRequestOverview details={details} />
              </TabsContent>
              <TabsContent value="files">
                <PullRequestFiles
                  pullRequestId={details.pullRequest.id}
                  url={details.pullRequest.url}
                  provider={details.pullRequest.provider}
                />
              </TabsContent>
              <TabsContent value="comments">
                <PullRequestComments comments={details.comments} />
              </TabsContent>
            </Tabs>
            <PullRequestActions
              details={details}
              launch={launch}
              onMerged={(merged) => {
                setDetails({
                  ...details,
                  pullRequest: merged,
                  canMerge: false,
                });
                onChanged();
              }}
              onUpdated={onChanged}
              onRetargeted={(retargeted) => {
                setDetails({ ...details, pullRequest: retargeted });
                onChanged();
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
