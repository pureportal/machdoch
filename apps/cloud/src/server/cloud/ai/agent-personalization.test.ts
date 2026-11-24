import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import type {
  AgentModelStartParams,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type { ChatMessage } from "../../../lib/cloud-chat-contract";
import { SettingsCipher } from "../../settings-crypto";
import { cloudMigrations } from "../database";
import { FakeGitServer, githubApiUrl } from "../git/test-git-server";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import type { McpConnectorTarget } from "./agent-connectors";

const repositoryUrl = "https://github.test/acme/app";
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let providerId: string;
let teamId: string;
let projectId: string;
let issueId: string;
let connected: McpConnectorTarget[];
let server: FakeGitServer;
const organizationToken = `github_pat_${"o".repeat(40)}`;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;
const answer: AgentModelTurn = {
  text: "Done",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
};

function toolCall(name: string, args: Record<string, unknown>): AgentModelTurn {
  return {
    text: "",
    toolCalls: [{ id: `call-${randomUUID()}`, name, arguments: args }],
    usage: { totalTokens: 10 },
  };
}

async function connect(target: McpConnectorTarget): Promise<Client> {
  connected.push(target);
  if (target.url.includes("offline")) throw new Error("connection refused");
  const server = new McpServer({ name: "docs", version: "1.0.0" });
  server.registerTool(
    "lookup",
    {
      description: "Look up a runbook",
      inputSchema: { topic: z.string() },
    },
    async ({ topic }) => ({
      content: [{ type: "text", text: `Runbook for ${topic}` }],
    }),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "machdoch-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function ask(
  actor: CloudActor,
  context: ChatMessage["context"] = [],
  model = "fixture-model",
) {
  const submission = await runtime.chat.store.submit(actor, randomUUID(), {
    chatId: null,
    revision: null,
    providerId,
    model,
    prompt: "Help me",
    context,
    attachmentIds: [],
  });
  await runtime.inference.worker.runOne(
    actor.organizationId,
    submission.requestId,
  );
  return (await runtime.chat.store.get(actor, submission.chatId)).turns.at(-1)!;
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
afterEach(async () => {
  await runtime?.inference.worker.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  connected = [];
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, name] of [
    [owner, "Ada"],
    [member, "Grace"],
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
  start = vi.fn(async () => answer);
  server = new FakeGitServer();
  server.logins.set(organizationToken, "acme-bot");
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    gitFetch: server.transport,
    mcpConnect: connect,
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => {
        throw new Error("Agent rounds restart with the full transcript.");
      },
    }),
  });
  providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model", "preferred-model"],
      apiKey: "fixture-credential",
      maxOutputTokens: 256,
      dailyTokenBudget: 1_000_000,
      maxConcurrentRequests: 4,
    })
  ).id;
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Platform",
      key: "PLAT",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  projectId = (
    await runtime.projects.create(owner, randomUUID(), {
      teamId,
      name: "Checkout",
      description: "",
    })
  ).id;
  issueId = (
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId, projectId, title: "Flaky checkout" }),
    )
  ).id;
});

it("applies personal instructions only to that user's sessions, next to workspace and team instructions", async () => {
  await runtime.settings.setOrganization(
    owner,
    randomUUID(),
    "agent.instructions",
    "Answer in British English.",
  );
  await runtime.settings.setTeam(
    owner,
    randomUUID(),
    teamId,
    "agent.instructions",
    "Link the platform runbook.",
  );
  await runtime.settings.setPersonal(
    owner,
    randomUUID(),
    "agent.instructions",
    "Call me Ada and keep answers short.",
  );
  await ask(owner, [{ kind: "issue", id: issueId }]);
  await ask(member);
  await ask(member, [{ kind: "issue", id: issueId }]);
  const [ownerPrompt, memberPrompt, memberIssuePrompt] = start.mock.calls.map(
    ([params]) => params.systemPrompt,
  );
  expect(ownerPrompt).toContain(
    "# Instructions\nFollow these instructions unless they conflict with the rules above.\n\n## Workspace\nAnswer in British English.\n\n## Team Platform\nLink the platform runbook.\n\n## Personal\nCall me Ada and keep answers short.",
  );
  expect(memberPrompt).toContain("## Workspace\nAnswer in British English.");
  expect(memberPrompt).not.toContain("Link the platform runbook.");
  expect(memberIssuePrompt).toContain("Link the platform runbook.");
  for (const prompt of [memberPrompt, memberIssuePrompt])
    expect(prompt).not.toContain("Call me Ada");
  const { rows } = await database.engine.query<{
    actorId: string;
    prompt: string;
  }>(
    `SELECT actor_id AS "actorId",system_prompt AS prompt FROM cloud_inference_calls`,
  );
  expect(
    rows
      .filter((row) => row.prompt.includes("Call me Ada"))
      .map((row) => row.actorId),
  ).toEqual([owner.userId]);
});

it("uses the personal default model, harness and placement for relays and handoffs", async () => {
  await runtime.settings.setPersonal(owner, randomUUID(), "agent.model", {
    providerId,
    model: "preferred-model",
  });
  await runtime.settings.setPersonal(
    owner,
    randomUUID(),
    "agent.harness",
    "codex",
  );
  await runtime.settings.setPersonal(
    owner,
    randomUUID(),
    "agent.placement",
    "sandbox",
  );
  const { id } = await runtime.comments.create(
    owner,
    randomUUID(),
    issueId,
    "@agent find the flake",
  );
  const chatId = await runtime.chat.relays.issueComment(owner, id);
  const { turns } = await runtime.chat.store.get(owner, chatId!);
  expect(turns[0]).toMatchObject({ providerId, model: "preferred-model" });
  expect(
    (await runtime.chat.handoffs.options(owner, turns[0]!.id)).defaults,
  ).toEqual({
    placement: "sandbox",
    harness: "codex",
    model: "preferred-model",
  });
  const memberTurn = await ask(member, [{ kind: "issue", id: issueId }]);
  expect(
    (await runtime.chat.handoffs.options(member, memberTurn.id)).defaults,
  ).toEqual({ placement: null, harness: null, model: null });
});

it("restricts agent tools and handoffs to the allowed repositories", async () => {
  server.add(server.github, 4, { headRef: "feature/checkout" });
  const { id: connectionId } = await runtime.git.connections.connect(
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
  await runtime.git.connections.addRepository(owner, connectionId, "acme/app");
  await runtime.git.connections.requestSync(owner, connectionId);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) break;
  const pullRequest = (await runtime.git.pullRequests.list(owner, undefined))
    .pullRequests[0]!.pullRequest;
  const appId = pullRequest.repositoryId;
  const webId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_git_repositories (organization_id,id,provider,external_id,full_name,default_branch,private,web_url,connection_id) VALUES ($1,$2,'github',8,'acme/web','main',true,'https://github.test/acme/web',$3)",
    [owner.organizationId, webId, connectionId],
  );
  const profile = await runtime.execution.profiles.create(owner, randomUUID(), {
    projectId,
    repository: repositoryUrl,
    autopilot: false,
    maxDurationSeconds: 3600,
    maxTokens: 10000,
    requiredChecks: [],
    name: "Sandbox",
    target: "cloud",
    providerId,
    model: "fixture-model",
  });
  const run = async (actor: CloudActor) => {
    start.mockReset();
    start
      .mockResolvedValueOnce(toolCall("list_pull_requests", {}))
      .mockResolvedValueOnce(
        toolCall("read_pull_request", { pullRequest: pullRequest.id }),
      )
      .mockResolvedValueOnce(
        toolCall("propose_issue_task", { issue: "PLAT-1" }),
      )
      .mockResolvedValue(answer);
    const turn = await ask(actor, [{ kind: "issue", id: issueId }]);
    return {
      steps: turn.steps.map((step) => step.label),
      profiles: (await runtime.chat.handoffs.options(actor, turn.id)).profiles,
    };
  };

  expect(
    await runtime.chat.personalization.setRepositories(owner, randomUUID(), [
      webId,
    ]),
  ).toEqual({ repositoryIds: [webId] });
  const restricted = await run(owner);
  expect(restricted.steps).toEqual([
    "Found 0 pull requests",
    "acme/app is not in your allowed repositories.",
    "The project of PLAT-1 has no repository set up for AI tasks.",
  ]);
  expect(restricted.profiles).toEqual([]);

  const unrestricted = await run(member);
  expect(unrestricted.steps[0]).toBe("Found 1 pull request");
  expect(unrestricted.steps[2]).not.toContain("no repository");
  expect(unrestricted.profiles.map((entry) => entry.id)).toEqual([profile.id]);

  await runtime.chat.personalization.setRepositories(owner, randomUUID(), [
    appId,
    webId,
  ]);
  const allowed = await run(owner);
  expect(allowed.steps[0]).toBe("Found 1 pull request");
  expect(allowed.profiles.map((entry) => entry.id)).toEqual([profile.id]);
  expect((await runtime.chat.personalization.get(owner)).repositoryIds).toEqual(
    [appId, webId].sort(),
  );
  await expect(
    runtime.chat.personalization.setRepositories(owner, randomUUID(), [
      randomUUID(),
    ]),
  ).rejects.toMatchObject({ status: 422, code: "repository_unavailable" });
});

it("adds personal MCP connectors whose tools reach only that user's agent sessions", async () => {
  const key = randomUUID();
  const input = {
    name: "docs",
    url: "https://mcp.example.test/mcp",
    token: "connector-secret",
  };
  const connector = await runtime.chat.personalization.addConnector(
    owner,
    key,
    input,
  );
  expect(connector).toMatchObject({
    name: "docs",
    url: input.url,
    authenticated: true,
  });
  expect(
    await runtime.chat.personalization.addConnector(owner, key, input),
  ).toEqual(connector);
  await expect(
    runtime.chat.personalization.addConnector(owner, randomUUID(), input),
  ).rejects.toMatchObject({ status: 409, code: "connector_exists" });
  await expect(
    runtime.chat.personalization.addConnector(owner, randomUUID(), {
      name: "offline",
      url: "https://offline.example.test/mcp",
      token: null,
    }),
  ).rejects.toMatchObject({ status: 422, code: "connector_unavailable" });
  const stored = await database.engine.query<{ token: Uint8Array }>(
    "SELECT token FROM cloud_agent_mcp_connectors",
  );
  expect(Buffer.from(stored.rows[0]!.token).toString("utf8")).not.toContain(
    "connector-secret",
  );
  expect((await runtime.chat.personalization.get(member)).connectors).toEqual(
    [],
  );

  connected = [];
  start
    .mockResolvedValueOnce(toolCall("mcp_docs_lookup", { topic: "deploys" }))
    .mockResolvedValueOnce(answer);
  const turn = await ask(owner);
  expect(start.mock.calls[0]![0].tools.map((tool) => tool.name)).toContain(
    "mcp_docs_lookup",
  );
  expect(connected).toEqual([
    { name: "docs", url: input.url, token: "connector-secret" },
  ]);
  expect(start.mock.calls[1]![0].userPrompt).toContain("Runbook for deploys");
  expect(turn.steps.map((step) => step.failed)).toEqual([false]);

  start.mockClear();
  await ask(member);
  expect(
    start.mock.calls[0]![0].tools.some((tool) => tool.name.startsWith("mcp_")),
  ).toBe(false);

  await runtime.chat.personalization.removeConnector(
    owner,
    randomUUID(),
    connector.id,
  );
  expect((await runtime.chat.personalization.get(owner)).connectors).toEqual(
    [],
  );
  await expect(
    runtime.chat.personalization.removeConnector(
      owner,
      randomUUID(),
      connector.id,
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it("adds the connector and allowed repository tables in migration 085", async () => {
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
  const columns = async (table: string) =>
    (
      await engine.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
        [table],
      )
    ).rows.map((row) => row.column_name);
  expect(await columns("cloud_agent_mcp_connectors")).toEqual([
    "organization_id",
    "id",
    "user_id",
    "name",
    "url",
    "token",
    "created_at",
  ]);
  expect(await columns("cloud_agent_allowed_repositories")).toEqual([
    "organization_id",
    "user_id",
    "repository_id",
  ]);
  await engine.close();
});
