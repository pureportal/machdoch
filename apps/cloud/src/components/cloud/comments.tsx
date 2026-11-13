"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { LoadingState } from "@machdoch/product-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronsUpDown } from "lucide-react";
import { CloudMarkdown } from "./cloud-markdown";
import type { CloudComment } from "@/lib/cloud-comment-contract";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudIssueRelation } from "@/lib/cloud-relation-contract";
import type { IssueSubscription } from "@/lib/cloud-favorite-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { MarkdownTextarea } from "./markdown-textarea";
import { uploadAttachment } from "./attachment-upload";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";
import {
  collapseActivity,
  issueChangeEntries,
  relationChangeEntries,
  type ActivityEntry,
  type IssueHistoryEntry,
} from "./issue-activity";
import { PersonAvatar } from "./person-avatar";
import { RelativeTime } from "./relative-time";

export function IssueComments({
  issue,
  workspace,
  history,
  relations,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
  history: IssueHistoryEntry[];
  relations: CloudIssueRelation[];
}) {
  const [comments, setComments] = useState<CloudComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [editing, setEditing] = useState<CloudComment | null>(null);
  const [deleting, setDeleting] = useState<CloudComment | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [subscription, setSubscription] = useState<IssueSubscription | null>(
    null,
  );
  const sequence = useRef(0);
  const sender = useRef(createCommandSender());
  const postingSender = useRef(createCommandSender());
  const draft = useRef<HTMLTextAreaElement>(null);
  const writable =
    holderCan(workspace.actor, "comments.write") && !issue.archived;
  const administrator = holderCan(workspace.actor, "teams.manage");
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
  useEffect(() => {
    const abort = new AbortController();
    void cloudRequest<IssueSubscription>(`issues/${issue.id}/subscription`, {
      signal: abort.signal,
    })
      .then(setSubscription)
      .catch(() => undefined);
    return () => abort.abort();
  }, [issue.id, comments.length, issue.assigneeId]);
  const rows = useMemo(() => {
    const changes = cursor
      ? []
      : [
          ...issueChangeEntries(history, workspace),
          ...relationChangeEntries(relations),
        ];
    const entries: ActivityEntry<CloudComment>[] = [
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
    ].sort((left, right) => left.at.localeCompare(right.at));
    return collapseActivity(entries, expanded);
  }, [comments, history, relations, workspace, cursor, expanded]);
  return (
    <section className="cloud-activity" aria-labelledby="activity-heading">
      <header className="cloud-activity-header">
        <h2 id="activity-heading">Activity</h2>
        {subscription && holderCan(workspace.actor, "comments.write") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void cloudRequest<IssueSubscription>(
                `issues/${issue.id}/subscription`,
                {
                  method: "POST",
                  body: { subscribed: !subscription.subscribed },
                },
              )
                .then(setSubscription)
                .catch((reason: Error) => setError(reason.message))
            }
          >
            {subscription.subscribed ? "Unsubscribe" : "Subscribe"}
          </Button>
        )}
        {subscription && subscription.subscribers.length > 0 && (
          <span
            className="cloud-activity-subscribers"
            title={subscription.subscribers
              .map((entry) => entry.name)
              .join(", ")}
          >
            {subscription.subscribers.slice(0, 4).map((entry) => (
              <PersonAvatar
                key={entry.id}
                name={entry.name}
                className="cloud-avatar-small"
              />
            ))}
          </span>
        )}
      </header>
      {comments.length === 50 && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => setCursor(comments.at(-1)!.id)}
        >
          Older comments
        </Button>
      )}
      {cursor && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => setCursor(null)}
        >
          Latest activity
        </Button>
      )}
      <ol className="cloud-activity-list">
        {rows.map((row) =>
          row.kind === "collapsed" ? (
            <li key={row.id} className="cloud-activity-change">
              <ChevronsUpDown size={13} aria-hidden="true" />
              <button
                type="button"
                className="cloud-activity-expand"
                onClick={() =>
                  setExpanded((current) => new Set(current).add(row.id))
                }
              >
                Show {row.changes.length} events
              </button>
            </li>
          ) : row.kind === "change" ? (
            <li key={row.change.id} className="cloud-activity-change">
              <PersonAvatar
                name={row.change.actor}
                className="cloud-avatar-tiny"
              />
              <span>
                <strong>{row.change.actor}</strong> {row.change.description}
              </span>
              <RelativeTime value={row.change.createdAt} />
            </li>
          ) : (
            <CommentEntry
              key={row.comment.id}
              comment={row.comment}
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
      {loading && !comments.length && (
        <LoadingState label="Loading activity…" compact />
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
          <MarkdownTextarea
            ref={draft}
            id="new-comment"
            name="body"
            placeholder="Leave a comment…"
            required
            maxLength={20000}
            disabled={pending}
            uploadFile={(file) => uploadAttachment(file, issue.id)}
          />
          <Button
            type="submit"
            size="icon"
            className="cloud-comment-send"
            aria-label="Post comment"
            disabled={pending || Boolean(connectionError)}
          >
            <ArrowUp />
          </Button>
        </form>
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
          <MarkdownTextarea
            id="edit-comment"
            name="body"
            defaultValue={editing?.body}
            required
            maxLength={20000}
            uploadFile={(file) => uploadAttachment(file, issue.id)}
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
  const own = comment.authorId === workspace.actor.id;
  return (
    <li className="cloud-activity-comment">
      <div className="cloud-comment-heading">
        <PersonAvatar name={comment.author} className="cloud-avatar-small" />
        <strong>{comment.author}</strong>
        <RelativeTime value={comment.createdAt} />
        {comment.revision > 1 && !comment.deleted && <span>Edited</span>}
        {!comment.deleted && (
          <span className="cloud-comment-actions">
            {writable && own && (
              <Button variant="ghost" size="sm" onClick={() => onEdit(comment)}>
                Edit
              </Button>
            )}
            {((own && holderCan(workspace.actor, "comments.write")) ||
              administrator) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(comment)}
              >
                Delete
              </Button>
            )}
          </span>
        )}
      </div>
      {comment.deleted ? (
        <p className="text-muted-foreground">Comment deleted</p>
      ) : (
        <CloudMarkdown className="cloud-comment-body" content={comment.body} />
      )}
    </li>
  );
}
