import { z } from "zod";
import { issueFilterKeys } from "./issue-filter-model";

export const viewFilterKeys = [
  "scope",
  "view",
  "group",
  "sort",
  "order",
  "teamId",
  ...issueFilterKeys,
  "planning",
  "query",
  "archived",
] as const;

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

export function savedViewHref(view: Pick<SavedView, "filters">): string {
  const query = new URLSearchParams(
    view.filters as Record<string, string>,
  ).toString();
  return `/cloud/issues${query ? `?${query}` : ""}`;
}
