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
import type {
  AgentModelStartParams,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  automationInputSchema,
  type AutomationInput,
} from "../../../lib/cloud-automation-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { handleCloudApi } from "../api";
import { createTestCloudDatabase, testStatusReference } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let teamId: string;
let providerId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;
const webhookFetch = vi.fn<typeof fetch>();

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
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  const actors: CloudActor[] = [];
  for (const role of ["owner", "member", "viewer"]) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, userId, role],
    );
    actors.push({ organizationId, userId });
  }
  [owner, member, viewer] = actors as [CloudActor, CloudActor, CloudActor];
  start = vi.fn(async () => ({
    text: "All good.",
    toolCalls: [],
    usage: { totalTokens: 4 },
  }));
  webhookFetch.mockReset();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    automationFetch: webhookFetch,
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => {
        throw new Error("Agent rounds restart with the full transcript.");
      },
    }),
  });
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
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

function automation(input: Partial<AutomationInput>): AutomationInput {
  return automationInputSchema.parse({
    name: "Automation",
    teamId,
    trigger: { kind: "manual" },
    actions: [{ kind: "comment", body: "Hello" }],
    ...input,
  });
}

async function createIssue(title: string, priority = "none") {
  return runtime.planning.createIssue(
    member,
    randomUUID(),
    issueInputSchema.parse({ teamId, title, priority }),
  );
}

async function settle() {
  for (let round = 0; round < 6; round++)
    await runtime.automations.dispatcher.tick();
}

async function moveTo(issueId: string, category: "active" | "complete") {
  await runtime.issueChanges.apply(member, randomUUID(), {
    issues: [{ id: issueId }],
    changes: {
      status: await testStatusReference(database, member, teamId, category),
    },
  });
}

it("reacts to status changes with templated actions and runs once per event", async () => {
  const active = await testStatusReference(database, owner, teamId, "active");
  await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      name: "Start work",
      trigger: { kind: "status_changed", statusIds: [active.id] },
      conditions: [{ field: "assignee", negated: false, values: ["none"] }],
      actions: [
        { kind: "assign", assignee: "trigger_actor" },
        {
          kind: "comment",
          body: "{{actor.name}} started {{issue.identifier}} ({{issue.status}}).",
        },
      ],
    }),
  );
  const issue = await createIssue("Build it");
  await moveTo(issue.id, "active");
  await settle();
  const updated = await runtime.planning.getIssue(owner, issue.id);
  expect(updated.assigneeId).toBe(member.userId);
  const comments = await runtime.comments.list(owner, issue.id);
  expect(comments.map((comment) => comment.body)).toEqual([
    "member started TM-1 (In progress).",
  ]);
  const [run] = await runtime.automations.service.runs(owner, {
    issueId: issue.id,
  });
  expect(run).toMatchObject({
    state: "succeeded",
    trigger: "status_changed",
    actorName: "member",
    issueIdentifier: "TM-1",
  });
  expect(run!.steps.map((step) => step.state)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  await moveTo(issue.id, "complete");
  await settle();
  expect(
    await runtime.automations.service.runs(owner, { issueId: issue.id }),
  ).toHaveLength(1);
});

it("skips issues that do not match the conditions", async () => {
  await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      trigger: { kind: "issue_created" },
      conditions: [{ field: "priority", negated: false, values: ["urgent"] }],
      actions: [{ kind: "set_priority", priority: "high" }],
    }),
  );
  const normal = await createIssue("Normal");
  const urgent = await createIssue("Urgent", "urgent");
  await settle();
  expect((await runtime.planning.getIssue(owner, normal.id)).priority).toBe(
    "none",
  );
  expect((await runtime.planning.getIssue(owner, urgent.id)).priority).toBe(
    "high",
  );
});

it("prevents automations from triggering themselves or looping endlessly", async () => {
  for (const name of ["Echo A", "Echo B"])
    await runtime.automations.service.create(
      owner,
      randomUUID(),
      automation({
        name,
        trigger: { kind: "comment_created", contains: "" },
        actions: [{ kind: "comment", body: `${name}: {{comment.body}}` }],
      }),
    );
  const issue = await createIssue("Loop");
  await runtime.comments.create(member, randomUUID(), issue.id, "Ping");
  await settle();
  await settle();
  const comments = await runtime.comments.list(owner, issue.id);
  expect(comments).toHaveLength(7);
  expect(
    comments.filter((comment) => comment.body.startsWith("Echo A: Echo A")),
  ).toEqual([]);
});

it("asks Agent on mentions as the commenter and applies proposals", async () => {
  await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      trigger: { kind: "comment_created", contains: "@agent" },
      actions: [
        {
          kind: "ask_agent",
          prompt: "{{comment.body}}",
          providerId,
          model: "fixture-model",
          postAnswer: true,
          applyProposals: true,
        },
      ],
    }),
  );
  const issue = await createIssue("Checkout fails");
  start
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          id: "update",
          name: "propose_issue_update",
          arguments: { issue: "TM-1", priority: "urgent" },
        },
      ],
      usage: { totalTokens: 4 },
    })
    .mockResolvedValueOnce({
      text: "Raised the priority.",
      toolCalls: [],
      usage: { totalTokens: 4 },
    });
  await runtime.comments.create(
    member,
    randomUUID(),
    issue.id,
    "@agent how urgent is this?",
  );
  await settle();
  const [waiting] = await runtime.automations.service.runs(owner, {
    issueId: issue.id,
  });
  expect(waiting!.state).toBe("waiting");
  const call = (
    await database.engine.query<{ id: string; actor_id: string }>(
      "SELECT id,actor_id FROM cloud_inference_calls",
    )
  ).rows[0]!;
  expect(call.actor_id).toBe(member.userId);
  expect(start).not.toHaveBeenCalled();
  await runtime.inference.worker.runOne(owner.organizationId, call.id);
  expect(start.mock.calls[0]![0].userPrompt).toContain(
    "@agent how urgent is this?",
  );
  await settle();
  expect((await runtime.planning.getIssue(owner, issue.id)).priority).toBe(
    "urgent",
  );
  const comments = await runtime.comments.list(owner, issue.id);
  expect(comments[0]).toMatchObject({
    authorId: member.userId,
    body: "**Agent**\n\nRaised the priority.",
  });
  const [run] = await runtime.automations.service.runs(owner, {
    issueId: issue.id,
  });
  expect(run).toMatchObject({ state: "succeeded" });
  expect(run!.steps[0]!.detail).toBe("Answered · Applied 1 proposal");
  expect(await runtime.chat.store.list(member)).toEqual([]);
});

it("creates issues from webhooks and rejects unknown tokens", async () => {
  const secret = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      trigger: { kind: "webhook" },
      actions: [
        {
          kind: "create_issue",
          title: "Alert: {{payload.title}}",
          description: "{{payload.detail}}",
          statusId: null,
          priority: "high",
          assigneeId: null,
          labelIds: [],
          subIssue: false,
        },
      ],
    }),
  );
  const token = secret.webhookUrl!.split("/").at(-1)!;
  expect(secret.webhookUrl).toBe(
    `https://cloud.example.test/api/v1/automations/hooks/${token}`,
  );
  const response = await handleCloudApi(
    new Request(
      `https://cloud.example.test/api/v1/automations/hooks/${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "CPU high", detail: "Node 3" }),
      },
    ),
    "203.0.113.1",
    runtime,
  );
  expect(response.status).toBe(202);
  await settle();
  const [created] = await runtime.planning.listIssues(owner, { teamId });
  expect(created).toMatchObject({
    title: "Alert: CPU high",
    description: "Node 3",
    priority: "high",
  });
  await expect(
    runtime.automations.service.receiveWebhook("unknown", {}),
  ).rejects.toMatchObject({ status: 404 });
});

it("runs schedules for each matching issue and sends webhooks for admins", async () => {
  webhookFetch.mockResolvedValue(new Response("ok", { status: 202 }));
  const { id } = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automation({
      trigger: {
        kind: "schedule",
        frequency: "daily",
        time: "09:00",
        weekday: 1,
        timeZone: "UTC",
        forEachIssue: true,
      },
      conditions: [{ field: "priority", negated: false, values: ["urgent"] }],
      actions: [
        { kind: "send_webhook", url: "https://hooks.example.test/x", body: "" },
      ],
    }),
  );
  await createIssue("Urgent", "urgent");
  await createIssue("Other");
  await database.engine.query(
    "UPDATE cloud_automations SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [id],
  );
  await settle();
  expect(webhookFetch).toHaveBeenCalledTimes(1);
  const [url, init] = webhookFetch.mock.calls[0]!;
  expect(url).toBe("https://hooks.example.test/x");
  expect(JSON.parse(String(init!.body))).toMatchObject({
    issue: { identifier: "TM-1", title: "Urgent" },
  });
  expect(
    (await runtime.automations.service.get(owner, id)).nextRunAt,
  ).not.toBeNull();
});

it("enforces ownership, roles and daily limits", async () => {
  await expect(
    runtime.automations.service.create(viewer, randomUUID(), automation({})),
  ).rejects.toMatchObject({ code: "permission_denied" });
  await expect(
    runtime.automations.service.create(
      member,
      randomUUID(),
      automation({
        actions: [
          { kind: "send_webhook", url: "https://hooks.example.test", body: "" },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: "permission_denied" });
  const { id } = await runtime.automations.service.create(
    member,
    randomUUID(),
    automation({ dailyLimit: 1 }),
  );
  const current = await runtime.automations.service.get(owner, id);
  await expect(
    runtime.automations.service.update(owner, randomUUID(), id, {
      revision: current.revision,
      automation: automation({ name: "Taken over" }),
    }),
  ).rejects.toMatchObject({ code: "automation_owner_required" });
  const issue = await createIssue("Manual");
  await runtime.automations.service.run(owner, randomUUID(), id, {
    issueId: issue.id,
  });
  await expect(
    runtime.automations.service.run(owner, randomUUID(), id, {
      issueId: issue.id,
    }),
  ).rejects.toMatchObject({ code: "automation_daily_limit" });
  await expect(
    runtime.automations.service.run(owner, randomUUID(), id, {
      issueId: null,
    }),
  ).rejects.toMatchObject({ code: "automation_issue_required" });
  await database.engine.query(
    "UPDATE cloud_memberships SET role='viewer' WHERE user_id=$1",
    [member.userId],
  );
  await settle();
  const [run] = await runtime.automations.service.runs(owner, {
    automationId: id,
  });
  expect(run).toMatchObject({ state: "failed" });
  expect((await runtime.automations.service.get(owner, id)).enabled).toBe(
    false,
  );
});
