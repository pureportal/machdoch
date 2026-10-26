import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  emailSettingsInputSchema,
  type EmailSettingsInput,
} from "../../../lib/cloud-email-contract";
import type { CloudActor } from "../../../lib/cloud-contract";
import { hashOwnerPasswordAsync, hashSecret, createSecret } from "../../crypto";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { CloudMailStore } from "./mail-store";

const password = "A verification password 2026!";
const origin = "https://cloud.example.test";
const cipher = new SettingsCipher(Buffer.alloc(32, 7));
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor,
  member: CloudActor,
  viewer: CloudActor,
  stranger: CloudActor;
let passwordHash: string;
const settings: EmailSettingsInput = {
  revision: 0,
  host: "smtp.example.test",
  port: 465,
  security: "tls",
  tlsName: null,
  username: "smtp-user",
  password: "smtp-fixture-secret",
  from: "signin@example.test",
  enabled: true,
};

beforeAll(async () => {
  database = await createTestCloudDatabase();
  passwordHash = await hashOwnerPasswordAsync(password);
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks,cloud_login_limits",
  );
  runtime = createCloudRuntime(database, origin, { credentialsCipher: cipher });
  const organizationId = randomUUID(),
    other = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Company'),($2,'Other')",
    [organizationId, other],
  );
  const actors: CloudActor[] = [];
  for (const [organization, role, email] of [
    [organizationId, "owner", "owner@example.test"],
    [organizationId, "member", "member@example.test"],
    [organizationId, "viewer", "viewer@example.test"],
    [other, "owner", "other@example.test"],
  ]) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
      [userId, email, role, passwordHash],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organization, userId, role],
    );
    actors.push({ organizationId: organization!, userId });
  }
  [owner, member, viewer, stranger] = actors as [
    CloudActor,
    CloudActor,
    CloudActor,
    CloudActor,
  ];
  await runtime.authentication.emailSettings.save(
    owner,
    randomUUID(),
    settings,
  );
});

async function deliver(
  email = "member@example.test",
  authorizationId?: string,
) {
  await runtime.authentication.magicLinks.request({
    email,
    ...(authorizationId ? { authorizationId } : {}),
  });
  const lease = await runtime.authentication.mailStore.claim();
  expect(lease).not.toBeNull();
  const mail = await runtime.authentication.mailStore.prepare(lease!);
  expect(mail).not.toBeNull();
  expect(await runtime.authentication.mailStore.finish(lease!, null)).toBe(
    true,
  );
  return {
    lease: lease!,
    mail: mail!,
    token: new URL(mail!.url).hash.slice(1),
  };
}

it("encrypts SMTP credentials, restricts administration and requires new credentials for a changed destination", async () => {
  const stored = (
    await database.engine.query<{ secret: Uint8Array }>(
      "SELECT secret FROM cloud_email_settings",
    )
  ).rows[0]!;
  expect(
    Buffer.from(stored.secret).includes(Buffer.from(settings.password!)),
  ).toBe(false);
  const publicSettings = await runtime.authentication.emailSettings.get(owner);
  expect(publicSettings.settings).toMatchObject({
    revision: 1,
    hasPassword: true,
  });
  expect(JSON.stringify(publicSettings)).not.toContain(settings.password!);
  const digest = (
    await database.engine.query<{ digest: string }>(
      "SELECT digest FROM cloud_command_receipts WHERE actor_id=$1",
      [owner.userId],
    )
  ).rows[0]!.digest;
  expect(digest).not.toBe(
    createHash("sha256")
      .update(JSON.stringify({ kind: "email.settings", input: settings }))
      .digest("hex"),
  );
  await expect(
    runtime.authentication.emailSettings.get(viewer),
  ).rejects.toMatchObject({ code: "permission_denied" });
  expect(
    (await runtime.authentication.emailSettings.get(stranger)).settings,
  ).toBeNull();
  const { password: _, ...retained } = settings;
  await expect(
    runtime.authentication.emailSettings.save(owner, randomUUID(), {
      ...retained,
      revision: 1,
      host: "other.example.test",
    }),
  ).rejects.toMatchObject({ code: "email_password_required" });
  const key = randomUUID();
  await runtime.authentication.emailSettings.save(owner, key, {
    ...retained,
    revision: 1,
    from: "updated@example.test",
  });
  await runtime.authentication.emailSettings.save(owner, key, {
    ...retained,
    revision: 1,
    from: "updated@example.test",
  });
  expect(
    (await runtime.authentication.emailSettings.connection(owner, 2)).password,
  ).toBe(settings.password);
  await expect(
    runtime.authentication.emailSettings.save(owner, randomUUID(), {
      ...retained,
      revision: 1,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(
    emailSettingsInputSchema.safeParse({
      ...settings,
      host: "https://smtp.example.test",
    }).success,
  ).toBe(false);
});

it("enqueues known and unknown addresses without looking up membership and discards unavailable recipients during delivery", async () => {
  await runtime.authentication.magicLinks.request({
    email: "member@example.test",
  });
  await runtime.authentication.magicLinks.request({
    email: "absent@example.test",
  });
  const rows = (
    await database.engine.query<{
      user_id: string | null;
      organization_id: string | null;
      payload: Uint8Array;
    }>(
      "SELECT user_id,organization_id,payload FROM cloud_magic_links ORDER BY created_at,id",
    )
  ).rows;
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.user_id).toBeNull();
    expect(row.organization_id).toBeNull();
    expect(Buffer.from(row.payload).toString("utf8")).not.toContain(
      "@example.test",
    );
  }
  let delivered = 0;
  for (let i = 0; i < 2; i++) {
    const lease = (await runtime.authentication.mailStore.claim())!;
    const mail = await runtime.authentication.mailStore.prepare(lease);
    if (mail) {
      delivered++;
      await runtime.authentication.mailStore.finish(lease, null);
    }
  }
  expect(delivered).toBe(1);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_magic_links WHERE delivery_state='discarded' AND payload IS NULL",
      )
    ).rows,
  ).toHaveLength(1);
});

it("previews without consuming, binds confirmation to the browser and consumes once", async () => {
  const { token, lease } = await deliver();
  const prepared = await runtime.authentication.magicLinks.prepare(token);
  expect(prepared.preview).toMatchObject({
    email: "member@example.test",
    organization: "Company",
    currentEmail: null,
  });
  expect(
    (
      await database.engine.query<{
        consumed_at: unknown;
        token_hash: string;
        payload: unknown;
      }>(
        "SELECT consumed_at,token_hash,payload FROM cloud_magic_links WHERE id=$1",
        [lease.id],
      )
    ).rows[0],
  ).toMatchObject({
    consumed_at: null,
    token_hash: hashSecret(token),
    payload: null,
  });
  await expect(
    runtime.authentication.magicLinks.consume(
      prepared.preview.confirmationId,
      createSecret("mch_cloud_confirmation"),
    ),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
  const session = await runtime.authentication.magicLinks.consume(
    prepared.preview.confirmationId,
    prepared.nonce,
  );
  expect(
    await runtime.identity.authenticate(
      session.sessionToken,
      session.csrfToken,
    ),
  ).toEqual(member);
  expect(session.redirect).toBe("/cloud/issues");
  expect(
    await runtime.authentication.magicLinks.consume(
      prepared.preview.confirmationId.toUpperCase(),
      prepared.nonce,
    ),
  ).toEqual(session);
  expect(
    await runtime.authentication.magicLinks.consume(
      prepared.preview.confirmationId,
      prepared.nonce,
    ),
  ).toEqual(session);
  await expect(
    runtime.authentication.magicLinks.prepare(token),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
  expect(
    (await database.engine.query("SELECT id FROM cloud_magic_confirmations"))
      .rows,
  ).toHaveLength(1);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='session.magic_link'",
      )
    ).rows,
  ).toHaveLength(1);
});

it("encrypts short recovery receipts and revokes them on logout without reviving the session", async () => {
  const link = await deliver();
  const prepared = await runtime.authentication.magicLinks.prepare(link.token);
  const session = await runtime.authentication.magicLinks.consume(
    prepared.preview.confirmationId,
    prepared.nonce,
  );
  const stored = (
    await database.engine.query<{ receipt: Uint8Array }>(
      "SELECT receipt FROM cloud_magic_confirmations WHERE id=$1",
      [prepared.preview.confirmationId],
    )
  ).rows[0]!;
  expect(
    Buffer.from(stored.receipt).includes(Buffer.from(session.sessionToken)),
  ).toBe(false);
  await runtime.identity.logout("", prepared.nonce);
  expect(await runtime.identity.authenticate(session.sessionToken)).toBeNull();
  await expect(
    runtime.authentication.magicLinks.consume(
      prepared.preview.confirmationId,
      prepared.nonce,
    ),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
});
it("does not recover an email-link session after another browser revokes it from Account", async () => {
  const link = await deliver();
  const prepared = await runtime.authentication.magicLinks.prepare(link.token);
  const completed = await runtime.authentication.magicLinks.consume(
    prepared.preview.confirmationId,
    prepared.nonce,
  );
  const current = await runtime.identity.login(
    "member@example.test",
    password,
    member.organizationId,
  );
  const target = (
    await runtime.authentication.sessions.list(
      member,
      current.sessionToken,
      member,
    )
  ).find((value) => !value.current)!;
  await runtime.authentication.sessions.revoke(
    member,
    randomUUID(),
    current.sessionToken,
    { scope: "session", id: target.id, account: member },
  );
  expect(
    await runtime.identity.authenticate(completed.sessionToken),
  ).toBeNull();
  await expect(
    runtime.authentication.magicLinks.consume(
      prepared.preview.confirmationId,
      prepared.nonce,
    ),
  ).rejects.toHaveProperty("code", "magic_link_unavailable");
});

it("does not retain a recovery credential beyond its bounded window", async () => {
  const link = await deliver();
  const prepared = await runtime.authentication.magicLinks.prepare(link.token);
  const session = await runtime.authentication.magicLinks.consume(
    prepared.preview.confirmationId,
    prepared.nonce,
  );
  await database.engine.query(
    "UPDATE cloud_magic_confirmations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [prepared.preview.confirmationId],
  );
  await runtime.authentication.mailStore.recover();
  expect(
    (await database.engine.query("SELECT id FROM cloud_magic_confirmations"))
      .rows,
  ).toHaveLength(0);
  await expect(
    runtime.authentication.magicLinks.consume(
      prepared.preview.confirmationId,
      prepared.nonce,
    ),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
  expect(await runtime.identity.authenticate(session.sessionToken)).toEqual(
    member,
  );
});

it("supports independent devices and serializes two completions of one link", async () => {
  const { token } = await deliver();
  const first = await runtime.authentication.magicLinks.prepare(token);
  const second = await runtime.authentication.magicLinks.prepare(token);
  expect(first.nonce).not.toBe(second.nonce);
  const outcomes = await Promise.allSettled([
    runtime.authentication.magicLinks.consume(
      first.preview.confirmationId,
      first.nonce,
    ),
    runtime.authentication.magicLinks.consume(
      second.preview.confirmationId,
      second.nonce,
    ),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    (await database.engine.query("SELECT token_hash FROM cloud_sessions")).rows,
  ).toHaveLength(1);
});

it("keeps a browser's independent preparations usable and identifies account switches", async () => {
  const previous = await runtime.identity.login("owner@example.test", password);
  const one = await deliver(),
    two = await deliver("viewer@example.test");
  const first = await runtime.authentication.magicLinks.prepare(
    one.token,
    owner,
  );
  const second = await runtime.authentication.magicLinks.prepare(
    two.token,
    owner,
    first.nonce,
  );
  expect(first.preview.currentEmail).toBe("owner@example.test");
  expect(second.nonce).toBe(first.nonce);
  expect(await runtime.identity.authenticate(previous.sessionToken)).toEqual(
    owner,
  );
  const session = await runtime.authentication.magicLinks.consume(
    first.preview.confirmationId,
    first.nonce,
    previous.sessionToken,
  );
  expect(await runtime.identity.authenticate(previous.sessionToken)).toBeNull();
  expect(await runtime.identity.authenticate(session.sessionToken)).toEqual(
    member,
  );
  expect(
    (
      await runtime.authentication.magicLinks.inspect(
        second.preview.confirmationId,
        second.nonce,
        member,
      )
    ).email,
  ).toBe("viewer@example.test");
});

it("rejects expired links and expired confirmations without issuing sessions", async () => {
  const one = await deliver();
  await database.engine.query(
    "UPDATE cloud_magic_links SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [one.lease.id],
  );
  await expect(
    runtime.authentication.magicLinks.prepare(one.token),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
  const two = await deliver();
  const prepared = await runtime.authentication.magicLinks.prepare(two.token);
  await database.engine.query(
    "UPDATE cloud_magic_confirmations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [prepared.preview.confirmationId],
  );
  await expect(
    runtime.authentication.magicLinks.consume(
      prepared.preview.confirmationId,
      prepared.nonce,
    ),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
  expect(
    (await database.engine.query("SELECT token_hash FROM cloud_sessions")).rows,
  ).toHaveLength(0);
});

it("does not revive links or sessions after access is suspended and restored", async () => {
  const session = await runtime.identity.login("member@example.test", password);
  const link = await deliver();
  await database.transaction(async (sql) => {
    await sql.query(
      "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
      [member.organizationId, member.userId],
    );
    await sql.query(
      "UPDATE cloud_memberships SET active=true WHERE organization_id=$1 AND user_id=$2",
      [member.organizationId, member.userId],
    );
  });
  expect(await runtime.identity.authenticate(session.sessionToken)).toBeNull();
  await expect(
    runtime.authentication.magicLinks.prepare(link.token),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
  const fresh = await deliver();
  expect(
    (await runtime.authentication.magicLinks.prepare(fresh.token)).preview
      .email,
  ).toBe("member@example.test");
});

it("discards a queued request if credentials changed before recipient resolution", async () => {
  const session = await runtime.identity.login("member@example.test", password);
  await runtime.authentication.magicLinks.request({
    email: "member@example.test",
  });
  await database.transaction(async (sql) => {
    await sql.query(
      "UPDATE cloud_users SET password_hash='changed' WHERE id=$1",
      [member.userId],
    );
    await sql.query("UPDATE cloud_users SET password_hash=$2 WHERE id=$1", [
      member.userId,
      passwordHash,
    ]);
  });
  expect(await runtime.identity.authenticate(session.sessionToken)).toBeNull();
  const lease = (await runtime.authentication.mailStore.claim())!;
  expect(await runtime.authentication.mailStore.prepare(lease)).toBeNull();
});

it("invalidates both queued and delivered links across email sign-in policy changes", async () => {
  const delivered = await deliver();
  await runtime.authentication.magicLinks.request({
    email: "member@example.test",
  });
  const { password: _, ...retained } = settings;
  await runtime.authentication.emailSettings.save(owner, randomUUID(), {
    ...retained,
    revision: 1,
    enabled: false,
  });
  expect(await runtime.authentication.magicLinks.available()).toBe(false);
  await runtime.authentication.emailSettings.save(owner, randomUUID(), {
    ...retained,
    revision: 2,
    enabled: true,
  });
  await expect(
    runtime.authentication.magicLinks.prepare(delivered.token),
  ).rejects.toMatchObject({ code: "magic_link_unavailable" });
  const lease = (await runtime.authentication.mailStore.claim())!;
  expect(await runtime.authentication.mailStore.prepare(lease)).toBeNull();
});

it("recovers delivery leases with stable content, rejects stale completion and bounds retries", async () => {
  await runtime.authentication.magicLinks.request({
    email: "member@example.test",
  });
  const store = runtime.authentication.mailStore;
  const first = (await store.claim())!,
    initial = (await store.prepare(first))!;
  await database.engine.query(
    "UPDATE cloud_magic_links SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [first.id],
  );
  const restarted = new CloudMailStore(database, cipher, origin);
  await restarted.recover();
  const second = (await restarted.claim())!,
    retry = (await restarted.prepare(second))!;
  expect(second.lease).not.toBe(first.lease);
  expect(retry.url).toBe(initial.url);
  expect(retry.messageId).toBe(initial.messageId);
  expect(await store.finish(first, null)).toBe(false);
  expect(await restarted.finish(second, "connection")).toBe(true);
  await database.engine.query(
    "UPDATE cloud_magic_links SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [first.id],
  );
  const third = (await restarted.claim())!;
  await restarted.prepare(third);
  await restarted.finish(third, "authentication");
  expect(
    (
      await database.engine.query<{
        attempts: number;
        delivery_state: string;
        payload: unknown;
      }>(
        "SELECT attempts,delivery_state,payload FROM cloud_magic_links WHERE id=$1",
        [first.id],
      )
    ).rows[0],
  ).toEqual({ attempts: 3, delivery_state: "failed", payload: null });
  expect(await restarted.claim()).toBeNull();
  expect(await runtime.authentication.emailSettings.get(owner)).toMatchObject({
    failedDeliveries: 1,
    lastError: "authentication",
  });
  expect(
    (
      await runtime.authentication.magicLinks.prepare(
        new URL(initial.url).hash.slice(1),
      )
    ).preview.email,
  ).toBe("member@example.test");
});

it("restricts requested organizations and constructs only the stored internal authorization redirect", async () => {
  await runtime.authentication.magicLinks.request({
    email: "member@example.test",
    organizationId: stranger.organizationId,
  });
  const rejected = (await runtime.authentication.mailStore.claim())!;
  expect(await runtime.authentication.mailStore.prepare(rejected)).toBeNull();
  const authorizationId = randomUUID(),
    link = await deliver("member@example.test", authorizationId);
  const prepared = await runtime.authentication.magicLinks.prepare(link.token);
  expect(
    (
      await runtime.authentication.magicLinks.consume(
        prepared.preview.confirmationId,
        prepared.nonce,
      )
    ).redirect,
  ).toBe(`/cloud/authorize?requestId=${authorizationId}`);
});

it("limits credential requests and repeated proof attempts independently", async () => {
  for (let i = 0; i < 8; i++)
    await runtime.identity.limitLogin("address", "member@example.test");
  await expect(
    runtime.identity.limitLogin("address", "member@example.test"),
  ).rejects.toMatchObject({ code: "rate_limited" });
  for (let i = 0; i < 12; i++)
    await runtime.identity.limitMagicProof("address", "confirmation");
  await expect(
    runtime.identity.limitMagicProof("address", "confirmation"),
  ).rejects.toMatchObject({ code: "rate_limited" });
});
