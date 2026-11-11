import { z } from "zod";
import { cloudId } from "./cloud-contract";

export const favoriteKinds = ["issue", "project", "cycle"] as const;
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
export function favoriteHref(
  favorite: Pick<CloudFavorite, "kind" | "id">,
): string {
  return `/cloud/${favorite.kind === "issue" ? "issues" : favorite.kind === "project" ? "projects" : "cycles"}/${favorite.id}`;
}
