import { z } from "zod";
import { cloudId } from "./cloud-contract";

export const favoriteKinds = ["issue", "project", "cycle", "view"] as const;
export type FavoriteKind = (typeof favoriteKinds)[number];
export const favoriteInputSchema = z.strictObject({
  kind: z.enum(favoriteKinds),
  id: cloudId,
  favorite: z.boolean(),
});
export type FavoriteInput = z.infer<typeof favoriteInputSchema>;
export interface CloudFavorite {
  kind: FavoriteKind;
  id: string;
  label: string;
  state: string | null;
}
export const subscriptionInputSchema = z.strictObject({
  subscribed: z.boolean(),
});
export interface IssueSubscription {
  subscribed: boolean;
  subscribers: { id: string; name: string }[];
}
const favoritePaths: Record<FavoriteKind, string> = {
  issue: "issues",
  project: "projects",
  cycle: "cycles",
  view: "views",
};

export function favoriteHref(
  favorite: Pick<CloudFavorite, "kind" | "id">,
): string {
  return `/cloud/${favoritePaths[favorite.kind]}/${favorite.id}`;
}
