import { z } from "zod";

export const agentAccessModes = [
  "off",
  "admins",
  "everyone",
  "people",
] as const;
export type AgentAccess = (typeof agentAccessModes)[number];

export const agentAccessSchema = z.strictObject({
  agentAccess: z.enum(agentAccessModes),
  agentUsers: z.array(z.uuid()).max(200),
});
export type AgentAccessInput = z.infer<typeof agentAccessSchema>;

export interface ClientUser {
  userId: string;
  manager: boolean;
  startsTasks: boolean;
}

export interface ClientAccessPolicy {
  ownerUserId: string | null;
  agentAccess: AgentAccess;
  agentUsers: readonly string[];
}

export function canUseClient(
  user: ClientUser,
  client: ClientAccessPolicy,
): boolean {
  if (client.ownerUserId) return client.ownerUserId === user.userId;
  switch (client.agentAccess) {
    case "admins":
      return user.manager;
    case "everyone":
      return user.startsTasks;
    case "people":
      return client.agentUsers.includes(user.userId);
    case "off":
      return false;
  }
}

export function canSeeClient(
  user: ClientUser,
  client: ClientAccessPolicy,
): boolean {
  return user.manager || canUseClient(user, client);
}
