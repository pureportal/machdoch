import type { ProductSession } from "@machdoch/fleet-protocol";
import {
  Archive,
  ArchiveRestore,
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
import { ProductModal } from "./product-modal";

export function SessionHeader({
  session,
  pending,
  onCommand,
}: {
  session: ProductSession;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [title, setTitle] = useState(session.title);
  const [renaming, setRenaming] = useState(false);
  const [tagDraft, setTagDraft] = useState(session.tags.join(", "));
  const [editingTags, setEditingTags] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const pendingEdit = useRef<"title" | "tags" | "delete" | null>(null);
  const cancelTagEdit = useRef(false);
  const cancelTitleEdit = useRef(false);
  const savingEdit = useRef(false);
  const sessionTags = session.tags.join(", ");
  const archiveLabel =
    session.archivedAt !== undefined ? "Restore session" : "Archive session";
  const ArchiveIcon =
    session.archivedAt !== undefined ? ArchiveRestore : Archive;

  useEffect(() => {
    if (!renaming) setTitle(session.title);
  }, [session.title, renaming]);
  useEffect(() => {
    if (!editingTags) setTagDraft(sessionTags);
  }, [sessionTags, editingTags]);

  const saveTitle = (): void => {
    if (pending || savingEdit.current) return;
    const nextTitle = title.trim();
    if (
      cancelTitleEdit.current ||
      !session.canRename ||
      !nextTitle ||
      nextTitle === session.title
    ) {
      cancelTitleEdit.current = false;
      setTitle(session.title);
      setRenaming(false);
      return;
    }
    savingEdit.current = true;
    void onCommand({
      kind: "rename-session",
      sessionId: session.id,
      title: nextTitle,
    }).then((saved) => {
      savingEdit.current = false;
      if (saved) setRenaming(false);
    });
  };

  const saveTags = (): void => {
    if (pending || savingEdit.current) return;
    const nextTags = [
      ...new Set(
        tagDraft
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ].slice(0, 24);
    setTagDraft(nextTags.join(", "));
    if (nextTags.join("\u0000") === session.tags.join("\u0000")) {
      setEditingTags(false);
      return;
    }
    savingEdit.current = true;
    void onCommand({
      kind: "tag-session",
      sessionId: session.id,
      tags: nextTags,
    }).then((saved) => {
      savingEdit.current = false;
      if (saved) setEditingTags(false);
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
            readOnly={pending}
            aria-label="Session title"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              if (pending || savingEdit.current) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancelTitleEdit.current = true;
                event.currentTarget.blur();
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
          readOnly={pending}
          aria-label="Session tags"
          placeholder="Tags"
          onFocus={() => setEditingTags(true)}
          onChange={(event) => setTagDraft(event.target.value)}
          onBlur={() => {
            if (!cancelTagEdit.current) saveTags();
            else setEditingTags(false);
            cancelTagEdit.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (pending || savingEdit.current) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
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
              disabled={pending}
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
                if (target === "delete") {
                  menuTriggerRef.current?.focus();
                  setDeleteError(null);
                  setDeleteOpen(true);
                  return;
                }
                if (target === "title") setRenaming(true);
                else setEditingTags(true);
                requestAnimationFrame(() =>
                  (target === "title" ? titleRef : tagsRef).current?.focus(),
                );
              }}
            >
              {session.canRename ? (
                <DropdownMenu.Item
                  disabled={pending}
                  onSelect={() => {
                    pendingEdit.current = "title";
                  }}
                >
                  <PencilLine />
                  Rename session
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item
                disabled={pending}
                onSelect={() => {
                  pendingEdit.current = "tags";
                }}
              >
                Edit tags
              </DropdownMenu.Item>
              {session.canPin ? (
                <DropdownMenu.Item
                  disabled={pending}
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
                  disabled={pending}
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
                  disabled={pending}
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
                  disabled={pending}
                  onSelect={() =>
                    void onCommand({
                      kind: "archive-session",
                      sessionId: session.id,
                    })
                  }
                >
                  <ArchiveIcon />
                  {archiveLabel}
                </DropdownMenu.Item>
              ) : null}
              {session.canDelete ? (
                <DropdownMenu.Item
                  disabled={pending}
                  data-destructive="true"
                  onSelect={() => {
                    pendingEdit.current = "delete";
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
            disabled={pending}
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
            disabled={pending}
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
            disabled={pending}
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
            disabled={pending}
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
            aria-label={archiveLabel}
            disabled={pending}
            onClick={() =>
              void onCommand({
                kind: "archive-session",
                sessionId: session.id,
              })
            }
          >
            <ArchiveIcon aria-hidden="true" />
          </button>
        ) : null}
        {session.canDelete ? (
          <button
            type="button"
            className="m-product-icon-button m-product-danger-button"
            aria-label="Delete session"
            disabled={pending}
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {deleteOpen ? (
        <ProductModal
          title={`Delete ${session.title}?`}
          description="This deletes all messages in the session."
          dismissible={!deleting}
          onClose={() => setDeleteOpen(false)}
        >
          {deleteError ? (
            <p className="m-product-inline-error" role="alert">
              {deleteError}
            </p>
          ) : null}
          <div>
            <button
              type="button"
              className="m-product-secondary-button"
              disabled={deleting}
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="m-product-secondary-button m-product-danger-button"
              disabled={pending || deleting}
              onClick={() => {
                setDeleting(true);
                setDeleteError(null);
                void onCommand({
                  kind: "delete-session",
                  sessionId: session.id,
                })
                  .then((deleted) => {
                    if (deleted) setDeleteOpen(false);
                    else
                      setDeleteError(
                        "Session could not be deleted. Try again.",
                      );
                  })
                  .finally(() => setDeleting(false));
              }}
            >
              Delete session
            </button>
          </div>
        </ProductModal>
      ) : null}
    </header>
  );
}
