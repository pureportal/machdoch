import { z } from "zod";

export const projectHealths = ["on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof projectHealths)[number];
export const projectHealthLabels: Record<ProjectHealth, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};
export const maximumUpdateSummaryLength = 300;
export const projectUpdateInputSchema = z.strictObject({
  health: z.enum(projectHealths),
  summary: z.string().trim().max(maximumUpdateSummaryLength).default(""),
  body: z.string().trim().max(20_000),
});
export type ProjectUpdateInput = z.input<typeof projectUpdateInputSchema>;
export interface CloudProjectUpdate {
  id: string;
  projectId: string;
  health: ProjectHealth;
  summary: string;
  body: string;
  generated: boolean;
  authorId: string;
  author: string;
  createdAt: string;
}
export interface CloudProjectUpdateEntry extends CloudProjectUpdate {
  projectName: string;
  teamId: string;
}
