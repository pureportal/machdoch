import { z } from "zod";
import { cloudId } from "./cloud-contract";
import { oidcSubjectSchema } from "./cloud-sso-contract";

export const invitationInputSchema = z.strictObject({
  organizationId: cloudId,
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  role: z.enum(["admin", "member", "viewer"]),
  authentication: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("password") }),
    z.strictObject({
      kind: z.literal("oidc"),
      providerId: cloudId,
      subject: oidcSubjectSchema,
    }),
  ]),
});
export const invitationPrepareSchema = z.strictObject({
  token: z.string().min(1).max(200),
});
export const invitationConfirmationSchema = z.strictObject({
  confirmationId: cloudId,
});
export const invitationAcceptSchema = invitationConfirmationSchema.extend({
  sessionId: cloudId.nullable(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(
      (value) => !value.includes("\u0000"),
      "Name must not contain a null character.",
    )
    .optional(),
  password: z.string().min(1).max(1024).optional(),
});
export type InvitationInput = z.infer<typeof invitationInputSchema>;
export type InvitationAccept = z.infer<typeof invitationAcceptSchema>;
export interface InvitationOptions {
  requiredSso: boolean;
  credentialStorageAvailable: boolean;
  providers: { id: string; name: string }[];
}
export interface InvitationPreview {
  confirmationId: string;
  organization: string;
  email: string;
  role: "admin" | "member" | "viewer";
  existingAccount: boolean;
  authentication: "password" | "oidc";
  provider: string | null;
  verifiedIdentity: string | null;
  currentEmail: string | null;
  canUseSession: boolean;
  completed: boolean;
  currentSessionId: string | null;
  ssoFailure: "failed" | "expired" | "identity_mismatch" | null;
}
