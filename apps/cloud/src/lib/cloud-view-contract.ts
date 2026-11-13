import { z } from "zod";
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

export const savedViewInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  filters: z.partialRecord(z.enum(viewFilterKeys), z.string().max(2000)),
  shared: z.boolean(),
});
export type SavedViewInput = z.infer<typeof savedViewInputSchema>;

export interface SavedView {
  id: string;
  name: string;
  filters: SavedViewInput["filters"];
  shared: boolean;
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
