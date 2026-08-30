import type { ProductSession } from "@machdoch/fleet-protocol";
import {
  Archive,
  Copy,
  GitBranch,
  PencilLine,
  Pin,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ProductCommandHandler } from "./product-runtime";

export function SessionHeader({
  session,
  onCommand,
}: {
  session: ProductSession;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [title, setTitle] = useState(session.title);
  const [renaming, setRenaming] = useState(false);
  const [tagDraft, setTagDraft] = useState(session.tags.join(", "));
  const sessionTags = session.tags.join(", ");

  useEffect(() => {
    setTitle(session.title);
    setRenaming(false);
    setTagDraft(sessionTags);
  }, [session.id, session.title, sessionTags]);

  const saveTitle = (): void => {
    const nextTitle = title.trim();
    setRenaming(false);
    if (!session.canRename || !nextTitle || nextTitle === session.title) {
      setTitle(session.title);
      return;
    }
    void onCommand({
      kind: "rename-session",
      sessionId: session.id,
      title: nextTitle,
    });
  };

  const saveTags = (): void => {
    const nextTags = [
      ...new Set(
        tagDraft
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ].slice(0, 24);
    setTagDraft(nextTags.join(", "));
    if (nextTags.join("\u0000") === session.tags.join("\u0000")) return;
    void onCommand({
      kind: "tag-session",
      sessionId: session.id,
      tags: nextTags,
    });
  };

  return (
    <header className="m-product-session-header">
      <div className="m-product-session-heading">
        {renaming ? (
          <input
            autoFocus
            className="m-product-session-title-input"
            value={title}
            aria-label="Session title"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveTitle();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTitle(session.title);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h1>{session.title}</h1>
        )}
      </div>
      <div className="m-product-session-actions">
        <input
          className="m-product-session-tags-input"
          value={tagDraft}
          aria-label="Session tags"
          placeholder="Tags"
          onChange={(event) => setTagDraft(event.target.value)}
          onBlur={saveTags}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveTags();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setTagDraft(session.tags.join(", "));
              event.currentTarget.blur();
            }
          }}
        />
        {session.canRename ? (
          <button
            type="button"
            className="m-product-icon-button"
            aria-label="Rename session"
            onClick={() => setRenaming(true)}
          >
            <PencilLine aria-hidden="true" />
          </button>
        ) : null}
        {session.canPin ? (
          <button
            type="button"
            className="m-product-icon-button"
            data-active={session.pinnedAt !== undefined}
            aria-label={
              session.pinnedAt !== undefined ? "Unpin session" : "Pin session"
            }
            onClick={() =>
              void onCommand({ kind: "pin-session", sessionId: session.id })
            }
          >
            <Pin aria-hidden="true" />
          </button>
        ) : null}
        {session.canDuplicate ? (
          <button
            type="button"
            className="m-product-icon-button"
            aria-label="Duplicate session"
            onClick={() =>
              void onCommand({
                kind: "duplicate-session",
                sessionId: session.id,
              })
            }
          >
            <Copy aria-hidden="true" />
          </button>
        ) : null}
        {session.canBranch ? (
          <button
            type="button"
            className="m-product-icon-button"
            aria-label="Branch session"
            onClick={() =>
              void onCommand({ kind: "branch-session", sessionId: session.id })
            }
          >
            <GitBranch aria-hidden="true" />
          </button>
        ) : null}
        {session.canArchive ? (
          <button
            type="button"
            className="m-product-icon-button"
            aria-label="Archive session"
            onClick={() =>
              void onCommand({
                kind: "archive-session",
                sessionId: session.id,
              })
            }
          >
            <Archive aria-hidden="true" />
          </button>
        ) : null}
        {session.canDelete ? (
          <button
            type="button"
            className="m-product-icon-button m-product-danger-button"
            aria-label="Delete session"
            onClick={() => {
              if (window.confirm(`Delete “${session.title}”?`)) {
                void onCommand({
                  kind: "delete-session",
                  sessionId: session.id,
                });
              }
            }}
          >
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
