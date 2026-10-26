"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudComment } from "@/lib/cloud-comment-contract";
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

export function IssueComments({
  issue,
  workspace,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
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
  return (
    <section className="cloud-comments" aria-labelledby="comments-heading">
      <header className="cloud-page-header">
        <h2 id="comments-heading">Comments</h2>
      </header>
      {writable && (
        <form
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
          <Field label="Comment" htmlFor="new-comment">
            <Textarea
              ref={draft}
              id="new-comment"
              name="body"
              required
              maxLength={20000}
              disabled={pending}
            />
          </Field>
          <Button type="submit" disabled={pending || Boolean(connectionError)}>
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
        {comments.map((comment) => (
          <li key={comment.id}>
            <div className="cloud-comment-heading">
              <strong>{comment.author}</strong>
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleString()}
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
                  <Button
                    variant="ghost"
                    onClick={() => {
                      sender.current = createCommandSender();
                      setEditing(comment);
                    }}
                  >
                    Edit comment
                  </Button>
                )}
                {((comment.authorId === workspace.actor.id &&
                  workspace.actor.role !== "viewer") ||
                  administrator) && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      sender.current = createCommandSender();
                      setDeleting(comment);
                    }}
                  >
                    Delete comment
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
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
