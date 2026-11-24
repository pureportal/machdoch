import { z } from "zod";
import {
  cloudId,
  projectStatuses,
  type ProjectStatusCategory,
} from "./cloud-contract";

export interface CloudProjectStatus {
  id: string;
  name: string;
  category: ProjectStatusCategory;
  position: number;
}

const statusName = z.string().trim().min(1).max(60);

export const projectStatusInputSchema = z.strictObject({
  name: statusName,
  category: z.enum(projectStatuses),
});
export type ProjectStatusInput = z.infer<typeof projectStatusInputSchema>;

export const projectStatusUpdateSchema = z.strictObject({
  name: statusName,
  position: z.number().int().min(0).max(10_000),
});
export type ProjectStatusUpdate = z.infer<typeof projectStatusUpdateSchema>;

export const projectStatusDeleteSchema = z.strictObject({
  replacementId: cloudId,
});
export type ProjectStatusDelete = z.infer<typeof projectStatusDeleteSchema>;
