import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { automationMarker } from "../../../lib/git-events";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { cloudMigrations } from "../database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { FakeGitServer, githubApiUrl } from "../git/test-git-server";

const organizationToken = `github_pat_${"o".repeat(40)}`;
const ownerToken = `github_pat_${"w".repeat(40)}`;
const commentUrl = "https://github.test/acme/app/pull/4#issuecomment-9";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let commenter: CloudActor;
let teamId: string;
let issueId: string;

async function provider() {
  return runtime.aiProviders.create(owner, randomUUID(), {
    name: "OpenAI",
    provider: "openai",
    region: null,
    models: ["test-model"],
    apiKey: "fixture-credential",
    maxOutputTokens: 512,
    dailyTokenBudget: 1_000_000,
    maxConcurrentRequests: 4,
  });
}

async function comment(actor: CloudActor, body: string, key = randomUUID()) {
  const { id } = await runtime.comments.create(actor, key, issueId, body);
  return { id, chatId: await runtime.chat.relays.issueComment(actor, id) };
}

async function deliverPullRequestComment(body: string, login: string) {
  const connection = (await runtime.git.connections.get(owner)).connections[0]!;
  const payload = JSON.stringify({
    action: "created",
    issue: { number: 4, pull_request: {} },
    comment: { body, user: { login }, html_url: commentUrl },
    repository: { id: 7 },
    sender: { login },
  });
  const response = await handleCloudApi(
    new Request(connection.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", connection.webhookSecret).update(payload).digest("hex")}`,
      },
      body: payload,
    }),
    "127.0.0.1",
    runtime,
  );
  expect(response.status).toBe(204);
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  server = new FakeGitServer();
  server.logins.set(organizationToken, "acme-bot");
  server.logins.set(ownerToken, "owner-gh");
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  commenter = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, name] of [
    [owner, "Ada"],
    [commenter, "Grace"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${name}@example.test`, name],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
      [organizationId, actor.userId],
    );
  }
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    gitFetch: server.transport,
  });
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Platform",
      key: "PLAT",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  issueId = (
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId, title: "Flaky checkout test" }),
    )
  ).id;
});

it("starts an agent session with issue context from an @agent issue comment", async () => {
  const { id: providerId } = await provider();
  expect((await comment(owner, "Looks flaky to me")).chatId).toBeNull();
  const key = randomUUID();
  const relayed = await comment(
    owner,
    "@agent: find why the checkout test flakes\nand propose a fix",
    key,
  );
  expect(relayed.chatId).toEqual(expect.any(String));
  const { chat, turns } = await runtime.chat.store.get(owner, relayed.chatId!);
  expect(chat).toMatchObject({
    title: "find why the checkout test flakes",
    context: [expect.objectContaining({ kind: "issue", id: issueId })],
  });
  expect(turns).toEqual([
    expect.objectContaining({
      prompt: "find why the checkout test flakes\nand propose a fix",
      providerId,
      model: "test-model",
      state: "queued",
      relay: { source: "issue_comment", author: "Ada", url: null },
    }),
  ]);
  expect(
    (await runtime.chat.store.sessions(owner)).running.map(
      (session) => session.id,
    ),
  ).toEqual([relayed.chatId]);
  expect(
    await comment(
      owner,
      "@agent: find why the checkout test flakes\nand propose a fix",
      key,
    ),
  ).toEqual(relayed);
  const { rows } = await database.engine.query(
    "SELECT count(*)::int AS count FROM cloud_chats WHERE organization_id=$1",
    [owner.organizationId],
  );
  expect(rows).toEqual([{ count: 1 }]);
});

it("rejects relays without an AI provider or the agent permission", async () => {
  await expect(comment(owner, "@agent investigate")).rejects.toMatchObject({
    status: 409,
    code: "ai_provider_required",
  });
  await provider();
  const { key } = await runtime.roles.create(owner, randomUUID(), {
    name: "Commenter",
    description: "",
    scope: "organization",
    permissions: ["comments.write"],
  });
  await database.engine.query(
    "UPDATE cloud_memberships SET role=$2 WHERE user_id=$1",
    [commenter.userId, key],
  );
  await expect(comment(commenter, "@agent investigate")).rejects.toMatchObject({
    status: 403,
  });
  const { rows } = await database.engine.query(
    "SELECT count(*)::int AS count FROM cloud_comments WHERE organization_id=$1",
    [owner.organizationId],
  );
  expect(rows).toEqual([{ count: 2 }]);
});

it("relays @agent pull request comments from linked accounts only", async () => {
  await provider();
  server.add(server.github, 4, { headRef: "feature/checkout" });
  const { id } = await runtime.git.connections.connect(
    owner,
    randomUUID(),
    "github",
    {
      revision: 0,
      apiUrl: githubApiUrl,
      token: organizationToken,
      automate: true,
      codeAccess: true,
    },
  );
  await runtime.git.connections.addRepository(owner, id, "acme/app");
  await runtime.git.connections.requestSync(owner, id);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) break;
  const pullRequest = (await runtime.git.pullRequests.list(owner, undefined))
    .pullRequests[0]!.pullRequest;

  await deliverPullRequestComment("@agent fix the failing check", "owner-gh");
  expect((await runtime.chat.store.sessions(owner)).running).toEqual([]);

  await runtime.git.accounts.connect(owner, "github", {
    revision: 0,
    apiUrl: githubApiUrl,
    token: ownerToken,
  });
  await deliverPullRequestComment(
    `@agent fix the failing check\n\n${automationMarker}`,
    "owner-gh",
  );
  await deliverPullRequestComment("@agent fix the failing check", "owner-gh");
  await deliverPullRequestComment("@agent fix the failing check", "owner-gh");
  const sessions = (await runtime.chat.store.sessions(owner)).running;
  expect(sessions).toEqual([
    expect.objectContaining({
      title: "fix the failing check",
      context: [
        expect.objectContaining({ kind: "pull_request", id: pullRequest.id }),
      ],
    }),
  ]);
  const { turns } = await runtime.chat.store.get(owner, sessions[0]!.id);
  expect(turns[0]!.relay).toEqual({
    source: "pull_request_comment",
    author: "owner-gh",
    url: commentUrl,
  });
});

it("adds the agent relay table in migration 084", async () => {
  const engine = new PGlite();
  await engine.exec(
    await readFile(new URL("./../schema.sql", import.meta.url), "utf8"),
  );
  for (const migration of cloudMigrations)
    await engine.exec(
      await readFile(
        new URL(`./../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  const { rows } = await engine.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name='cloud_agent_relays' ORDER BY ordinal_position",
  );
  expect(rows.map((row) => row.column_name)).toEqual([
    "organization_id",
    "turn_id",
    "source",
    "author",
    "comment_id",
    "pull_request_id",
    "external_url",
    "created_at",
  ]);
  await engine.close();
});
