import { z } from "zod";
import type { RecurrenceInput } from "@machdoch/recurrence";
import { cloudId, issueInputSchema, revision } from "./cloud-contract";
import { runInputSchema } from "@machdoch/fleet-protocol/cloud-execution";

export const scheduleIssueSchema = issueInputSchema.omit({
  cycleId: true,
  dueOn: true,
});
export type ScheduleIssue = z.output<typeof scheduleIssueSchema>;
export const scheduleActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create-issue"),
    issue: scheduleIssueSchema,
  }),
  z.strictObject({
    kind: z.literal("run-task"),
    run: runInputSchema,
    profileRevision: revision,
    maxRuns: z.number().int().min(1).max(1000),
    maxTokens: z.number().int().min(1).max(1_000_000_000),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
]);
export type ScheduleAction = z.output<typeof scheduleActionSchema>;

export const scheduleInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  teamId: cloudId,
  action: scheduleActionSchema,
  recurrence: z
    .unknown()
    .refine((value) => value !== undefined, "Choose a schedule."),
  missed: z.enum(["skip", "latest", "bounded-all"]),
  catchUpLimit: z.number().int().min(1).max(20),
  lookbackHours: z.number().int().min(1).max(168),
});
export const scheduleUpdateSchema = scheduleInputSchema.extend({ revision });
export const scheduleStateSchema = z.strictObject({
  revision,
  enabled: z.boolean(),
});
export const scheduleArchiveSchema = z.strictObject({
  revision,
  archived: z.boolean(),
});
export const scheduleListSchema = z.strictObject({
  teamId: cloudId.optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  archived: z.boolean().default(false),
});
export type ScheduleFilters = z.input<typeof scheduleListSchema>;
export const scheduleQuerySchema = scheduleListSchema.extend({
  offset: z.coerce
    .number()
    .pipe(scheduleListSchema.shape.offset.unwrap())
    .default(0),
  archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});
const historyInstant = z.number().int().min(0).max(16725225599999);
const completeHistoryCursor = (value: {
  beforeAt?: number;
  beforeRevision?: number;
}) => (value.beforeAt === undefined) === (value.beforeRevision === undefined);
export const scheduleHistorySchema = z
  .strictObject({
    beforeAt: historyInstant.optional(),
    beforeRevision: revision.optional(),
  })
  .refine(completeHistoryCursor, "Provide both history cursor values.");
export const scheduleHistoryQuerySchema = z
  .strictObject({
    beforeAt: z.coerce.number().pipe(historyInstant).optional(),
    beforeRevision: z.coerce.number().pipe(revision).optional(),
  })
  .refine(completeHistoryCursor, "Provide both history cursor values.");
export type ScheduleInput = z.output<typeof scheduleInputSchema>;
export interface CloudSchedule {
  id: string;
  name: string;
  teamId: string;
  ownerId: string;
  ownerName: string;
  revision: number;
  enabled: boolean;
  action: ScheduleAction;
  providerRevision: number | null;
  admittedRuns: number;
  usedTokens: number;
  reservedTokens: number;
  archived: boolean;
  waitingRunId: string | null;
  recurrence: RecurrenceInput;
  definitionKey: string;
  missed: ScheduleInput["missed"];
  catchUpLimit: number;
  lookbackHours: number;
  nextAt: number | null;
  error: string | null;
  createdAt: string;
}
export interface ScheduleOccurrence {
  revision: number;
  at: number;
  issueId: string | null;
  identifier: string | null;
  runId: string | null;
  runState: string | null;
  reason: string | null;
  outcome: "created" | "skipped" | "admitted" | "overlap";
  accountedThrough: number;
  completedAt: number | null;
  usedTokens: number;
  reservedTokens: number;
}
