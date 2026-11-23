"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Pencil, Pin, PinOff, X } from "lucide-react";
import {
  pinnedViewHref,
  savedViewDraftChanged,
  savedViewHref,
  savedViewUpdate,
  togglePinnedView,
  viewPinnable,
  withoutPinnedTeam,
  type SavedView,
  type SavedViewInput,
} from "@/lib/cloud-view-contract";
import { Button } from "@/components/ui/button";
import { createCommandSender } from "./api-client";
import { SaveViewDialog } from "./save-view-dialog";
import { SavedViewIcon } from "./saved-view-icon";
import { useToast } from "./toast";

export function IssueViewBar({
  view,
  filters,
  writable,
  teams,
  teamId,
  pinnedIds,
}: {
  view: SavedView;
  filters: SavedViewInput["filters"];
  writable: boolean;
  teams: { id: string; name: string }[];
  teamId: string | null;
  pinnedIds: string[] | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const pinSender = useRef(createCommandSender());
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    name: view.name,
    description: view.description,
  });
  useEffect(
    () => setDraft({ name: view.name, description: view.description }),
    [view.name, view.description],
  );
  const pinned = pinnedIds?.includes(view.id) ?? false;
  const effectiveFilters = withoutPinnedTeam(
    view,
    filters,
    pinned ? teamId : null,
  );
  const current = new URLSearchParams(
    effectiveFilters as Record<string, string>,
  );
  const changed = savedViewDraftChanged(view, draft, current);
  const canPin =
    writable &&
    teamId !== null &&
    pinnedIds !== null &&
    viewPinnable(view, teamId);

  function save() {
    setSaving(true);
    void sender
      .current(
        `views/${view.id}`,
        savedViewUpdate(view, draft, effectiveFilters),
        "PATCH",
      )
      .then(() => {
        sender.current = createCommandSender();
        toast("View updated");
        router.refresh();
      })
      .catch((reason: Error) => toast(reason.message, "error"))
      .finally(() => setSaving(false));
  }

  function cancel() {
    setDraft({ name: view.name, description: view.description });
    router.push(
      pinned && teamId ? pinnedViewHref(view, teamId) : savedViewHref(view),
    );
  }

  function togglePin() {
    void pinSender
      .current(
        `teams/${teamId}/pinned-views`,
        { viewIds: togglePinnedView(pinnedIds!, view.id) },
        "PATCH",
      )
      .then(() => {
        pinSender.current = createCommandSender();
        router.refresh();
      })
      .catch((reason: Error) => toast(reason.message, "error"));
  }

  return (
    <div className="cloud-view-bar">
      <SavedViewIcon icon={view.icon} />
      {view.owned ? (
        <>
          <input
            className="cloud-view-bar-name"
            aria-label="View name"
            value={draft.name}
            maxLength={80}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
          <input
            className="cloud-view-bar-description"
            aria-label="View description"
            placeholder="Description"
            value={draft.description}
            maxLength={500}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
          />
        </>
      ) : (
        <>
          <strong>{view.name}</strong>
          {view.description && (
            <span className="cloud-view-bar-text">{view.description}</span>
          )}
        </>
      )}
      <span className="cloud-view-bar-spacer" />
      {changed && (
        <>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          {view.owned && (
            <Button
              size="sm"
              variant="outline"
              disabled={saving || !draft.name.trim()}
              onClick={save}
            >
              Save
            </Button>
          )}
        </>
      )}
      {canPin && (
        <Button
          size="icon"
          variant="ghost"
          aria-label={pinned ? "Unpin from team" : "Pin to team"}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          {pinned ? <PinOff /> : <Pin />}
        </Button>
      )}
      {view.owned && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Edit view"
          onClick={() => setEditing(true)}
        >
          <Pencil />
        </Button>
      )}
      <Button size="icon" variant="ghost" aria-label="Close view" asChild>
        <Link href="/cloud/issues">
          <X />
        </Link>
      </Button>
      <SaveViewDialog
        key={view.id}
        open={editing}
        onOpenChange={setEditing}
        filters={view.filters}
        writable={writable}
        teams={teams}
        view={view}
      />
    </div>
  );
}
