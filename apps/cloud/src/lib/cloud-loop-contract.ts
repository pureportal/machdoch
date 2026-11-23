import { z } from "zod";
import { cloudId, revision } from "./cloud-contract";
import { issueFilterConditionSchema } from "./issue-filter-model";
import {
  memoryKeySchema,
  type CloudAutomationRun,
} from "./cloud-automation-contract";
import type { AgentStep } from "./cloud-chat-contract";

export const loopPlacements = [
  "automatic",
  "sandbox",
  "client",
  "runner_pool",
] as const;
export type LoopPlacement = (typeof loopPlacements)[number];
export const loopHarnesses = [
  "machdoch",
  "codex",
  "claude",
  "copilot",
] as const;
export type LoopHarness = (typeof loopHarnesses)[number];
export const loopCapabilities = [
  "repository",
  "shell",
  "browser",
  "desktop",
  "local_files",
  "gpu",
] as const;
export type LoopCapability = (typeof loopCapabilities)[number];
export const loopOverlapPolicies = [
  "allow",
  "skip",
  "queue",
  "cancel_previous",
] as const;
export type LoopOverlapPolicy = (typeof loopOverlapPolicies)[number];
export const loopMissedPolicies = ["skip", "latest"] as const;
export type LoopMissedPolicy = (typeof loopMissedPolicies)[number];
export const loopSources = [
  "webhook",
  "email",
  "github",
  "gitlab",
  "sentry",
  "grafana",
  "teams",
  "slack",
] as const;
export type LoopSource = (typeof loopSources)[number];
export const loopRejectionReasons = [
  "source_disabled",
  "invalid_secret",
  "untrusted",
  "loops_disabled",
  "killed",
] as const;
export type LoopRejectionReason = (typeof loopRejectionReasons)[number];
export const codeAccessModes = ["all", "selected"] as const;
export type CodeAccessMode = (typeof codeAccessModes)[number];

const targetId = z.string().trim().min(1).max(200).nullable().default(null);
const cents = z.number().int().min(1).max(100_000_000).nullable().default(null);

export const loopExecutorSchema = z
  .strictObject({
    placement: z.enum(loopPlacements).default("automatic"),
    targetId,
    harness: z.enum(loopHarnesses).default("machdoch"),
    model: z.string().trim().max(120).default(""),
    capabilities: z
      .array(z.enum(loopCapabilities))
      .max(loopCapabilities.length)
      .default([]),
  })
  .refine(
    (executor) => (executor.placement === "automatic") === !executor.targetId,
    { path: ["targetId"], message: "Choose where the loop runs." },
  );
export type LoopExecutor = z.output<typeof loopExecutorSchema>;

export const loopGuardrailsSchema = z.strictObject({
  runBudgetCents: cents,
  monthBudgetCents: cents,
  maxDurationMinutes: z.number().int().min(1).max(1440).default(60),
  overlap: z.enum(loopOverlapPolicies).default("allow"),
  missed: z.enum(loopMissedPolicies).default("latest"),
  approvalRequired: z.boolean().default(false),
  pauseAfterFailures: z.number().int().min(1).max(100).nullable().default(null),
});
export type LoopGuardrails = z.output<typeof loopGuardrailsSchema>;

export const loopContextSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("saved_view"), savedViewId: cloudId }),
  z.strictObject({
    kind: z.literal("filter"),
    conditions: z.array(issueFilterConditionSchema).min(1).max(10),
  }),
  z.strictObject({ kind: z.literal("team_projects"), teamId: cloudId }),
  z.strictObject({ kind: z.literal("document"), documentId: cloudId }),
  z.strictObject({ kind: z.literal("repository"), repositoryId: cloudId }),
  z.strictObject({ kind: z.literal("trigger_payload") }),
  z.strictObject({
    kind: z.literal("previous_runs"),
    runCount: z.number().int().min(1).max(20),
  }),
]);
export type LoopContextSource = z.output<typeof loopContextSourceSchema>;
export type LoopContextKind = LoopContextSource["kind"];

export interface LoopContextEntry {
  kind: LoopContextKind;
  title: string;
  items: string[];
}

export const loopConfigSchema = z.strictObject({
  description: z.string().trim().max(2_000).default(""),
  executor: loopExecutorSchema,
  guardrails: loopGuardrailsSchema,
  contextSources: z.array(loopContextSourceSchema).max(20).default([]),
  trustedSources: z
    .array(z.enum(loopSources))
    .max(loopSources.length)
    .default([]),
});
export type LoopConfig = z.output<typeof loopConfigSchema>;
export const loopConfigUpdateSchema = z.strictObject({
  revision,
  config: loopConfigSchema,
});

export const loopMemoryEntrySchema = z.strictObject({
  key: memoryKeySchema,
  value: z.string().max(4_000),
});
export type LoopMemoryEntry = z.output<typeof loopMemoryEntrySchema>;

export const loopSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    codeAccess: z.enum(codeAccessModes),
    repositoryIds: z.array(cloudId).max(500).default([]),
    defaultPlacement: z.enum(loopPlacements),
    defaultTargetId: targetId,
    runBudgetCapCents: cents,
    monthBudgetCapCents: cents,
    retentionDays: z.number().int().min(7).max(3650),
  })
  .refine(
    (settings) =>
      (settings.defaultPlacement === "automatic") === !settings.defaultTargetId,
    { path: ["defaultTargetId"], message: "Choose where loops run." },
  );
export type LoopSettingsInput = z.output<typeof loopSettingsSchema>;
export const loopSettingsUpdateSchema = z.strictObject({
  revision,
  settings: loopSettingsSchema,
});

export interface LoopSettings extends LoopSettingsInput {
  revision: number;
  centsPerThousandTokens: number;
  usage: { runs: number; tokens: number; costCents: number };
}

export const loopSourceUpdateSchema = z.strictObject({ enabled: z.boolean() });

export interface LoopSourceState {
  source: LoopSource;
  enabled: boolean;
  trustedBy: number;
  configured: boolean;
  rotatedAt: string | null;
  lastRejection: { reason: LoopRejectionReason; at: string } | null;
}

export interface LoopSourceSecret {
  source: LoopSource;
  url: string;
  secret: string;
}

export const documentInputSchema = z.strictObject({
  teamId: cloudId,
  title: z.string().trim().min(1).max(200),
});

export interface CloudDocumentSummary {
  id: string;
  title: string;
  teamId: string;
}

export interface CloudDocumentSection {
  id: string;
  position: number;
  heading: string;
  body: string;
  automationRunId: string | null;
  createdAt: string;
}

export interface CloudDocument extends CloudDocumentSummary {
  sections: CloudDocumentSection[];
}

export type LoopKind = "automation" | "schedule";

export interface CloudLoopSummary {
  id: string;
  kind: LoopKind;
  name: string;
  description: string;
  teamId: string;
  ownerId: string;
  ownerName: string;
  enabled: boolean;
  killed: boolean;
  trigger: string;
  executor: LoopExecutor;
  runs: number;
  succeededRuns: number;
  finishedRuns: number;
  costCents: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface LoopRevision {
  revision: number;
  createdAt: string;
}

export interface CloudLoop extends CloudLoopSummary {
  revision: number;
  config: LoopConfig;
  memory: LoopMemoryEntry[];
  revisions: LoopRevision[];
  consecutiveFailures: number;
}

export const loopTemplateInstallSchema = z.strictObject({
  templateId: z.string().trim().min(1).max(80),
  teamId: cloudId,
  executor: loopExecutorSchema,
  providerId: cloudId,
  model: z.string().trim().min(1).max(200),
  documentId: cloudId.nullable().default(null),
  timeZone: z.string().trim().min(1).max(80).default("UTC"),
});
export type LoopTemplateInstall = z.output<typeof loopTemplateInstallSchema>;

export const loopDryRunSchema = z.strictObject({
  runId: cloudId.nullable().default(null),
});

export const loopKillSchema = z.strictObject({ killed: z.boolean() });

export const loopApprovalSchema = z.strictObject({ approved: z.literal(true) });

export const loopInputAnswerSchema = z.strictObject({
  value: z.string().trim().min(1).max(4_000),
});

export interface LoopTranscriptTurn {
  prompt: string;
  answer: string;
  steps: AgentStep[];
}

export interface CloudLoopRunDetail extends CloudAutomationRun {
  payload: Record<string, unknown>;
  resolvedContext: LoopContextEntry[] | null;
  transcript: LoopTranscriptTurn[];
  awaitingApproval: boolean;
  awaitingInput: string | null;
  approvedByName: string | null;
}
