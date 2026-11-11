import { z } from "zod";

const code = z.string().trim().min(1).max(64);

export const twoFactorCodeSchema = z.strictObject({ code });
export const authenticatorReplacementSchema = z.strictObject({
  currentCode: code,
  code,
});
export type AuthenticatorReplacement = z.infer<
  typeof authenticatorReplacementSchema
>;

export interface AuthenticatorSetup {
  secret: string;
  uri: string;
}
export interface TwoFactorStatus {
  createdAt: string;
  recoveryCodes: number;
}
export interface TwoFactorVerification {
  remainingRecoveryCodes: number | null;
}
export interface RecoveryCodes {
  recoveryCodes: string[];
}
