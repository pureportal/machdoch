import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { OidcSave } from "../../../lib/cloud-sso-contract";
import { SettingsCipher } from "../../settings-crypto";
import { hashSecret } from "../../crypto";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { issueCloudSession } from "../session-issuance";
import { nativeCloudClient } from "../oauth/validation";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor, member: CloudActor, stranger: CloudActor;
let providerId: string;
const cipher = new SettingsCipher(Buffer.alloc(32, 12));
const origin = "https://cloud.example.test";
const input: OidcSave = {
  revision: 0,
  name: "Work identity",
  enabled: true,
  clientId: "client",
  secret: "provider-fixture-secret",
  authentication: "client_secret_basic",
  algorithm: "RS256",
  displaySource: "id_token",
  displayClaim: "email",
  requiredAcr: null,
  maxAge: null,
  metadata: {
    issuer: "https://identity.test",
    authorization_endpoint: "https://identity.test/auth",
    token_endpoint: "https://identity.test/token",
    jwks_uri: "https://identity.test/jwks",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  },
};
beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  runtime = createCloudRuntime(database, origin, { credentialsCipher: cipher });
  const org = randomUUID(),
    other = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Company'),($2,'Other')",
    [org, other],
  );
  owner = { organizationId: org, userId: randomUUID() };
  member = { organizationId: org, userId: randomUUID() };
  stranger = { organizationId: other, userId: randomUUID() };
  for (const [actor, role, email] of [
    [owner, "owner", "owner@example.test"],
    [member, "member", "member@example.test"],
    [stranger, "owner", "stranger@example.test"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,'Person','unused')",
      [actor.userId, email],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [actor.organizationId, actor.userId, role],
    );
  }
  providerId = randomUUID();
  await runtime.authentication.ssoProviders.save(
    owner,
    randomUUID(),
    providerId,
    input,
  );
});
async function localSession(actor = owner) {
  return database.transaction((sql) =>
    issueCloudSession(sql, actor.userId, "password", actor.organizationId),
  );
}
async function verifiedFlow(
  mode: "login" | "link" = "link",
  subject = "owner-subject",
  actor = owner,
  token?: string,
) {
  const session = token ?? (await localSession(actor)).sessionToken;
  const start = await runtime.authentication.ssoFlows.begin(
    providerId,
    mode,
    "",
    session,
    mode === "link" ? actor : undefined,
  );
  const state = new URL(start.url).searchParams.get("state")!;
  const row = (
    await database.engine.query<{ id: string }>(
      "UPDATE cloud_sso_flows SET status='verified',proof=NULL,claims=$2 WHERE state_hash=$1 RETURNING id",
      [
        hashSecret(state),
        JSON.stringify({
          subject,
          display: "owner@example.test",
          authTime: null,
          acr: null,
        }),
      ],
    )
  ).rows[0]!;
  return { id: row.id, nonce: start.nonce, session, state };
}
async function complete(flow: Awaited<ReturnType<typeof verifiedFlow>>) {
  await runtime.authentication.ssoFlows.preview(
    flow.id,
    flow.nonce,
    flow.session,
  );
  return runtime.authentication.ssoFlows.consume(
    flow.id,
    flow.nonce,
    flow.session,
  );
}

it("encrypts credentials, denies non-admin edits, pins identity coordinates and requires a new secret for another destination", async () => {
  const saved = await runtime.authentication.ssoProviders.get(owner);
  expect(JSON.stringify(saved)).not.toContain(input.secret);
  const storage = (
    await database.engine.query<{ secret: Uint8Array }>(
      "SELECT secret FROM cloud_sso_providers WHERE id=$1",
      [providerId],
    )
  ).rows[0]!;
  await expect(
    runtime.authentication.ssoProviders.save(
      stranger,
      randomUUID(),
      providerId,
      { ...input, name: "Other organization" },
    ),
  ).rejects.toHaveProperty("code", "23505");
  expect(
    (await runtime.authentication.ssoProviders.get(owner)).providers[0]?.name,
  ).toBe(input.name);
  expect(Buffer.from(storage.secret).includes(Buffer.from(input.secret!))).toBe(
    false,
  );
  await expect(
    runtime.authentication.ssoProviders.get(member),
  ).rejects.toHaveProperty("code", "permission_denied");
  await expect(
    runtime.authentication.ssoProviders.save(
      stranger,
      randomUUID(),
      providerId,
      { ...input, revision: 1 },
    ),
  ).rejects.toHaveProperty("code", "revision_conflict");
  await expect(
    runtime.authentication.ssoProviders.save(owner, randomUUID(), providerId, {
      ...input,
      revision: 1,
      clientId: "other",
    }),
  ).rejects.toHaveProperty("code", "sso_identity_immutable");
  await expect(
    runtime.authentication.ssoProviders.save(owner, randomUUID(), providerId, {
      ...input,
      revision: 1,
      secret: undefined,
      metadata: {
        ...input.metadata,
        token_endpoint: "https://other.test/token",
      },
    }),
  ).rejects.toHaveProperty("code", "sso_secret_required");
});
it("never links by matching email and binds linking to the initiating account and browser", async () => {
  const flow = await verifiedFlow("login", "unknown");
  await expect(
    runtime.authentication.ssoFlows.preview(flow.id, flow.nonce, flow.session),
  ).rejects.toHaveProperty("code", "sso_unmapped");
  const link = await verifiedFlow();
  await expect(
    runtime.authentication.ssoFlows.preview(link.id, "wrong", link.session),
  ).rejects.toHaveProperty("code", "sso_expired");
  await expect(
    runtime.authentication.ssoFlows.preview(
      link.id,
      link.nonce,
      (await localSession(member)).sessionToken,
    ),
  ).rejects.toHaveProperty("code", "sso_link_session");
  const result = await complete(link);
  expect(await runtime.identity.authenticate(result.sessionToken)).toEqual(
    owner,
  );
  expect(await runtime.identity.authenticate(link.session)).toBeNull();
  expect(
    (await runtime.authentication.ssoProviders.get(owner)).providers[0]
      ?.verified,
  ).toBe(true);
});
it("recovers the same completed session after a lost response, but logout ends recovery", async () => {
  const flow = await verifiedFlow();
  const result = await complete(flow);
  expect(
    await runtime.authentication.ssoFlows.consume(
      flow.id,
      flow.nonce,
      flow.session,
    ),
  ).toEqual(result);
  await runtime.identity.logout(result.sessionToken, undefined, flow.nonce);
  await expect(
    runtime.authentication.ssoFlows.consume(flow.id, flow.nonce, ""),
  ).rejects.toHaveProperty("code", "sso_expired");
});
it("does not recover a completed SSO session after it is revoked from Account", async () => {
  const flow = await verifiedFlow();
  const completed = await complete(flow);
  const current = await localSession();
  const target = (
    await runtime.authentication.sessions.list(
      owner,
      current.sessionToken,
      owner,
    )
  ).find((value) => !value.current)!;
  await runtime.authentication.sessions.revoke(
    owner,
    randomUUID(),
    current.sessionToken,
    { scope: "session", id: target.id, account: owner },
  );
  expect(
    await runtime.identity.authenticate(completed.sessionToken),
  ).toBeNull();
  await expect(
    runtime.authentication.ssoFlows.consume(flow.id, flow.nonce, ""),
  ).rejects.toHaveProperty("code", "sso_expired");
});
it("invalidates stale provider flows and never re-exchanges a possibly consumed authorization code", async () => {
  const flow = await verifiedFlow();
  await database.engine.query(
    "UPDATE cloud_sso_flows SET status='exchanging',exchange_expires_at=now()-interval '1 minute' WHERE id=$1",
    [flow.id],
  );
  await expect(
    runtime.authentication.oidcExchange.callback(
      `?code=unknown&state=${flow.state}`,
      flow.nonce,
    ),
  ).rejects.toHaveProperty("code", "sso_expired");
  const next = await verifiedFlow();
  await runtime.authentication.ssoProviders.save(
    owner,
    randomUUID(),
    providerId,
    { ...input, revision: 1, enabled: false },
  );
  await expect(complete(next)).rejects.toHaveProperty("code", "sso_expired");
});
it("invalidates sessions and app grants when a provider is disabled and re-enabled", async () => {
  const session = await complete(await verifiedFlow());
  const requestId = await runtime.authorization.begin(
    new URLSearchParams({
      client_id: nativeCloudClient.id,
      redirect_uri: nativeCloudClient.redirectUri,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
      resource: `${origin}/api/v1/mcp`,
      state: randomUUID(),
      scope: "cloud:read",
    }),
  );
  await runtime.authorization.consent(owner, requestId);
  await runtime.authorization.decide(
    owner,
    requestId,
    true,
    ["cloud:read"],
    session.sessionToken,
  );
  expect(await runtime.authorization.connections(owner)).toHaveLength(1);
  await runtime.authentication.ssoProviders.save(
    owner,
    randomUUID(),
    providerId,
    { ...input, revision: 1, enabled: false },
  );
  await runtime.authentication.ssoProviders.save(
    owner,
    randomUUID(),
    providerId,
    { ...input, revision: 2 },
  );
  expect(await runtime.identity.authenticate(session.sessionToken)).toBeNull();
  expect(await runtime.authorization.connections(owner)).toHaveLength(0);
});
it("requires tested owner SSO, denies local sessions after enforcement and protects the final provider and owner mapping", async () => {
  const local = await localSession();
  await expect(
    runtime.authentication.signinPolicy.save(
      owner,
      randomUUID(),
      { required: true, revision: 0 },
      local.sessionToken,
    ),
  ).rejects.toHaveProperty("code", "sso_test_required");
  const sso = await complete(await verifiedFlow());
  await runtime.authentication.signinPolicy.save(
    owner,
    randomUUID(),
    { required: true, revision: 0 },
    sso.sessionToken,
  );
  expect(await runtime.identity.authenticate(sso.sessionToken)).toBeNull();
  expect(await runtime.identity.authenticate(local.sessionToken)).toBeNull();
  await expect(localSession(member)).rejects.toHaveProperty(
    "code",
    "sso_required",
  );
  const login = await complete(
    await verifiedFlow("login", "owner-subject", owner, ""),
  );
  expect(await runtime.identity.authenticate(login.sessionToken)).toEqual(
    owner,
  );
  await expect(
    runtime.authentication.ssoProviders.save(owner, randomUUID(), providerId, {
      ...input,
      revision: 1,
      enabled: false,
    }),
  ).rejects.toHaveProperty("code", "sso_last_provider");
  await expect(
    runtime.authentication.ssoProviders.unmap(
      owner,
      randomUUID(),
      providerId,
      owner.userId,
      "owner-subject",
    ),
  ).rejects.toHaveProperty("code", "sso_last_owner");
  await runtime.authentication.signinPolicy.save(
    owner,
    randomUUID(),
    { required: false, revision: 1 },
    login.sessionToken,
  );
  expect(await runtime.identity.authenticate(local.sessionToken)).toBeNull();
  expect(await localSession(member)).toHaveProperty("sessionToken");
});
it("does not silently change the account after a confirmation preview", async () => {
  await runtime.authentication.ssoProviders.map(
    owner,
    randomUUID(),
    providerId,
    member.userId,
    "mapped",
  );
  const flow = await verifiedFlow("login", "mapped");
  expect(
    (
      await runtime.authentication.ssoFlows.preview(
        flow.id,
        flow.nonce,
        flow.session,
      )
    ).account,
  ).toBe("member@example.test");
  await runtime.authentication.ssoProviders.unmap(
    owner,
    randomUUID(),
    providerId,
    member.userId,
    "mapped",
  );
  await runtime.authentication.ssoProviders.map(
    owner,
    randomUUID(),
    providerId,
    owner.userId,
    "mapped",
  );
  await expect(
    runtime.authentication.ssoFlows.consume(flow.id, flow.nonce, flow.session),
  ).rejects.toHaveProperty("code", "sso_expired");
});
it("does not revive an unconfirmed SSO proof after membership suspension and restoration", async () => {
  await runtime.authentication.ssoProviders.map(
    owner,
    randomUUID(),
    providerId,
    member.userId,
    "member-subject",
  );
  const flow = await verifiedFlow("login", "member-subject");
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
    [owner.organizationId, member.userId],
  );
  await database.engine.query(
    "UPDATE cloud_memberships SET active=true WHERE organization_id=$1 AND user_id=$2",
    [owner.organizationId, member.userId],
  );
  await expect(
    runtime.authentication.ssoFlows.preview(flow.id, flow.nonce, flow.session),
  ).rejects.toHaveProperty("code", "sso_expired");
});
it("keeps issuer mappings tenant-scoped and invalidates only the mapped organization membership", async () => {
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
    [stranger.organizationId, member.userId],
  );
  const other = await localSession({
    organizationId: stranger.organizationId,
    userId: member.userId,
  });
  const local = await localSession(member);
  await runtime.authentication.ssoProviders.map(
    owner,
    randomUUID(),
    providerId,
    member.userId,
    "member-subject",
  );
  expect(await runtime.identity.authenticate(local.sessionToken)).toBeNull();
  expect(await runtime.identity.authenticate(other.sessionToken)).toEqual({
    organizationId: stranger.organizationId,
    userId: member.userId,
  });
  await expect(
    runtime.authentication.ssoProviders.map(
      stranger,
      randomUUID(),
      providerId,
      stranger.userId,
      "member-subject",
    ),
  ).rejects.toHaveProperty("code", "23503");
});
it("provisions a passwordless member only through explicit subject mapping without merging an existing global account", async () => {
  await complete(await verifiedFlow());
  const input = {
    email: "new@example.test",
    name: "New member",
    role: "member" as const,
    subject: "new-subject",
  };
  const created = await runtime.authentication.ssoProviders.addMember(
    owner,
    randomUUID(),
    providerId,
    input,
  );
  expect(
    (
      await database.engine.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM cloud_users WHERE id=$1",
        [created.userId],
      )
    ).rows[0]!.password_hash,
  ).toBeNull();
  await expect(
    runtime.identity.login(input.email, "No password was ever set"),
  ).rejects.toHaveProperty("code", "invalid_credentials");
  const signedIn = await complete(await verifiedFlow("login", input.subject));
  expect(await runtime.identity.authenticate(signedIn.sessionToken)).toEqual({
    organizationId: owner.organizationId,
    userId: created.userId,
  });
  await expect(
    runtime.authentication.ssoProviders.addMember(
      owner,
      randomUUID(),
      providerId,
      { ...input, email: "stranger@example.test", subject: "other" },
    ),
  ).rejects.toHaveProperty("code", "sso_existing_account");
  expect(
    (
      await database.engine.query(
        "SELECT * FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
        [owner.organizationId, stranger.userId],
      )
    ).rows,
  ).toHaveLength(0);
});
