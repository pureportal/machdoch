"use client";

import Link from "next/link";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import type {
  CloudChannel,
  CloudProduct,
  CloudRelease,
  ReleaseJob,
} from "@/lib/cloud-release-contract";
import type {
  MediaCapabilities,
  ReleaseMedia,
} from "@/lib/cloud-release-media-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { cloudRequest } from "./api-client";
import { ReleaseStatusPill } from "./release-display";
import { ReleaseMediaTab } from "./release-media-tab";
import { ReleaseOverview } from "./release-overview";
import { ReleasePosts } from "./release-posts";
import { ReleaseWriteDialog } from "./release-write-dialog";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

type Tab = "overview" | "media" | "posts";
const pollMs = 4_000;

const jobLabels: Record<ReleaseJob["kind"], string> = {
  write: "Agent writing",
  video: "Video",
  capture: "Sandbox capture",
};

function JobIcon({ state }: { state: ReleaseJob["state"] }) {
  if (state === "succeeded")
    return <CircleCheck size={14} aria-label="Succeeded" />;
  if (state === "failed") return <CircleX size={14} aria-label="Failed" />;
  if (state === "waiting")
    return <CircleDashed size={14} aria-label="Waiting" />;
  return <LoaderCircle size={14} className="cloud-spin" aria-label="Running" />;
}

export interface StudioContext {
  workspace: CloudWorkspace;
  product: CloudProduct;
  channels: CloudChannel[];
  release: CloudRelease;
  media: ReleaseMedia[];
  capabilities: MediaCapabilities;
  canWrite: boolean;
  refresh: () => Promise<void>;
  write: (channel?: CloudChannel) => void;
}

export function ReleaseStudio({
  workspace,
  product,
  channels,
  initial,
  initialMedia,
  capabilities,
}: {
  workspace: CloudWorkspace;
  product: CloudProduct;
  channels: CloudChannel[];
  initial: CloudRelease;
  initialMedia: ReleaseMedia[];
  capabilities: MediaCapabilities;
}) {
  const toast = useToast();
  const [release, setRelease] = useState(initial);
  const [media, setMedia] = useState(initialMedia);
  const [tab, setTab] = useState<Tab>("overview");
  const [writing, setWriting] = useState<{ channel?: CloudChannel } | null>(
    null,
  );
  const canWrite = workspace.actor.role !== "viewer" && !release.archived;
  const refresh = useCallback(async () => {
    const [nextRelease, nextMedia] = await Promise.all([
      cloudRequest<CloudRelease>(`releases/${initial.id}`),
      cloudRequest<ReleaseMedia[]>(
        `release-media?productId=${initial.productId}&releaseId=${initial.id}`,
      ),
    ]);
    setRelease(nextRelease);
    setMedia(nextMedia);
  }, [initial.id, initial.productId]);
  const active =
    release.jobs.some((job) =>
      ["queued", "running", "waiting"].includes(job.state),
    ) ||
    release.posts.some((post) =>
      ["scheduled", "publishing"].includes(post.state),
    );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh().catch(() => undefined);
    }, pollMs);
    return () => clearInterval(timer);
  }, [active, refresh]);
  const context: StudioContext = {
    workspace,
    product,
    channels,
    release,
    media,
    capabilities,
    canWrite,
    refresh,
    write: (channel) => setWriting({ channel }),
  };
  const approved = release.posts.filter((post) =>
    ["approved", "scheduled", "publishing", "published"].includes(post.state),
  ).length;
  const live = release.posts.filter(
    (post) => post.state === "published",
  ).length;
  const steps: { tab: Tab; label: string; value: string; done: boolean }[] = [
    {
      tab: "overview",
      label: "Shipped",
      value: `${release.itemCount} ${release.itemCount === 1 ? "issue" : "issues"}`,
      done: release.itemCount > 0,
    },
    {
      tab: "overview",
      label: "Notes",
      value: release.notes.trim() ? "Written" : "Not written",
      done: Boolean(release.notes.trim()),
    },
    {
      tab: "media",
      label: "Media",
      value: `${media.length} ${media.length === 1 ? "file" : "files"}`,
      done: media.length > 0,
    },
    {
      tab: "posts",
      label: "Approved",
      value: `${approved} of ${release.posts.length}`,
      done: release.posts.length > 0 && approved === release.posts.length,
    },
    {
      tab: "posts",
      label: "Live",
      value: `${live} of ${release.posts.length}`,
      done: release.posts.length > 0 && live === release.posts.length,
    },
  ];
  async function archive(archived: boolean) {
    try {
      await cloudRequest(`releases/${release.id}/archive`, {
        method: "POST",
        body: { revision: release.revision, archived },
      });
      await refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    }
  }
  return (
    <div className="cloud-release-studio">
      <header className="cloud-release-header">
        <nav className="cloud-issue-breadcrumb" aria-label="Release location">
          <Link href="/cloud/releases">Releases</Link>
          <ChevronRight size={13} aria-hidden="true" />
          <span>{product.name}</span>
        </nav>
        <div className="cloud-release-heading">
          <span
            className="cloud-release-badge"
            style={{
              backgroundImage: `linear-gradient(135deg, ${product.brand.primary}, ${product.brand.accent})`,
            }}
          >
            {product.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h1>
              {product.name} {release.version}
            </h1>
            {release.name && <p>{release.name}</p>}
          </div>
          <ReleaseStatusPill status={release.status} />
          <span className="cloud-automation-spacer" />
          {canWrite && (
            <Button onClick={() => setWriting({})}>
              <Sparkles />
              Write with Agent
            </Button>
          )}
          {workspace.actor.role !== "viewer" && (
            <ConfirmButton
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    release.archived ? "Restore release" : "Archive release"
                  }
                >
                  {release.archived ? <ArchiveRestore /> : <Archive />}
                </Button>
              }
              title={release.archived ? "Restore release?" : "Archive release?"}
              description={
                release.archived
                  ? "It returns to the release list."
                  : "It leaves the release list. Published posts stay online."
              }
              actionLabel={release.archived ? "Restore" : "Archive"}
              destructive={!release.archived}
              onConfirm={() => archive(!release.archived)}
            />
          )}
        </div>
        <ol className="cloud-release-pipeline" aria-label="Progress">
          {steps.map((step) => (
            <li key={step.label} data-done={step.done || undefined}>
              <button type="button" onClick={() => setTab(step.tab)}>
                {step.done ? (
                  <CircleCheck size={15} aria-hidden="true" />
                ) : (
                  <CircleDashed size={15} aria-hidden="true" />
                )}
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.value}</small>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </header>
      <div className="cloud-release-body">
        <div className="cloud-release-main">
          <div
            className="cloud-release-tabs"
            role="tablist"
            aria-label="Release"
          >
            {(
              [
                ["overview", "Overview"],
                ["media", `Media · ${media.length}`],
                ["posts", `Posts · ${release.posts.length}`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "overview" && (
            <ReleaseOverview key={release.revision} context={context} />
          )}
          {tab === "media" && <ReleaseMediaTab context={context} />}
          {tab === "posts" && <ReleasePosts context={context} />}
        </div>
        <aside className="cloud-release-rail" aria-label="Activity">
          <h2>Activity</h2>
          {release.jobs.length ? (
            <ol className="cloud-release-jobs">
              {release.jobs.map((job) => (
                <li key={job.id} data-state={job.state}>
                  <JobIcon state={job.state} />
                  <div>
                    <strong>{jobLabels[job.kind]}</strong>
                    {job.detail && <span>{job.detail}</span>}
                    {job.error && (
                      <span className="cloud-release-error">{job.error}</span>
                    )}
                    <span className="cloud-automation-muted">
                      <RelativeTime value={job.createdAt} />
                      {job.chatId && (
                        <>
                          {" · "}
                          <Link href={`/cloud/chat/${job.chatId}`}>
                            Conversation
                          </Link>
                        </>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="cloud-automation-muted">No activity yet.</p>
          )}
          <dl className="cloud-automation-facts">
            {release.targetDate && (
              <>
                <dt>Launch</dt>
                <dd>
                  {new Date(
                    `${release.targetDate}T00:00:00`,
                  ).toLocaleDateString(undefined, { dateStyle: "medium" })}
                </dd>
              </>
            )}
            {release.since && (
              <>
                <dt>Since</dt>
                <dd>
                  {new Date(`${release.since}T00:00:00`).toLocaleDateString(
                    undefined,
                    { dateStyle: "medium" },
                  )}
                </dd>
              </>
            )}
            <dt>Updated</dt>
            <dd>
              <RelativeTime value={release.updatedAt} />
            </dd>
          </dl>
        </aside>
      </div>
      {writing && (
        <ReleaseWriteDialog
          context={context}
          channel={writing.channel}
          onClose={() => setWriting(null)}
          onStarted={async () => {
            await refresh();
            toast("Agent is writing");
          }}
        />
      )}
    </div>
  );
}
