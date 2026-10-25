import { z } from "zod";
import { recurrenceInputSchema } from "@machdoch/recurrence";

const previewFields = {
  fromActivation: z
    .boolean()
    .describe(
      "Preview the first fixed-delay occurrence from activation when its start is in the past.",
    )
    .optional(),
  after: z.string().max(40).optional(),
  count: z.number().int().min(1).max(20).default(5),
};
export const recurrencePreviewSchema = z.strictObject({
  recurrence: z
    .unknown()
    .refine((value) => value !== undefined, "Provide a recurrence definition."),
  ...previewFields,
});
export const recurrencePreviewDocumentation = z.strictObject({
  recurrence: recurrenceInputSchema,
  ...previewFields,
});
export type RecurrencePreviewRequest = z.output<typeof recurrencePreviewSchema>;
