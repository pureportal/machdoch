"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Columns3, Layers, LayoutList, Pencil, Search, X } from "lucide-react";
import { holderCan } from "@/lib/cloud-permissions";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { savedViewHref, type SavedView } from "@/lib/cloud-view-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import { parseIssueFilterConditions } from "@/lib/issue-filter-model";
import {
  completedWindows,
  parseIssueViewOptions,
} from "@/lib/issue-view-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest } from "./api-client";
import { favoritesChangedEvent } from "./events";
import { FavoriteButton } from "./favorite-button";
import {
  conditionOperator,
  conditionValues,
  filterFieldDefinitions,
} from "./issue-filter-fields";
import { issueGroupings, parseGrouping } from "./issue-grouping";
import { SaveViewDialog } from "./save-view-dialog";
import { useToast } from "./toast";

const scopes = { all: "All", mine: "Created by me", shared: "Shared" } as const;
type Scope = keyof typeof scopes;

function describeFilters(
  view: SavedView,
  workspace: CloudWorkspace,
  labels: CloudLabel[],
): string {
  const filters = view.filters;
  const teamId = filters.teamId ?? null;
  const definitions = filterFieldDefinitions(workspace, labels, teamId);
  const options = parseIssueViewOptions(
    new URLSearchParams(filters as Record<string, string>),
  );
  return [
    workspace.teams.find((team) => team.id === teamId)?.name,
    filters.scope === "mine" && "My issues",
    filters.group && `By ${issueGroupings[parseGrouping(filters.group)]}`,
    options.completed !== "all" &&
      `Completed: ${completedWindows[options.completed]}`,
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
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SavedView | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = views.filter(
    (view) =>
      (scope === "all" || (scope === "mine" ? view.owned : view.shared)) &&
      (!needle || view.name.toLowerCase().includes(needle)),
  );
  return (
    <>
      <header className="cloud-page-header">
        <h1>Views</h1>
        <Button asChild>
          <Link href="/cloud/issues">New view</Link>
        </Button>
      </header>
      {!views.length ? (
        <div className="cloud-empty">
          <Layers aria-hidden="true" />
          <p>No saved views yet.</p>
        </div>
      ) : (
        <>
          <div className="cloud-view-toolbar">
            <nav className="cloud-scope-tabs" aria-label="View scope">
              {(Object.keys(scopes) as Scope[]).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  aria-current={entry === scope ? "page" : undefined}
                  onClick={() => setScope(entry)}
                >
                  {scopes[entry]}
                </button>
              ))}
            </nav>
            <label className="cloud-issue-search">
              <Search size={14} aria-hidden="true" />
              <Input
                aria-label="Search views"
                placeholder="Search…"
                value={query}
                maxLength={80}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {!shown.length ? (
            <p className="cloud-empty-inline">No matching views.</p>
          ) : (
            <ul className="cloud-view-list" aria-label="Saved views">
              {shown.map((view) => {
                const Layout =
                  view.filters.view === "board" ? Columns3 : LayoutList;
                return (
                  <li key={view.id}>
                    <Layout size={15} aria-hidden="true" />
                    <Link href={savedViewHref(view)}>
                      <span>{view.name}</span>
                      <span className="cloud-view-filters">
                        {describeFilters(view, workspace, labels)}
                      </span>
                    </Link>
                    {view.shared && (
                      <span className="cloud-view-shared">Shared</span>
                    )}
                    <FavoriteButton
                      kind="view"
                      id={view.id}
                      initial={favorites.has(view.id)}
                    />
                    {view.owned && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit view ${view.name}`}
                        onClick={() => setEditing(view)}
                      >
                        <Pencil />
                      </Button>
                    )}
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
                              window.dispatchEvent(
                                new Event(favoritesChangedEvent),
                              );
                              router.refresh();
                            })
                            .catch((reason: Error) =>
                              toast(reason.message, "error"),
                            )
                        }
                      >
                        <X />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {editing && (
        <SaveViewDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          filters={editing.filters}
          writable={holderCan(workspace.actor, "issues.edit")}
          view={editing}
        />
      )}
    </>
  );
}
