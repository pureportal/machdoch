import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import { hashOwnerPasswordAsync, hashSecret } from "../../crypto";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { issueCloudSession } from "../session-issuance";
import { createTestCloudDatabase } from "../test-database";
import { replaceRequestCookies } from "./remembered-navigation";
import { rememberedSessionCookie } from "./remembered-sessions";
import { totpCode, totpStep } from "./totp";

const origin = "https://cloud.example.test";
const password = "Remembered session verification 2026!";
const cipher = new SettingsCipher(Buffer.alloc(32, 7));
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let member: CloudActor;
let passwordHash: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
  passwordHash = await hashOwnerPasswordAsync(password);
}, 30_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_login_limits",
  );
  member = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Acme')",
    [member.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'member@example.test','Member',$2)",
    [member.userId, passwordHash],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
    [member.organizationId, member.userId],
  );
  runtime = createCloudRuntime(database, origin, { credentialsCipher: cipher });
  secret = null;
});

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    current = 0;
  const bytes: number[] = [];
  for (const character of value) {
    current = (current << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((current >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}
let secret: Buffer | null = null;
async function signIn(remember: boolean) {
  const pending = await database.transaction((sql) =>
    issueCloudSession(sql, member.userId, "password", member.organizationId),
  );
  if (secret) {
    await database.engine.query(
      "UPDATE cloud_authenticators SET last_step=0 WHERE user_id=$1",
      [member.userId],
    );
    return runtime.authentication.twoFactor.verify(
      pending.sessionToken,
      pending.csrfToken,
      totpCode(secret, totpStep()),
      remember,
    );
  }
  const setup = await runtime.authentication.twoFactor.setup(
    pending.sessionToken,
    pending.csrfToken,
  );
  secret = decodeBase32(setup.secret);
  return runtime.authentication.twoFactor.confirmSetup(
    pending.sessionToken,
    pending.csrfToken,
    totpCode(secret, totpStep()),
    remember,
  );
}
async function idle(sessionToken: string) {
  await database.engine.query(
    "UPDATE cloud_sessions SET touched_at=now()-interval '31 minutes' WHERE token_hash=$1",
    [hashSecret(sessionToken)],
  );
}
async function sessionCount() {
  return (await database.engine.query("SELECT 1 FROM cloud_sessions")).rows
    .length;
}

it("remembers a verified session only when requested", async () => {
  expect((await signIn(false)).remember).toBeNull();
  const remembered = await signIn(true);
  expect(remembered.remember?.maxAge).toBe(30 * 24 * 60 * 60);
  const stored = await database.engine.query<{ remember_hash: string }>(
    "SELECT remember_hash FROM cloud_sessions WHERE token_hash=$1",
    [hashSecret(remembered.sessionToken)],
  );
  expect(stored.rows[0]?.remember_hash).toBe(
    hashSecret(remembered.remember!.token),
  );
});

it("leaves a still valid session untouched", async () => {
  const signedIn = await signIn(true);
  expect(
    await runtime.authentication.rememberedSessions.restore(
      signedIn.sessionToken,
      signedIn.remember!.token,
    ),
  ).toEqual({ kind: "unchanged" });
});

it("restores an idle session with fresh credentials and rotates the remember token", async () => {
  const signedIn = await signIn(true);
  await idle(signedIn.sessionToken);
  expect(await runtime.identity.authenticate(signedIn.sessionToken)).toBeNull();
  const restored = await runtime.authentication.rememberedSessions.restore(
    signedIn.sessionToken,
    signedIn.remember!.token,
  );
  if (restored.kind !== "restored") throw new Error("Session not restored.");
  expect(restored.sessionToken).not.toBe(signedIn.sessionToken);
  expect(restored.remember?.token).not.toBe(signedIn.remember!.token);
  expect(restored.remember!.maxAge).toBeGreaterThan(29 * 24 * 60 * 60);
  expect(await runtime.identity.authenticate(restored.sessionToken)).toEqual(
    member,
  );
  expect(await runtime.identity.authenticate(signedIn.sessionToken)).toBeNull();
  expect(await sessionCount()).toBe(1);
});

it("tolerates concurrent restores but revokes the session when an old token is replayed later", async () => {
  const signedIn = await signIn(true);
  await idle(signedIn.sessionToken);
  const first = await runtime.authentication.rememberedSessions.restore(
    "",
    signedIn.remember!.token,
  );
  expect(first.kind).toBe("restored");
  const concurrent = await runtime.authentication.rememberedSessions.restore(
    "",
    signedIn.remember!.token,
  );
  if (concurrent.kind !== "restored") throw new Error("Session not restored.");
  expect(concurrent.remember).toBeNull();
  await database.engine.query(
    "UPDATE cloud_sessions SET remember_rotated_at=now()-interval '1 minute'",
  );
  expect(
    await runtime.authentication.rememberedSessions.restore(
      "",
      signedIn.remember!.token,
    ),
  ).toEqual({ kind: "forgotten" });
  expect(await sessionCount()).toBe(0);
  expect(
    await runtime.identity.authenticate(concurrent.sessionToken),
  ).toBeNull();
  expect(
    (
      await database.engine.query(
        "SELECT 1 FROM cloud_outbox WHERE kind='sessions.remembered_token_reused'",
      )
    ).rows,
  ).toHaveLength(1);
});

it("forgets remembered sessions after expiry, password changes and deactivation", async () => {
  const expired = await signIn(true);
  await database.engine.query(
    "UPDATE cloud_sessions SET remembered_until=now()-interval '1 second',expires_at=now()-interval '1 second'",
  );
  expect(
    await runtime.authentication.rememberedSessions.restore(
      "",
      expired.remember!.token,
    ),
  ).toEqual({ kind: "forgotten" });
  expect(await sessionCount()).toBe(0);

  const changed = await signIn(true);
  await database.engine.query(
    "UPDATE cloud_users SET password_hash=$2 WHERE id=$1",
    [member.userId, await hashOwnerPasswordAsync("Another password 2026!")],
  );
  expect(
    await runtime.authentication.rememberedSessions.restore(
      "",
      changed.remember!.token,
    ),
  ).toEqual({ kind: "forgotten" });

  const deactivated = await signIn(true);
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE user_id=$1",
    [member.userId],
  );
  expect(
    await runtime.authentication.rememberedSessions.restore(
      "",
      deactivated.remember!.token,
    ),
  ).toEqual({ kind: "forgotten" });
  expect(
    await runtime.authentication.rememberedSessions.restore("", "invalid"),
  ).toEqual({ kind: "forgotten" });
});

it("keeps idle remembered sessions listed and revocable", async () => {
  const current = await signIn(false);
  const remembered = await signIn(true);
  await idle(remembered.sessionToken);
  await runtime.authentication.mailStore.recover();
  const sessions = await runtime.authentication.sessions.list(
    member,
    current.sessionToken,
    member,
  );
  expect(sessions).toHaveLength(2);
  const other = sessions.find((session) => !session.current)!;
  expect(Date.parse(other.expiresAt)).toBeGreaterThan(
    Date.now() + 29 * 24 * 60 * 60 * 1000,
  );
  await runtime.authentication.sessions.revoke(
    member,
    randomUUID(),
    current.sessionToken,
    { scope: "session", id: other.id, account: member },
  );
  expect(
    await runtime.authentication.rememberedSessions.restore(
      "",
      remembered.remember!.token,
    ),
  ).toEqual({ kind: "forgotten" });
});

it("removes idle sessions that are no longer restorable", async () => {
  const forgotten = await signIn(false);
  await idle(forgotten.sessionToken);
  await runtime.authentication.mailStore.recover();
  expect(await sessionCount()).toBe(0);
});

it("sets the remember cookie at sign-in and clears it at sign-out", async () => {
  const pending = await database.transaction((sql) =>
    issueCloudSession(sql, member.userId, "password", member.organizationId),
  );
  const cookies = {
    "__Host-machdoch_cloud_session": pending.sessionToken,
    "__Host-machdoch_cloud_csrf": pending.csrfToken,
  };
  const call = (path: string, values: Record<string, string>, body?: unknown) =>
    handleCloudApi(
      new Request(`${origin}/api/v1/${path}`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-machdoch-cloud-csrf": values["__Host-machdoch_cloud_csrf"] ?? "",
          cookie: Object.entries(values)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      "127.0.0.1",
      runtime,
    );
  const setup = (await (
    await call("auth/two-factor/setup", cookies)
  ).json()) as {
    secret: string;
  };
  const confirmed = await call("auth/two-factor/setup/confirm", cookies, {
    code: totpCode(decodeBase32(setup.secret), totpStep()),
    remember: true,
  });
  expect(confirmed.status).toBe(200);
  const issued = confirmed.headers.getSetCookie();
  const remember = issued.find((cookie) =>
    cookie.startsWith(`${rememberedSessionCookie}=mch_cloud_remember_`),
  );
  expect(remember).toContain("HttpOnly; Secure; SameSite=Strict");
  expect(remember).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  const active = Object.fromEntries(
    issued.map(
      (cookie) => cookie.split(";", 1)[0]!.split("=") as [string, string],
    ),
  );
  const signedOut = await call("auth/logout", active);
  expect(signedOut.status).toBe(200);
  expect(signedOut.headers.getSetCookie()).toContain(
    `${rememberedSessionCookie}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  );
  expect(await sessionCount()).toBe(0);
});

it("signs out a remembered browser whose session cookie is gone", async () => {
  const signedIn = await signIn(true);
  await runtime.identity.logout(
    "",
    undefined,
    undefined,
    undefined,
    signedIn.remember!.token,
  );
  expect(await sessionCount()).toBe(0);
});

it("replaces restored credentials in the forwarded cookie header", () => {
  expect(
    replaceRequestCookies("theme=dark; session=old; remember=old", {
      session: "new",
      remember: "next",
    }),
  ).toBe("theme=dark; session=new; remember=next");
  expect(replaceRequestCookies(undefined, { session: "new" })).toBe(
    "session=new",
  );
});
