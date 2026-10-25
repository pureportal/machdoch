import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { InvitationInput } from "../../../lib/cloud-invitation-contract";
import { createSecret, hashOwnerPasswordAsync } from "../../crypto";
import { SettingsCipher } from "../../settings-crypto";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { issueCloudSession } from "../session-issuance";

const password = "Invitation verification 2026!";
const origin = "https://cloud.example.test";
const cipher = new SettingsCipher(Buffer.alloc(32, 23));
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor, admin: CloudActor, outsider: CloudActor;
let providerId: string;
let passwordHash: string;
beforeAll(async () => {
  database = await createTestCloudDatabase();
  passwordHash = await hashOwnerPasswordAsync(password);
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_users,cloud_organizations CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  const organizationId = randomUUID(),
    otherOrganization = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Company'),($2,'Other')",
    [organizationId, otherOrganization],
  );
  owner = { organizationId, userId: randomUUID() };
  admin = { organizationId, userId: randomUUID() };
  outsider = { organizationId: otherOrganization, userId: randomUUID() };
  for (const [actor, role, email] of [
    [owner, "owner", "owner@example.test"],
    [admin, "admin", "admin@example.test"],
    [outsider, "owner", "other@example.test"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,'Person',$3)",
      [actor.userId, email, passwordHash],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [actor.organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, origin, { credentialsCipher: cipher });
  providerId = randomUUID();
  await runtime.authentication.ssoProviders.save(
    owner,
    randomUUID(),
    providerId,
    {
      revision: 0,
      name: "Work identity",
      enabled: true,
      clientId: "client",
      secret: "fixture-secret",
      authentication: "client_secret_basic",
      algorithm: "RS256",
      displaySource: "id_token",
      displayClaim: "sub",
      requiredAcr: null,
      maxAge: null,
      metadata: {
        issuer: "https://idp.test",
        authorization_endpoint: "https://idp.test/auth",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      },
    },
  );
  await database.engine.query(
    "UPDATE cloud_sso_providers SET verified_revision=revision WHERE id=$1",
    [providerId],
  );
});
function inviteInput(email = "new@example.test", sso = false): InvitationInput {
  return {
    organizationId: owner.organizationId,
    email,
    role: "member",
    authentication: sso
      ? { kind: "oidc", providerId, subject: "invited-subject" }
      : { kind: "password" },
  };
}
async function prepare(input = inviteInput(), token = "") {
  const invitation = await runtime.authentication.invitations.create(
    owner,
    randomUUID(),
    input,
  );
  const confirmation = await runtime.authentication.invitations.prepare(
    invitation.token,
    "",
    token,
    "",
  );
  return { invitation, ...confirmation };
}
async function accept(
  value: Awaited<ReturnType<typeof prepare>>,
  session = "",
  ssoBrowser = "",
  input: { name?: string; password?: string; sessionId?: string | null } = {},
) {
  return runtime.authentication.invitationAcceptance.accept(
    {
      confirmationId: value.preview.confirmationId,
      sessionId: value.preview.currentSessionId,
      name: "Invited person",
      ...(value.preview.authentication === "password" &&
      !value.preview.canUseSession
        ? { password }
        : {}),
      ...input,
    },
    value.nonce,
    session,
    ssoBrowser,
  );
}
async function identity(
  value: Awaited<ReturnType<typeof prepare>>,
  subject = "invited-subject",
) {
  const result = await runtime.authentication.invitations.startSso(
    value.preview.confirmationId,
    value.nonce,
    "",
  );
  await database.engine.query(
    "UPDATE cloud_sso_flows SET status='verified',proof=NULL,claims=$2 WHERE id=$1",
    [
      result.id,
      JSON.stringify({
        subject,
        display: "Invited identity",
        authTime: null,
        acr: null,
      }),
    ],
  );
  return result;
}

it("creates one encrypted invitation on retries and rejects privilege and organization-context changes", async () => {
  const key = randomUUID(),
    input = inviteInput();
  const created = await runtime.authentication.invitations.create(
    owner,
    key,
    input,
  );
  expect(
    await runtime.authentication.invitations.create(owner, key, input),
  ).toEqual(created);
  expect(
    JSON.stringify(
      (await database.engine.query("SELECT result FROM cloud_command_receipts"))
        .rows,
    ),
  ).not.toContain(created.token);
  expect(
    (await database.engine.query("SELECT id FROM cloud_invitations")).rows,
  ).toHaveLength(1);
  await expect(
    runtime.authentication.invitations.create(admin, randomUUID(), {
      ...input,
      role: "admin",
    }),
  ).rejects.toHaveProperty("code", "owner_required");
  await expect(
    runtime.authentication.invitations.create(outsider, randomUUID(), input),
  ).rejects.toHaveProperty("code", "account_changed");
});
it("binds previews to the browser, requires an explicit join and recovers the same completed session", async () => {
  const value = await prepare();
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_users WHERE email='new@example.test'",
      )
    ).rows,
  ).toHaveLength(0);
  await expect(
    runtime.authentication.invitations.inspect(
      value.preview.confirmationId,
      createSecret("mch_cloud_invitation"),
      "",
      "",
    ),
  ).rejects.toHaveProperty("code", "invitation_unavailable");
  const result = await accept(value);
  const current = await runtime.identity.authenticate(result.sessionToken);
  expect(current?.organizationId).toBe(owner.organizationId);
  expect(await accept(value)).toEqual(result);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='member.joined'",
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    runtime.authentication.invitations.prepare(
      value.invitation.token,
      "",
      "",
      "",
    ),
  ).rejects.toHaveProperty("code", "invitation_unavailable");
  const preview = await runtime.authentication.invitations.inspect(
    value.preview.confirmationId,
    value.nonce,
    "",
    "",
  );
  expect(preview.completed).toBe(true);
  await runtime.identity.logout(
    result.sessionToken,
    undefined,
    undefined,
    value.nonce,
  );
  await expect(accept(value)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
});
it("requires the existing password or its valid authenticated session without changing profile or credentials", async () => {
  const local = await runtime.identity.login(
    "other@example.test",
    password,
    outsider.organizationId,
  );
  const value = await prepare(
    inviteInput("other@example.test"),
    local.sessionToken,
  );
  expect(value.preview.canUseSession).toBe(true);
  const result = await accept(value, local.sessionToken, "", {
    name: "Must not replace profile",
    password: undefined,
  });
  expect(
    (await runtime.identity.authenticate(result.sessionToken))?.userId,
  ).toBe(outsider.userId);
  const user = (
    await database.engine.query<{ name: string; password_hash: string }>(
      "SELECT name,password_hash FROM cloud_users WHERE id=$1",
      [outsider.userId],
    )
  ).rows[0]!;
  expect(user).toEqual({ name: "Person", password_hash: passwordHash });
  expect(
    (
      await database.engine.query<{ role: string }>(
        "SELECT role FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
        [outsider.organizationId, outsider.userId],
      )
    ).rows[0]?.role,
  ).toBe("owner");
});
it("rejects the wrong account password and a changed account after preview", async () => {
  const value = await prepare(inviteInput("other@example.test"));
  await expect(
    accept(value, "", "", { password: "incorrect password" }),
  ).rejects.toHaveProperty("code", "invalid_credentials");
  const local = await runtime.identity.login(
    "owner@example.test",
    password,
    owner.organizationId,
  );
  await expect(accept(value, local.sessionToken)).rejects.toHaveProperty(
    "code",
    "account_changed",
  );
  const reviewed = await runtime.authentication.invitations.inspect(
    value.preview.confirmationId,
    value.nonce,
    local.sessionToken,
    "",
  );
  const completed = await accept(value, local.sessionToken, "", {
    sessionId: reviewed.currentSessionId,
  });
  expect(
    (await runtime.identity.authenticate(completed.sessionToken))?.userId,
  ).toBe(outsider.userId);
  expect(await runtime.identity.authenticate(local.sessionToken)).toBeNull();
});
it("requires the pinned provider subject and prevents bypass through the ordinary SSO confirmation route", async () => {
  const value = await prepare(inviteInput("new@example.test", true));
  const incorrect = await identity(value, "wrong-subject");
  expect(
    (
      await runtime.authentication.invitations.inspect(
        value.preview.confirmationId,
        value.nonce,
        "",
        incorrect.nonce,
      )
    ).ssoFailure,
  ).toBe("identity_mismatch");
  await expect(accept(value, "", incorrect.nonce)).rejects.toHaveProperty(
    "code",
    "identity_mismatch",
  );
  await expect(
    runtime.authentication.ssoFlows.consume(incorrect.id, incorrect.nonce, ""),
  ).rejects.toHaveProperty("code", "sso_expired");
  const correct = await identity(value);
  const result = await accept(value, "", correct.nonce);
  const actor = (await runtime.identity.authenticate(result.sessionToken))!;
  expect(
    (
      await database.engine.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM cloud_users WHERE id=$1",
        [actor.userId],
      )
    ).rows[0]?.password_hash,
  ).toBeNull();
  expect(
    (
      await database.engine.query<{ subject: string }>(
        "SELECT subject FROM cloud_sso_mappings WHERE organization_id=$1 AND user_id=$2",
        [owner.organizationId, actor.userId],
      )
    ).rows[0]?.subject,
  ).toBe("invited-subject");
  expect(await accept(value, "", correct.nonce)).toEqual(result);
});
it("joins an existing SSO-only account by explicit mapping without changing its other organization's identity or sessions", async () => {
  await database.engine.query(
    "UPDATE cloud_users SET password_hash=NULL WHERE id=$1",
    [outsider.userId],
  );
  const otherProvider = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_sso_providers(id,organization_id,configuration,secret,enabled,verified_revision) SELECT $1,$2,configuration,secret,true,revision FROM cloud_sso_providers WHERE id=$3",
    [otherProvider, outsider.organizationId, providerId],
  );
  await database.engine.query(
    "INSERT INTO cloud_sso_mappings(organization_id,provider_id,user_id,subject) VALUES($1,$2,$3,'source-identity')",
    [outsider.organizationId, otherProvider, outsider.userId],
  );
  const epoch = (
    await database.engine.query<{ authentication_epoch: string }>(
      "SELECT authentication_epoch FROM cloud_sso_providers WHERE id=$1",
      [otherProvider],
    )
  ).rows[0]!.authentication_epoch;
  const otherSession = await database.transaction((sql) =>
    issueCloudSession(
      sql,
      outsider.userId,
      "oidc",
      outsider.organizationId,
      undefined,
      { id: otherProvider, epoch },
    ),
  );
  await expect(
    runtime.authentication.invitations.create(
      owner,
      randomUUID(),
      inviteInput("other@example.test"),
    ),
  ).rejects.toHaveProperty("code", "sso_invitation_required");
  const value = await prepare(inviteInput("other@example.test", true));
  const proof = await identity(value);
  const result = await accept(value, "", proof.nonce);
  expect(
    await runtime.identity.authenticate(otherSession.sessionToken),
  ).toEqual(outsider);
  expect(await runtime.identity.authenticate(result.sessionToken)).toEqual({
    organizationId: owner.organizationId,
    userId: outsider.userId,
  });
  expect(
    (
      await database.engine.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM cloud_users WHERE id=$1",
        [outsider.userId],
      )
    ).rows[0]?.password_hash,
  ).toBeNull();
  expect(
    (
      await database.engine.query<{ subject: string }>(
        "SELECT subject FROM cloud_sso_mappings WHERE organization_id=$1 AND user_id=$2",
        [outsider.organizationId, outsider.userId],
      )
    ).rows[0]?.subject,
  ).toBe("source-identity");
});
it("fences revoked invitations, inviter restoration and provider/policy changes", async () => {
  const revoked = await prepare();
  await runtime.administration.revokeInvitation(
    owner,
    randomUUID(),
    revoked.invitation.id,
  );
  await expect(accept(revoked)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
  const changed = await prepare(inviteInput("changed@example.test"));
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
    [owner.organizationId, owner.userId],
  );
  await database.engine.query(
    "UPDATE cloud_memberships SET active=true WHERE organization_id=$1 AND user_id=$2",
    [owner.organizationId, owner.userId],
  );
  await expect(accept(changed)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
  const sso = await prepare(inviteInput("sso@example.test", true));
  await database.engine.query(
    "UPDATE cloud_sso_providers SET revision=revision+1 WHERE id=$1",
    [providerId],
  );
  await expect(
    runtime.authentication.invitations.startSso(
      sso.preview.confirmationId,
      sso.nonce,
      "",
    ),
  ).rejects.toHaveProperty("code", "invitation_unavailable");
  const policy = await prepare(inviteInput("policy@example.test"));
  await database.engine.query(
    "INSERT INTO cloud_signin_policies(organization_id,required_sso) VALUES($1,true)",
    [owner.organizationId],
  );
  await expect(accept(policy)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
});
it("never merges a newly appeared account or overrides a membership changed after invitation creation", async () => {
  const appeared = await prepare();
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'new@example.test','Someone',$2)",
    [randomUUID(), passwordHash],
  );
  await expect(accept(appeared)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
  const changed = await prepare(inviteInput("other@example.test"));
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [owner.organizationId, outsider.userId],
  );
  await expect(accept(changed)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
  expect(
    (
      await database.engine.query<{ role: string }>(
        "SELECT role FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
        [owner.organizationId, outsider.userId],
      )
    ).rows[0]?.role,
  ).toBe("admin");
});
it("expires proof windows and lets a valid invitation restart an expired SSO attempt", async () => {
  const value = await prepare(inviteInput("new@example.test", true));
  const proof = await identity(value);
  await database.engine.query(
    "UPDATE cloud_sso_flows SET expires_at=now()-interval '1 second' WHERE id=$1",
    [proof.id],
  );
  expect(
    (
      await runtime.authentication.invitations.inspect(
        value.preview.confirmationId,
        value.nonce,
        "",
        proof.nonce,
      )
    ).ssoFailure,
  ).toBe("expired");
  const restarted = await identity(value);
  expect(restarted.id).not.toBe(proof.id);
  await database.engine.query(
    "UPDATE cloud_invitation_confirmations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [value.preview.confirmationId],
  );
  await expect(accept(value, "", restarted.nonce)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
});
it("does not restore an accepted invitation session after account revocation", async () => {
  const value = await prepare();
  const result = await accept(value);
  const actor = (await runtime.identity.authenticate(result.sessionToken))!;
  const current = await runtime.identity.login(
    "new@example.test",
    password,
    actor.organizationId,
  );
  const target = (
    await runtime.authentication.sessions.list(
      actor,
      current.sessionToken,
      actor,
    )
  ).find((row) => !row.current)!;
  await runtime.authentication.sessions.revoke(
    actor,
    randomUUID(),
    current.sessionToken,
    { scope: "session", id: target.id, account: actor },
  );
  await expect(accept(value)).rejects.toHaveProperty(
    "code",
    "invitation_unavailable",
  );
  expect(
    (
      await database.engine.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM cloud_users WHERE email='new@example.test'",
      )
    ).rows[0]?.count,
  ).toBe(1);
});
it("requires owner authority to change sign-in roots while administrators can still invite ordinary members", async () => {
  const settings = (await runtime.authentication.ssoProviders.get(admin))
    .providers[0]!;
  const { id, verified: _verified, ...update } = settings;
  await expect(
    runtime.authentication.ssoProviders.save(admin, randomUUID(), id, update),
  ).rejects.toHaveProperty("code", "owner_required");
  await expect(
    runtime.authentication.ssoProviders.save(
      admin,
      randomUUID(),
      randomUUID(),
      { ...update, revision: 0, secret: "fixture-secret" },
    ),
  ).rejects.toHaveProperty("code", "owner_required");
  await expect(
    runtime.authentication.emailSettings.save(admin, randomUUID(), {
      revision: 0,
      host: "smtp.example.test",
      port: 465,
      security: "tls",
      tlsName: null,
      username: null,
      from: "signin@example.test",
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "owner_required");
  expect(
    (await runtime.authentication.ssoProviders.get(owner)).providers[0]!
      .revision,
  ).toBe(1);
  expect(
    (await runtime.authentication.emailSettings.get(owner)).settings,
  ).toBeNull();
  const invite = await runtime.authentication.invitations.create(
    admin,
    randomUUID(),
    inviteInput(),
  );
  expect(invite).toHaveProperty("token");
});
it("does not silently downgrade an inactive owner through an administrator invitation", async () => {
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role,active) VALUES($1,$2,'owner',false)",
    [owner.organizationId, outsider.userId],
  );
  await expect(
    runtime.authentication.invitations.create(
      admin,
      randomUUID(),
      inviteInput("other@example.test"),
    ),
  ).rejects.toHaveProperty("code", "owner_required");
});
it("does not report an accepted invitation as revoked or return a stale creation receipt as a usable link", async () => {
  const key = randomUUID(),
    input = inviteInput();
  const invitation = await runtime.authentication.invitations.create(
    owner,
    key,
    input,
  );
  const value = {
    invitation,
    ...(await runtime.authentication.invitations.prepare(
      invitation.token,
      "",
      "",
      "",
    )),
  };
  await accept(value);
  await expect(
    runtime.administration.revokeInvitation(owner, randomUUID(), invitation.id),
  ).rejects.toHaveProperty("code", "invitation_accepted");
  await expect(
    runtime.authentication.invitations.create(owner, key, input),
  ).rejects.toHaveProperty("code", "invitation_changed");
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='invitation.revoked'",
      )
    ).rows,
  ).toHaveLength(0);
  expect((await runtime.administration.get(owner)).invitations).toHaveLength(0);
});
