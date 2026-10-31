import { z } from "zod";
import { revision } from "./cloud-contract";

const name = z.string().trim().min(1).max(120);

export const milestoneInputSchema = z.strictObject({
  name,
  targetOn: z.iso.date().nullable(),
});
export const milestoneUpdateSchema = milestoneInputSchema.extend({
  revision,
  completed: z.boolean(),
});
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;
export type MilestoneUpdate = z.infer<typeof milestoneUpdateSchema>;

export interface CloudMilestone {
  id: string;
  projectId: string;
  name: string;
  targetOn: string | null;
  completed: boolean;
  revision: number;
}
