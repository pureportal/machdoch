import { z } from "zod";
import { cloudId } from "./cloud-contract";
import { issueFilterKeys } from "./issue-filter-model";

export const viewFilterKeys = [
  "scope",
  "view",
  "group",
  "sort",
  "order",
  "density",
  "completed",
  "subIssues",
  "empty",
  "hide",
  "teamId",
  ...issueFilterKeys,
  "planning",
  "query",
  "archived",
] as const;
export type ViewFilterKey = (typeof viewFilterKeys)[number];

export const savedViewParameter = "savedView";

export const savedViewScopes = ["personal", "team", "workspace"] as const;
export type SavedViewScope = (typeof savedViewScopes)[number];

export const savedViewIcons = [
  "bookmark",
  "layers",
  "star",
  "flag",
  "bug",
  "rocket",
  "zap",
  "target",
  "inbox",
  "eye",
] as const;
export type SavedViewIcon = (typeof savedViewIcons)[number];

export const maximumPinnedViews = 8;

export const savedViewInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    icon: z.enum(savedViewIcons),
    scope: z.enum(savedViewScopes),
    teamId: cloudId.nullable(),
    filters: z.partialRecord(z.enum(viewFilterKeys), z.string().max(2000)),
  })
  .refine((input) => (input.scope === "team") === (input.teamId !== null), {
    message: "Choose a team for team views.",
    path: ["teamId"],
  });
export type SavedViewInput = z.infer<typeof savedViewInputSchema>;

export const pinnedViewsInputSchema = z.strictObject({
  viewIds: z.array(cloudId).max(maximumPinnedViews),
});

export interface SavedView {
  id: string;
  name: string;
  description: string;
  icon: SavedViewIcon;
  scope: SavedViewScope;
  teamId: string | null;
  filters: SavedViewInput["filters"];
  owned: boolean;
}

export function viewFilters(
  search: Pick<URLSearchParams, "get">,
): SavedViewInput["filters"] {
  return Object.fromEntries(
    viewFilterKeys.flatMap((key) => {
      const value = search.get(key);
      return value === null ? [] : [[key, value]];
    }),
  );
}

export function viewChanged(
  view: Pick<SavedView, "filters">,
  search: Pick<URLSearchParams, "get">,
): boolean {
  const current = viewFilters(search);
  return viewFilterKeys.some(
    (key) => (view.filters[key] ?? null) !== (current[key] ?? null),
  );
}

export function savedViewHref(view: Pick<SavedView, "id" | "filters">): string {
  const query = new URLSearchParams(view.filters as Record<string, string>);
  query.set(savedViewParameter, view.id);
  return `/cloud/issues?${query}`;
}

export interface SavedViewDraft {
  name: string;
  description: string;
}

export function savedViewUpdate(
  view: SavedView,
  draft: SavedViewDraft,
  filters: SavedViewInput["filters"],
): SavedViewInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    icon: view.icon,
    scope: view.scope,
    teamId: view.teamId,
    filters,
  };
}

export function savedViewDraftChanged(
  view: SavedView,
  draft: SavedViewDraft,
  search: Pick<URLSearchParams, "get">,
): boolean {
  return (
    draft.name.trim() !== view.name ||
    draft.description.trim() !== view.description ||
    viewChanged(view, search)
  );
}

export function viewPinnable(
  view: Pick<SavedView, "scope" | "teamId">,
  teamId: string,
): boolean {
  return (
    view.scope === "workspace" ||
    (view.scope === "team" && view.teamId === teamId)
  );
}

export function togglePinnedView(
  pinnedIds: readonly string[],
  viewId: string,
): string[] {
  return pinnedIds.includes(viewId)
    ? pinnedIds.filter((id) => id !== viewId)
    : [...pinnedIds, viewId].slice(-maximumPinnedViews);
}

export function pinnedViewHref(
  view: Pick<SavedView, "id" | "filters">,
  teamId: string,
): string {
  return savedViewHref({
    id: view.id,
    filters: { ...view.filters, teamId: view.filters.teamId ?? teamId },
  });
}

export function withoutPinnedTeam(
  view: Pick<SavedView, "filters">,
  filters: SavedViewInput["filters"],
  pinnedTeamId: string | null,
): SavedViewInput["filters"] {
  if (view.filters.teamId || !pinnedTeamId || filters.teamId !== pinnedTeamId)
    return filters;
  const { teamId: _teamId, ...rest } = filters;
  return rest;
}
