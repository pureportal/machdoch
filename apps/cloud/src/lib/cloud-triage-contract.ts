import { z } from "zod";
import {
  cloudId,
  issueStatusReferenceSchema,
  revision,
  type CloudIssueSummary,
} from "./cloud-contract";

export const triageDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("accept"),
    revision,
    status: issueStatusReferenceSchema.nullable().default(null),
  }),
  z.strictObject({
    decision: z.literal("decline"),
    revision,
    reason: z.string().trim().max(20_000).default(""),
  }),
  z.strictObject({
    decision: z.literal("duplicate"),
    revision,
    duplicateOfId: cloudId,
  }),
]);
export type TriageDecision = z.infer<typeof triageDecisionSchema>;
export type TriageDecisionInput = z.input<typeof triageDecisionSchema>;
export interface TriageIssue extends CloudIssueSummary {
  description: string;
  creator: string | null;
}
export interface TriageResult extends Record<string, unknown> {
  id: string;
  revision: number;
  statusName: string;
}
