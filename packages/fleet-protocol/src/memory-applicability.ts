import { z } from "zod";

const terms = z.array(z.string().trim().min(1).max(200)).max(32);
const timestamp = z.number().finite().min(0).max(8_640_000_000_000_000);
export const memoryApplicabilitySchema = z.strictObject({
  taskTerms: terms.optional(),
  excludedTaskTerms: terms.optional(),
  expiresAt: timestamp.optional(),
  verifiedAt: timestamp.optional(),
  maxAgeDays: z.number().finite().nonnegative().optional(),
  enabled: z.boolean().optional(),
});
export interface MemoryApplicability {
  taskTerms?: string[];
  excludedTaskTerms?: string[];
  expiresAt?: number;
  verifiedAt?: number;
  maxAgeDays?: number;
  enabled?: boolean;
}
