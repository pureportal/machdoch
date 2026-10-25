import { z } from "zod";
import { cloudApiProviders } from "@machdoch/fleet-protocol/cloud-providers";
import {
  taskInferenceInputSchema,
  taskInferenceReceiptSchema,
} from "@machdoch/fleet-protocol/cloud-inference";

export const cloudAgentStartSchema = z.strictObject({
  kind: z.literal("start"),
  task: z
    .string()
    .min(1)
    .max(32 * 1024),
  provider: z.enum(cloudApiProviders),
  model: z.string().min(1).max(160),
  contextLimitBytes: z
    .number()
    .int()
    .min(256)
    .max(48 * 1024),
  durationMs: z
    .number()
    .int()
    .min(1)
    .max(24 * 60 * 60 * 1000),
});
export type CloudAgentStart = z.infer<typeof cloudAgentStartSchema>;
export const cloudAgentInferenceSchema = taskInferenceInputSchema.omit({
  runId: true,
  attemptId: true,
  epoch: true,
});
export type CloudAgentInference = z.infer<typeof cloudAgentInferenceSchema>;
export class CloudAgentContextLimit extends Error {
  constructor(readonly bytes: number) {
    super("The remaining allowance requires a smaller model context.");
  }
}
export const cloudAgentReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inference_limit"),
    requestId: z.uuid(),
    contextLimitBytes: z
      .number()
      .int()
      .min(256)
      .max(48 * 1024),
  }),
  z.strictObject({
    kind: z.literal("inference_result"),
    requestId: z.uuid(),
    response: taskInferenceReceiptSchema.shape.response.unwrap(),
  }),
  z.strictObject({
    kind: z.literal("inference_error"),
    requestId: z.uuid(),
    error: z.string().min(1).max(1024),
  }),
]);
export type CloudAgentReply = z.infer<typeof cloudAgentReplySchema>;
export type CloudAgentTransport = (
  request: CloudAgentInference,
  signal: AbortSignal,
) => Promise<CloudAgentReply>;
