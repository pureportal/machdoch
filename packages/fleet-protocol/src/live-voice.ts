import { z } from "zod";

export const liveVoiceRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("session") }),
  z.strictObject({
    action: z.literal("process"),
    text: z.string().trim().min(1).max(20_000),
  }),
]);
export type LiveVoiceRequest = z.infer<typeof liveVoiceRequestSchema>;
export const liveVoiceSessionSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("openai"),
    token: z.string().min(1).max(8192),
    expiresAt: z.number().int().positive(),
    sampleRate: z.literal(24000),
  }),
  z.strictObject({
    provider: z.literal("google"),
    token: z.string().min(1).max(8192),
    expiresAt: z.number().int().positive(),
    sampleRate: z.literal(16000),
    setup: z.record(z.string(), z.unknown()),
  }),
]);
export type LiveVoiceSession = z.infer<typeof liveVoiceSessionSchema>;
