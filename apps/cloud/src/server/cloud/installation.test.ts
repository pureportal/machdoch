import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCloudDatabase } from "./test-database";
import { initializeInstallation } from "./installation-storage";
import { cloudCredentialsCipher } from "./credential-storage";
import {
  createCloudRuntime,
  closeCloudRuntime,
  setCloudRuntimeForTests,
  type CloudRuntime,
} from "./runtime";
import { handleCloudApi } from "./api";
import {
  authenticateRequest,
  requireMutation,
  isRemoteSessionActive,
} from "../request-auth";
import { runtimeConfig } from "../config";
import { hashSecret } from "../crypto";
import type { FleetRuntime } from "../runtime";

let runtime: CloudRuntime;
const origin = "https://cloud.example.test";
const owner = {
  organization: "Test",
  name: "Owner",
  email: "owner@example.test",
  password: "a secure test password",
};

beforeEach(async () => {
  const database = await createTestCloudDatabase();
  const installation = await initializeInstallation(database);
  runtime = createCloudRuntime(database, "", {
    credentialsCipher: cloudCredentialsCipher(installation.credentials_key),
  });
  setCloudRuntimeForTests(runtime);
});
afterEach(async () => {
  await closeCloudRuntime();
});

function setup(headers: Record<string, string> = { Origin: origin }) {
  return handleCloudApi(
    new Request(`${origin}/api/v1/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(owner),
    }),
    "127.0.0.1",
    runtime,
  );
}

describe("Cloud installation and remote authentication", () => {
  it("changes migrated sign-in details without an email and invalidates prior sessions", async () => {
    expect((await setup()).status).toBe(201);
    await runtime.database.transaction(async (sql) => {
      await sql.query(
        "UPDATE cloud_users SET email=NULL,login_name='legacy-owner'",
      );
    });
    const credentials = await runtime.identity.login(
      "legacy-owner",
      owner.password,
    );
    const otherSession = await runtime.identity.login(
      "legacy-owner",
      owner.password,
    );
    const actor = (await runtime.identity.authenticate(
      credentials.sessionToken,
    ))!;
    expect(await runtime.authentication.credentials.status(actor)).toEqual({
      username: "legacy-owner",
      passwordEnabled: true,
    });
    const change = (body: Record<string, unknown>) =>
      handleCloudApi(
        new Request(`${origin}/api/v1/account/credentials`, {
          method: "PUT",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            Cookie: `__Host-machdoch_cloud_session=${credentials.sessionToken}; __Host-machdoch_cloud_csrf=${credentials.csrfToken}`,
            "x-machdoch-cloud-csrf": credentials.csrfToken,
          },
          body: JSON.stringify(body),
        }),
        "127.0.0.1",
        runtime,
      );
    const input = {
      account: actor,
      currentPassword: owner.password,
      newPassword: "updated secure password",
      username: "updated-owner",
    };
    expect(
      (await change({ ...input, account: { ...actor, userId: randomUUID() } }))
        .status,
    ).toBe(409);
    expect(
      (await change({ ...input, currentPassword: "incorrect password" }))
        .status,
    ).toBe(422);
    await runtime.database.transaction(async (sql) => {
      await sql.query(
        "INSERT INTO cloud_users(id,email,name,password_hash) VALUES ($1,'taken@example.test','Other','unused')",
        [randomUUID()],
      );
    });
    expect(
      (await change({ ...input, username: "taken@example.test" })).status,
    ).toBe(409);
    expect(
      await runtime.identity.authenticate(credentials.sessionToken),
    ).toEqual(actor);
    const result = await change(input);
    expect(result.status).toBe(200);
    expect(
      result.headers
        .getSetCookie()
        .every((cookie) => cookie.includes("Max-Age=0")),
    ).toBe(true);
    expect(
      await runtime.identity.authenticate(credentials.sessionToken),
    ).toBeNull();
    expect(
      await runtime.identity.authenticate(otherSession.sessionToken),
    ).toBeNull();
    await expect(
      runtime.identity.login("legacy-owner", owner.password),
    ).rejects.toMatchObject({ status: 401 });
    const renewed = await runtime.identity.login(
      "updated-owner",
      input.newPassword,
    );
    expect(await runtime.identity.authenticate(renewed.sessionToken)).toEqual(
      actor,
    );
  });

  it("sets up once using only PostgreSQL and persists its public origin and encryption key", async () => {
    const status = await handleCloudApi(
      new Request(`${origin}/api/v1/auth/setup`),
      "127.0.0.1",
      runtime,
    );
    expect(await status.json()).toEqual({ initialized: false });
    expect((await setup({})).status).toBe(403);
    const results = await Promise.all([setup(), setup()]);
    expect(
      results
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([201, 409]);
    expect(runtime.origin).toBe(origin);
    const stored = await initializeInstallation(runtime.database);
    expect(stored.origin).toBe(origin);
    expect(stored.credentials_key).toHaveLength(43);
    expect(
      (await initializeInstallation(runtime.database)).credentials_key,
    ).toBe(stored.credentials_key);
    const login = await runtime.identity.login(owner.email, owner.password);
    expect(
      await runtime.identity.authenticate(login.sessionToken),
    ).not.toBeNull();
  });

  it("shares Cloud sessions and CSRF with remote controls and rejects another organization's administrator", async () => {
    expect((await setup()).status).toBe(201);
    const credentials = await runtime.identity.login(
      owner.email,
      owner.password,
    );
    const actor = (await runtime.identity.authenticate(
      credentials.sessionToken,
    ))!;
    const remote = { config: runtimeConfig(origin) } as FleetRuntime;
    const cookie = `__Host-machdoch_cloud_session=${credentials.sessionToken}; __Host-machdoch_cloud_csrf=${credentials.csrfToken}`;
    const request = new Request(`${origin}/api/instances`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "X-Machdoch-Cloud-CSRF": credentials.csrfToken,
      },
    });
    expect((await requireMutation(remote, request)).userId).toBe(actor.userId);
    await expect(
      requireMutation(
        remote,
        new Request(request, { headers: { Origin: origin, Cookie: cookie } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const otherOrganization = randomUUID();
    await runtime.database.transaction(async (sql) => {
      await sql.query(
        "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Other')",
        [otherOrganization],
      );
      await sql.query(
        "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
        [otherOrganization, actor.userId],
      );
    });
    const other = await runtime.identity.login(
      owner.email,
      owner.password,
      otherOrganization,
    );
    await expect(
      authenticateRequest(
        remote,
        new Request(`${origin}/api/instances`, {
          headers: {
            Cookie: `__Host-machdoch_cloud_session=${other.sessionToken}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await runtime.database.transaction(async (sql) => {
      await sql.query(
        "UPDATE cloud_memberships SET role='member' WHERE organization_id=$1 AND user_id=$2",
        [actor.organizationId, actor.userId],
      );
    });
    await expect(requireMutation(remote, request)).rejects.toMatchObject({
      status: 401,
    });
    const member = await runtime.identity.login(
      owner.email,
      owner.password,
      actor.organizationId,
    );
    await expect(
      authenticateRequest(
        remote,
        new Request(`${origin}/api/instances`, {
          headers: {
            Cookie: `__Host-machdoch_cloud_session=${member.sessionToken}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await isRemoteSessionActive(hashSecret(credentials.sessionToken)),
    ).toBe(false);
  });
});
