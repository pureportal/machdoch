import { z } from "zod";

const cloudId = z.uuid();
const commit = z.string().regex(/^[0-9a-f]{40}$/);

export const maximumReviewRounds = 3;

export const reviewFindingSchema = z.strictObject({
  severity: z.enum(["blocking", "suggestion"]),
  file: z.string().trim().max(1024).nullable(),
  line: z.number().int().min(1).max(10_000_000).nullable(),
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(4000),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewVerdictSchema = z.strictObject({
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(reviewFindingSchema).max(30),
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export const deliveryGateIds = [
  "checks",
  "tests_intact",
  "protected_paths",
  "change_size",
] as const;
export type DeliveryGateId = (typeof deliveryGateIds)[number];

export interface DeliveryGate {
  id: DeliveryGateId;
  passed: boolean;
  detail: string;
  paths: string[];
}

export interface ChangedFileStat {
  path: string;
  previousPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RunReview {
  id: string;
  round: number;
  candidateCommit: string;
  decision: ReviewVerdict["decision"];
  summary: string;
  findings: ReviewFinding[];
  gates: DeliveryGate[];
  model: string;
  createdAt: string;
}

export const deliveryStates = [
  "publishing",
  "reported",
  "open",
  "merging",
  "merged",
  "needs_person",
  "closed",
  "failed",
] as const;
export type DeliveryState = (typeof deliveryStates)[number];

export interface RunDelivery {
  kind: "change" | "check";
  state: DeliveryState;
  branch: string;
  baseBranch: string;
  headSha: string;
  pullRequestId: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  autoMerge: boolean;
  problems: number | null;
  reason: string | null;
  updatedAt: string;
  mergedAt: string | null;
}

export const workerReviewRequestSchema = z.strictObject({
  requestId: cloudId,
  runId: cloudId,
  attemptId: cloudId,
  epoch: z.number().int().min(1).max(2_147_483_646),
  candidateCommit: commit,
  round: z.number().int().min(1).max(maximumReviewRounds),
});
export type WorkerReviewRequest = z.infer<typeof workerReviewRequestSchema>;

export const workerReviewReceiptSchema = z.strictObject({
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string(),
  findings: z.array(reviewFindingSchema),
  gatesPassed: z.boolean(),
});
export type WorkerReviewReceipt = z.infer<typeof workerReviewReceiptSchema>;

export const workerReviewResultSchema = z.strictObject({
  state: z.enum([
    "queued",
    "running",
    "cancel_requested",
    "complete",
    "failed",
    "canceled",
    "unknown",
  ]),
  errorCode: z.string().nullable(),
  chargedTokens: z.number().min(0),
  review: workerReviewReceiptSchema.nullable(),
});
export type WorkerReviewResult = z.infer<typeof workerReviewResultSchema>;
