import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import type {
  OidcConfiguration,
  OidcMetadata,
} from "../../../lib/cloud-sso-contract";
import {
  oidcMetadataSchema,
  oidcSubjectSchema,
} from "../../../lib/cloud-sso-contract";

export interface OidcProof {
  verifier: string;
  nonce: string;
  state: string;
}
export interface OidcClaims {
  subject: string;
  display: string;
  authTime: number | null;
  acr: string | null;
}
export type OidcJob =
  | { kind: "discover"; issuer: string }
  | {
      kind: "exchange";
      configuration: OidcConfiguration;
      secret: string;
      proof: OidcProof;
      redirectUri: string;
      callback: string;
    };

export function validateOidcMetadata(
  value: unknown,
  issuer: string,
): OidcMetadata {
  const metadata = oidcMetadataSchema.strip().parse(value);
  if (
    metadata.issuer !== issuer ||
    !metadata.response_types_supported.includes("code") ||
    (metadata.code_challenge_methods_supported &&
      !metadata.code_challenge_methods_supported.includes("S256"))
  )
    throw new Error("Unsupported OIDC metadata");
  return metadata;
}

export function validateOidcConfiguration(value: OidcConfiguration): void {
  const metadata = validateOidcMetadata(value.metadata, value.metadata.issuer);
  if (
    !metadata.id_token_signing_alg_values_supported.includes(value.algorithm) ||
    (metadata.token_endpoint_auth_methods_supported &&
      !metadata.token_endpoint_auth_methods_supported.includes(
        value.authentication,
      )) ||
    (value.displaySource === "userinfo" && !metadata.userinfo_endpoint)
  )
    throw new Error("Unsupported OIDC configuration");
}

export function oidcAuthorization(
  configuration: OidcConfiguration,
  redirectUri: string,
) {
  validateOidcConfiguration(configuration);
  const proof: OidcProof = {
    verifier: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
  const config = new oidc.Configuration(
    configuration.metadata,
    configuration.clientId,
    undefined,
    oidc.None(),
  );
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: "openid profile email",
    code_challenge: createHash("sha256")
      .update(proof.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    nonce: proof.nonce,
    state: proof.state,
    ...(configuration.requiredAcr
      ? { acr_values: configuration.requiredAcr }
      : {}),
    ...(configuration.maxAge !== null
      ? { max_age: String(configuration.maxAge) }
      : {}),
  });
  return { proof, url: url.href };
}

export async function executeOidcJob(
  job: OidcJob,
  fetch: oidc.CustomFetch,
): Promise<OidcMetadata | OidcClaims> {
  if (job.kind === "discover") {
    const config = await oidc.discovery(
      new URL(job.issuer),
      "discovery",
      undefined,
      oidc.None(),
      { [oidc.customFetch]: fetch, timeout: 10 },
    );
    return validateOidcMetadata(config.serverMetadata(), job.issuer);
  }
  const value = job.configuration;
  validateOidcConfiguration(value);
  const callback = new URL(job.callback);
  if (
    callback.origin + callback.pathname !== job.redirectUri ||
    callback.hash ||
    callback.href.length > 16384
  )
    throw new Error("Invalid callback");
  for (const key of new Set(callback.searchParams.keys()))
    if (callback.searchParams.getAll(key).length !== 1)
      throw new Error("Duplicate callback parameter");
  const config = new oidc.Configuration(
    value.metadata,
    value.clientId,
    { id_token_signed_response_alg: value.algorithm },
    value.authentication === "client_secret_basic"
      ? oidc.ClientSecretBasic(job.secret)
      : oidc.ClientSecretPost(job.secret),
  );
  config.timeout = 10;
  config[oidc.customFetch] = fetch;
  oidc.enableNonRepudiationChecks(config);
  const tokens = await oidc.authorizationCodeGrant(config, callback, {
    expectedState: job.proof.state,
    expectedNonce: job.proof.nonce,
    pkceCodeVerifier: job.proof.verifier,
    idTokenExpected: true,
    ...(value.maxAge !== null ? { maxAge: value.maxAge } : {}),
  });
  const claims = tokens.claims();
  if (
    !claims ||
    !oidcSubjectSchema.safeParse(claims.sub).success ||
    (value.requiredAcr !== null && claims.acr !== value.requiredAcr)
  )
    throw new Error("Invalid identity claims");
  const displayClaims =
    value.displaySource === "userinfo"
      ? await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
      : claims;
  const display = displayClaims[value.displayClaim];
  if (
    typeof display !== "string" ||
    !display.trim() ||
    display.length > 512 ||
    [...display].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid display claim");
  return {
    subject: claims.sub,
    display,
    authTime: typeof claims.auth_time === "number" ? claims.auth_time : null,
    acr: typeof claims.acr === "string" ? claims.acr : null,
  };
}
