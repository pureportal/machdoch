import { z } from "zod";

export const hostTelemetrySchema = z
  .strictObject({
    capturedAt: z.number().int().nonnegative(),
    platform: z.string().trim().min(1).max(64),
    architecture: z.string().trim().min(1).max(64),
    cpuCount: z.number().int().positive(),
    cpuUsagePercent: z.number().min(0).max(100).nullable(),
    memoryTotalBytes: z.number().int().nonnegative(),
    memoryUsedBytes: z.number().int().nonnegative(),
    uptimeSeconds: z.number().int().nonnegative(),
  })
  .refine((value) => value.memoryUsedBytes <= value.memoryTotalBytes);

export type HostTelemetry = z.infer<typeof hostTelemetrySchema>;
