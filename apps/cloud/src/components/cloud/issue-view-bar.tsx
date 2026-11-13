"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { Bookmark, Pencil, X } from "lucide-react";
import {
  savedViewHref,
  viewChanged,
  type SavedView,
  type SavedViewInput,
} from "@/lib/cloud-view-contract";
import { Button } from "@/components/ui/button";
import { createCommandSender } from "./api-client";
import { SaveViewDialog } from "./save-view-dialog";
import { useToast } from "./toast";

export function IssueViewBar({
  view,
  filters,
  writable,
}: {
  view: SavedView;
  filters: SavedViewInput["filters"];
  writable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const search = useSearchParams();
  const current = new URLSearchParams(search);
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined) current.set(key, value);
  const changed = viewChanged(view, current);
  return (
    <div className="cloud-view-bar">
      <Bookmark size={14} aria-hidden="true" />
      <strong>{view.name}</strong>
      {changed && (
        <>
          <Link className="cloud-view-bar-reset" href={savedViewHref(view)}>
            Reset
          </Link>
          {view.owned && (
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void sender
                  .current(
                    `views/${view.id}`,
                    { name: view.name, shared: view.shared, filters },
                    "PATCH",
                  )
                  .then(() => {
                    sender.current = createCommandSender();
                    toast("View updated");
                    router.refresh();
                  })
                  .catch((reason: Error) => toast(reason.message, "error"))
                  .finally(() => setSaving(false));
              }}
            >
              Save changes
            </Button>
          )}
        </>
      )}
      <span className="cloud-view-bar-spacer" />
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
        open={editing}
        onOpenChange={setEditing}
        filters={view.filters}
        writable={writable}
        view={view}
      />
    </div>
  );
}
