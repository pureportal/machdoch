"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bookmark, Layers, X } from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { savedViewHref, type SavedView } from "@/lib/cloud-view-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import { parseIssueFilterConditions } from "@/lib/issue-filter-model";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { favoritesChangedEvent } from "./events";
import { FavoriteButton } from "./favorite-button";
import {
  conditionOperator,
  conditionValues,
  filterFieldDefinitions,
} from "./issue-filter-fields";
import { useToast } from "./toast";

function describeFilters(
  view: SavedView,
  workspace: CloudWorkspace,
  labels: CloudLabel[],
): string {
  const filters = view.filters;
  const teamId = filters.teamId ?? null;
  const definitions = filterFieldDefinitions(workspace, labels, teamId);
  return [
    filters.view === "board" ? "Board" : "List",
    workspace.teams.find((team) => team.id === teamId)?.name,
    filters.scope === "mine" && "My issues",
    ...parseIssueFilterConditions(filters).map((condition) => {
      const definition = definitions.find(
        (entry) => entry.field === condition.field,
      );
      return `${definition?.label ?? condition.field} ${conditionOperator(condition)} ${conditionValues(condition, definition)}`;
    }),
    filters.query && `“${filters.query}”`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SavedViewList({
  views,
  labels,
  favorites,
  workspace,
}: {
  views: SavedView[];
  labels: CloudLabel[];
  favorites: ReadonlySet<string>;
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
              <Link href={savedViewHref(view)}>
                <span>{view.name}</span>
                <span className="cloud-view-filters">
                  {describeFilters(view, workspace, labels)}
                </span>
              </Link>
              {view.shared && <span className="cloud-view-shared">Shared</span>}
              <FavoriteButton
                kind="view"
                id={view.id}
                initial={favorites.has(view.id)}
              />
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
                      .then(() => {
                        window.dispatchEvent(new Event(favoritesChangedEvent));
                        router.refresh();
                      })
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
