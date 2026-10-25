import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  defaultEstimateScale,
  issueInputSchema,
} from "../../../lib/cloud-contract";
import type { CloudOAuthScope } from "../../../lib/cloud-oauth-contract";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { issueCloudSession } from "../session-issuance";
import { handleCloudApi } from "../api";
import { nativeCloudClient } from "./validation";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
const origin = "https://cloud.example.test";
const resource = `${origin}/api/v1/mcp`;
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const scopes: CloudOAuthScope[] = [
  "cloud:read",
  "cloud:write",
  "cloud:execute",
];

beforeAll(async () => {
  database = await createTestCloudDatabase();
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
  member = { organizationId, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Cloud test')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
    [member, "member"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,'Test','unused')",
      [actor.userId, `${role}@example.test`],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, origin);
});

function parameters(selected: CloudOAuthScope[] = scopes) {
  return new URLSearchParams({
    client_id: nativeCloudClient.id,
    redirect_uri: nativeCloudClient.redirectUri,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: challenge,
    resource,
    state: randomUUID(),
    scope: selected.join(" "),
  });
}
async function session(actor: CloudActor) {
  return (
    await database.transaction((sql) =>
      issueCloudSession(sql, actor.userId, "password", actor.organizationId),
    )
  ).sessionToken;
}
async function authorize(actor = member, selected: CloudOAuthScope[] = scopes) {
  const id = await runtime.authorization.begin(parameters(selected));
  await runtime.authorization.consent(actor, id);
  const redirect = new URL(
    await runtime.authorization.decide(
      actor,
      id,
      true,
      selected,
      await session(actor),
    ),
  );
  return { code: redirect.searchParams.get("code")!, redirect, id };
}
function exchange(code: string, overrides = {}) {
  return runtime.oauthTokens.exchange({
    grant_type: "authorization_code",
    client_id: nativeCloudClient.id,
    redirect_uri: nativeCloudClient.redirectUri,
    resource,
    code,
    code_verifier: verifier,
    ...overrides,
  });
}
async function token(selected: CloudOAuthScope[] = scopes) {
  return exchange((await authorize(member, selected)).code);
}
it("keeps separately consented app access when another browser session is signed out", async () => {
  const tokens = await token();
  const current = await session(member);
  await runtime.authentication.sessions.revoke(member, randomUUID(), current, {
    scope: "other_sessions",
    account: member,
  });
  expect(
    await runtime.oauthTokens.authenticate(tokens.access_token),
  ).not.toBeNull();
});
function refresh(refresh_token: string) {
  return runtime.oauthTokens.exchange({
    grant_type: "refresh_token",
    client_id: nativeCloudClient.id,
    resource,
    refresh_token,
  });
}
async function mcp(access: string) {
  const client = new Client({ name: "conformance-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: `Bearer ${access}` } },
    fetch: async (url, init) =>
      handleCloudApi(new Request(url, init), "test", runtime),
  });
  await client.connect(transport);
  return client;
}

it("rejects redirect substitution, duplicate parameters, wrong audience, and missing PKCE", async () => {
  for (const [key, value] of [
    ["redirect_uri", "https://evil.test/callback"],
    ["resource", "https://evil.test/mcp"],
    ["code_challenge_method", "plain"],
  ]) {
    const input = parameters();
    input.set(key!, value!);
    await expect(runtime.authorization.begin(input)).rejects.toHaveProperty(
      "code",
      key === "resource" ? "invalid_target" : "invalid_request",
    );
  }
  const repeated = parameters();
  repeated.append("client_id", nativeCloudClient.id);
  await expect(runtime.authorization.begin(repeated)).rejects.toHaveProperty(
    "code",
    "invalid_request",
  );
});
it("binds consent to the signed-in account, supports denial, and includes issuer and state", async () => {
  const params = parameters();
  const id = await runtime.authorization.begin(params);
  await runtime.authorization.consent(member, id);
  await expect(runtime.authorization.consent(owner, id)).rejects.toHaveProperty(
    "status",
    410,
  );
  const redirect = new URL(
    await runtime.authorization.decide(
      member,
      id,
      false,
      [],
      await session(member),
    ),
  );
  expect(redirect.searchParams.get("iss")).toBe(origin);
  expect(redirect.searchParams.get("state")).toBe(params.get("state"));
  expect(redirect.searchParams.get("error")).toBe("access_denied");
  expect(await runtime.authorization.connections(member)).toEqual([]);
  await expect(
    runtime.authorization.decide(
      member,
      id,
      true,
      scopes,
      await session(member),
    ),
  ).rejects.toHaveProperty("status", 410);
});
it("requires the verifier and single-use code, revoking the grant on valid code replay", async () => {
  const { code } = await authorize();
  await expect(
    exchange(code, { code_verifier: "b".repeat(43) }),
  ).rejects.toHaveProperty("code", "invalid_grant");
  const issued = await exchange(code);
  expect(
    await runtime.oauthTokens.authenticate(issued.access_token),
  ).not.toBeNull();
  await expect(exchange(code)).rejects.toHaveProperty("code", "invalid_grant");
  expect(
    await runtime.oauthTokens.authenticate(issued.access_token),
  ).toBeNull();
});
it("rotates refresh tokens and commits family revocation when an old token is replayed", async () => {
  const first = await token();
  const second = await refresh(first.refresh_token);
  expect(second.refresh_token).not.toBe(first.refresh_token);
  expect(
    await runtime.oauthTokens.authenticate(second.access_token),
  ).not.toBeNull();
  await expect(refresh(first.refresh_token)).rejects.toHaveProperty(
    "code",
    "invalid_grant",
  );
  expect(
    await runtime.oauthTokens.authenticate(second.access_token),
  ).toBeNull();
  await expect(refresh(second.refresh_token)).rejects.toHaveProperty(
    "code",
    "invalid_grant",
  );
});
it("enforces grant, code, request, and token expiration independently", async () => {
  const id = await runtime.authorization.begin(parameters());
  await database.engine.query(
    "UPDATE cloud_oauth_requests SET expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await expect(
    runtime.authorization.consent(member, id),
  ).rejects.toHaveProperty("status", 410);
  const { code } = await authorize();
  await database.engine.exec(
    "UPDATE cloud_oauth_codes SET expires_at=now()-interval '1 second'",
  );
  await expect(exchange(code)).rejects.toHaveProperty("code", "invalid_grant");
  const issued = await token();
  await database.engine.exec(
    "UPDATE cloud_oauth_tokens SET expires_at=now()-interval '1 second' WHERE kind='access'",
  );
  expect(
    await runtime.oauthTokens.authenticate(issued.access_token),
  ).toBeNull();
  const renewed = await refresh(issued.refresh_token);
  await database.engine.exec(
    "UPDATE cloud_oauth_grants SET expires_at=now()-interval '1 second'",
  );
  expect(
    await runtime.oauthTokens.authenticate(renewed.access_token),
  ).toBeNull();
});
it("never lets viewers consent to writes or execution", async () => {
  await database.engine.query(
    "UPDATE cloud_memberships SET role='viewer' WHERE user_id=$1",
    [member.userId],
  );
  const id = await runtime.authorization.begin(parameters());
  expect((await runtime.authorization.consent(member, id)).scopes).toEqual([
    "cloud:read",
  ]);
  await expect(
    runtime.authorization.decide(
      member,
      id,
      true,
      scopes,
      await session(member),
    ),
  ).rejects.toHaveProperty("code", "invalid_scope");
  await runtime.authorization.decide(
    member,
    id,
    true,
    ["cloud:read"],
    await session(member),
  );
});

it("limits active connections without consuming the pending consent on failure", async () => {
  const id = await runtime.authorization.begin(parameters());
  await runtime.authorization.consent(member, id);
  await database.engine.query(
    `INSERT INTO cloud_oauth_grants(id,client_id,organization_id,user_id,resource,scopes,authentication_epoch,membership_epoch)
    SELECT gen_random_uuid(),'machdoch-client',$1,$2,$3,ARRAY['cloud:read'],u.authentication_epoch,m.authentication_epoch FROM generate_series(1,20),cloud_users u JOIN cloud_memberships m ON m.user_id=u.id WHERE u.id=$2 AND m.organization_id=$1`,
    [member.organizationId, member.userId, resource],
  );
  await expect(
    runtime.authorization.decide(
      member,
      id,
      true,
      ["cloud:read"],
      await session(member),
    ),
  ).rejects.toHaveProperty("code", "connection_limit");
  const first = (await runtime.authorization.connections(member))[0]!;
  await runtime.authorization.disconnect(member, first.id);
  expect(
    new URL(
      await runtime.authorization.decide(
        member,
        id,
        true,
        ["cloud:read"],
        await session(member),
      ),
    ).searchParams.has("code"),
  ).toBe(true);
});

it("invalidates old app authority after credential changes and allows a fresh connection", async () => {
  const old = await token();
  expect(
    await runtime.oauthTokens.authenticate(old.access_token),
  ).not.toBeNull();
  await database.engine.query(
    "UPDATE cloud_users SET password_hash='changed' WHERE id=$1",
    [member.userId],
  );
  expect(await runtime.oauthTokens.authenticate(old.access_token)).toBeNull();
  await expect(refresh(old.refresh_token)).rejects.toHaveProperty(
    "code",
    "invalid_grant",
  );
  expect(await runtime.authorization.connections(member)).toHaveLength(0);
  const fresh = await token();
  expect(
    await runtime.oauthTokens.authenticate(fresh.access_token),
  ).not.toBeNull();
});

it("requires browser CSRF protection for consent and rejects cross-origin MCP requests", async () => {
  const id = await runtime.authorization.begin(parameters());
  await runtime.authorization.consent(member, id);
  const response = await handleCloudApi(
    new Request(`${origin}/api/v1/authorizations/${id}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true, scopes }),
    }),
    "test",
    runtime,
  );
  expect(response.status).toBe(403);
  const issued = await token();
  const crossOrigin = await handleCloudApi(
    new Request(resource, {
      method: "POST",
      headers: {
        Origin: "https://evil.test",
        Authorization: `Bearer ${issued.access_token}`,
      },
    }),
    "test",
    runtime,
  );
  expect(crossOrigin.status).toBe(403);
  expect(
    (
      await handleCloudApi(
        new Request(`${resource}?access_token=${issued.access_token}`),
        "test",
        runtime,
      )
    ).status,
  ).toBe(401);
});
it("revokes delegated calls even when their actor was authenticated before disconnect", async () => {
  const issued = await token();
  const session = (await runtime.oauthTokens.authenticate(
    issued.access_token,
  ))!;
  const connection = (await runtime.authorization.connections(member))[0]!;
  await runtime.authorization.disconnect(owner, connection.id);
  expect(
    await runtime.oauthTokens.authenticate(issued.access_token),
  ).not.toBeNull();
  await runtime.authorization.disconnect(member, connection.id);
  await expect(
    runtime.planning.workspace(session.actor),
  ).rejects.toHaveProperty("code", "delegation_denied");
});
it("membership changes permanently revoke grants, including after access is restored", async () => {
  const issued = await token();
  await runtime.administration.updateMember(
    owner,
    randomUUID(),
    member.userId,
    { role: "viewer", active: true, revision: 1 },
  );
  await runtime.administration.updateMember(
    owner,
    randomUUID(),
    member.userId,
    { role: "member", active: true, revision: 2 },
  );
  expect(
    await runtime.oauthTokens.authenticate(issued.access_token),
  ).toBeNull();
  await expect(refresh(issued.refresh_token)).rejects.toHaveProperty(
    "code",
    "invalid_grant",
  );
});
it("serves real SDK clients, filters scope, and rejects cookie-only MCP authentication", async () => {
  const issued = await token(["cloud:read"]);
  const client = await mcp(issued.access_token);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("get_issue_relations");
    expect(names).not.toContain("add_issue_relation");
    expect(names).not.toContain("remove_issue_relation");
    expect(names).not.toContain("create_sub_issue");
    expect(names).toContain("get_workspace");
    expect(names).not.toContain("create_issue");
    expect(names).not.toContain("start_run");
    const result = await client.callTool({
      name: "get_workspace",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const denied = await client.callTool({
      name: "create_issue",
      arguments: {},
    });
    expect(denied.isError).toBe(true);
  } finally {
    await client.close();
  }
  const response = await handleCloudApi(
    new Request(resource, { headers: { Cookie: "session=unknown" } }),
    "test",
    runtime,
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    "oauth-protected-resource",
  );
});
it("MCP mutations preserve idempotency, revision conflicts, and private team boundaries", async () => {
  const publicTeam = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Public",
    key: "PU",
    visibility: "organization",
    estimateScale: defaultEstimateScale,
  });
  const privateTeam = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Private",
    key: "PR",
    visibility: "private",
    estimateScale: defaultEstimateScale,
  });
  const issued = await token();
  const client = await mcp(issued.access_token);
  const issue = issueInputSchema.parse({
    teamId: publicTeam.id,
    title: "Via MCP",
    description: "",
    acceptanceCriteria: "",
    priority: "normal",
    projectId: null,
    cycleId: null,
    assigneeId: null,
    estimate: null,
    dueOn: null,
  });
  const args = { commandId: randomUUID(), issue };
  try {
    const first = await client.callTool({
      name: "create_issue",
      arguments: args,
    });
    expect(first.isError).not.toBe(true);
    expect(
      await client.callTool({ name: "create_issue", arguments: args }),
    ).toEqual(first);
    const denied = await client.callTool({
      name: "create_issue",
      arguments: {
        commandId: randomUUID(),
        issue: { ...issue, teamId: privateTeam.id },
      },
    });
    expect(denied.isError).toBe(true);
    const created = JSON.parse((first.content as { text: string }[])[0]!.text);
    const { teamId, ...fields } = issue;
    expect(teamId).toBe(publicTeam.id);
    const update = {
      ...fields,
      status: (await runtime.planning.getIssue(member, created.id)).status,
      revision: 1,
      archived: false,
      title: "Updated",
    };
    expect(
      (
        await client.callTool({
          name: "update_issue",
          arguments: { commandId: randomUUID(), id: created.id, issue: update },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: "update_issue",
          arguments: { commandId: randomUUID(), id: created.id, issue: update },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
  }
});
