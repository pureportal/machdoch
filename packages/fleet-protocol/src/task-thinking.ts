import { z } from "zod";
import {
  modelProviderSchema,
  runModeSchema,
} from "@machdoch/fleet-protocol/runtime-options";

export const taskPanelToneSchema = z.enum([
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
]);
export type TaskPanelTone = z.infer<typeof taskPanelToneSchema>;
const timestamp = z.number().nonnegative();
const tokens = z.number().int().nonnegative().optional();
const tokenUsage = z.strictObject({
  inputTokens: tokens,
  outputTokens: tokens,
  totalTokens: tokens,
  cachedInputTokens: tokens,
  cacheReadInputTokens: tokens,
  cacheWriteInputTokens: tokens,
  toolUseInputTokens: tokens,
  reasoningTokens: tokens,
});
export const taskTimeoutSchema = z.strictObject({
  startedAt: timestamp.int(),
  lastActivityAt: timestamp.int(),
  idleTimeoutMs: timestamp.int().nullable(),
  absoluteTimeoutMs: timestamp.int().nullable(),
});
export type TaskExecutionTimeoutState = z.infer<typeof taskTimeoutSchema>;
export const taskThinkingModelStreamSchema = z.strictObject({
  kind: z.enum([
    "assistant",
    "tool-call",
    "reasoning",
    "status",
    "tool-result",
  ]),
  label: z.string(),
  content: z.string(),
  complete: z.boolean().optional(),
});
export type TaskThinkingModelStream = z.infer<
  typeof taskThinkingModelStreamSchema
>;
export const finalAnswerStreamSchema=z.strictObject({
  source:z.literal("openai-responses"),
  channel:z.literal("final_answer"),
  responseId:z.string().min(1).max(512),
  answerId:z.string().min(1).max(512),
  sequence:z.number().int().nonnegative().safe(),
  text:z.string().max(1_048_576).refine(value=>new TextEncoder().encode(value).byteLength<=1_048_576,"Final answer text exceeds the stream byte limit."),
  status:z.enum(["streaming","completed","retracted","limited"]),
  reason:z.string().max(512).optional(),
});
export type FinalAnswerStreamSnapshot=z.infer<typeof finalAnswerStreamSchema>;
export const taskThinkingActionOutputLineSchema = z.strictObject({
  id: z.string(),
  toolName: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
  timestamp,
});
export type TaskThinkingActionOutputLine = z.infer<
  typeof taskThinkingActionOutputLineSchema
>;
export const taskThinkingActionOutputSummarySchema = z.strictObject({
  id: z.string(),
  toolName: z.string(),
  timestamp,
  endedAt: timestamp,
  stdoutLineCount: z.number().int().nonnegative(),
  stderrLineCount: z.number().int().nonnegative(),
});
export type TaskThinkingActionOutputSummary = z.infer<
  typeof taskThinkingActionOutputSummarySchema
>;
export const taskThinkingTimelineEventSchema = z.strictObject({
  id: z.string(),
  kind: z.enum([
    "state",
    "agent",
    "model-call",
    "tool-call",
    "retry",
    "validator",
    "output",
  ]),
  phase: z.enum([
    "started",
    "streaming",
    "completed",
    "failed",
    "skipped",
    "usage",
    "passed",
    "requested-continuation",
    "rejected",
  ]),
  label: z.string(),
  detail: z.string(),
  tone: taskPanelToneSchema,
  timestamp,
  elapsedMs: timestamp,
  provider: modelProviderSchema.or(z.literal("unconfigured")).optional(),
  model: z.string().optional(),
  toolName: z.string().optional(),
  callId: z.string().optional(),
  stream: z.enum(["stdout", "stderr"]).optional(),
  tokenUsage: tokenUsage.optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
export type TaskThinkingTimelineEvent = z.infer<
  typeof taskThinkingTimelineEventSchema
>;

const liveText = (max: number) => z.string().max(max);
const liveCount = z.number().int().nonnegative().safe();
export const agentLiveProviderSchema = z.enum([
  "claude-cli",
  "codex-cli",
  "copilot-cli",
]);
export const agentLiveCapabilitySchema = z.enum([
  "steer",
  "interrupt",
  "answer",
  "stop-task",
]);
export type AgentLiveCapability = z.infer<typeof agentLiveCapabilitySchema>;
export const agentLiveUsageSchema = z.strictObject({
  inputTokens: liveCount.optional(),
  outputTokens: liveCount.optional(),
  cachedInputTokens: liveCount.optional(),
  reasoningTokens: liveCount.optional(),
  contextUsedTokens: liveCount.optional(),
  contextWindowTokens: liveCount.optional(),
  costUsd: z.number().nonnegative().optional(),
});
export const agentLiveLimitSchema = z.strictObject({
  id: liveText(80),
  label: liveText(120),
  usedPercent: z.number().min(0).max(1_000),
  resetsAt: timestamp.optional(),
  limited: z.boolean().optional(),
});
export const agentLivePlanStepSchema = z.strictObject({
  text: liveText(600),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export const agentLiveFileChangeSchema = z.strictObject({
  path: liveText(1_024),
  kind: z.enum(["add", "update", "delete"]).optional(),
  additions: liveCount.optional(),
  deletions: liveCount.optional(),
});
export const agentLiveTaskSchema = z.strictObject({
  id: liveText(200),
  kind: z.enum(["shell", "agent", "monitor", "other"]),
  description: liveText(600),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  background: z.boolean(),
  startedAt: timestamp.optional(),
  summary: liveText(600).optional(),
  canStop: z.boolean(),
});
export const agentLiveQuestionItemSchema = z.strictObject({
  id: liveText(200),
  header: liveText(120).optional(),
  question: liveText(2_000),
  options: z
    .array(
      z.strictObject({
        label: liveText(200),
        description: liveText(600).optional(),
      }),
    )
    .max(12),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  secret: z.boolean().optional(),
});
export const agentLiveQuestionSchema = z.strictObject({
  id: liveText(200),
  items: z.array(agentLiveQuestionItemSchema).min(1).max(8),
  status: z.enum(["pending", "answered", "cancelled"]),
  answers: z.record(z.string().max(200), liveText(4_000)).optional(),
});
export const agentLiveSteerSchema = z.strictObject({
  id: liveText(120),
  text: liveText(4_000),
  status: z.enum(["pending", "delivered", "failed"]),
  error: liveText(600).optional(),
});
export const agentLiveNoticeSchema = z.strictObject({
  id: liveText(120),
  tone: taskPanelToneSchema,
  text: liveText(600),
  timestamp,
});
/**
 * What a provider CLI reported live during one run: usage, plan, background
 * work, pending questions and follow-up suggestions. Each progress update
 * carries the full snapshot, so consumers replace rather than merge it.
 */
export const agentLiveStateSchema = z.strictObject({
  provider: agentLiveProviderSchema,
  transport: z.enum(["stream-json", "app-server", "sdk-server", "exec"]),
  capabilities: z.array(agentLiveCapabilitySchema).max(8),
  model: liveText(200).optional(),
  fastMode: z.boolean().optional(),
  usage: agentLiveUsageSchema.optional(),
  limits: z.array(agentLiveLimitSchema).max(8).optional(),
  plan: z.array(agentLivePlanStepSchema).max(80).optional(),
  fileChanges: z.array(agentLiveFileChangeSchema).max(200).optional(),
  tasks: z.array(agentLiveTaskSchema).max(60).optional(),
  question: agentLiveQuestionSchema.optional(),
  steering: z.array(agentLiveSteerSchema).max(20).optional(),
  suggestions: z.array(liveText(300)).max(5).optional(),
  notices: z.array(agentLiveNoticeSchema).max(20).optional(),
});
export type AgentLiveState = z.infer<typeof agentLiveStateSchema>;
export type AgentLiveTask = z.infer<typeof agentLiveTaskSchema>;
export type AgentLiveQuestion = z.infer<typeof agentLiveQuestionSchema>;
export type AgentLiveLimit = z.infer<typeof agentLiveLimitSchema>;
export type AgentLivePlanStep = z.infer<typeof agentLivePlanStepSchema>;
export type AgentLiveFileChange = z.infer<typeof agentLiveFileChangeSchema>;
/** A run-scoped loopback endpoint for sending input into the running turn. */
export const agentControlEndpointSchema = z.strictObject({
  url: z.string().url().max(200),
  token: z.string().min(32).max(200),
  capabilities: z.array(agentLiveCapabilitySchema).max(8),
});
export type AgentControlEndpoint = z.infer<typeof agentControlEndpointSchema>;

export const taskThinkingTraceSchema = z.strictObject({
  status: z.enum(["running", "complete"]),
  mode: runModeSchema,
  startedAt: timestamp,
  lastActivityAt: timestamp.optional(),
  timeout: taskTimeoutSchema.optional(),
  timelineEvents: z.array(taskThinkingTimelineEventSchema),
  task: z.string().optional(),
  completedAt: timestamp.optional(),
  assistantText: z.string().optional(),
  modelStream: taskThinkingModelStreamSchema.optional(),
  finalAnswerStream:finalAnswerStreamSchema.optional(),
  actionOutputLines: z.array(taskThinkingActionOutputLineSchema).optional(),
  actionOutputSummaries: z
    .array(taskThinkingActionOutputSummarySchema)
    .optional(),
  tokenUsage: tokenUsage.optional(),
  agentLive: agentLiveStateSchema.optional(),
});
export type TaskThinkingTrace = z.infer<typeof taskThinkingTraceSchema>;
export const resetTaskTimeoutCommandSchema = z.strictObject({
  taskId: z.string().trim().min(1).max(240),
  idleTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
});
