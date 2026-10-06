import { z } from "zod";
import { taskExecutionInsightSchema } from "@machdoch/fleet-protocol/task-execution-insight";
import { sessionDataCommands } from "@machdoch/fleet-protocol/session-data-commands";
import {
  taskThinkingTraceSchema,
  taskTimeoutSchema,
} from "@machdoch/fleet-protocol/task-thinking";
import {
  productMessageSchema,
  productSessionSchema,
  productAttachmentSchema,
  productQueuedMessageSchema,
} from "@machdoch/fleet-protocol";
export {
  sessionDataCommands,
  type SessionIndexQuery,
  type SessionMessageQuery,
  type SessionDataCommand,
} from "@machdoch/fleet-protocol/session-data-commands";

const identifier = z.string().trim().min(1).max(240);

const traceEntry = z.strictObject({
  label: z.string(),
  detail: z.string(),
  tone: z.string().max(240).optional(),
  timestamp: z.number().int().nonnegative().optional(),
});

export const sessionMessageSchema = productMessageSchema.extend({
  execution: taskExecutionInsightSchema.optional(),
  thinking: taskThinkingTraceSchema.optional(),
  content: z.string(),
  rawContent: z.string().optional(),
  originalPrompt: z.string().optional(),
  source: z
    .strictObject({
      kind: z.string().max(64),
      status: z.string().max(64).optional(),
      title: z.string().optional(),
      summary: z.string().optional(),
      mode: z.string().max(64).optional(),
      entries: z.array(traceEntry).max(24),
      timeline: z.array(traceEntry).max(40),
      timeout: taskTimeoutSchema.optional(),
    })
    .optional(),
});

export const sessionMessagePageSchema = z.strictObject({
  sessionId: identifier,
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  messages: z.array(sessionMessageSchema).max(80),
  total: z.number().int().nonnegative(),
  hasEarlier: z.boolean(),
});

export const sessionIndexPageSchema = z.strictObject({
  sessions: z.array(productSessionSchema).max(80),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  sessionIds: z.array(identifier).max(5_000),
  projects: z.array(
    z.strictObject({
      id: z.string().max(2048),
      label: z.string(),
      path: z.string().nullable(),
      count: z.number().int().nonnegative(),
    }),
  ),
  tags: z.array(
    z.strictObject({
      label: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  statuses: z
    .array(sessionDataCommands.get_session_index.shape.statuses.element)
    .max(10),
});

export type SessionMessagePage = z.infer<typeof sessionMessagePageSchema>;
export type SessionIndexPage = z.infer<typeof sessionIndexPageSchema>;
export const sessionComposerTextSchema = z.strictObject({
  sessionId: identifier,
  draft: z.string(),
  draftRevision: z.number().int().nonnegative(),
  history: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative().max(10_000),
        prompt: z.string(),
        attachments: z.array(productAttachmentSchema).max(64),
      }),
    )
    .max(100),
  queuedMessages: z
    .array(
      productQueuedMessageSchema.extend({
        content: z.string(),
        failureMessage: z.string().optional(),
      }),
    )
    .max(512),
});
export type SessionComposerText = z.infer<typeof sessionComposerTextSchema>;
