import { z } from "zod";
import { taskFileChangesSchema } from "@machdoch/fleet-protocol/task-file-changes";

export const taskExecutionInsightSchema = z.strictObject({
  task: z.string(),
  status: z.enum([
    "planned",
    "executed",
    "failed",
    "blocked",
    "cancelled",
    "unsupported",
  ]),
  fileChanges: taskFileChangesSchema.optional(),
  response: z
    .strictObject({
      relatedFiles: z.array(
        z.strictObject({ path: z.string(), description: z.string() }),
      ),
      verification: z.array(z.string()),
    })
    .optional(),
  autopilot: z
    .strictObject({ continuationCount: z.number().int().nonnegative() })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type TaskExecutionInsight = z.infer<typeof taskExecutionInsightSchema>;
