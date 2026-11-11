import { z } from "zod";
import { cloudId, revision } from "./cloud-contract";
import type { ProjectHealth } from "./cloud-project-update-contract";

export const initiativeStatuses = ["planned", "active", "completed"] as const;
export type InitiativeStatus = (typeof initiativeStatuses)[number];
export const initiativeStatusLabels: Record<InitiativeStatus, string> = {
  planned: "Planned",
  active: "Active",
  completed: "Completed",
};
const initiativeFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(20_000),
  status: z.enum(initiativeStatuses),
  ownerId: cloudId.nullable(),
  targetOn: z.iso.date().nullable(),
  projectIds: z
    .array(cloudId)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Choose each project once.",
    ),
};
export const initiativeInputSchema = z.strictObject({
  name: initiativeFields.name,
  description: initiativeFields.description.default(""),
  status: initiativeFields.status.default("planned"),
  ownerId: initiativeFields.ownerId.default(null),
  targetOn: initiativeFields.targetOn.default(null),
  projectIds: initiativeFields.projectIds.default([]),
});
export const initiativeUpdateSchema = z.strictObject({
  ...initiativeFields,
  revision,
});
export type InitiativeInput = z.infer<typeof initiativeInputSchema>;
export type InitiativeUpdate = z.infer<typeof initiativeUpdateSchema>;
export interface CloudInitiative {
  id: string;
  name: string;
  description: string;
  status: InitiativeStatus;
  ownerId: string | null;
  targetOn: string | null;
  revision: number;
  projectIds: string[];
  issues: number;
  completedIssues: number;
  health: ProjectHealth | null;
}
