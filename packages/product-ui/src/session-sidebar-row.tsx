import type { ProductCommand, ProductSession } from "@machdoch/fleet-protocol";
import {
  Archive,
  ArchiveRestore,
  ArrowUpToLine,
  CircleDashed,
  Copy,
  Ellipsis,
  Pin,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useRef } from "react";
import { DropdownMenu } from "radix-ui";
import { formatTimestamp } from "./format";
import { sessionStatusFilters } from "./session-sidebar-filters";
import {
  getSessionRowActions,
  type SessionRowActionId,
} from "./session-sidebar-actions";

const statusIconById = new Map<string, LucideIcon>(
  sessionStatusFilters.map(({ id, icon }) => [id, icon]),
);

const rowActionPresentation: Record<
  SessionRowActionId,
  { label: string; icon: LucideIcon }
> = {
  "reset-time": { label: "Reset Time", icon: RotateCcw },
  "move-to-top": { label: "Move To Top", icon: ArrowUpToLine },
  pin: { label: "Pin", icon: Pin },
  unpin: { label: "Unpin", icon: Pin },
  duplicate: { label: "Duplicate", icon: Copy },
  archive: { label: "Archive", icon: Archive },
  restore: { label: "Restore", icon: ArchiveRestore },
  delete: { label: "Delete", icon: Trash2 },
};

const getWorkspaceLabel = (workspace: string | undefined): string =>
  workspace?.split(/[\\/]/u).filter(Boolean).at(-1) ??
  workspace ??
  "No workspace";

export function SessionSidebarRow({
  session,
  active,
  firstUnpinned,
  pending,
  onCommand,
}: {
  session: ProductSession;
  active: boolean;
  firstUnpinned: boolean;
  pending: boolean;
  onCommand: (command: ProductCommand) => void;
}): React.ReactElement {
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const StatusIcon = statusIconById.get(session.status) ?? CircleDashed;
  const archived = session.archivedAt !== undefined;
  const unread = session.unread === true && !active && !archived;
  const actions = getSessionRowActions(session);
  const [primaryTag, ...extraTags] = session.tags;
  return (
    <>
      {firstUnpinned ? (
        <div className="m-product-session-divider">Unpinned</div>
      ) : null}
      <div
        className="m-product-session-item"
        data-unpinned-divider={firstUnpinned || undefined}
        data-active={active}
        data-unread={unread || undefined}
        data-archived={archived || undefined}
        data-has-actions={actions.length > 0 || undefined}
      >
        <button
          type="button"
          className="m-product-session-open"
          aria-current={active ? "page" : undefined}
          disabled={pending}
          onClick={() =>
            onCommand({ kind: "activate-session", sessionId: session.id })
          }
        >
          <span className="m-product-session-title-row">
            <span
              className="m-product-session-status"
              data-state={session.status}
              aria-label={`Status: ${session.status}`}
            >
              <StatusIcon aria-hidden="true" />
            </span>
            {session.pinnedAt !== undefined ? (
              <Pin className="m-product-session-pin" aria-label="Pinned" />
            ) : null}
            {archived ? (
              <Archive
                className="m-product-session-archived"
                aria-label="Archived"
              />
            ) : null}
            <span className="m-product-session-title">{session.title}</span>
            {unread ? (
              <span className="m-product-visually-hidden">New reply ready</span>
            ) : null}
          </span>
          <span className="m-product-session-meta">
            <span className="m-product-session-meta-label">
              {primaryTag ? (
                <span className="m-product-session-tag">
                  {extraTags.length > 0
                    ? `${primaryTag} +${extraTags.length}`
                    : primaryTag}
                </span>
              ) : null}
              <span>
                {session.provider || "Provider"} ·{" "}
                {getWorkspaceLabel(session.workspace)}
              </span>
            </span>
            <span>{formatTimestamp(session.updatedAt)}</span>
          </span>
        </button>
        {actions.length > 0 ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                ref={menuTrigger}
                type="button"
                className="m-product-session-row-menu"
                aria-label={`Session actions for ${session.title}`}
                disabled={pending}
              >
                <Ellipsis aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal
              container={menuTrigger.current?.closest<HTMLElement>(
                ".machdoch-product",
              )}
            >
              <DropdownMenu.Content
                className="m-product-session-menu"
                align="end"
                sideOffset={6}
                collisionPadding={8}
              >
                {actions.map((action) => {
                  const { label, icon: Icon } = rowActionPresentation[action.id];
                  return (
                    <DropdownMenu.Item
                      key={action.id}
                      disabled={pending}
                      data-destructive={action.id === "delete" || undefined}
                      onSelect={() => onCommand(action.command)}
                    >
                      <Icon aria-hidden="true" />
                      {label}
                    </DropdownMenu.Item>
                  );
                })}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
    </>
  );
}
