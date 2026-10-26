import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import { hashOwnerPasswordAsync, hashSecret } from "../../crypto";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { issueCloudSession } from "../session-issuance";
import { handleCloudApi } from "../api";
import { browserSessionContext } from "./session-context";

const password = "Account session verification 2026!";
const origin = "https://cloud.example.test";
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let actor: CloudActor, otherOrganization: CloudActor, otherUser: CloudActor;
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
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID(),
    secondOrganizationId = randomUUID();
  actor = { organizationId, userId: randomUUID() };
  otherOrganization = {
    organizationId: secondOrganizationId,
    userId: actor.userId,
  };
  otherUser = { organizationId, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Company'),($2,'Other company')",
    [organizationId, secondOrganizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'owner@example.test','Owner',$3),($2,'other@example.test','Other',$3)",
    [actor.userId, otherUser.userId, passwordHash],
  );
  for (const identity of [actor, otherOrganization, otherUser])
    await database.engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
      [identity.organizationId, identity.userId],
    );
  runtime = createCloudRuntime(database, origin);
});
async function session(identity = actor) {
  return database.transaction((sql) =>
    issueCloudSession(
      sql,
      identity.userId,
      "password",
      identity.organizationId,
      undefined,
      undefined,
      { browser: "Firefox", platform: "Windows", address: "127.0.0.1" },
    ),
  );
}
async function id(token: string) {
  return (
    await database.engine.query<{ id: string }>(
      "SELECT id FROM cloud_sessions WHERE token_hash=$1",
      [hashSecret(token)],
    )
  ).rows[0]!.id;
}

it("lists only this account's active organization sessions and never returns credential hashes", async () => {
  const current = await session();
  const second = await session();
  await session(otherOrganization);
  await session(otherUser);
  const values = await runtime.authentication.sessions.list(
    actor,
    current.sessionToken,
    actor,
  );
  expect(values).toHaveLength(2);
  expect(values[0]?.current).toBe(true);
  expect(values[1]?.id).toBe(await id(second.sessionToken));
  expect(values[0]).toMatchObject({
    browser: "Firefox",
    platform: "Windows",
    address: "127.0.0.1",
    method: "password",
  });
  const serialized = JSON.stringify(values);
  expect(serialized).not.toContain(hashSecret(current.sessionToken));
  expect(serialized).not.toContain(hashSecret(current.csrfToken));
  await database.engine.query(
    "UPDATE cloud_sessions SET touched_at=now()-interval '31 minutes' WHERE token_hash=$1",
    [hashSecret(second.sessionToken)],
  );
  expect(
    await runtime.authentication.sessions.list(
      actor,
      current.sessionToken,
      actor,
    ),
  ).toHaveLength(1);
  expect(await runtime.identity.authenticate(second.sessionToken)).toBeNull();
});
it("keeps session caps within an organization so one SSO realm cannot evict another realm's sessions", async () => {
  const elsewhere = await session(otherOrganization);
  const first = await session();
  let latest = first;
  for (let index = 0; index < 9; index++) latest = await session();
  expect(
    await runtime.authentication.sessions.list(
      actor,
      latest.sessionToken,
      actor,
    ),
  ).toHaveLength(8);
  expect(await runtime.identity.authenticate(first.sessionToken)).toBeNull();
  expect(await runtime.identity.authenticate(elsewhere.sessionToken)).toEqual(
    otherOrganization,
  );
});
it("revokes one session idempotently without revoking a newer or unrelated session", async () => {
  const current = await session(),
    target = await session(),
    unrelated = await session(otherUser);
  const key = randomUUID();
  const input = {
    scope: "session" as const,
    id: await id(target.sessionToken),
    account: actor,
  };
  expect(
    await runtime.authentication.sessions.revoke(
      actor,
      key,
      current.sessionToken,
      input,
    ),
  ).toEqual({ signedOut: false, revoked: 1 });
  expect(
    await runtime.authentication.sessions.revoke(
      actor,
      key,
      current.sessionToken,
      input,
    ),
  ).toEqual({ signedOut: false, revoked: 1 });
  expect(await runtime.identity.authenticate(target.sessionToken)).toBeNull();
  expect(await runtime.identity.authenticate(unrelated.sessionToken)).toEqual(
    otherUser,
  );
  const events = await database.engine.query(
    "SELECT * FROM cloud_outbox WHERE kind='sessions.revoked'",
  );
  expect(events.rows).toHaveLength(1);
  expect(
    await runtime.authentication.sessions.revoke(
      actor,
      randomUUID(),
      current.sessionToken,
      { ...input, id: await id(unrelated.sessionToken) },
    ),
  ).toEqual({ signedOut: false, revoked: 0 });
});
it("signs out other organization sessions, preserves the current one, and then revokes the current session explicitly", async () => {
  const current = await session(),
    target = await session(),
    elsewhere = await session(otherOrganization);
  expect(
    await runtime.authentication.sessions.revoke(
      actor,
      randomUUID(),
      current.sessionToken,
      { scope: "other_sessions", account: actor },
    ),
  ).toEqual({ signedOut: false, revoked: 1 });
  expect(await runtime.identity.authenticate(current.sessionToken)).toEqual(
    actor,
  );
  expect(await runtime.identity.authenticate(target.sessionToken)).toBeNull();
  expect(await runtime.identity.authenticate(elsewhere.sessionToken)).toEqual(
    otherOrganization,
  );
  expect(
    await runtime.authentication.sessions.revoke(
      actor,
      randomUUID(),
      current.sessionToken,
      { scope: "session", account: actor, id: await id(current.sessionToken) },
    ),
  ).toEqual({ signedOut: true, revoked: 1 });
  await expect(
    runtime.authentication.sessions.list(actor, current.sessionToken, actor),
  ).rejects.toHaveProperty("status", 401);
});
it("rejects stale account/organization pages and revoked authority", async () => {
  const current = await session();
  await expect(
    runtime.authentication.sessions.list(
      actor,
      current.sessionToken,
      otherOrganization,
    ),
  ).rejects.toHaveProperty("code", "account_changed");
  await expect(
    runtime.authentication.sessions.revoke(
      actor,
      randomUUID(),
      current.sessionToken,
      { scope: "other_sessions", account: otherUser },
    ),
  ).rejects.toHaveProperty("code", "account_changed");
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
    [actor.organizationId, actor.userId],
  );
  await expect(
    runtime.authentication.sessions.revoke(
      actor,
      randomUUID(),
      current.sessionToken,
      { scope: "other_sessions", account: actor },
    ),
  ).rejects.toHaveProperty("code", "membership_required");
});
it("captures only bounded browser hints and the server-supplied address", () => {
  const request = new Request(origin, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0 Safari/537.36 Edg/155.0",
      "x-forwarded-for": "203.0.113.8",
    },
  });
  expect(browserSessionContext(request, "127.0.0.1")).toEqual({
    browser: "Edge",
    platform: "Windows",
    address: "127.0.0.1",
  });
  expect(
    browserSessionContext(
      new Request(origin, {
        headers: { "user-agent": "invalid".repeat(1000) },
      }),
      "untrusted input",
    ),
  ).toEqual({ browser: null, platform: null, address: null });
});
it("requires CSRF and account binding at the HTTP boundary, and clears cookies on current-session revocation", async () => {
  const current = await runtime.identity.login(
    "owner@example.test",
    password,
    actor.organizationId,
  );
  const target = await id(current.sessionToken);
  const headers = {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: `__Host-machdoch_cloud_session=${current.sessionToken}; __Host-machdoch_cloud_csrf=${current.csrfToken}`,
    "Idempotency-Key": randomUUID(),
  };
  const input = { scope: "session", id: target, account: actor };
  expect(
    (
      await handleCloudApi(
        new Request(`${origin}/api/v1/account/sessions/revoke`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        }),
        "127.0.0.1",
        runtime,
      )
    ).status,
  ).toBe(403);
  const response = await handleCloudApi(
    new Request(`${origin}/api/v1/account/sessions/revoke`, {
      method: "POST",
      headers: { ...headers, "x-machdoch-cloud-csrf": current.csrfToken },
      body: JSON.stringify(input),
    }),
    "127.0.0.1",
    runtime,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await runtime.identity.authenticate(current.sessionToken)).toBeNull();
});
