import { CircleCheck, CircleX, MessageSquare } from "lucide-react";
import type {
  CloudPullRequestDetails,
  GitConversationEntry,
  GitReviewComment,
} from "@/lib/cloud-git-contract";
import { CloudMarkdown } from "./cloud-markdown";
import { PersonAvatar } from "./person-avatar";
import { RelativeTime } from "./relative-time";

type TimelineItem =
  | { kind: "entry"; createdAt: string; entry: GitConversationEntry }
  | { kind: "code"; createdAt: string; comment: GitReviewComment };

const reviewVerbs: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "reviewed",
  DISMISSED: "review was dismissed",
};

function ReviewIcon({ state }: { state: string | null }) {
  if (state === "APPROVED")
    return <CircleCheck size={14} aria-hidden="true" data-tone="success" />;
  if (state === "CHANGES_REQUESTED")
    return <CircleX size={14} aria-hidden="true" data-tone="danger" />;
  return <MessageSquare size={14} aria-hidden="true" />;
}

function CodeContext({ comment }: { comment: GitReviewComment }) {
  const lines = comment.diffHunk.split("\n").slice(-4);
  return (
    <>
      <a
        className="cloud-timeline-path"
        href={comment.url}
        target="_blank"
        rel="noreferrer"
      >
        <code>
          {comment.path}
          {comment.line === null ? "" : `:${comment.line}`}
        </code>
      </a>
      {comment.diffHunk && (
        <pre className="cloud-diff-hunk">
          {lines.map((line, index) => (
            <span
              key={index}
              data-kind={
                line.startsWith("+")
                  ? "added"
                  : line.startsWith("-")
                    ? "removed"
                    : undefined
              }
            >
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </>
  );
}

export function PullRequestTimeline({
  details,
}: {
  details: CloudPullRequestDetails;
}) {
  const items: TimelineItem[] = [
    ...details.conversation.map((entry) => ({
      kind: "entry" as const,
      createdAt: entry.createdAt,
      entry,
    })),
    ...details.comments.map((comment) => ({
      kind: "code" as const,
      createdAt: comment.createdAt,
      comment,
    })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const { pullRequest } = details;
  return (
    <ol className="cloud-pull-request-timeline">
      <li className="cloud-timeline-card">
        <header>
          <PersonAvatar
            name={pullRequest.author ?? "?"}
            className="cloud-avatar-small"
          />
          <strong>{pullRequest.author ?? "Unknown"}</strong>
        </header>
        {details.body.trim() ? (
          <CloudMarkdown content={details.body} />
        ) : (
          <p className="cloud-pull-request-muted">No description.</p>
        )}
      </li>
      {items.map((item) =>
        item.kind === "code" ? (
          <li key={`code-${item.comment.id}`} className="cloud-timeline-card">
            <header>
              <PersonAvatar
                name={item.comment.author}
                className="cloud-avatar-small"
              />
              <strong>{item.comment.author}</strong>
              <span>commented on code</span>
              <RelativeTime value={item.createdAt} />
            </header>
            <CodeContext comment={item.comment} />
            <CloudMarkdown content={item.comment.body} />
          </li>
        ) : item.entry.kind === "review" ? (
          <li
            key={item.entry.id}
            className="cloud-timeline-event"
            data-state={item.entry.state ?? undefined}
          >
            <header>
              <ReviewIcon state={item.entry.state} />
              <strong>{item.entry.author}</strong>
              <span>
                {reviewVerbs[item.entry.state ?? ""] ??
                  item.entry.state?.toLowerCase()}
              </span>
              <RelativeTime value={item.createdAt} />
            </header>
            {item.entry.body.trim() && (
              <CloudMarkdown content={item.entry.body} />
            )}
          </li>
        ) : (
          <li key={item.entry.id} className="cloud-timeline-card">
            <header>
              <PersonAvatar
                name={item.entry.author}
                className="cloud-avatar-small"
              />
              <strong>{item.entry.author}</strong>
              <RelativeTime value={item.createdAt} />
            </header>
            <CloudMarkdown content={item.entry.body} />
          </li>
        ),
      )}
    </ol>
  );
}
