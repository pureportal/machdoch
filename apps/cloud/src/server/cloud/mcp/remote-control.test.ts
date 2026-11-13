import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type { CloudOAuthScope } from "../../../lib/cloud-oauth-contract";
import { hashSecret } from "../../crypto";
import { handleCloudApi } from "../api";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { issueCloudSession } from "../session-issuance";
import { createTestCloudDatabase, verifyTestSession } from "../test-database";
import { nativeCloudClient } from "../oauth/validation";

const origin = "https://cloud.example.test";
const resource = `${origin}/api/v1/mcp`;
const verifier = "v".repeat(43);
const allScopes: CloudOAuthScope[] = [
  "cloud:read",
  "cloud:write",
  "cloud:execute",
];

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let outsider: CloudActor;
const clients: Client[] = [];

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 60_000);
afterAll(async () => {
  await database?.close();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_login_limits",
  );
  const organizationId = randomUUID();
  owner = { organizationId, userId: randomUUID() };
  member = { organizationId, userId: randomUUID() };
  outsider = { organizationId, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Remote')",
    [organizationId],
  );
  for (const [actor, role, email] of [
    [owner, "owner", "owner@example.test"],
    [member, "member", "member@example.test"],
    [outsider, "member", "outsider@example.test"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,$2,'unused')",
      [actor.userId, email],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, origin);
});

async function accessToken(
  actor: CloudActor,
  scopes: CloudOAuthScope[] = allScopes,
): Promise<string> {
  const requestId = await runtime.authorization.begin(
    new URLSearchParams({
      client_id: nativeCloudClient.id,
      redirect_uri: nativeCloudClient.redirectUri,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      resource,
      state: randomUUID(),
      scope: scopes.join(" "),
    }),
  );
  await runtime.authorization.consent(actor, requestId);
  const { sessionToken } = await database.transaction((sql) =>
    issueCloudSession(sql, actor.userId, "password", actor.organizationId),
  );
  await verifyTestSession(database, sessionToken);
  const redirect = new URL(
    await runtime.authorization.decide(
      actor,
      requestId,
      true,
      scopes,
      sessionToken,
    ),
  );
  return (
    await runtime.oauthTokens.exchange({
      grant_type: "authorization_code",
      client_id: nativeCloudClient.id,
      redirect_uri: nativeCloudClient.redirectUri,
      resource,
      code: redirect.searchParams.get("code")!,
      code_verifier: verifier,
    })
  ).access_token;
}

async function connect(actor: CloudActor, scopes?: CloudOAuthScope[]) {
  const token = await accessToken(actor, scopes);
  const client = new Client({ name: "remote-control-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, init) =>
        handleCloudApi(new Request(url, init), "test", runtime),
    }),
  );
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = result.content[0]!.text;
    return {
      failed: result.isError === true,
      text,
      value: result.isError ? null : JSON.parse(text),
    };
  };
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    expect(result.failed, `${name}: ${result.text}`).toBe(false);
    return result.value;
  };
  return { client, call, ok, token };
}

async function privateBoard() {
  const team = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Product",
    key: "PRD",
    visibility: "private",
    estimateScale: defaultEstimateScale,
  });
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [member.organizationId, team.id, member.userId],
  );
  const issues = [];
  for (const title of [
    "Checkout loses the basket",
    "Retry webhook",
    "Old pixel",
  ])
    issues.push(
      await runtime.planning.createIssue(
        owner,
        randomUUID(),
        issueInputSchema.parse({ teamId: team.id, title }),
      ),
    );
  const label = await runtime.labels.create(owner, randomUUID(), team.id, {
    name: "Bug",
    color: "red",
  });
  await runtime.comments.create(
    owner,
    randomUUID(),
    issues[0]!.id,
    "Happens on **Safari** only.",
  );
  return { team, issues, label };
}

it("lets a member run the full planning workflow remotely", async () => {
  const { team, label } = await privateBoard();
  const { client, ok } = await connect(member);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "find_issue",
      "change_issues",
      "list_milestones",
      "list_comments",
      "create_comment",
      "set_issue_labels",
      "add_issue_relation",
      "create_issue",
    ]),
  );

  const first = await ok("find_issue", { identifier: "prd-1" });
  expect(first.title).toBe("Checkout loses the basket");
  const second = await ok("find_issue", { identifier: "PRD-2" });
  const third = await ok("find_issue", { identifier: "PRD-3" });
  expect(
    (await ok("list_comments", { issueId: first.id })).map(
      (comment: { body: string }) => comment.body,
    ),
  ).toEqual(["Happens on **Safari** only."]);
  await ok("create_comment", {
    commandId: randomUUID(),
    issueId: first.id,
    comment: { body: "I can reproduce it.\n\n- [ ] Add a test" },
  });

  const edit = {
    commandId: randomUUID(),
    issues: [{ id: first.id, revision: first.revision }],
    changes: { description: "## Steps\n\n1. Add an item", estimate: "5" },
  };
  await ok("change_issues", edit);
  await ok("change_issues", edit);
  await ok("change_issues", {
    commandId: randomUUID(),
    issues: [{ id: first.id }, { id: second.id }],
    changes: { statusCategory: "active", priority: "high" },
  });
  await ok("change_issues", {
    commandId: randomUUID(),
    issues: [{ id: third.id }],
    changes: { archived: true },
  });
  const labels = await ok("get_issue_labels", { id: first.id });
  await ok("set_issue_labels", {
    commandId: randomUUID(),
    id: first.id,
    labels: { revision: labels.revision, labelIds: [label.id] },
  });
  const current = await ok("get_issue", { id: first.id });
  await ok("add_issue_relation", {
    commandId: randomUUID(),
    id: second.id,
    relation: {
      kind: "blocks",
      targetId: first.id,
      sourceRevision: (await ok("get_issue", { id: second.id })).revision,
      targetRevision: current.revision,
    },
  });
  const created = await ok("create_issue", {
    commandId: randomUUID(),
    issue: issueInputSchema.parse({ teamId: team.id, title: "From remote" }),
  });

  expect(await runtime.planning.getIssue(owner, first.id)).toMatchObject({
    description: "## Steps\n\n1. Add an item",
    estimate: "5",
    priority: "high",
    state: "active",
  });
  expect(await runtime.planning.getIssue(owner, second.id)).toMatchObject({
    priority: "high",
    state: "active",
  });
  expect(await runtime.planning.getIssue(owner, third.id)).toMatchObject({
    archived: true,
  });
  expect(
    (await runtime.labels.getIssue(owner, first.id)).labels.map(
      (entry) => entry.name,
    ),
  ).toEqual(["Bug"]);
  expect(
    (await runtime.relations.list(owner, second.id)).map((relation) => [
      relation.kind,
      relation.issue.identifier,
    ]),
  ).toEqual([["blocks", "PRD-1"]]);
  expect(
    (await runtime.comments.list(owner, first.id)).map(
      (comment) => comment.author,
    ),
  ).toEqual(["member@example.test", "owner@example.test"]);
  expect((await runtime.planning.getIssue(owner, created.id)).identifier).toBe(
    "PRD-4",
  );

  await ok("change_issues", {
    commandId: randomUUID(),
    issues: [{ id: third.id }],
    changes: { archived: false },
  });
  expect(await runtime.planning.getIssue(owner, third.id)).toMatchObject({
    archived: false,
  });
});

it("never lets a connection reach beyond the user's own access", async () => {
  const { team, issues } = await privateBoard();
  const outsiderSession = await connect(outsider);
  for (const [name, args] of [
    ["find_issue", { identifier: "PRD-1" }],
    ["get_issue", { id: issues[0]!.id }],
    ["list_comments", { issueId: issues[0]!.id }],
    [
      "change_issues",
      {
        commandId: randomUUID(),
        issues: [{ id: issues[0]!.id }],
        changes: { archived: true },
      },
    ],
    [
      "create_comment",
      {
        commandId: randomUUID(),
        issueId: issues[0]!.id,
        comment: { body: "Sneaking in" },
      },
    ],
    [
      "create_issue",
      {
        commandId: randomUUID(),
        issue: issueInputSchema.parse({ teamId: team.id, title: "Sneak" }),
      },
    ],
  ] as const) {
    const result = await outsiderSession.call(name, args);
    expect(result.failed, name).toBe(true);
    expect(result.text).not.toContain("Checkout loses");
  }
  expect(
    JSON.stringify(await outsiderSession.ok("list_issues", {})),
  ).not.toContain("PRD-");

  const reader = await connect(member, ["cloud:read"]);
  const readable = (await reader.client.listTools()).tools.map(
    (tool) => tool.name,
  );
  expect(readable).toContain("find_issue");
  expect(readable).not.toContain("change_issues");
  expect(readable).not.toContain("create_comment");
  expect(readable).toContain("get_pull_request");
  expect(readable).toContain("list_pull_requests");
  expect(readable).not.toContain("merge_pull_request");
  expect(readable).not.toContain("update_pull_request_branch");
  const blocked = await reader.call("change_issues", {
    commandId: randomUUID(),
    issues: [{ id: issues[0]!.id }],
    changes: { archived: true },
  });
  expect(blocked).toMatchObject({
    failed: true,
    text: "Tool is unavailable for this connection.",
  });

  const ownerSession = await connect(owner);
  const delegated = (await runtime.oauthTokens.authenticate(
    ownerSession.token,
  ))!.actor;
  for (const scope of allScopes)
    await expect(
      runtime.administration.get({
        ...delegated,
        delegation: { ...delegated.delegation!, scope },
      }),
    ).rejects.toMatchObject({ status: 403, code: "delegation_denied" });

  expect(await runtime.planning.getIssue(owner, issues[0]!.id)).toMatchObject({
    archived: false,
    revision: 1,
  });
  expect(await runtime.comments.list(owner, issues[0]!.id)).toHaveLength(1);
  expect(
    (await runtime.planning.listIssues(owner, { teamId: team.id })).length,
  ).toBe(3);
});

it("limits how many requests one connection can send per minute", async () => {
  const session = await connect(member);
  await session.ok("get_workspace");
  const { grantId } = (await runtime.oauthTokens.authenticate(session.token))!;
  await database.engine.query(
    "UPDATE cloud_login_limits SET attempts=600 WHERE key=$1",
    [hashSecret(`mcp:grant:${grantId}`)],
  );
  await expect(session.call("get_workspace")).rejects.toThrow(
    "Too many requests from this app.",
  );
  const other = await connect(member);
  await other.ok("get_workspace");
});

it("stops remote changes when the member loses the team and revokes the connection when the role changes", async () => {
  const { team, issues } = await privateBoard();
  const session = await connect(member);
  await database.engine.query(
    "DELETE FROM cloud_team_memberships WHERE organization_id=$1 AND team_id=$2 AND user_id=$3",
    [member.organizationId, team.id, member.userId],
  );
  const removed = await session.call("change_issues", {
    commandId: randomUUID(),
    issues: [{ id: issues[0]!.id }],
    changes: { priority: "urgent" },
  });
  expect(removed.failed).toBe(true);
  expect(removed.text).toContain("not_found");
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [member.organizationId, team.id, member.userId],
  );
  await database.engine.query(
    "UPDATE cloud_memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
    [member.organizationId, member.userId],
  );
  await expect(
    session.call("change_issues", {
      commandId: randomUUID(),
      issues: [{ id: issues[0]!.id }],
      changes: { priority: "urgent" },
    }),
  ).rejects.toThrow("Connect this app to machdoch.cloud.");
  expect(await runtime.oauthTokens.authenticate(session.token)).toBeNull();
  expect(await runtime.planning.getIssue(owner, issues[0]!.id)).toMatchObject({
    priority: "none",
  });
});

it("limits remote tools to what the member's role allows", async () => {
  const { team } = await privateBoard();
  const { key } = await runtime.roles.create(owner, randomUUID(), {
    name: "Reviewer",
    description: "",
    scope: "assigned",
    permissions: ["comments.write", "apps.connect"],
  });
  await database.engine.query(
    "UPDATE cloud_memberships SET role=$2 WHERE user_id=$1",
    [member.userId, key],
  );
  await expect(accessToken(member)).rejects.toMatchObject({
    code: "invalid_scope",
  });
  const { client, ok, call } = await connect(member, [
    "cloud:read",
    "cloud:write",
  ]);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(["find_issue", "create_comment", "get_my_access"]),
  );
  for (const hidden of [
    "create_issue",
    "change_issues",
    "list_pull_requests",
    "list_roles",
  ])
    expect(names).not.toContain(hidden);
  expect(await ok("get_my_access")).toMatchObject({
    role: key,
    roleName: "Reviewer",
    scope: "assigned",
    permissions: [
      expect.objectContaining({ key: "comments.write" }),
      expect.objectContaining({ key: "apps.connect" }),
    ],
    teams: [expect.objectContaining({ id: team.id })],
  });
  await database.engine.query(
    "UPDATE cloud_roles SET permissions=ARRAY['comments.write'] WHERE key=$1",
    [key],
  );
  await expect(call("get_my_access")).rejects.toThrow("Connect this app");
});
