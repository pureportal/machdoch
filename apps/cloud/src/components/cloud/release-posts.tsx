"use client";

import {
  CalendarClock,
  Check,
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  RotateCcw,
  Send,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  CloudChannel,
  PostStateChange,
  ReleaseLaunch,
  ReleaseLaunchResult,
  ReleasePost,
} from "@/lib/cloud-release-contract";
import { channelLimits, composePost, releaseTitle } from "@/lib/release-posts";
import { createCommandSender } from "./api-client";
import { ChannelMark, mediaUrl, postStateLabels } from "./release-display";
import { PostPreview } from "./release-post-preview";
import type { StudioContext } from "./release-studio";
import { useToast } from "./toast";

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

const inAnHour = () => localDateTime(new Date(Date.now() + 60 * 60_000));

function isEmpty(post: ReleasePost): boolean {
  return !post.body.trim() && !post.mediaIds.length;
}

function isLaunchable(post: ReleasePost, channel: CloudChannel): boolean {
  return (
    channel.enabled &&
    !isEmpty(post) &&
    (post.state === "approved" ||
      (post.state === "draft" && !channel.requiresApproval))
  );
}

function PostCard({
  context,
  post,
  channel,
}: {
  context: StudioContext;
  post: ReleasePost;
  channel: CloudChannel;
}) {
  const { product, release, media, canWrite } = context;
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [draft, setDraft] = useState({
    title: post.title,
    body: post.body,
    mediaIds: post.mediaIds,
    link: post.link ?? "",
  });
  const [when, setWhen] = useState(
    post.scheduledAt ? localDateTime(new Date(post.scheduledAt)) : inAnHour(),
  );
  const [postedUrl, setPostedUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const editable =
    canWrite && !["publishing", "published"].includes(post.state);
  const dirty =
    draft.title !== post.title ||
    draft.body !== post.body ||
    draft.link !== (post.link ?? "") ||
    draft.mediaIds.join() !== post.mediaIds.join();
  const composed = composePost(
    channel.kind,
    channel.rules,
    { title: draft.title, body: draft.body, link: draft.link || null },
    product,
    releaseTitle(product, release),
  );
  const mediaLimit =
    channel.kind === "reddit" ? 1 : channelLimits[channel.kind].media;
  const attached = draft.mediaIds
    .map((id) => media.find((entry) => entry.id === id))
    .filter((entry) => entry !== undefined);
  async function run(action: () => Promise<unknown>, success: string) {
    setPending(true);
    try {
      await action();
      await context.refresh();
      toast(success);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending(false);
    }
  }
  const change = (body: PostStateChange, success: string) =>
    run(() => sender.current(`release-posts/${post.id}/state`, body), success);
  const save = () =>
    run(
      () =>
        sender.current(
          `release-posts/${post.id}`,
          {
            revision: post.revision,
            title: draft.title,
            body: draft.body,
            mediaIds: draft.mediaIds,
            link: draft.link || null,
          },
          "PATCH",
        ),
      "Post saved",
    );
  const approvalNeeded = channel.requiresApproval && post.state === "draft";
  const empty = isEmpty(post);
  const canSchedule =
    release.canPublish &&
    canWrite &&
    !dirty &&
    ["draft", "approved", "scheduled"].includes(post.state) &&
    !approvalNeeded;
  const canMarkPosted =
    release.canPublish &&
    canWrite &&
    !dirty &&
    channel.enabled &&
    !["publishing", "published"].includes(post.state);
  async function copyText() {
    try {
      await navigator.clipboard.writeText(
        channel.kind === "reddit"
          ? `${composed.title}\n\n${composed.text}`
          : composed.text,
      );
      toast("Copied");
    } catch {
      toast("Copying is blocked in this browser.", "error");
    }
  }
  return (
    <section
      className="cloud-post-card"
      aria-label={`${channel.name} post`}
      data-state={post.state}
    >
      <header>
        <ChannelMark kind={channel.kind} />
        <div>
          <h3>{channel.name}</h3>
          <span>
            {channel.kind === "reddit"
              ? channel.subreddits.map((entry) => `r/${entry.name}`).join(", ")
              : channel.kind === "linkedin"
                ? channel.authorName
                : channel.webhookHost}
          </span>
        </div>
        <span className="cloud-automation-spacer" />
        <span className="cloud-post-state" data-state={post.state}>
          {post.state === "publishing" && (
            <LoaderCircle size={12} className="cloud-spin" aria-hidden="true" />
          )}
          {postStateLabels[post.state]}
          {post.state === "scheduled" &&
            post.scheduledAt &&
            ` · ${new Date(post.scheduledAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}
        </span>
      </header>
      <div className="cloud-post-layout">
        <div className="cloud-post-editor">
          {channel.kind === "reddit" && (
            <Input
              aria-label="Title"
              placeholder="Title"
              maxLength={300}
              value={draft.title}
              disabled={!editable}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          )}
          <Textarea
            aria-label="Post"
            rows={9}
            value={draft.body}
            placeholder="Write the post, or let Agent write it."
            disabled={!editable}
            onChange={(event) =>
              setDraft({ ...draft, body: event.target.value })
            }
          />
          <div
            className="cloud-post-counter"
            data-over={composed.truncated || undefined}
          >
            {composed.length.toLocaleString()} /{" "}
            {composed.limit.toLocaleString()}
            {composed.truncated && " · will be shortened"}
          </div>
          {channel.rules.includeLink && (
            <Input
              aria-label="Link"
              type="url"
              placeholder={product.website ?? "https://"}
              value={draft.link}
              disabled={!editable}
              onChange={(event) =>
                setDraft({ ...draft, link: event.target.value })
              }
            />
          )}
          {media.length > 0 && (
            <div
              className="cloud-release-picker"
              role="group"
              aria-label="Attached media"
            >
              {media.map((entry) => {
                const selected = draft.mediaIds.includes(entry.id);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${selected ? "Detach" : "Attach"} ${entry.caption || entry.name}`}
                    disabled={
                      !editable ||
                      (!selected && draft.mediaIds.length >= mediaLimit)
                    }
                    onClick={() =>
                      setDraft({
                        ...draft,
                        mediaIds: selected
                          ? draft.mediaIds.filter((id) => id !== entry.id)
                          : [...draft.mediaIds, entry.id],
                      })
                    }
                  >
                    {entry.kind === "video" ? (
                      <video src={`${mediaUrl(entry.id)}#t=1`} muted />
                    ) : (
                      <img src={mediaUrl(entry.id)} alt="" />
                    )}
                    {selected && <Check size={14} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
          {post.error && <p className="cloud-release-error">{post.error}</p>}
          {post.deliveries.length > 0 && (
            <ul className="cloud-post-deliveries">
              {post.deliveries.map((delivery) => (
                <li key={delivery.target} data-state={delivery.state}>
                  <span>
                    {delivery.target === "manual"
                      ? "Posted manually"
                      : delivery.target}
                  </span>
                  <span>
                    {delivery.state === "published"
                      ? "Published"
                      : delivery.state === "failed"
                        ? "Failed"
                        : "Pending"}
                  </span>
                  {delivery.url && (
                    <a href={delivery.url} target="_blank" rel="noreferrer">
                      View
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <div className="cloud-post-actions">
              {editable && dirty && (
                <Button disabled={pending} onClick={() => void save()}>
                  Save
                </Button>
              )}
              {editable && !dirty && (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => context.write(channel)}
                >
                  <Sparkles />
                  Rewrite
                </Button>
              )}
              {approvalNeeded && !dirty && (
                <Button
                  disabled={pending || empty}
                  onClick={() =>
                    void change(
                      { action: "approve", revision: post.revision },
                      "Post approved",
                    )
                  }
                >
                  <Check />
                  Approve
                </Button>
              )}
              {canSchedule && (
                <>
                  <Input
                    aria-label="Publish at"
                    type="datetime-local"
                    className="cloud-post-when"
                    value={when}
                    onChange={(event) => setWhen(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={pending || !when || empty}
                    onClick={() =>
                      void change(
                        {
                          action: "schedule",
                          revision: post.revision,
                          at: new Date(when).toISOString(),
                        },
                        "Post scheduled",
                      )
                    }
                  >
                    <CalendarClock />
                    Schedule
                  </Button>
                  <Button
                    disabled={pending || empty}
                    onClick={() =>
                      void change(
                        { action: "publish", revision: post.revision },
                        "Publishing",
                      )
                    }
                  >
                    <Send />
                    Publish now
                  </Button>
                </>
              )}
              {post.state === "failed" && release.canPublish && (
                <Button
                  disabled={pending}
                  onClick={() =>
                    void change(
                      { action: "retry", revision: post.revision },
                      "Retrying",
                    )
                  }
                >
                  <RotateCcw />
                  Retry
                </Button>
              )}
              {["approved", "scheduled", "failed"].includes(post.state) &&
                !post.deliveries.some(
                  (delivery) => delivery.state === "published",
                ) && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      void change(
                        { action: "reopen", revision: post.revision },
                        "Back to draft",
                      )
                    }
                  >
                    <Undo2 />
                    {post.state === "scheduled"
                      ? "Unschedule"
                      : "Back to draft"}
                  </Button>
                )}
              <span className="cloud-automation-spacer" />
              {composed.text && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Copy text"
                  title="Copy text"
                  onClick={() => void copyText()}
                >
                  <Copy />
                </Button>
              )}
              {canMarkPosted && postedUrl === null && (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setPostedUrl("")}
                >
                  <Link2 />
                  Mark as posted
                </Button>
              )}
            </div>
          )}
          {canMarkPosted && postedUrl !== null && (
            <form
              className="cloud-post-actions"
              onSubmit={(event) => {
                event.preventDefault();
                void change(
                  { action: "manual", revision: post.revision, url: postedUrl },
                  "Marked as posted",
                );
              }}
            >
              <Input
                aria-label="Post URL"
                type="url"
                required
                pattern="https://.*"
                placeholder="https://"
                autoFocus
                value={postedUrl}
                onChange={(event) => setPostedUrl(event.target.value)}
              />
              <Button type="submit" disabled={pending}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPostedUrl(null)}
              >
                Cancel
              </Button>
            </form>
          )}
        </div>
        <PostPreview
          channel={channel}
          product={product}
          composed={composed}
          media={attached}
          link={draft.link || null}
        />
      </div>
    </section>
  );
}

function LaunchBar({ context }: { context: StudioContext }) {
  const { release, channels } = context;
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [when, setWhen] = useState(inAnHour);
  const [pending, setPending] = useState(false);
  const ready = release.posts.filter((post) => {
    const channel = channels.find((entry) => entry.id === post.channelId);
    return channel !== undefined && isLaunchable(post, channel);
  }).length;
  if (!release.canPublish || !context.canWrite || ready < 2) return null;
  async function launch(body: ReleaseLaunch) {
    setPending(true);
    try {
      const result = await sender.current<ReleaseLaunchResult>(
        `releases/${release.id}/launch`,
        body,
      );
      await context.refresh();
      const done = `${result.launched} ${result.launched === 1 ? "post" : "posts"} ${body.action === "publish" ? "publishing" : "scheduled"}`;
      if (result.skipped.length)
        toast(
          `${done}. Skipped ${result.skipped.map((entry) => `${entry.channelName}: ${entry.reason}`).join(" · ")}`,
          "error",
        );
      else toast(done);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="cloud-release-toolbar" role="group" aria-label="Launch">
      <Input
        aria-label="Schedule all at"
        type="datetime-local"
        className="cloud-post-when"
        value={when}
        onChange={(event) => setWhen(event.target.value)}
      />
      <Button
        variant="outline"
        disabled={pending || !when}
        onClick={() =>
          void launch({ action: "schedule", at: new Date(when).toISOString() })
        }
      >
        <CalendarClock />
        Schedule {ready} posts
      </Button>
      <ConfirmButton
        trigger={
          <Button disabled={pending}>
            <Send />
            Publish {ready} posts
          </Button>
        }
        title={`Publish ${ready} posts now?`}
        description="They go live on every channel immediately."
        actionLabel="Publish"
        destructive={false}
        onConfirm={() => launch({ action: "publish" })}
      />
    </div>
  );
}

export function ReleasePosts({ context }: { context: StudioContext }) {
  const { release, channels } = context;
  if (!release.posts.length)
    return (
      <p className="cloud-automation-muted">
        Add channels to {context.product.name} to write posts.
      </p>
    );
  return (
    <div className="cloud-post-list">
      <LaunchBar context={context} />
      {release.posts.map((post) => {
        const channel = channels.find((entry) => entry.id === post.channelId);
        return channel ? (
          <PostCard
            key={`${post.id}:${post.revision}`}
            context={context}
            post={post}
            channel={channel}
          />
        ) : null;
      })}
    </div>
  );
}
