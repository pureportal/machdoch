import { z } from "zod";
import { cloudOAuthScopes } from "../../../lib/cloud-oauth-contract";

export const nativeCloudClient = {
  id: "machdoch-client",
  name: "Machdoch client",
  redirectUri: "http://127.0.0.1:43110/oauth/callback",
};
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function singleParameters(
  parameters: URLSearchParams,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of parameters) {
    if (Object.hasOwn(result, key))
      throw new OAuthError(
        "invalid_request",
        "Duplicate parameters are not allowed.",
      );
    result[key] = value;
  }
  return result;
}
const scopeSchema = z
  .string()
  .max(100)
  .default("cloud:read")
  .transform((text) => text.split(" "))
  .pipe(z.array(z.enum(cloudOAuthScopes)).min(1).max(3))
  .refine(
    (scopes) =>
      new Set(scopes).size === scopes.length && scopes.includes("cloud:read"),
  );
export const authorizeSchema = z.object({
  client_id: z.literal(nativeCloudClient.id),
  redirect_uri: z.literal(nativeCloudClient.redirectUri),
  response_type: z.literal("code"),
  code_challenge_method: z.literal("S256"),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  resource: z.url().max(2048),
  state: z.string().min(16).max(1024),
  scope: scopeSchema,
});
const tokenBase = {
  client_id: z.literal(nativeCloudClient.id),
  resource: z.url().max(2048),
};
export const tokenSchema = z.discriminatedUnion("grant_type", [
  z.object({
    ...tokenBase,
    grant_type: z.literal("authorization_code"),
    code: z.string().min(32).max(200),
    redirect_uri: z.literal(nativeCloudClient.redirectUri),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  z.object({
    ...tokenBase,
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(32).max(200),
    scope: z.string().optional(),
  }),
]);
export type TokenInput = z.infer<typeof tokenSchema>;
