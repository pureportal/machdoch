import { z } from "zod";

export const projectHealths = ["on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof projectHealths)[number];
export const projectHealthLabels: Record<ProjectHealth, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};
export const projectUpdateInputSchema = z.strictObject({
  health: z.enum(projectHealths),
  body: z.string().trim().max(20_000),
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInputSchema>;
export interface CloudProjectUpdate {
  id: string;
  projectId: string;
  health: ProjectHealth;
  body: string;
  authorId: string;
  author: string;
  createdAt: string;
}
export interface CloudProjectUpdateEntry extends CloudProjectUpdate {
  projectName: string;
  teamId: string;
}
