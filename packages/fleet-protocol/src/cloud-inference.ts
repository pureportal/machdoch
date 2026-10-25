import { z } from "zod";
import { reasoningModeSchema } from "./runtime-options.js";
export const maximumTaskInferenceRequestBytes = 256 * 1024;
const cloudId = z.uuid();
import { attemptIdentitySchema } from "@machdoch/fleet-protocol/cloud-execution";
type InferenceState =
  | "queued"
  | "running"
  | "cancel_requested"
  | "complete"
  | "failed"
  | "canceled"
  | "unknown";
interface InferenceToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const toolSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (schema) => schema.$async !== true,
    "Tool schemas must use synchronous validation.",
  )
  .refine((schema) => {
    const pending: { value: unknown; depth: number }[] = [
      { value: schema, depth: 0 },
    ];
    let nodes = 0;
    while (pending.length) {
      const entry = pending.pop()!;
      if (++nodes > 20000 || entry.depth > 32) return false;
      if (entry.value !== null && typeof entry.value === "object") {
        for (const value of Object.values(entry.value))
          pending.push({ value, depth: entry.depth + 1 });
      }
    }
    return true;
  }, "Tool schema exceeds its complexity limit.");

export const inferenceToolsSchema = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
      description: z.string().max(16384),
      inputSchema: toolSchema,
      strict: z.boolean().optional(),
    }),
  )
  .max(256)
  .refine(
    (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
    "Tool names must be unique.",
  );

export const inferenceModelOptionsSchema = z.strictObject({
  reasoning: reasoningModeSchema.optional(),
  toolChoice: z.enum(["auto", "required"]).optional(),
  structuredOutput: z
    .strictObject({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
      schema: toolSchema,
      strict: z.boolean().optional(),
    })
    .optional(),
});
export type InferenceModelOptions = z.infer<typeof inferenceModelOptionsSchema>;

export const taskInferenceInputSchema = attemptIdentitySchema.extend({
  requestId: cloudId,
  runtimePrompt: z.string().max(32 * 1024),
  tools: inferenceToolsSchema,
  modelOptions: inferenceModelOptionsSchema,
  context: z
    .string()
    .min(1)
    .max(48 * 1024),
});
export const taskInferenceReadSchema = attemptIdentitySchema.extend({
  requestId: cloudId,
});
export type TaskInferenceInput = z.infer<typeof taskInferenceInputSchema>;
export type TaskInferenceRead = z.infer<typeof taskInferenceReadSchema>;
export interface InferenceResponse {
  text: string;
  toolCalls: InferenceToolCall[];
}
export interface TaskInferenceReceipt {
  requestId: string;
  state: InferenceState;
  response: InferenceResponse | null;
  errorCode: string | null;
  chargedTokens: number;
}

export const taskInferenceReceiptSchema = z.strictObject({
  requestId: z.uuid(),
  state: z.enum([
    "queued",
    "running",
    "cancel_requested",
    "complete",
    "failed",
    "canceled",
    "unknown",
  ]),
  response: z
    .strictObject({
      text: z.string().max(256 * 1024),
      toolCalls: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(512),
            name: z.string().min(1).max(120),
            arguments: z.record(z.string(), z.unknown()),
          }),
        )
        .max(16),
    })
    .nullable(),
  errorCode: z.string().max(120).nullable(),
  chargedTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
