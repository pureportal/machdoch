import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { triageDecisionSchema } from "../../lib/cloud-triage-contract";
import { workflowDefinitionSchema } from "../../lib/cloud-workflow-contract";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let teamId: string;
let triageId: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test");
}, 30_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
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
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  const workflow = await runtime.workflows.get(owner, teamId);
  triageId = randomUUID();
  const definition = workflowDefinitionSchema.parse({
    revision: workflow.revision,
    defaultStatusId: triageId,
    statuses: [
      { id: triageId, name: "Triage", category: "triage", archived: false },
      ...workflow.statuses.map(({ revision: _, ...status }) => status),
    ],
  });
  await runtime.workflows.update(owner, randomUUID(), teamId, {
    definition,
    impactDigest: (await runtime.workflows.preview(owner, teamId, definition))
      .digest,
  });
});

async function issue(title: string, description = "") {
  return (
    await runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({ teamId, title, description }),
    )
  ).id;
}

async function decide(
  id: string,
  decision: Record<string, unknown>,
  actor = owner,
  key = randomUUID(),
) {
  const { revision } = await runtime.planning.getIssue(actor, id);
  return runtime.triage.decide(
    actor,
    key,
    id,
    triageDecisionSchema.parse({ revision, ...decision }),
  );
}

it("allows one active triage status per team", async () => {
  const workflow = await runtime.workflows.get(owner, teamId);
  const statuses = workflow.statuses.map(
    ({ revision: _, ...status }) => status,
  );
  const result = workflowDefinitionSchema.safeParse({
    revision: workflow.revision,
    defaultStatusId: workflow.defaultStatusId,
    statuses: [
      ...statuses,
      {
        id: randomUUID(),
        name: "Second triage",
        category: "triage",
        archived: false,
      },
    ],
  });
  expect(result.error?.issues[0]?.message).toBe("Use one Triage status.");
  expect(
    workflowDefinitionSchema.safeParse({
      revision: workflow.revision,
      defaultStatusId: workflow.defaultStatusId,
      statuses: [
        ...statuses,
        {
          id: randomUUID(),
          name: "Old triage",
          category: "triage",
          archived: true,
        },
      ],
    }).success,
  ).toBe(true);
});

it("lists and counts new issues in triage, then accepts, declines and merges duplicates", async () => {
  const accepted = await issue("Login fails on Safari", "Steps to reproduce");
  const declined = await issue("Add a dark mode toggle");
  const duplicate = await issue("Safari login broken");
  expect(await runtime.triage.counts(viewer)).toEqual({ [teamId]: 3 });
  const listed = await runtime.triage.list(member, teamId);
  expect(listed.map((entry) => entry.id)).toEqual([
    duplicate,
    declined,
    accepted,
  ]);
  expect(listed[2]).toMatchObject({
    state: "triage",
    statusName: "Triage",
    creator: "member",
    description: "Steps to reproduce",
  });
  await expect(
    decide(accepted, {
      decision: "accept",
      status: { id: triageId, revision: 1 },
    }),
  ).rejects.toMatchObject({ code: "triage_status" });
  await expect(
    decide(accepted, { decision: "accept" }, viewer),
  ).rejects.toMatchObject({ status: 403 });

  const key = randomUUID();
  const result = await decide(accepted, { decision: "accept" }, member, key);
  expect(result).toMatchObject({ id: accepted, statusName: "Backlog" });
  expect(
    await runtime.triage.decide(
      member,
      key,
      accepted,
      triageDecisionSchema.parse({ decision: "accept", revision: 1 }),
    ),
  ).toEqual(result);
  expect(await runtime.planning.getIssue(member, accepted)).toMatchObject({
    state: "backlog",
    revision: result.revision,
  });
  await expect(decide(accepted, { decision: "decline" })).rejects.toMatchObject(
    { code: "triage_settled" },
  );

  await decide(declined, { decision: "decline", reason: "Out of scope." });
  expect(await runtime.planning.getIssue(member, declined)).toMatchObject({
    state: "canceled",
    statusName: "Canceled",
  });
  expect(
    (await runtime.comments.list(member, declined)).map(
      (comment) => comment.body,
    ),
  ).toEqual(["Out of scope."]);

  await decide(duplicate, { decision: "duplicate", duplicateOfId: accepted });
  expect((await runtime.planning.getIssue(member, duplicate)).state).toBe(
    "canceled",
  );
  expect(
    (await runtime.relations.list(member, duplicate)).map((relation) => [
      relation.kind,
      relation.issue.id,
    ]),
  ).toEqual([["duplicate_of", accepted]]);
  expect(
    (await runtime.relations.list(member, accepted)).map((relation) => [
      relation.kind,
      relation.issue.id,
    ]),
  ).toEqual([["duplicated_by", duplicate]]);
  expect(await runtime.triage.counts(member)).toEqual({});
  expect(await runtime.triage.list(member, null)).toEqual([]);
});
