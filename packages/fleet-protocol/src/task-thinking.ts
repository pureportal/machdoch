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
});
export type TaskThinkingTrace = z.infer<typeof taskThinkingTraceSchema>;
export const resetTaskTimeoutCommandSchema = z.strictObject({
  taskId: z.string().trim().min(1).max(240),
  idleTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
});
