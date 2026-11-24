import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { AgentModelTurn } from "@machdoch/model-runtime/types";
import { issueInputSchema, type CloudActor } from "../../../lib/cloud-contract";
import {
  agentEntityKinds,
  maximumStepEntities,
  type AgentEntityKind,
} from "../../../lib/cloud-chat-contract";
import {
  agentEntityHref,
  agentStepSegments,
} from "../../../lib/agent-entity-links";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let providerId: string;
let turns: AgentModelTurn[];
const usage = { inputTokens: 10, outputTokens: 6, totalTokens: 16 };

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
  owner = { userId: randomUUID(), organizationId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [owner.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'owner@example.test','Olga Owner','test')",
    [owner.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [owner.organizationId, owner.userId],
  );
  turns = [];
  const next = async () => turns.shift() ?? { text: "Done", toolCalls: [] };
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    modelAdapterFactory: async () => ({
      startTurn: next,
      continueTurn: next,
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

it("records tool steps with linked result entities in the worked-for trace", async () => {
  const team = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Product",
    key: "PRD",
    visibility: "private",
    estimateScale: [{ label: "1", points: 1 }],
  });
  const issues = [];
  for (let index = 1; index <= maximumStepEntities + 2; index += 1)
    issues.push(
      await runtime.planning.getIssue(
        owner,
        (
          await runtime.planning.createIssue(
            owner,
            randomUUID(),
            issueInputSchema.parse({ teamId: team.id, title: `Bug ${index}` }),
          )
        ).id,
      ),
    );
  turns.push(
    {
      text: "",
      toolCalls: [
        { id: "search", name: "search_issues", arguments: { team: "PRD" } },
        {
          id: "read",
          name: "get_issue",
          arguments: { issue: issues[0]!.identifier },
        },
        { id: "team", name: "get_team", arguments: { team: "PRD" } },
        { id: "missing", name: "get_issue", arguments: { issue: "PRD-999" } },
      ],
      usage,
    },
    { text: `Start with ${issues[0]!.identifier}.`, toolCalls: [], usage },
  );
  const request = await runtime.chat.store.submit(owner, randomUUID(), {
    chatId: null,
    revision: null,
    providerId,
    model: "fixture-model",
    prompt: "Which bug comes first?",
    context: [],
    attachmentIds: [],
  });
  await runtime.inference.worker.runOne(
    owner.organizationId,
    request.requestId,
  );
  const [turn] = (await runtime.chat.store.get(owner, request.chatId)).turns;
  expect(turn).toMatchObject({ state: "complete" });
  expect(Date.parse(turn!.finishedAt!)).toBeGreaterThanOrEqual(
    Date.parse(turn!.startedAt!),
  );
  const [search, read, teamStep, missing] = turn!.steps;
  expect(search).toMatchObject({ tool: "search_issues", failed: false });
  expect(search!.entities).toHaveLength(maximumStepEntities);
  expect(search!.entities!.every((entity) => entity.kind === "issue")).toBe(
    true,
  );
  expect(read).toMatchObject({
    label: `Read ${issues[0]!.identifier}`,
    entities: [
      { kind: "issue", id: issues[0]!.id, label: issues[0]!.identifier },
    ],
  });
  expect(teamStep!.entities).toEqual([
    { kind: "team", id: team.id, label: "Product" },
  ]);
  expect(missing).toMatchObject({ failed: true });
  expect(missing!.entities).toBeUndefined();
  expect(read!.entities!.map(agentEntityHref)).toEqual([
    `/cloud/issues/${issues[0]!.id}`,
  ]);
});

it("links every entity kind to its page", () => {
  const routes: Record<AgentEntityKind, string> = {
    issue: "/cloud/issues/x",
    project: "/cloud/projects/x",
    initiative: "/cloud/initiatives/x",
    cycle: "/cloud/cycles/x",
    team: "/cloud/teams/x",
    pull_request: "/cloud/pull-requests/x",
    release: "/cloud/releases/x",
    loop: "/cloud/loops/x",
  };
  for (const kind of agentEntityKinds)
    expect(agentEntityHref({ kind, id: "x" })).toBe(routes[kind]);
});

it("links named results inside the step label and lists the rest after it", () => {
  const issue = { kind: "issue" as const, id: "1", label: "ENG-1" };
  const other = { kind: "issue" as const, id: "2", label: "ENG-2" };
  expect(
    agentStepSegments({ label: "Read 3 comments on ENG-1", entities: [issue] }),
  ).toEqual({ label: ["Read 3 comments on ", issue], trailing: [] });
  expect(
    agentStepSegments({ label: "Found 2 issues", entities: [issue, other] }),
  ).toEqual({ label: ["Found 2 issues"], trailing: [issue, other] });
  expect(agentStepSegments({ label: "Asked a question" })).toEqual({
    label: ["Asked a question"],
    trailing: [],
  });
});
