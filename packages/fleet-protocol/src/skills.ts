import { z } from "zod";

const name = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (maximum: number) => z.string().min(1).max(maximum).refine((value) => !value.includes("\0"));
export const skillInputSchema = z.strictObject({
  name,
  description: text(1024),
  content: text(128 * 1024),
  enabled: z.boolean(),
  expectedFingerprint: fingerprint.optional(),
});
export const skillRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("save"), skill: skillInputSchema }),
  z.strictObject({ action: z.literal("delete"), name, expectedFingerprint: fingerprint }),
]);
export type SkillRequest = z.infer<typeof skillRequestSchema>;
