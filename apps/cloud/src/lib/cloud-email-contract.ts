import { z } from "zod";
import { cloudId, revision } from "./cloud-contract";

const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) =>
    (value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1)
      : value
    ).toLowerCase(),
  )
  .refine(
    (value) =>
      z.hostname().safeParse(value).success ||
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success,
    "Enter a hostname or IP address.",
  );
export const emailSettingsInputSchema = z.strictObject({
  revision: z.number().int().min(0).max(2_147_483_646),
  host: hostname,
  port: z.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls"]),
  tlsName: hostname.nullable(),
  username: z.string().trim().min(1).max(254).nullable(),
  password: z.string().min(1).max(4096).optional(),
  from: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  enabled: z.boolean(),
});
export const emailConnectionCheckSchema = z.strictObject({ revision });
export const magicLinkRequestSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  organizationId: cloudId.optional(),
  authorizationId: cloudId.optional(),
});
export const magicLinkPrepareSchema = z.strictObject({
  token: z.string().min(1).max(200),
});
export const magicLinkConfirmationSchema = z.strictObject({
  confirmationId: cloudId,
});
export type EmailSettingsInput = z.infer<typeof emailSettingsInputSchema>;
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;
export interface CloudEmailSettings extends Omit<
  EmailSettingsInput,
  "password"
> {
  hasPassword: boolean;
}
export type MailFailureCode =
  | "authentication"
  | "connection"
  | "timeout"
  | "recipient"
  | "failed";
export interface CloudEmailAdministration {
  settings: CloudEmailSettings | null;
  credentialStorageAvailable: boolean;
  failedDeliveries: number;
  lastError: MailFailureCode | null;
}
export interface MagicLinkPreview {
  confirmationId: string;
  email: string;
  organization: string;
  currentEmail: string | null;
}
