"use client";

import { Globe, Link2 } from "lucide-react";
import type { CloudChannel, CloudProduct } from "@/lib/cloud-release-contract";
import type { ReleaseMedia } from "@/lib/cloud-release-media-contract";
import type { ComposedPost } from "@/lib/release-posts";
import { mediaUrl } from "./release-display";

function PreviewMedia({
  media,
  limit,
}: {
  media: ReleaseMedia[];
  limit: number;
}) {
  const shown = media.slice(0, limit);
  if (!shown.length) return null;
  return (
    <div
      className="cloud-post-preview-media"
      data-count={Math.min(shown.length, 4)}
    >
      {shown
        .slice(0, 4)
        .map((entry) =>
          entry.kind === "video" ? (
            <video
              key={entry.id}
              src={`${mediaUrl(entry.id)}#t=1`}
              muted
              controls
              preload="metadata"
            />
          ) : (
            <img
              key={entry.id}
              src={mediaUrl(entry.id)}
              alt={entry.altText || entry.caption}
            />
          ),
        )}
    </div>
  );
}

export function PostPreview({
  channel,
  product,
  composed,
  media,
  link,
}: {
  channel: CloudChannel;
  product: CloudProduct;
  composed: ComposedPost;
  media: ReleaseMedia[];
  link: string | null;
}) {
  const badge = (
    <span
      className="cloud-post-preview-avatar"
      style={{
        backgroundImage: `linear-gradient(135deg, ${product.brand.primary}, ${product.brand.accent})`,
      }}
    >
      {product.name.slice(0, 1).toUpperCase()}
    </span>
  );
  if (channel.kind === "reddit") {
    const subreddit = channel.subreddits[0];
    return (
      <article
        className="cloud-post-preview"
        data-kind="reddit"
        aria-label="Reddit preview"
      >
        <header>
          <span className="cloud-post-preview-avatar" data-kind="reddit">
            r/
          </span>
          <div>
            <strong>r/{subreddit?.name ?? "subreddit"}</strong>
            <span>
              {channel.accountName ?? "Reddit account"}
              {channel.subreddits.length > 1
                ? ` · +${channel.subreddits.length - 1} more`
                : ""}
            </span>
          </div>
        </header>
        {subreddit?.flairText && (
          <span className="cloud-post-preview-flair">
            {subreddit.flairText}
          </span>
        )}
        <h4>{composed.title}</h4>
        {subreddit?.postType === "image" ? (
          <PreviewMedia
            media={media.filter((entry) => entry.kind === "image")}
            limit={1}
          />
        ) : subreddit?.postType === "link" ? (
          <a
            className="cloud-post-preview-link"
            href={link ?? product.website ?? "#"}
            target="_blank"
            rel="noreferrer"
          >
            <Link2 size={14} aria-hidden="true" />
            {(link ?? product.website ?? "").replace(/^https:\/\//, "")}
          </a>
        ) : null}
        {subreddit?.postType !== "link" && <p>{composed.text}</p>}
      </article>
    );
  }
  if (channel.kind === "linkedin")
    return (
      <article
        className="cloud-post-preview"
        data-kind="linkedin"
        aria-label="LinkedIn preview"
      >
        <header>
          {badge}
          <div>
            <strong>{channel.authorName}</strong>
            <span>
              Now · <Globe size={11} aria-label="Public" />
            </span>
          </div>
        </header>
        <p>{composed.text}</p>
        <PreviewMedia media={media} limit={9} />
      </article>
    );
  return (
    <article
      className="cloud-post-preview"
      data-kind="webhook"
      aria-label="Message preview"
    >
      <header>
        {badge}
        <div>
          <strong>{product.name}</strong>
          <span>{channel.webhookHost}</span>
        </div>
      </header>
      <p>{composed.text}</p>
      <PreviewMedia media={media} limit={4} />
    </article>
  );
}
