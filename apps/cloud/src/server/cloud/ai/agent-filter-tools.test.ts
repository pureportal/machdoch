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
import { issueInputSchema, type CloudActor } from "../../../lib/cloud-contract";
import type { CloudChatTurn } from "../../../lib/cloud-chat-contract";
import { decodeIssueFilter } from "../../../lib/issue-filter-model";
import { issueFiltersFromParameters } from "../../../lib/issue-scopes";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase, testStatusReference } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let outsider: CloudActor;
let providerId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;

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
    [owner, "owner", "Olga Owner"],
    [member, "member", "Mia Member"],
    [outsider, "member", "Otto Outsider"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${randomUUID()}@example.test`, name],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  start = vi.fn();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
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
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 1_000_000,
      maxConcurrentRequests: 4,
    })
  ).id;
});

async function privateTeam() {
  const team = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Product",
    key: "PRD",
    visibility: "private",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [member.organizationId, team.id, member.userId],
  );
  const [bug, frontend] = await Promise.all(
    ["Bug", "Frontend"].map(
      async (name) =>
        (
          await runtime.labels.create(owner, randomUUID(), team.id, {
            name,
            color: "red",
          })
        ).id,
    ),
  );
  const active = await testStatusReference(database, owner, team.id, "active");
  const issue = async (
    title: string,
    labelId: string,
    extra: Record<string, unknown> = {},
  ) => {
    const created = await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId: team.id, title, ...extra }),
    );
    const { revision } = await runtime.planning.getIssue(owner, created.id);
    await runtime.labels.setIssue(owner, randomUUID(), created.id, {
      revision,
      labelIds: [labelId],
    });
    return created.id;
  };
  return {
    team,
    urgentBug: await issue("Checkout crashes", bug!, { priority: "urgent" }),
    startedBug: await issue("Webhook retries twice", bug!, {
      priority: "low",
      status: active,
    }),
    assignedBug: await issue("Receipt total is off", bug!, {
      priority: "urgent",
      assigneeId: member.userId,
    }),
    urgentFrontend: await issue("Button misaligned", frontend!, {
      priority: "urgent",
    }),
    quietBug: await issue("Old log line", bug!, { priority: "normal" }),
  };
}

function toolCalls(
  ...calls: { name: string; arguments: Record<string, unknown> }[]
): AgentModelTurn {
  return {
    text: "",
    toolCalls: calls.map((call) => ({ ...call, id: `call-${randomUUID()}` })),
    usage: { totalTokens: 10 },
  };
}

async function ask(
  actor: CloudActor,
  ...rounds: AgentModelTurn[]
): Promise<CloudChatTurn> {
  for (const round of rounds) start.mockResolvedValueOnce(round);
  start.mockResolvedValueOnce({
    text: "Done.",
    toolCalls: [],
    usage: { totalTokens: 1 },
  });
  const submission = await runtime.chat.store.submit(actor, randomUUID(), {
    chatId: null,
    revision: null,
    providerId,
    model: "fixture-model",
    prompt: "Show unassigned bugs that are urgent or already started.",
    context: [],
    attachmentIds: [],
  });
  await runtime.inference.worker.runOne(
    actor.organizationId,
    submission.requestId,
  );
  return (await runtime.chat.store.get(actor, submission.chatId)).turns[0]!;
}

function toolOutputs(): unknown[] {
  return (
    JSON.parse(start.mock.lastCall![0].userPrompt) as {
      role: string;
      content: string;
    }[]
  )
    .filter((entry) => entry.role === "tool")
    .map((entry) => JSON.parse(entry.content));
}

const describedFilter = {
  name: "propose_issue_filter",
  arguments: {
    conditions: [
      { field: "label", values: ["bug"] },
      { field: "assignee", values: ["None"] },
    ],
    anyOf: [
      [
        { field: "priority", values: ["Urgent"] },
        { field: "status", values: ["active"] },
      ],
    ],
  },
};

it("turns a described filter into editable chips and runs it without a model", async () => {
  const { urgentBug, startedBug } = await privateTeam();
  const turn = await ask(member, toolCalls(describedFilter));
  const [action] = turn.actions;
  expect(action).toMatchObject({ kind: "issue_filter", state: "pending" });
  expect(action!.fields).toEqual([
    { label: "Labels", value: "include any of Bug" },
    { label: "Assignee", value: "is none" },
    {
      label: "Any of",
      value: "Priority is urgent or Status is active",
    },
  ]);

  const modelCalls = start.mock.calls.length;
  const applied = await runtime.chat.actions.apply(member, turn.id, action!.id);
  expect(applied).toMatchObject({
    state: "applied",
    result: { kind: "filter" },
  });
  const url = new URL(applied.result!.href!, "https://cloud.example.test");
  expect(url.pathname).toBe("/cloud/issues");
  const parameters = Object.fromEntries(url.searchParams);
  const tree = decodeIssueFilter(parameters.filter!);
  expect(tree.conditions.map((entry) => entry.field)).toEqual([
    "label",
    "assignee",
  ]);
  expect(tree.groups).toHaveLength(1);

  const filters = issueFiltersFromParameters(parameters);
  const found = await runtime.planning.listIssueSummaries(member, filters);
  expect(found.map((issue) => issue.id).sort()).toEqual(
    [urgentBug, startedBug].sort(),
  );
  expect(start.mock.calls.length).toBe(modelCalls);
});

it("rejects names it cannot resolve and never resolves hidden team values", async () => {
  await privateTeam();
  const unknown = await ask(
    member,
    toolCalls({
      name: "propose_issue_filter",
      arguments: { conditions: [{ field: "label", values: ["Bugz"] }] },
    }),
  );
  expect(unknown.actions).toEqual([]);
  expect(JSON.stringify(toolOutputs())).toContain(
    'Labels: nothing matches \\"Bugz\\"',
  );

  const hidden = await ask(outsider, toolCalls(describedFilter));
  expect(hidden.actions).toEqual([]);
  expect(JSON.stringify(toolOutputs())).toContain("Labels: nothing matches");
});
