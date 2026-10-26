import { z } from "zod";
import { cloudId } from "./cloud-contract";

const oidcEndpointSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  }, "Use an HTTPS URL without credentials or a fragment.");
export const oidcUrlSchema = oidcEndpointSchema.refine(
  (value) => !new URL(value).search,
  "The issuer URL cannot contain a query.",
);
export const oidcAlgorithms = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;
export const oidcMetadataSchema = z.strictObject({
  issuer: oidcUrlSchema,
  authorization_endpoint: oidcEndpointSchema,
  token_endpoint: oidcEndpointSchema,
  jwks_uri: oidcEndpointSchema,
  userinfo_endpoint: oidcEndpointSchema.optional(),
  response_types_supported: z.array(z.string().max(80)).min(1).max(30),
  subject_types_supported: z
    .array(z.enum(["public", "pairwise"]))
    .min(1)
    .max(2),
  id_token_signing_alg_values_supported: z
    .array(z.string().max(30))
    .min(1)
    .max(30),
  token_endpoint_auth_methods_supported: z
    .array(z.string().max(80))
    .min(1)
    .max(30)
    .optional(),
  code_challenge_methods_supported: z
    .array(z.string().max(30))
    .min(1)
    .max(10)
    .optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export const oidcConfigurationSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  metadata: oidcMetadataSchema,
  clientId: z.string().trim().min(1).max(512),
  authentication: z.enum(["client_secret_basic", "client_secret_post"]),
  algorithm: z.enum(oidcAlgorithms),
  displaySource: z.enum(["id_token", "userinfo"]),
  displayClaim: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
  requiredAcr: z.string().trim().min(1).max(256).nullable(),
  maxAge: z.number().int().min(0).max(43200).nullable(),
});
export const oidcSaveSchema = oidcConfigurationSchema.extend({
  revision: z.number().int().min(0),
  secret: z.string().min(1).max(8192).optional(),
  enabled: z.boolean(),
});
export const oidcDiscoverySchema = z.strictObject({ issuer: oidcUrlSchema });
export const oidcSubjectSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !value.includes("\u0000"),
    "Subject must not contain a null character.",
  );
export const oidcMappingSchema = z.strictObject({
  userId: cloudId,
  subject: oidcSubjectSchema,
});
export const ssoMemberSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(
      (value) => !value.includes("\u0000"),
      "Name must not contain a null character.",
    ),
  role: z.enum(["admin", "member", "viewer"]),
  subject: oidcSubjectSchema,
});
export type SsoMember = z.infer<typeof ssoMemberSchema>;
export type OidcMetadata = z.infer<typeof oidcMetadataSchema>;
export type OidcConfiguration = z.infer<typeof oidcConfigurationSchema>;
export type OidcSave = z.infer<typeof oidcSaveSchema>;
export type OidcProvider = OidcConfiguration & {
  id: string;
  revision: number;
  enabled: boolean;
  verified: boolean;
};
export interface SsoAdministration {
  providers: OidcProvider[];
  linkedProviderIds: string[];
  credentialStorageAvailable: boolean;
  redirectUri: string;
}
