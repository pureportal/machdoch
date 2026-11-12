import type { GitHubReviewComment } from "@/lib/cloud-github-contract";
import { CloudMarkdown } from "./cloud-markdown";
import { RelativeTime } from "./relative-time";

const contextLines = 5;

function DiffHunk({ hunk }: { hunk: string }) {
  return (
    <pre className="cloud-diff-hunk">
      {hunk
        .split("\n")
        .slice(-contextLines)
        .map((line, index) => (
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
  );
}

export function PullRequestComments({
  comments,
}: {
  comments: GitHubReviewComment[];
}) {
  if (!comments.length)
    return <p className="cloud-pull-request-loading">No code comments.</p>;
  return (
    <ol className="cloud-review-comments">
      {comments.map((comment) => (
        <li key={comment.id}>
          <header>
            <a href={comment.url} target="_blank" rel="noreferrer">
              <code>
                {comment.path}
                {comment.line === null ? "" : `:${comment.line}`}
              </code>
            </a>
            <span>{comment.author}</span>
            <RelativeTime value={comment.createdAt} />
          </header>
          <DiffHunk hunk={comment.diffHunk} />
          <CloudMarkdown content={comment.body} />
        </li>
      ))}
    </ol>
  );
}
