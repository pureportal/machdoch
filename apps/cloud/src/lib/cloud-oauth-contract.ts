import { z } from "zod";

export const cloudOAuthScopes = [
  "cloud:read",
  "cloud:write",
  "cloud:execute",
] as const;
export type CloudOAuthScope = (typeof cloudOAuthScopes)[number];
export const cloudOAuthScopeLabels: Record<CloudOAuthScope, string> = {
  "cloud:read": "Read issues, projects, cycles, and tasks",
  "cloud:write": "Edit planning and comments",
  "cloud:execute": "Start and cancel AI tasks",
};
export const cloudConsentSchema = z.strictObject({
  approve: z.boolean(),
  scopes: z.array(z.enum(cloudOAuthScopes)).max(3),
});
export interface CloudConsent {
  id: string;
  clientName: string;
  organization: string;
  account: string;
  redirectUri: string;
  scopes: CloudOAuthScope[];
}
export interface CloudConnectedApp {
  id: string;
  clientName: string;
  scopes: CloudOAuthScope[];
  createdAt: string;
  expiresAt: string;
}
