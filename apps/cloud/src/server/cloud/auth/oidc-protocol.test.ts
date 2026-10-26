import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import type { OidcConfiguration } from "../../../lib/cloud-sso-contract";
import {
  executeOidcJob,
  oidcAuthorization,
  validateOidcMetadata,
} from "./oidc-protocol";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
const configuration: OidcConfiguration = {
  name: "Identity",
  clientId: "client",
  authentication: "client_secret_basic",
  algorithm: "RS256",
  displaySource: "id_token",
  displayClaim: "email",
  requiredAcr: null,
  maxAge: null,
  metadata: {
    issuer: "https://issuer.test",
    authorization_endpoint: "https://login.test/authorize",
    token_endpoint: "https://tokens.test/token",
    jwks_uri: "https://keys.test/jwks",
    userinfo_endpoint: "https://user.test/me",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
  },
};
const redirectUri = "https://cloud.test/api/v1/auth/sso/callback";

function exchange(
  options: {
    claims?: Record<string, unknown>;
    userinfo?: Record<string, unknown>;
    signature?: boolean;
    query?: string;
    config?: Partial<OidcConfiguration>;
    pkce?: boolean;
  } = {},
) {
  const config = { ...configuration, ...options.config };
  const { proof, url } = oidcAuthorization(config, redirectUri);
  const parameters = new URL(url).searchParams;
  const payload = {
    iss: config.metadata.issuer,
    aud: config.clientId,
    sub: "stable-subject",
    email: "owner@example.test",
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce: proof.nonce,
    ...options.claims,
  };
  const message = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const token = `${message}.${options.signature === false ? Buffer.alloc(256, 1).toString("base64url") : sign("sha256", Buffer.from(message), privateKey).toString("base64url")}`;
  const calls: string[] = [];
  const fetch: CustomFetch = async (destination, init) => {
    calls.push(destination);
    if (destination === config.metadata.token_endpoint) {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("redirect_uri")).toBe(redirectUri);
      const challenge = createHash("sha256")
        .update(body.get("code_verifier")!)
        .digest("base64url");
      expect(challenge).toBe(parameters.get("code_challenge"));
      if (config.authentication === "client_secret_basic")
        expect(new Headers(init.headers).get("authorization")).toMatch(
          /^Basic /,
        );
      else {
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        expect(body.get("client_secret")).toBe("fixture-secret");
      }
      if (options.pkce === false)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "fixture-access",
        token_type: "Bearer",
        expires_in: 300,
        id_token: token,
      });
    }
    if (destination === config.metadata.jwks_uri)
      return Response.json({ keys: [jwk] });
    if (destination === config.metadata.userinfo_endpoint)
      return Response.json(
        options.userinfo ?? {
          sub: "stable-subject",
          email: "info@example.test",
        },
      );
    throw new Error("Unexpected destination");
  };
  const result = executeOidcJob(
    {
      kind: "exchange",
      configuration: config,
      proof,
      secret: "fixture-secret",
      redirectUri,
      callback: `${redirectUri}?code=fixture&state=${proof.state}${options.query ?? ""}`,
    },
    fetch,
  );
  return { result, calls, parameters };
}

it("uses S256 and verifies signed ID tokens through the pinned JWKS endpoint", async () => {
  const run = exchange();
  expect(run.parameters.get("code_challenge_method")).toBe("S256");
  expect(run.parameters.get("response_type")).toBe("code");
  expect(await run.result).toEqual({
    subject: "stable-subject",
    display: "owner@example.test",
    authTime: null,
    acr: null,
  });
  expect(run.calls).toEqual([
    configuration.metadata.token_endpoint,
    configuration.metadata.jwks_uri,
  ]);
});
it.each([
  { signature: false },
  { claims: { iss: "https://other.test" } },
  { claims: { aud: "other" } },
  { claims: { nonce: "wrong" } },
  { claims: { exp: 1 } },
  { claims: { sub: "" } },
  { claims: { sub: "invalid\u0000subject" } },
  { query: "&state=duplicate" },
  { query: "&code=duplicate" },
  { pkce: false },
  { claims: { email: undefined } },
  { config: { requiredAcr: "mfa" } },
  {
    config: { maxAge: 60 },
    claims: { auth_time: Math.floor(Date.now() / 1000) - 600 },
  },
])("rejects invalid identity evidence: %j", async (options) => {
  await expect(exchange(options).result).rejects.toBeInstanceOf(Error);
});
it("checks UserInfo subject and never replaces ID-token security claims with profile claims", async () => {
  const config = {
    displaySource: "userinfo" as const,
    requiredAcr: "mfa",
    maxAge: 300,
  };
  await expect(
    exchange({
      config,
      claims: { acr: "mfa", auth_time: Math.floor(Date.now() / 1000) },
      userinfo: { sub: "wrong", email: "same@example.test" },
    }).result,
  ).rejects.toBeInstanceOf(Error);
  expect(
    await exchange({
      config,
      claims: { acr: "mfa", auth_time: Math.floor(Date.now() / 1000) },
      userinfo: {
        sub: "stable-subject",
        email: "info@example.test",
        acr: "weak",
      },
    }).result,
  ).toMatchObject({
    subject: "stable-subject",
    display: "info@example.test",
    acr: "mfa",
  });
});
it("uses the explicitly selected POST client authentication method", async () => {
  expect(
    await exchange({ config: { authentication: "client_secret_post" } }).result,
  ).toMatchObject({ subject: "stable-subject" });
});
it("requires exact HTTPS issuer and code flow while tolerating omitted PKCE advertisement", () => {
  expect(
    validateOidcMetadata(
      {
        ...configuration.metadata,
        code_challenge_methods_supported: undefined,
      },
      configuration.metadata.issuer,
    ).issuer,
  ).toBe(configuration.metadata.issuer);
  for (const change of [
    { issuer: "https://issuer.test/" },
    { token_endpoint: "http://tokens.test" },
    { token_endpoint: "https://user:secret@tokens.test" },
    { response_types_supported: ["token"] },
    { code_challenge_methods_supported: ["plain"] },
  ])
    expect(() =>
      validateOidcMetadata(
        { ...configuration.metadata, ...change },
        configuration.metadata.issuer,
      ),
    ).toThrow();
});
