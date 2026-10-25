import { z } from "zod";
import { cloudId } from "./cloud-contract";

export const sessionAccountSchema = z.strictObject({
  organizationId: cloudId,
  userId: cloudId,
});
export type SessionAccount = z.infer<typeof sessionAccountSchema>;
export const sessionRevocationSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("session"),
    id: cloudId,
    account: sessionAccountSchema,
  }),
  z.strictObject({
    scope: z.literal("other_sessions"),
    account: sessionAccountSchema,
  }),
]);
export type SessionRevocation = z.infer<typeof sessionRevocationSchema>;
export interface CloudSessionInfo {
  id: string;
  current: boolean;
  browser: string | null;
  platform: string | null;
  address: string | null;
  method: "password" | "magic_link" | "oidc";
  provider: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}
export interface SessionRevocationResult {
  signedOut: boolean;
  revoked: number;
}
