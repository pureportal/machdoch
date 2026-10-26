import { z } from "zod";
import {
  cloudId,
  revision,
  type CloudCycle,
  type IssueSnapshot,
} from "./cloud-contract";

export const cycleCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start"), revision }),
  z.strictObject({
    kind: z.literal("close"),
    revision,
    carryoverCycleId: cloudId.nullable(),
  }),
]);
export type CycleCommand = z.infer<typeof cycleCommandSchema>;
export interface CycleTotals {
  issues: number;
  points: number;
  completed: number;
  completedPoints: number;
  unestimated: number;
}
export interface CycleDetail {
  cycle: CloudCycle;
  issues: IssueSnapshot[];
  commitment: IssueSnapshot[];
  statusNames: Record<string, string>;
  totals: CycleTotals;
  committedTotals: CycleTotals;
  carriedIssueIds: string[];
}
