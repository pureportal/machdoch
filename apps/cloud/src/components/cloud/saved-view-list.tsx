"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bookmark, Layers, X } from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { SavedView } from "@/lib/cloud-view-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { useToast } from "./toast";

function viewHref(view: SavedView): string {
  const query = new URLSearchParams(
    view.filters as Record<string, string>,
  ).toString();
  return `/cloud/issues${query ? `?${query}` : ""}`;
}

function describeFilters(view: SavedView, workspace: CloudWorkspace): string {
  const filters = view.filters;
  const named = <T extends { id: string; name: string }>(
    entries: T[],
    id: string | undefined,
  ) => (id ? entries.find((entry) => entry.id === id)?.name : undefined);
  return [
    filters.view === "board" ? "Board" : "List",
    named(workspace.teams, filters.teamId),
    named(workspace.projects, filters.projectId),
    named(workspace.cycles, filters.cycleId),
    named(workspace.members, filters.assigneeId),
    filters.priority && `${filters.priority} priority`,
    filters.query && `“${filters.query}”`,
    filters.scope === "mine" && "My issues",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SavedViewList({
  views,
  workspace,
}: {
  views: SavedView[];
  workspace: CloudWorkspace;
}) {
  const router = useRouter();
  const toast = useToast();
  return (
    <>
      <header className="cloud-page-header">
        <h1>Views</h1>
      </header>
      {!views.length ? (
        <div className="cloud-empty">
          <Layers aria-hidden="true" />
          <p>No saved views yet.</p>
          <Link className="underline" href="/cloud/issues">
            Open issues
          </Link>
        </div>
      ) : (
        <ul className="cloud-view-list" aria-label="Saved views">
          {views.map((view) => (
            <li key={view.id}>
              <Bookmark size={15} aria-hidden="true" />
              <Link href={viewHref(view)}>
                <span>{view.name}</span>
                <span className="cloud-view-filters">
                  {describeFilters(view, workspace)}
                </span>
              </Link>
              {view.shared && <span className="cloud-view-shared">Shared</span>}
              {view.owned && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove view ${view.name}`}
                  onClick={() =>
                    void cloudRequest(`views/${view.id}/remove`, {
                      method: "POST",
                      body: {},
                    })
                      .then(() => router.refresh())
                      .catch((reason: Error) => toast(reason.message, "error"))
                  }
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
