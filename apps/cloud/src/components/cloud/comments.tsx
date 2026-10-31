"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudComment } from "@/lib/cloud-comment-contract";
import { issueChangeEntries, type IssueHistoryEntry } from "./issue-activity";
import { PersonAvatar } from "./person-avatar";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export function IssueComments({
  issue,
  workspace,
  history,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
  history: IssueHistoryEntry[];
}) {
  const [comments, setComments] = useState<CloudComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [editing, setEditing] = useState<CloudComment | null>(null);
  const [deleting, setDeleting] = useState<CloudComment | null>(null);
  const sequence = useRef(0);
  const sender = useRef(createCommandSender());
  const postingSender = useRef(createCommandSender());
  const draft = useRef<HTMLTextAreaElement>(null);
  const writable = workspace.actor.role !== "viewer" && !issue.archived;
  const administrator = ["owner", "admin"].includes(workspace.actor.role);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++sequence.current;
      const result = await cloudRequest<{ comments: CloudComment[] }>(
        `issues/${issue.id}/comments${cursor ? `?before=${cursor}` : ""}`,
        { signal },
      );
      if (sequence.current === current) {
        setComments(result.comments);
        setConnectionError("");
        setLoading(false);
      }
    },
    [issue.id, cursor],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    async function poll() {
      try {
        if (!document.hidden) await refresh(abort.signal);
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [401, 403, 404].includes(reason.status)
        )
          setComments([]);
        setConnectionError((reason as Error).message);
        setLoading(false);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      sequence.current++;
    };
  }, [refresh]);
  const timeline = useMemo(() => {
    const changes = cursor ? [] : issueChangeEntries(history, workspace);
    return [
      ...comments.map((comment) => ({
        kind: "comment" as const,
        at: comment.createdAt,
        comment,
      })),
      ...changes.map((change) => ({
        kind: "change" as const,
        at: change.createdAt,
        change,
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));
  }, [comments, history, workspace, cursor]);
  return (
    <section className="cloud-comments" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="sr-only">
        Comments
      </h2>
      {writable && (
        <form
          className="cloud-comment-composer"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const body = formText(
              new FormData(event.currentTarget),
              "body",
            ).trim();
            if (!body) {
              setError("Enter a comment.");
              return;
            }
            setPending(true);
            setError("");
            void postingSender
              .current(`issues/${issue.id}/comments`, { body })
              .then(async () => {
                if (draft.current) draft.current.value = "";
                postingSender.current = createCommandSender();
                if (cursor) setCursor(null);
                else await refresh();
              })
              .catch((reason: Error) => setError(reason.message))
              .finally(() => setPending(false));
          }}
        >
          <label className="sr-only" htmlFor="new-comment">
            Comment
          </label>
          <Textarea
            ref={draft}
            id="new-comment"
            name="body"
            placeholder="Leave a comment…"
            required
            maxLength={20000}
            disabled={pending}
          />
          <Button
            type="submit"
            size="sm"
            disabled={pending || Boolean(connectionError)}
          >
            {pending ? "Posting…" : "Post comment"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {connectionError && (
        <p role="alert" className="cloud-error">
          {connectionError}
        </p>
      )}
      {loading && <p role="status">Loading comments…</p>}
      <ol className="cloud-comment-list">
        {timeline.map((entry) =>
          entry.kind === "change" ? (
            <li key={entry.change.id} className="cloud-activity-change">
              <PersonAvatar
                name={entry.change.actor}
                className="cloud-avatar-small"
              />
              <span>
                <strong>{entry.change.actor}</strong> {entry.change.description}
              </span>
              <time dateTime={entry.change.createdAt}>
                {relativeTime(entry.change.createdAt)}
              </time>
            </li>
          ) : (
            <CommentEntry
              key={entry.comment.id}
              comment={entry.comment}
              workspace={workspace}
              writable={writable}
              administrator={administrator}
              onEdit={(comment) => {
                sender.current = createCommandSender();
                setEditing(comment);
              }}
              onDelete={(comment) => {
                sender.current = createCommandSender();
                setDeleting(comment);
              }}
            />
          ),
        )}
      </ol>
      {(cursor || comments.length === 50) && (
        <div className="cloud-editor-actions">
          <Button
            variant="outline"
            disabled={!cursor || loading}
            onClick={() => setCursor(null)}
          >
            Latest comments
          </Button>
          <Button
            variant="outline"
            disabled={comments.length < 50 || loading}
            onClick={() => setCursor(comments.at(-1)!.id)}
          >
            Older comments
          </Button>
        </div>
      )}
      <FormDialog
        open={editing !== null}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
        title="Edit comment"
        submitLabel="Save comment"
        onSubmit={async (form) => {
          if (!editing) return;
          await sender.current(
            `comments/${editing.id}`,
            {
              kind: "edit",
              revision: editing.revision,
              body: formText(form, "body"),
            },
            "PATCH",
          );
          await refresh();
        }}
      >
        <Field label="Comment" htmlFor="edit-comment">
          <Textarea
            id="edit-comment"
            name="body"
            defaultValue={editing?.body}
            required
            maxLength={20000}
          />
        </Field>
      </FormDialog>
      <FormDialog
        open={deleting !== null}
        onOpenChange={(value) => {
          if (!value) setDeleting(null);
        }}
        title="Delete comment"
        submitLabel="Delete comment"
        onSubmit={async () => {
          if (!deleting) return;
          await sender.current(
            `comments/${deleting.id}`,
            { kind: "delete", revision: deleting.revision },
            "PATCH",
          );
          await refresh();
        }}
      >
        <p>
          The comment will be removed from this discussion. Its audit history
          will be retained.
        </p>
      </FormDialog>
    </section>
  );
}

function CommentEntry({
  comment,
  workspace,
  writable,
  administrator,
  onEdit,
  onDelete,
}: {
  comment: CloudComment;
  workspace: CloudWorkspace;
  writable: boolean;
  administrator: boolean;
  onEdit: (comment: CloudComment) => void;
  onDelete: (comment: CloudComment) => void;
}) {
  return (
          <li key={comment.id}>
            <div className="cloud-comment-heading">
              <PersonAvatar
                name={comment.author}
                className="cloud-avatar-small"
              />
              <strong>{comment.author}</strong>
              <time dateTime={comment.createdAt}>
                {relativeTime(comment.createdAt)}
              </time>
              {comment.revision > 1 && !comment.deleted && <span>Edited</span>}
            </div>
            <p
              className={
                comment.deleted ? "text-muted-foreground" : "cloud-comment-body"
              }
            >
              {comment.deleted ? "Comment deleted" : comment.body}
            </p>
            {!comment.deleted && (
              <div className="cloud-editor-actions">
                {writable && comment.authorId === workspace.actor.id && (
                  <Button variant="ghost" size="sm" onClick={() => onEdit(comment)}>
                    Edit comment
                  </Button>
                )}
                {((comment.authorId === workspace.actor.id &&
                  workspace.actor.role !== "viewer") ||
                  administrator) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(comment)}
                  >
                    Delete comment
                  </Button>
                )}
              </div>
            )}
          </li>
  );
}
