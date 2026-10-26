import { z } from "zod";
import { sessionAccountSchema } from "./cloud-session-contract";

export const credentialsInputSchema = z.strictObject({
  account: sessionAccountSchema,
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
  username: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => [...value].length <= 64,
      "Username can contain at most 64 characters.",
    )
    .refine(
      (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
      "Username contains unsupported characters.",
    )
    .optional(),
});

export type CredentialsInput = z.infer<typeof credentialsInputSchema>;
export interface CredentialStatus {
  username: string | null;
  passwordEnabled: boolean;
}
