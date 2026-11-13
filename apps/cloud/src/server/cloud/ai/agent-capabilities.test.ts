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
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { agentContext } from "./agent-context";

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
      { label: "8", points: 8 },
    ],
  });
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [member.organizationId, team.id, member.userId],
  );
  const issue = (title: string, extra: Record<string, unknown> = {}) =>
    runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId: team.id, title, ...extra }),
    );
  const first = await issue("Checkout loses the basket", {
    assigneeId: member.userId,
    estimate: "3",
  });
  const second = await issue("Retry payment webhook");
  const third = await issue("Old tracking pixel");
  for (const name of ["Bug", "Payments", "Frontend"])
    await runtime.labels.create(owner, randomUUID(), team.id, {
      name,
      color: "red",
    });
  return { team, first, second, third };
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
    prompt: "Help me with the board.",
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

async function issue(actor: CloudActor, value: { id: string }) {
  return runtime.planning.getIssue(actor, value.id);
}

it("reads the newest comments and pages through the full discussion", async () => {
  const { first } = await privateTeam();
  for (let index = 1; index <= 15; index++)
    await runtime.comments.create(
      owner,
      randomUUID(),
      first.id,
      `Comment ${index}\n\n- detail ${index}`,
    );
  await ask(
    member,
    toolCalls(
      { name: "get_issue", arguments: { issue: "prd-1" } },
      { name: "list_comments", arguments: { issue: "PRD-1" } },
    ),
  );
  const [read, listed] = toolOutputs() as [
    { comments: { body: string }[]; olderComments: boolean },
    { comments: { body: string }[]; older: string | null },
  ];
  expect(read.comments.map((comment) => comment.body)).toEqual(
    Array.from({ length: 12 }, (_, index) =>
      expect.stringContaining(`Comment ${index + 4} `),
    ),
  );
  expect(read.olderComments).toBe(true);
  expect(listed.comments[0]!.body).toBe("Comment 15\n\n- detail 15");
  expect(listed.comments).toHaveLength(15);
  expect(listed.older).toBeNull();
});

it("changes labels, moves and archives issues and edits links once the member confirms", async () => {
  const { team, first, second, third } = await privateTeam();
  const cycle = await runtime.planning.createCycle(owner, randomUUID(), {
    teamId: team.id,
    name: "Sprint 1",
    startsOn: "2026-11-09",
    endsOn: "2026-11-20",
    timezone: "UTC",
    capacity: null,
  });
  await runtime.labels.setIssue(owner, randomUUID(), first.id, {
    revision: 1,
    labelIds: [
      (await runtime.labels.list(owner, team.id)).find(
        (label) => label.name === "Frontend",
      )!.id,
    ],
  });
  const turn = await ask(
    member,
    toolCalls(
      {
        name: "propose_issue_update",
        arguments: {
          issue: "PRD-1",
          description: "## Steps\n\n1. Add an item\n2. Retry",
          estimate: "8",
          addLabels: ["Bug", "payments"],
          removeLabels: ["Frontend"],
        },
      },
      {
        name: "propose_bulk_update",
        arguments: {
          issues: ["PRD-1", "PRD-2"],
          status: "In progress",
          cycle: "Sprint 1",
          priority: "high",
        },
      },
      { name: "propose_archive_issues", arguments: { issues: ["PRD-3"] } },
      {
        name: "propose_link",
        arguments: { issue: "PRD-2", relation: "blocks", target: "PRD-1" },
      },
    ),
  );
  expect(turn.actions.map((action) => [action.kind, action.state])).toEqual([
    ["update_issue", "pending"],
    ["update_issues", "pending"],
    ["update_issues", "pending"],
    ["link", "pending"],
  ]);
  expect(turn.actions[0]!.fields).toContainEqual({
    label: "Description",
    value: "## Steps\n\n1. Add an item\n2. Retry",
    markdown: true,
  });
  expect(await issue(member, first)).toMatchObject({ estimate: "3" });
  for (const action of turn.actions)
    expect(
      await runtime.chat.actions.apply(member, turn.id, action.id),
    ).toMatchObject({ state: "applied" });
  expect(await issue(member, first)).toMatchObject({
    description: "## Steps\n\n1. Add an item\n2. Retry",
    estimate: "8",
    priority: "high",
    state: "active",
    cycleId: cycle.id,
  });
  expect(
    (await runtime.labels.getIssue(member, first.id)).labels.map(
      (label) => label.name,
    ),
  ).toEqual(["Bug", "Payments"]);
  expect(await issue(member, second)).toMatchObject({
    state: "active",
    cycleId: cycle.id,
  });
  expect(await issue(member, third)).toMatchObject({ archived: true });
  const links = await runtime.relations.list(member, second.id);
  expect(links.map((link) => [link.kind, link.issue.identifier])).toEqual([
    ["blocks", "PRD-1"],
  ]);

  const undo = await ask(
    member,
    toolCalls(
      {
        name: "propose_archive_issues",
        arguments: { issues: ["PRD-3"], restore: true },
      },
      {
        name: "propose_link",
        arguments: {
          issue: "PRD-2",
          relation: "blocks",
          target: "PRD-1",
          remove: true,
        },
      },
    ),
  );
  for (const action of undo.actions)
    await runtime.chat.actions.apply(member, undo.id, action.id);
  expect(await issue(member, third)).toMatchObject({ archived: false });
  expect(await runtime.relations.list(member, second.id)).toEqual([]);
});

it("keeps private teams hidden from members outside them", async () => {
  await privateTeam();
  const turn = await ask(
    outsider,
    toolCalls(
      { name: "get_issue", arguments: { issue: "PRD-1" } },
      {
        name: "propose_issue",
        arguments: { team: "PRD", title: "Sneak in" },
      },
      {
        name: "propose_archive_issues",
        arguments: { issues: ["PRD-1"] },
      },
    ),
  );
  expect(turn.actions).toEqual([]);
  expect(turn.steps.map((step) => step.failed)).toEqual([true, true, true]);
  expect(JSON.stringify(toolOutputs())).not.toContain("Checkout loses");
  expect(await runtime.planning.findIssue(outsider, "prd-1")).toBeNull();
  expect(await runtime.planning.findIssue(member, "prd-1")).toMatchObject({
    identifier: "PRD-1",
  });
});

it("re-checks the member's access when a proposal is confirmed", async () => {
  const { team, first } = await privateTeam();
  const turn = await ask(
    member,
    toolCalls(
      {
        name: "propose_issue_update",
        arguments: { issue: "PRD-1", priority: "urgent" },
      },
      {
        name: "propose_comment",
        arguments: { issue: "PRD-1", body: "I will take this **today**." },
      },
    ),
  );
  const [update, comment] = turn.actions;
  await database.engine.query(
    "DELETE FROM cloud_team_memberships WHERE organization_id=$1 AND team_id=$2 AND user_id=$3",
    [member.organizationId, team.id, member.userId],
  );
  expect(
    await runtime.chat.actions.apply(member, turn.id, update!.id),
  ).toMatchObject({ state: "failed", error: "Team is unavailable." });
  await database.engine.query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [member.organizationId, team.id, member.userId],
  );
  await database.engine.query(
    "UPDATE cloud_memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
    [member.organizationId, member.userId],
  );
  await expect(
    runtime.chat.actions.apply(member, turn.id, comment!.id),
  ).rejects.toMatchObject({ status: 403 });
  expect(await issue(owner, first)).toMatchObject({ priority: "none" });
  expect(await runtime.comments.list(owner, first.id)).toEqual([]);
});

it("gives the agent the user's role, team vocabulary and assigned work", async () => {
  await privateTeam();
  const asMember = await database.transaction((sql) =>
    agentContext(sql, member, []),
  );
  expect(asMember).toContain("User: Mia Member, role Member.");
  expect(asMember).toContain(
    "- Product (PRD), you are a member. Statuses: Backlog (backlog)",
  );
  expect(asMember).toContain(
    "Estimates: 1, 3, 8. Labels: Bug, Frontend, Payments.",
  );
  expect(asMember).toContain("## Assigned to you (1 open)");
  expect(asMember).toContain("- PRD-1 Checkout loses the basket");
  const asOutsider = await database.transaction((sql) =>
    agentContext(sql, outsider, []),
  );
  expect(asOutsider).not.toContain("PRD");
});
