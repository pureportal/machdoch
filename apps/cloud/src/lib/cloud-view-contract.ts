import { z } from "zod";

export const viewFilterKeys = [
  "scope",
  "view",
  "group",
  "sort",
  "teamId",
  "projectId",
  "cycleId",
  "labelId",
  "statusId",
  "assigneeId",
  "priority",
  "estimate",
  "planning",
  "query",
  "archived",
] as const;

export const savedViewInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  filters: z.partialRecord(z.enum(viewFilterKeys), z.string().max(200)),
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
