import { z } from "zod";
import { githubRepositorySchema } from "@machdoch/fleet-protocol/cloud-repository";
import type { TaskArtifact } from "@machdoch/fleet-protocol/cloud-artifacts";
import { cloudApiProviders } from "./cloud-providers.ts";
const cloudId = z.uuid();
const revision = z.number().int().min(1).max(2_147_483_646);

export const runStates = [
  "queued",
  "preparing",
  "running",
  "waiting",
  "validating",
  "publishing",
  "cancel_requested",
  "reconciling",
  "succeeded",
  "failed",
  "canceled",
  "timed_out",
] as const;
export const terminalRunStates = [
  "succeeded",
  "failed",
  "canceled",
  "timed_out",
] as const;
export type RunState = (typeof runStates)[number];
export const repositoryDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[a-z]:/iu.test(value) &&
      !/[\\\u0000-\u001f]/u.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a relative repository directory without empty, . or .. segments.",
  );
export const executionCheckSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  command: z
    .string()
    .trim()
    .min(1)
    .max(16384)
    .refine(
      (value) => new TextEncoder().encode(value).length <= 32768,
      "Commands must fit within 32 KiB.",
    ),
  timeoutSeconds: z.number().int().min(1).max(300),
});
export type ExecutionCheck = z.infer<typeof executionCheckSchema>;
export const clientAgents = ["machdoch", "codex-cli", "claude-cli"] as const;
export type ClientAgent = (typeof clientAgents)[number];
const modelName = z.string().trim().min(1).max(160);
const executionProfileFields = {
  projectId: cloudId,
  name: z.string().trim().min(1).max(120),
  workspacePath: repositoryDirectorySchema.optional(),
  repository: githubRepositorySchema,
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/, "Use a full Git commit SHA."),
  maxDurationSeconds: z.number().int().min(60).max(86_400),
  maxTokens: z.number().int().min(1).max(10_000_000),
  requiredChecks: z
    .array(executionCheckSchema)
    .min(1)
    .max(30)
    .refine(
      (items) => new Set(items.map((item) => item.name)).size === items.length,
      "Check names must be unique.",
    ),
};
const brokeredProfileInputSchema = z.strictObject({
  ...executionProfileFields,
  target: z.enum(["cloud", "client-linux"]),
  providerId: cloudId,
  model: modelName,
});
const clientProfileInputSchema = z.strictObject({
  ...executionProfileFields,
  target: z.literal("client"),
  agent: z.enum(clientAgents),
  model: modelName.optional(),
});
export const executionProfileInputSchema = z.discriminatedUnion("target", [
  brokeredProfileInputSchema,
  clientProfileInputSchema,
]);
const profileUpdateFields = { revision, enabled: z.boolean() };
export const executionProfileUpdateSchema = z.discriminatedUnion("target", [
  brokeredProfileInputSchema
    .omit({ projectId: true })
    .extend(profileUpdateFields),
  clientProfileInputSchema
    .omit({ projectId: true })
    .extend(profileUpdateFields),
]);
export const runInputSchema = z.strictObject({
  profileId: cloudId,
  subject: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("issue"), id: cloudId, revision }),
    z.strictObject({
      kind: z.literal("project"),
      id: cloudId,
      revision,
      purpose: z.enum(["research", "maintenance", "test"]),
      objective: z.string().trim().min(1).max(20_000),
      acceptanceCriteria: z.string().trim().min(1).max(20_000),
    }),
  ]),
});
export const runCancelSchema = z.strictObject({ revision });
export const workerInputSchema = z.strictObject({
  profileId: cloudId,
  name: z.string().trim().min(1).max(120),
});
export const clientWorkspaceBindingSchema = z.strictObject({
  workspaceId: cloudId,
  name: z.string().trim().min(1).max(120),
  repository: githubRepositorySchema,
});
export type ClientWorkspaceBinding = z.infer<
  typeof clientWorkspaceBindingSchema
>;
export const workerClaimSchema = z.strictObject({ claimId: cloudId });
export const attemptIdentitySchema = z.strictObject({
  runId: cloudId,
  attemptId: cloudId,
  epoch: revision,
});
export const workerAcceptSchema = attemptIdentitySchema.extend({
  environmentId: cloudId,
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  isolation: z.enum(["microvm", "independent-checkout"]),
});
export const workerProgressSchema = attemptIdentitySchema.extend({
  state: z.enum(["running", "waiting", "validating"]),
});
export const workerFinishSchema = attemptIdentitySchema.extend({
  outcome: z.enum(terminalRunStates),
  summary: z.string().trim().min(1).max(20_000),
  stopped: z.literal(true),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidateCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  tokensUsed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  checks: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(120),
        passed: z.boolean(),
        candidateCommit: z.string().regex(/^[0-9a-f]{40}$/),
        evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(30)
    .refine(
      (items) => new Set(items.map((item) => item.name)).size === items.length,
      "Check names must be unique.",
    ),
});
export type ExecutionProfileInput = z.infer<typeof executionProfileInputSchema>;
export type ExecutionProfileUpdate = z.infer<
  typeof executionProfileUpdateSchema
>;
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type RunInput = z.infer<typeof runInputSchema>;
export type AttemptIdentity = z.infer<typeof attemptIdentitySchema>;
export type WorkerProgress = z.infer<typeof workerProgressSchema>;
export type WorkerAccept = z.infer<typeof workerAcceptSchema>;
export type WorkerFinish = z.infer<typeof workerFinishSchema>;
export type WorkerCompletionReceipt =
  | { accepted: true; state: RunState }
  | {
      accepted: false;
      state: RunState;
      requiredOutcome: "canceled" | "failed" | "timed_out";
    };
export interface WorkerLeaseReceipt {
  instruction: "continue" | "stop";
  localStopSeconds: number;
  leaseExpiresAt?: string;
}
export type RunManifest = z.infer<typeof runManifestSchema>;
export interface CloudRun {
  id: string;
  teamId: string;
  projectId: string;
  issueId: string | null;
  title: string;
  state: RunState;
  revision: number;
  epoch: number;
  attemptId: string | null;
  createdAt: string;
  deadlineAt: string;
  summary: string | null;
  cancelRequested: boolean;
}
export interface RunAttempt {
  id: string;
  workerId: string;
  workerName: string;
  epoch: number;
  state: "preparing" | "running" | "stopping" | "suspect" | "stopped";
  leaseExpiresAt: string;
}
export interface RunDetail extends CloudRun {
  contextChanged: boolean;
  candidateCommit: string | null;
  reason: string | null;
  manifest: RunManifest;
  inputDigest: string;
  attempts: RunAttempt[];
  artifacts: TaskArtifact[];
  usage: {
    usedTokens: number;
    reservedTokens: number;
    requests: number;
  };
}
export interface WorkerClaim extends AttemptIdentity {
  manifest: RunManifest;
  inputDigest: string;
  leaseExpiresAt: string;
  deadlineAt: string;
}
export interface ExecutionWorker {
  id: string;
  profileId: string;
  name: string;
  enabled: boolean;
  lastSeenAt: string | null;
  expiresAt: string;
  workspaceBinding: ClientWorkspaceBinding | null;
}

const storedProfileFields = {
  id: cloudId,
  teamId: cloudId,
  revision,
  enabled: z.boolean(),
};
export const executionProfileSchema = z.discriminatedUnion("target", [
  brokeredProfileInputSchema.extend(storedProfileFields),
  clientProfileInputSchema.extend(storedProfileFields),
]);
export const workerRegistrationSchema = z.strictObject({
  workerId: cloudId,
  organizationId: cloudId,
  projectName: z.string().min(1).max(120),
  profile: executionProfileSchema,
  workspaceBinding: clientWorkspaceBindingSchema.nullable(),
});
export type WorkerRegistration = z.infer<typeof workerRegistrationSchema>;

export const runManifestSchema = z
  .strictObject({
    automation: z
      .strictObject({
        scheduleId: cloudId,
        revision,
        expiresAt: z.iso.datetime({ offset: true }),
        membershipEpoch: z.string().regex(/^[1-9]\d{0,18}$/),
        userEpoch: z.string().regex(/^[1-9]\d{0,18}$/),
        teamEpoch: z.string().regex(/^[1-9]\d{0,18}$/),
      })
      .optional(),
    contextLimitBytes: z
      .number()
      .int()
      .min(256)
      .max(48 * 1024),
    subject: runInputSchema.shape.subject,
    title: z.string().max(300),
    objective: z.string().max(30302),
    acceptanceCriteria: z.string().max(20000),
    profile: executionProfileSchema,
    provider: z
      .strictObject({
        id: cloudId,
        name: z.string().max(120),
        provider: z.enum(cloudApiProviders),
        inferenceRevision: revision,
        maxOutputTokens: z.number().int().min(64).max(65536),
      })
      .nullable(),
    actorId: cloudId,
  })
  .refine(
    (manifest) =>
      (manifest.profile.target === "client") === (manifest.provider === null),
    "Only client agents run without a cloud model provider.",
  );
export const workerGrantIdentitySchema = attemptIdentitySchema.extend({
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type WorkerGrantIdentity = z.infer<typeof workerGrantIdentitySchema>;
export const workerClaimReceiptSchema = workerGrantIdentitySchema.extend({
  manifest: runManifestSchema,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  leaseExpiresAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
});
export const workerClaimResponseSchema = z.strictObject({
  claim: workerClaimReceiptSchema.nullable(),
  localStopSeconds: z.number().int().min(0).max(60),
});
export const workerLeaseReceiptSchema = z.strictObject({
  instruction: z.enum(["continue", "stop"]),
  localStopSeconds: z.number().int().min(0).max(60),
  leaseExpiresAt: z.iso.datetime().optional(),
});
export const workerProgressReceiptSchema = z.strictObject({
  instruction: z.enum(["continue", "stop"]),
});
export const workerCompletionReceiptSchema = z.discriminatedUnion("accepted", [
  z.strictObject({ accepted: z.literal(true), state: z.enum(runStates) }),
  z.strictObject({
    accepted: z.literal(false),
    state: z.enum(runStates),
    requiredOutcome: z.enum(["canceled", "failed", "timed_out"]),
  }),
]);
export const workerRecoverySchema = z.strictObject({
  workerId: cloudId,
  enabled: z.boolean(),
  recovery: z
    .strictObject({
      grant: workerGrantIdentitySchema,
      state: z.enum(runStates),
      attemptState: z.enum([
        "preparing",
        "running",
        "stopping",
        "suspect",
        "stopped",
      ]),
      reason: z.string().nullable(),
      tokensUsed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .nullable(),
});
export type WorkerRecovery = z.infer<typeof workerRecoverySchema>;
export const workerAvailabilitySchema = z.strictObject({
  workerId: cloudId,
  enabled: z.boolean(),
  available: z.boolean(),
});
export type WorkerAvailability = z.infer<typeof workerAvailabilitySchema>;
