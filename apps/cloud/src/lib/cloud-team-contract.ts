import { z } from "zod";

export const maximumTeamResources = 30;

export const teamResourceInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  url: z.url({ protocol: /^https?$/ }).max(2000),
});
export type TeamResourceInput = z.infer<typeof teamResourceInputSchema>;

export interface TeamResource extends TeamResourceInput {
  id: string;
  createdAt: string;
}

export interface CloudTeamHome {
  memberIds: string[];
  resources: TeamResource[];
}
