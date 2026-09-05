import type { ProductSession } from "@machdoch/fleet-protocol";
import {
  Archive,
  Copy,
  GitBranch,
  PencilLine,
  Pin,
  Trash2,
  MoreHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
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
  const [editingTags, setEditingTags] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const pendingEdit = useRef<"title" | "tags" | null>(null);
  const cancelTagEdit = useRef(false);
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
    <header
      className="m-product-session-header"
      data-editing-tags={editingTags}
    >
      <div className="m-product-session-heading">
        {renaming ? (
          <input
            ref={titleRef}
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
          ref={tagsRef}
          className="m-product-session-tags-input"
          value={tagDraft}
          aria-label="Session tags"
          placeholder="Tags"
          onChange={(event) => setTagDraft(event.target.value)}
          onBlur={() => {
            if (!cancelTagEdit.current) saveTags();
            cancelTagEdit.current = false;
            setEditingTags(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveTags();
              setEditingTags(false);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelTagEdit.current = true;
              setTagDraft(session.tags.join(", "));
              event.currentTarget.blur();
            }
          }}
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              ref={menuTriggerRef}
              type="button"
              className="m-product-icon-button m-product-session-menu-toggle"
              aria-label="Session actions"
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal
            container={menuTriggerRef.current?.closest<HTMLElement>(
              ".machdoch-product",
            )}
          >
            <DropdownMenu.Content
              className="m-product-session-menu"
              align="end"
              sideOffset={6}
              collisionPadding={8}
              onCloseAutoFocus={(event) => {
                const target = pendingEdit.current;
                if (!target) return;
                event.preventDefault();
                pendingEdit.current = null;
                if (target === "title") setRenaming(true);
                else setEditingTags(true);
                requestAnimationFrame(() =>
                  (target === "title" ? titleRef : tagsRef).current?.focus(),
                );
              }}
            >
              {session.canRename ? (
                <DropdownMenu.Item
                  onSelect={() => {
                    pendingEdit.current = "title";
                  }}
                >
                  <PencilLine />
                  Rename session
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item
                onSelect={() => {
                  pendingEdit.current = "tags";
                }}
              >
                Edit tags
              </DropdownMenu.Item>
              {session.canPin ? (
                <DropdownMenu.Item
                  onSelect={() =>
                    void onCommand({
                      kind: "pin-session",
                      sessionId: session.id,
                    })
                  }
                >
                  <Pin />
                  {session.pinnedAt !== undefined
                    ? "Unpin session"
                    : "Pin session"}
                </DropdownMenu.Item>
              ) : null}
              {session.canDuplicate ? (
                <DropdownMenu.Item
                  onSelect={() =>
                    void onCommand({
                      kind: "duplicate-session",
                      sessionId: session.id,
                    })
                  }
                >
                  <Copy />
                  Duplicate session
                </DropdownMenu.Item>
              ) : null}
              {session.canBranch ? (
                <DropdownMenu.Item
                  onSelect={() =>
                    void onCommand({
                      kind: "branch-session",
                      sessionId: session.id,
                    })
                  }
                >
                  <GitBranch />
                  Branch session
                </DropdownMenu.Item>
              ) : null}
              {session.canArchive ? (
                <DropdownMenu.Item
                  onSelect={() =>
                    void onCommand({
                      kind: "archive-session",
                      sessionId: session.id,
                    })
                  }
                >
                  <Archive />
                  Archive session
                </DropdownMenu.Item>
              ) : null}
              {session.canDelete ? (
                <DropdownMenu.Item
                  data-destructive="true"
                  onSelect={() => {
                    if (window.confirm(`Delete "${session.title}"?`))
                      void onCommand({
                        kind: "delete-session",
                        sessionId: session.id,
                      });
                  }}
                >
                  <Trash2 />
                  Delete session
                </DropdownMenu.Item>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
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
