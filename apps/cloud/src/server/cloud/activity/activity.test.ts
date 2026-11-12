import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { AgentModelTurn } from "@machdoch/model-runtime/types";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  aiActivityQuerySchema,
  mimoriiSettingsInputSchema,
} from "../../../lib/cloud-activity-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { CloudMimoriiExporter } from "./mimorii-export";
import type { MimoriiLogBatch } from "./mimorii-protocol";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let outsider: CloudActor;
let providerId: string;
const cipher = new SettingsCipher(randomBytes(32));
const token = `mim_log_${"a".repeat(43)}`;
const answer: AgentModelTurn = {
  text: "Cycles group issues into time boxes.",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
};
const feed = (actor: CloudActor, query: Record<string, string> = {}) =>
  runtime.activity.feed.list(actor, aiActivityQuerySchema.parse(query));

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
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  outsider = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role, name] of [
    [owner, "owner", "Owner"],
    [member, "member", "Member"],
    [outsider, "member", "Outsider"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${name.toLowerCase()}@example.test`, name],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: cipher,
    modelAdapterFactory: async () => ({
      startTurn: async () => answer,
      continueTurn: async () => {
        throw new Error("Unexpected continuation");
      },
    }),
  });
  providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 200000,
      maxConcurrentRequests: 4,
    })
  ).id;
});

async function askAgent(actor: CloudActor) {
  const submission = await runtime.chat.store.submit(actor, randomUUID(), {
    chatId: null,
    revision: null,
    providerId,
    model: "fixture-model",
    prompt: "How does a cycle work?",
    context: [],
  });
  await runtime.inference.worker.runOne(
    actor.organizationId,
    submission.requestId,
  );
  return submission;
}

async function queuePrivateTask() {
  const team = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Security",
    key: "SEC",
    visibility: "private",
    estimateScale: defaultEstimateScale,
  });
  const project = await runtime.projects.create(owner, randomUUID(), {
    teamId: team.id,
    name: "Hardening",
    description: "",
  });
  const profile = await runtime.execution.profiles.create(owner, randomUUID(), {
    projectId: project.id,
    name: "Linked client",
    target: "client",
    agent: "codex-cli",
    repository: "https://github.com/example/project",
    baseCommit: "a".repeat(40),
    maxDurationSeconds: 3600,
    maxTokens: 10000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  const issue = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId: team.id,
      projectId: project.id,
      title: "Rotate signing keys",
      acceptanceCriteria: "Old keys stop working",
    }),
  );
  return runtime.execution.runs.create(owner, randomUUID(), {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
}

it("records Agent answers with usage and shows them only to their author and administrators", async () => {
  const submission = await askAgent(member);
  const own = await feed(member);
  expect(own.entries).toEqual([
    expect.objectContaining({
      kind: "agent",
      status: "succeeded",
      title: "Agent answered",
      actorName: "Member",
      model: "fixture-model",
      provider: "openai",
      tokens: 16,
      chatId: submission.chatId,
      run: null,
    }),
  ]);
  expect((await feed(outsider)).entries).toEqual([]);
  expect((await feed(owner)).entries).toEqual([
    expect.objectContaining({ title: "Agent answered", chatId: null }),
  ]);
  expect((await feed(member, { filter: "tasks" })).entries).toEqual([]);
});

it("records task state changes for the task's team and hides private teams from other members", async () => {
  const run = await queuePrivateTask();
  const queued = await runtime.execution.runs.get(owner, run.id);
  await runtime.execution.runs.cancel(
    owner,
    randomUUID(),
    run.id,
    queued.revision,
  );
  const tasks = await feed(owner, { filter: "tasks" });
  expect(tasks.entries.map((entry) => [entry.title, entry.status])).toEqual([
    ["Task canceled", "canceled"],
    ["Task queued", "started"],
  ]);
  expect(tasks.entries[0]).toMatchObject({
    run: { id: run.id, title: "Rotate signing keys" },
    issue: { identifier: "SEC-1" },
  });
  expect((await feed(owner, { runId: run.id })).entries).toHaveLength(2);
  expect((await feed(member, { filter: "tasks" })).entries).toEqual([]);
  expect(
    (await feed(owner, { problems: "true" })).entries.map(
      (entry) => entry.title,
    ),
  ).toEqual([]);
});

it("sends activity recorded after connecting to Mimorii once and reports delivery", async () => {
  await askAgent(member);
  const batches: MimoriiLogBatch[] = [];
  const authorizations: (string | null)[] = [];
  const transport = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as MimoriiLogBatch;
      batches.push(batch);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json(
        {
          accepted: batch.entries.length,
          duplicates: 0,
          rejected: 0,
          errors: [],
        },
        { status: 202 },
      );
    },
  ) as unknown as typeof fetch;
  await runtime.activity.mimorii.save(owner, randomUUID(), {
    revision: 0,
    url: "https://mimorii.example.test",
    token,
    enabled: true,
  });
  await askAgent(member);
  const exporter = new CloudMimoriiExporter(database, cipher, transport);
  expect(await exporter.tick()).toBe(1);
  expect(await exporter.tick()).toBe(0);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(vi.mocked(transport).mock.calls[0]![0]).toBe(
    "https://mimorii.example.test/api/logs/push",
  );
  expect(authorizations).toEqual([`Bearer ${token}`]);
  expect(batches[0]).toMatchObject({
    labels: { service: "machdoch-cloud" },
    entries: [
      {
        level: "info",
        message: "Agent answered",
        labels: { activity: "agent" },
        attributes: expect.objectContaining({
          actor: "Member",
          model: "fixture-model",
          tokens: 16,
          status: "succeeded",
        }),
      },
    ],
  });
  expect(batches[0]!.entries[0]!.timestamp).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
  );
  expect(batches[0]!.entries[0]!.attributes).not.toHaveProperty("run_id");
  const administration = await runtime.activity.mimorii.get(owner);
  expect(administration.settings).toMatchObject({
    deliveredEntries: 1,
    pending: 0,
    lastError: null,
    tokenPrefix: token.slice(0, 16),
  });
  expect(JSON.stringify(administration)).not.toContain(token);
  expect((await feed(member)).mimorii).toMatchObject({
    url: "https://mimorii.example.test",
    pending: 0,
    failing: false,
  });
});

it("keeps undelivered activity pending with a growing retry delay when Mimorii rejects the token", async () => {
  await runtime.activity.mimorii.save(owner, randomUUID(), {
    revision: 0,
    url: "https://mimorii.example.test",
    token,
    enabled: true,
  });
  await askAgent(member);
  const transport = vi.fn(
    async () =>
      new Response(JSON.stringify({ message: "Invalid token" }), {
        status: 401,
      }),
  ) as unknown as typeof fetch;
  const exporter = new CloudMimoriiExporter(database, cipher, transport);
  expect(await exporter.tick()).toBe(0);
  const settings = (await runtime.activity.mimorii.get(owner)).settings!;
  expect(settings).toMatchObject({
    pending: 1,
    deliveredEntries: 0,
    lastError:
      "Mimorii rejected the log source token. Create a new token in Mimorii and update it here.",
  });
  expect(Date.parse(settings.retryAt!)).toBeGreaterThan(Date.now());
  expect(await exporter.tick()).toBe(0);
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await feed(member)).mimorii).toMatchObject({ failing: true });
  await runtime.activity.mimorii.save(owner, randomUUID(), {
    revision: settings.revision,
    url: settings.url,
    token: `mim_log_${"b".repeat(43)}`,
    enabled: true,
  });
  const restarted = (await runtime.activity.mimorii.get(owner)).settings!;
  expect(restarted).toMatchObject({ lastError: null, retryAt: null });
});

it("requires a token for new addresses and leaves disabled connections idle", async () => {
  await expect(
    runtime.activity.mimorii.save(owner, randomUUID(), {
      revision: 0,
      url: "https://mimorii.example.test",
      enabled: true,
    }),
  ).rejects.toMatchObject({ code: "mimorii_token_required" });
  await expect(
    runtime.activity.mimorii.save(member, randomUUID(), {
      revision: 0,
      url: "https://mimorii.example.test",
      token,
      enabled: true,
    }),
  ).rejects.toMatchObject({ status: 403 });
  const saved = await runtime.activity.mimorii.save(owner, randomUUID(), {
    revision: 0,
    url: "https://mimorii.example.test",
    token,
    enabled: false,
  });
  await expect(
    runtime.activity.mimorii.save(owner, randomUUID(), {
      revision: saved.revision,
      url: "https://other.example.test",
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: "mimorii_token_required" });
  await askAgent(member);
  const transport = vi.fn() as unknown as typeof fetch;
  expect(
    await new CloudMimoriiExporter(database, cipher, transport).tick(),
  ).toBe(0);
  expect(transport).not.toHaveBeenCalled();
  await runtime.activity.mimorii.remove(owner, saved.revision);
  expect((await runtime.activity.mimorii.get(owner)).settings).toBeNull();
});

it("accepts HTTPS Mimorii addresses and plain HTTP only on this computer", () => {
  const parse = (url: string) =>
    mimoriiSettingsInputSchema.safeParse({ revision: 0, url, enabled: true });
  expect(parse("https://mimorii.app/").data?.url).toBe("https://mimorii.app");
  expect(parse("http://localhost:4310").data?.url).toBe(
    "http://localhost:4310",
  );
  expect(parse("http://mimorii.internal").success).toBe(false);
  expect(parse("https://user:secret@mimorii.app").success).toBe(false);
  expect(parse("https://mimorii.app/?team=1").success).toBe(false);
});
