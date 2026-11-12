import { z } from "zod";
import {
  cloudId,
  revision,
  issueInputSchema,
  type CloudIssue,
} from "./cloud-contract";

export const relationKinds = [
  "parent",
  "child",
  "blocks",
  "blocked_by",
  "related",
  "duplicate_of",
  "duplicated_by",
] as const;
export type RelationKind = (typeof relationKinds)[number];
export const relationInputSchema = z.strictObject({
  kind: z.enum(relationKinds),
  targetId: cloudId,
  sourceRevision: revision,
  targetRevision: revision,
});
export const childIssueInputSchema = z.strictObject({
  parentRevision: revision,
  issue: issueInputSchema,
});
export type RelationInput = z.infer<typeof relationInputSchema>;
export type ChildIssueInput = z.infer<typeof childIssueInputSchema>;
export interface CloudIssueRelation {
  id: string;
  kind: RelationKind;
  actor: string;
  createdAt: string;
  issue: Pick<
    CloudIssue,
    | "id"
    | "identifier"
    | "title"
    | "state"
    | "statusName"
    | "archived"
    | "revision"
  >;
}
