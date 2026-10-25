import { z } from "zod";
import { cloudId, revision } from "./cloud-contract";

export const labelColors = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
] as const;
export const labelInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  color: z.enum(labelColors),
});
export const labelUpdateSchema = labelInputSchema.extend({
  revision,
  archived: z.boolean(),
});
export const issueLabelsUpdateSchema = z.strictObject({
  revision,
  labelIds: z
    .array(cloudId)
    .max(30)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Choose each label once.",
    ),
});
export type LabelInput = z.infer<typeof labelInputSchema>;
export type LabelUpdate = z.infer<typeof labelUpdateSchema>;
export type IssueLabelsUpdate = z.infer<typeof issueLabelsUpdateSchema>;
export interface CloudLabel extends LabelInput {
  id: string;
  teamId: string;
  revision: number;
  archived: boolean;
}
export interface CloudIssueLabels {
  revision: number;
  labels: CloudLabel[];
}
