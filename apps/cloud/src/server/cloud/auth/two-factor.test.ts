import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import { hashOwnerPasswordAsync, hashSecret } from "../../crypto";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { cloudMigrations } from "../database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { issueCloudSession } from "../session-issuance";
import { createTestCloudDatabase } from "../test-database";
import { totpCode, totpStep } from "./totp";

const origin = "https://cloud.example.test";
const password = "Two-factor verification 2026!";
const cipher = new SettingsCipher(Buffer.alloc(32, 9));
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor, admin: CloudActor, member: CloudActor;
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
  const organizationId = randomUUID();
  owner = { organizationId, userId: randomUUID() };
  admin = { organizationId, userId: randomUUID() };
  member = { organizationId, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Acme')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
    [admin, "admin"],
    [member, "member"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
      [actor.userId, `${role}@example.test`, role, passwordHash],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, origin, { credentialsCipher: cipher });
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
function code(secret: string, offset = 0) {
  return totpCode(decodeBase32(secret), totpStep() + offset);
}
function wrongCode(secret: string) {
  const valid = new Set([-1, 0, 1, 2].map((offset) => code(secret, offset)));
  let candidate = 0;
  while (valid.has(String(candidate).padStart(6, "0"))) candidate++;
  return String(candidate).padStart(6, "0");
}
function signIn(actor: CloudActor) {
  return database.transaction((sql) =>
    issueCloudSession(sql, actor.userId, "password", actor.organizationId),
  );
}
async function enroll(actor: CloudActor) {
  const pending = await signIn(actor);
  const setup = await runtime.authentication.twoFactor.setup(
    pending.sessionToken,
    pending.csrfToken,
  );
  const used = code(setup.secret);
  const result = await runtime.authentication.twoFactor.confirmSetup(
    pending.sessionToken,
    pending.csrfToken,
    used,
  );
  return { secret: setup.secret, used, ...result };
}
async function verified(actor: CloudActor, secretCode: string) {
  const pending = await signIn(actor);
  return runtime.authentication.twoFactor.verify(
    pending.sessionToken,
    pending.csrfToken,
    secretCode,
  );
}

it("keeps new sessions pending until an authenticator is confirmed", async () => {
  const pending = await signIn(member);
  expect(await runtime.identity.authenticate(pending.sessionToken)).toBeNull();
  expect(
    await runtime.authentication.twoFactor.challenge(pending.sessionToken),
  ).toEqual({ userId: member.userId, enrolled: false });
  const first = await runtime.authentication.twoFactor.setup(
    pending.sessionToken,
    pending.csrfToken,
  );
  const second = await runtime.authentication.twoFactor.setup(
    pending.sessionToken,
    pending.csrfToken,
  );
  expect(second).toEqual(first);
  expect(first.secret).toMatch(/^[A-Z2-7]{32}$/);
  expect(first.uri).toContain("otpauth://totp/Acme:member%40example.test?");
  const stored = await database.engine.query<{ setup: Uint8Array }>(
    "SELECT authenticator_setup AS setup FROM cloud_sessions WHERE token_hash=$1",
    [hashSecret(pending.sessionToken)],
  );
  expect(Buffer.from(stored.rows[0]!.setup).toString("latin1")).not.toContain(
    decodeBase32(first.secret).toString("latin1"),
  );
  await expect(
    runtime.authentication.twoFactor.confirmSetup(
      pending.sessionToken,
      pending.csrfToken,
      wrongCode(first.secret),
    ),
  ).rejects.toMatchObject({ code: "invalid_setup_code" });
  const result = await runtime.authentication.twoFactor.confirmSetup(
    pending.sessionToken,
    pending.csrfToken,
    code(first.secret),
  );
  expect(result.recoveryCodes).toHaveLength(10);
  expect(result.sessionToken).not.toBe(pending.sessionToken);
  expect(
    await runtime.authentication.twoFactor.challenge(pending.sessionToken),
  ).toBeNull();
  expect(await runtime.identity.authenticate(result.sessionToken)).toEqual(
    member,
  );
  const session = await database.engine.query<{
    setup: Uint8Array | null;
    hours: number;
  }>(
    "SELECT authenticator_setup AS setup,round(extract(epoch FROM expires_at-now())/3600)::integer AS hours FROM cloud_sessions WHERE token_hash=$1",
    [hashSecret(result.sessionToken)],
  );
  expect(session.rows[0]).toEqual({ setup: null, hours: 12 });
  const another = await signIn(member);
  expect(
    await runtime.authentication.twoFactor.challenge(another.sessionToken),
  ).toEqual({ userId: member.userId, enrolled: true });
  await expect(
    runtime.authentication.twoFactor.setup(
      another.sessionToken,
      another.csrfToken,
    ),
  ).rejects.toMatchObject({ code: "two_factor_enabled" });
});

it("expires pending sessions after fifteen minutes", async () => {
  const pending = await signIn(member);
  await database.engine.query(
    "UPDATE cloud_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [hashSecret(pending.sessionToken)],
  );
  expect(
    await runtime.authentication.twoFactor.challenge(pending.sessionToken),
  ).toBeNull();
  await expect(
    runtime.authentication.twoFactor.setup(
      pending.sessionToken,
      pending.csrfToken,
    ),
  ).rejects.toMatchObject({ status: 401 });
});

it("accepts each authenticator code once", async () => {
  const enrolled = await enroll(member);
  const replay = await signIn(member);
  await expect(
    runtime.authentication.twoFactor.verify(
      replay.sessionToken,
      replay.csrfToken,
      enrolled.used,
    ),
  ).rejects.toMatchObject({ code: "invalid_code" });
  const nextCode = code(enrolled.secret, 1);
  const next = await runtime.authentication.twoFactor.verify(
    replay.sessionToken,
    replay.csrfToken,
    nextCode,
  );
  expect(next.remainingRecoveryCodes).toBeNull();
  expect(await runtime.identity.authenticate(next.sessionToken)).toEqual(
    member,
  );
  await expect(verified(member, nextCode)).rejects.toMatchObject({
    code: "invalid_code",
  });
});

it("accepts each recovery code once and reports the remaining codes", async () => {
  const enrolled = await enroll(member);
  const result = await verified(
    member,
    ` ${enrolled.recoveryCodes[0]!.toUpperCase()} `,
  );
  expect(result.remainingRecoveryCodes).toBe(9);
  expect(await runtime.identity.authenticate(result.sessionToken)).toEqual(
    member,
  );
  await expect(
    verified(member, enrolled.recoveryCodes[0]!),
  ).rejects.toMatchObject({ code: "invalid_code" });
  const other = await enroll(admin);
  await expect(verified(member, other.recoveryCodes[0]!)).rejects.toMatchObject(
    { code: "invalid_code" },
  );
});

it("locks authenticator codes for fifteen minutes after ten failures and permanently after one hundred", async () => {
  const enrolled = await enroll(member);
  const pending = await signIn(member);
  const attempt = (value: string) =>
    runtime.authentication.twoFactor.verify(
      pending.sessionToken,
      pending.csrfToken,
      value,
    );
  const age = (failures: number, interval: string) =>
    database.engine.query(
      `UPDATE cloud_authenticators SET failed_attempts=$2,last_failed_at=now()-interval '${interval}' WHERE user_id=$1`,
      [member.userId, failures],
    );
  for (let index = 0; index < 9; index++)
    await expect(attempt(wrongCode(enrolled.secret))).rejects.toMatchObject({
      code: "invalid_code",
    });
  await expect(attempt(wrongCode(enrolled.secret))).rejects.toMatchObject({
    code: "two_factor_locked",
    status: 423,
    message: expect.stringContaining("15 minutes"),
  });
  await expect(attempt(code(enrolled.secret, 1))).rejects.toMatchObject({
    code: "two_factor_locked",
  });
  await age(10, "16 minutes");
  await expect(attempt(wrongCode(enrolled.secret))).rejects.toMatchObject({
    code: "two_factor_locked",
  });
  await age(11, "16 minutes");
  expect((await attempt(code(enrolled.secret, 1))).sessionToken).toBeTruthy();
  const stored = await database.engine.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM cloud_authenticators WHERE user_id=$1",
    [member.userId],
  );
  expect(stored.rows[0]!.failed_attempts).toBe(0);
  await age(99, "1 day");
  await expect(
    verified(member, wrongCode(enrolled.secret)),
  ).rejects.toMatchObject({ code: "two_factor_blocked", status: 423 });
  await age(100, "1 day");
  await expect(
    verified(member, code(enrolled.secret, 1)),
  ).rejects.toMatchObject({ code: "two_factor_blocked" });
  expect(
    (await verified(member, enrolled.recoveryCodes[1]!)).remainingRecoveryCodes,
  ).toBe(9);
  const unlocked = await database.engine.query<{
    failed_attempts: number;
    last_failed_at: Date | null;
  }>(
    "SELECT failed_attempts,last_failed_at FROM cloud_authenticators WHERE user_id=$1",
    [member.userId],
  );
  expect(unlocked.rows[0]).toEqual({
    failed_attempts: 0,
    last_failed_at: null,
  });
});

it("rejects malformed codes without counting them and accepts separators", async () => {
  const enrolled = await enroll(member);
  const pending = await signIn(member);
  for (const value of ["12345", "1234567", "not a code", "ab2cd-ef3g"])
    await expect(
      runtime.authentication.twoFactor.verify(
        pending.sessionToken,
        pending.csrfToken,
        value,
      ),
    ).rejects.toMatchObject({ code: "invalid_code_format", status: 422 });
  const stored = await database.engine.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM cloud_authenticators WHERE user_id=$1",
    [member.userId],
  );
  expect(stored.rows[0]!.failed_attempts).toBe(0);
  const next = code(enrolled.secret, 1);
  const result = await runtime.authentication.twoFactor.verify(
    pending.sessionToken,
    pending.csrfToken,
    `${next.slice(0, 3)}-${next.slice(3)}`,
  );
  expect(await runtime.identity.authenticate(result.sessionToken)).toEqual(
    member,
  );
});

it("never lets password-only sign-ins evict verified sessions", async () => {
  const enrolled = await enroll(member);
  for (let index = 0; index < 9; index++) await signIn(member);
  expect(await runtime.identity.authenticate(enrolled.sessionToken)).toEqual(
    member,
  );
  const sessions = await database.engine.query<{
    verified: boolean;
    count: number;
  }>(
    "SELECT second_factor_at IS NOT NULL AS verified,count(*)::integer AS count FROM cloud_sessions WHERE user_id=$1 GROUP BY 1 ORDER BY 1",
    [member.userId],
  );
  expect(sessions.rows).toEqual([
    { verified: false, count: 5 },
    { verified: true, count: 1 },
  ]);
  for (let index = 0; index < 8; index++)
    await verified(member, enrolled.recoveryCodes[index]!);
  const remaining = await database.engine.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM cloud_sessions WHERE user_id=$1 AND second_factor_at IS NOT NULL",
    [member.userId],
  );
  expect(remaining.rows[0]!.count).toBe(8);
  expect(await runtime.identity.authenticate(enrolled.sessionToken)).toBeNull();
});

it("rejects second-factor requests without the session's CSRF token", async () => {
  const enrolled = await enroll(member);
  const pending = await signIn(member);
  const other = await signIn(admin);
  await expect(
    runtime.authentication.twoFactor.verify(
      pending.sessionToken,
      other.csrfToken,
      code(enrolled.secret, 1),
    ),
  ).rejects.toMatchObject({ code: "invalid_csrf" });
});

it("replaces the authenticator after confirming the current factor and ends other sessions", async () => {
  const enrolled = await enroll(member);
  const other = await verified(member, code(enrolled.secret, 1));
  const replacement = await runtime.authentication.twoFactor.beginReplacement(
    member,
    enrolled.sessionToken,
  );
  expect(replacement.secret).not.toBe(enrolled.secret);
  await expect(
    runtime.authentication.twoFactor.replace(member, enrolled.sessionToken, {
      currentCode: enrolled.recoveryCodes[0]!,
      code: wrongCode(replacement.secret),
    }),
  ).rejects.toMatchObject({
    code: "invalid_setup_code",
    message: "The code from the new app is incorrect.",
  });
  await expect(
    runtime.authentication.twoFactor.replace(member, enrolled.sessionToken, {
      currentCode: wrongCode(enrolled.secret),
      code: code(replacement.secret),
    }),
  ).rejects.toMatchObject({
    code: "invalid_code",
    message: "The current code or recovery code is incorrect.",
  });
  await runtime.authentication.twoFactor.replace(
    member,
    enrolled.sessionToken,
    {
      currentCode: enrolled.recoveryCodes[0]!,
      code: code(replacement.secret),
    },
  );
  expect(await runtime.identity.authenticate(other.sessionToken)).toBeNull();
  expect(await runtime.identity.authenticate(enrolled.sessionToken)).toEqual(
    member,
  );
  expect(await runtime.authentication.twoFactor.status(member)).toMatchObject({
    recoveryCodes: 9,
  });
  await expect(
    verified(member, code(enrolled.secret, 1)),
  ).rejects.toMatchObject({ code: "invalid_code" });
  expect(
    (await verified(member, code(replacement.secret, 1))).sessionToken,
  ).toBeTruthy();
});

it("replaces recovery codes after confirming a current factor", async () => {
  const enrolled = await enroll(member);
  await expect(
    runtime.authentication.twoFactor.regenerateRecoveryCodes(
      member,
      enrolled.sessionToken,
      wrongCode(enrolled.secret),
    ),
  ).rejects.toMatchObject({ code: "invalid_code" });
  const renewed =
    await runtime.authentication.twoFactor.regenerateRecoveryCodes(
      member,
      enrolled.sessionToken,
      code(enrolled.secret, 1),
    );
  expect(renewed.recoveryCodes).toHaveLength(10);
  expect(renewed.recoveryCodes).not.toContain(enrolled.recoveryCodes[0]);
  await expect(
    verified(member, enrolled.recoveryCodes[2]!),
  ).rejects.toMatchObject({ code: "invalid_code" });
  expect(
    (await verified(member, renewed.recoveryCodes[0]!)).remainingRecoveryCodes,
  ).toBe(9);
  await expect(
    runtime.authentication.twoFactor.regenerateRecoveryCodes(
      { ...member, delegation: { tokenHash: "unused", scope: "cloud:write" } },
      enrolled.sessionToken,
      renewed.recoveryCodes[1]!,
    ),
  ).rejects.toMatchObject({ code: "browser_required" });
});

it("lets administrators reset a member's second factor within their role", async () => {
  const memberFactor = await enroll(member);
  const adminFactor = await enroll(admin);
  const ownerFactor = await enroll(owner);
  await database.engine.query(
    `INSERT INTO cloud_oauth_grants(id,client_id,organization_id,user_id,resource,scopes,authentication_epoch,membership_epoch)
    SELECT $1,'client',m.organization_id,m.user_id,'resource',ARRAY['cloud:read'],u.authentication_epoch,m.authentication_epoch
    FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id WHERE m.user_id=$2`,
    [randomUUID(), member.userId],
  );
  await expect(
    runtime.authentication.twoFactor.resetMember(
      member,
      randomUUID(),
      admin.userId,
    ),
  ).rejects.toMatchObject({ code: "permission_denied" });
  await expect(
    runtime.authentication.twoFactor.resetMember(
      admin,
      randomUUID(),
      owner.userId,
    ),
  ).rejects.toMatchObject({ code: "owner_required" });
  await expect(
    runtime.authentication.twoFactor.resetMember(
      admin,
      randomUUID(),
      admin.userId,
    ),
  ).rejects.toMatchObject({ code: "own_two_factor" });
  const key = randomUUID();
  expect(
    await runtime.authentication.twoFactor.resetMember(
      admin,
      key,
      member.userId,
    ),
  ).toEqual({ id: member.userId });
  expect(
    await runtime.authentication.twoFactor.resetMember(
      admin,
      key,
      member.userId,
    ),
  ).toEqual({ id: member.userId });
  expect(
    await runtime.identity.authenticate(memberFactor.sessionToken),
  ).toBeNull();
  const grants = await database.engine.query<{ revoked: boolean }>(
    "SELECT revoked_at IS NOT NULL AS revoked FROM cloud_oauth_grants WHERE user_id=$1",
    [member.userId],
  );
  expect(grants.rows).toEqual([{ revoked: true }]);
  const fresh = await signIn(member);
  expect(
    await runtime.authentication.twoFactor.challenge(fresh.sessionToken),
  ).toEqual({ userId: member.userId, enrolled: false });
  expect(
    (await runtime.administration.get(admin)).members.map((person) => [
      person.id,
      person.twoFactor,
    ]),
  ).toEqual(
    expect.arrayContaining([
      [member.userId, false],
      [admin.userId, true],
      [owner.userId, true],
    ]),
  );
  await runtime.authentication.twoFactor.resetMember(
    owner,
    randomUUID(),
    admin.userId,
  );
  expect(
    await runtime.identity.authenticate(adminFactor.sessionToken),
  ).toBeNull();
  expect(await runtime.identity.authenticate(ownerFactor.sessionToken)).toEqual(
    owner,
  );
  const elsewhere = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Elsewhere')",
    [elsewhere],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
    [elsewhere, member.userId],
  );
  await expect(
    runtime.authentication.twoFactor.resetMember(
      owner,
      randomUUID(),
      member.userId,
    ),
  ).rejects.toMatchObject({ code: "shared_account" });
});

it("requires the second factor before any API access and upgrades the browser session", async () => {
  const address = "127.0.0.1";
  async function call(
    path: string,
    method: string,
    cookies: Record<string, string>,
    body?: unknown,
  ) {
    const headers: Record<string, string> = {
      origin,
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && cookies["__Host-machdoch_cloud_csrf"])
      headers["x-machdoch-cloud-csrf"] = cookies["__Host-machdoch_cloud_csrf"];
    return handleCloudApi(
      new Request(`${origin}/api/v1/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      address,
      runtime,
    );
  }
  function cookiesFrom(response: Response) {
    return Object.fromEntries(
      response.headers
        .getSetCookie()
        .map(
          (cookie) => cookie.split(";", 1)[0]!.split("=") as [string, string],
        ),
    );
  }
  const login = await call(
    "auth/login",
    "POST",
    {},
    {
      email: "member@example.test",
      password,
    },
  );
  expect(login.status).toBe(200);
  const pending = cookiesFrom(login);
  expect((await call("workspace", "GET", pending)).status).toBe(401);
  expect((await call("account/two-factor/setup", "POST", pending)).status).toBe(
    401,
  );
  const setup = await call("auth/two-factor/setup", "POST", pending);
  expect(setup.status).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  const wrong = await call("auth/two-factor/setup/confirm", "POST", pending, {
    code: wrongCode(secret),
  });
  expect(wrong.status).toBe(422);
  const confirmed = await call(
    "auth/two-factor/setup/confirm",
    "POST",
    pending,
    { code: code(secret) },
  );
  expect(confirmed.status).toBe(200);
  expect(
    ((await confirmed.json()) as { recoveryCodes: string[] }).recoveryCodes,
  ).toHaveLength(10);
  const active = cookiesFrom(confirmed);
  expect(active["__Host-machdoch_cloud_session"]).not.toBe(
    pending["__Host-machdoch_cloud_session"],
  );
  expect((await call("workspace", "GET", pending)).status).toBe(401);
  expect((await call("workspace", "GET", active)).status).toBe(200);
  expect(await runtime.authentication.twoFactor.status(member)).toMatchObject({
    recoveryCodes: 10,
  });
  const missingCsrf = await call(
    "auth/two-factor/verify",
    "POST",
    {
      "__Host-machdoch_cloud_session":
        pending["__Host-machdoch_cloud_session"]!,
    },
    { code: code(secret, 1) },
  );
  expect(missingCsrf.status).toBe(403);
});

it("signs out sessions and revokes app grants that predate two-factor authentication", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("036-two-factor.sql");
    for (const migration of cloudMigrations.slice(0, index))
      await engine.exec(
        await readFile(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    const actor = { organizationId: randomUUID(), userId: randomUUID() };
    await engine.query(
      "INSERT INTO cloud_organizations(id,name) VALUES($1,'Upgrade')",
      [actor.organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'upgrade@example.test','Owner','fixture')",
      [actor.userId],
    );
    await engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [actor.organizationId, actor.userId],
    );
    await engine.query(
      `INSERT INTO cloud_sessions(token_hash,csrf_hash,user_id,organization_id,expires_at,authentication_epoch,membership_epoch,authentication_method)
      SELECT 'session','csrf',u.id,m.organization_id,now()+interval '12 hours',u.authentication_epoch,m.authentication_epoch,'password'
      FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id`,
    );
    await engine.query(
      `INSERT INTO cloud_oauth_grants(id,client_id,organization_id,user_id,resource,scopes,authentication_epoch,membership_epoch)
      SELECT $1,'client',m.organization_id,m.user_id,'resource',ARRAY['cloud:read'],u.authentication_epoch,m.authentication_epoch
      FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id`,
      [randomUUID()],
    );
    await engine.exec(
      await readFile(
        new URL("../migrations/036-two-factor.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (await engine.query("SELECT 1 FROM cloud_sessions")).rows,
    ).toHaveLength(0);
    expect(
      (
        await engine.query(
          "SELECT 1 FROM cloud_oauth_grants WHERE revoked_at IS NULL",
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await engine.query("SELECT 1 FROM cloud_users WHERE id=$1", [
          actor.userId,
        ])
      ).rows,
    ).toHaveLength(1);
  } finally {
    await engine.close();
  }
}, 60_000);
