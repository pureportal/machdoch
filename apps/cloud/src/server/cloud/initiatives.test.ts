import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { initiativeInputSchema } from "../../lib/cloud-initiative-contract";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase, testStatusReference } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let teamId: string;
let privateTeamId: string;

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
  privateTeamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Hidden",
      key: "HID",
      visibility: "private",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

async function project(name: string, team = teamId) {
  return (
    await runtime.projects.create(owner, randomUUID(), {
      teamId: team,
      name,
      description: "",
    })
  ).id;
}

it("groups projects into initiatives without exposing or unlinking inaccessible projects", async () => {
  const visible = await project("Checkout");
  const hidden = await project("Treasury", privateTeamId);
  const done = await testStatusReference(database, owner, teamId, "complete");
  for (const status of [done, null])
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        title: "Work",
        projectId: visible,
        status,
      }),
    );
  await runtime.projectUpdates.create(owner, randomUUID(), visible, {
    health: "at_risk",
    body: "",
  });
  await runtime.projectUpdates.create(owner, randomUUID(), hidden, {
    health: "off_track",
    body: "",
  });
  const { id } = await runtime.initiatives.create(
    owner,
    randomUUID(),
    initiativeInputSchema.parse({
      name: "Growth",
      ownerId: member.userId,
      projectIds: [visible, hidden],
    }),
  );
  await expect(
    runtime.initiatives.create(
      viewer,
      randomUUID(),
      initiativeInputSchema.parse({ name: "Nope" }),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    runtime.initiatives.create(
      member,
      randomUUID(),
      initiativeInputSchema.parse({ name: "Leak", projectIds: [hidden] }),
    ),
  ).rejects.toMatchObject({ code: "invalid_reference" });
  expect(await runtime.initiatives.get(owner, id)).toMatchObject({
    projectIds: [visible, hidden].sort(),
    health: "off_track",
  });
  const seen = await runtime.initiatives.get(member, id);
  expect(seen).toMatchObject({
    name: "Growth",
    status: "planned",
    ownerId: member.userId,
    projectIds: [visible],
    issues: 2,
    completedIssues: 1,
    health: "at_risk",
  });
  await runtime.initiatives.update(member, randomUUID(), id, {
    revision: seen.revision,
    name: "Growth",
    description: "",
    status: "active",
    ownerId: null,
    targetOn: "2027-03-01",
    projectIds: [],
  });
  expect(await runtime.initiatives.get(owner, id)).toMatchObject({
    status: "active",
    targetOn: "2027-03-01",
    projectIds: [hidden],
  });
  await expect(
    runtime.initiatives.update(member, randomUUID(), id, {
      revision: seen.revision,
      name: "Stale",
      description: "",
      status: "active",
      ownerId: null,
      targetOn: null,
      projectIds: [],
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(
    (await runtime.initiatives.list(member)).map((entry) => entry.name),
  ).toEqual(["Growth"]);
});

it("keeps issue milestones inside the issue's project", async () => {
  const first = await project("First");
  const second = await project("Second");
  const milestone = await runtime.milestones.create(
    owner,
    randomUUID(),
    first,
    {
      name: "Beta",
      targetOn: null,
    },
  );
  await expect(
    runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        title: "Wrong project",
        projectId: second,
        milestoneId: milestone.id,
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_reference" });
  const { id } = await runtime.planning.createIssue(
    member,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      title: "Ship beta",
      projectId: first,
      milestoneId: milestone.id,
    }),
  );
  expect((await runtime.planning.getIssue(member, id)).milestoneId).toBe(
    milestone.id,
  );
  await runtime.issueChanges.apply(member, randomUUID(), {
    issues: [{ id }],
    changes: { projectId: second },
  });
  expect(await runtime.planning.getIssue(member, id)).toMatchObject({
    projectId: second,
    milestoneId: null,
  });
  await runtime.issueChanges.apply(member, randomUUID(), {
    issues: [{ id }],
    changes: { projectId: first, milestoneId: milestone.id },
  });
  await runtime.milestones.remove(owner, milestone.id);
  expect(await runtime.planning.getIssue(member, id)).toMatchObject({
    projectId: first,
    milestoneId: null,
  });
});

it("summarizes parents only when the parent is accessible and feeds updates newest first", async () => {
  const parent = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title: "Parent" }),
  );
  const child = await runtime.relations.createChild(
    owner,
    randomUUID(),
    parent.id,
    {
      parentRevision: 1,
      issue: issueInputSchema.parse({ teamId, title: "Child" }),
    },
  );
  const summaries = await runtime.planning.listIssueSummaries(member, {
    teamId,
  });
  expect(summaries.find((issue) => issue.id === child.id)?.parent).toEqual({
    id: parent.id,
    identifier: "TM-1",
    title: "Parent",
  });
  expect(summaries.find((issue) => issue.id === parent.id)?.parent).toBeNull();
  const visible = await project("Visible");
  const hidden = await project("Hidden", privateTeamId);
  await runtime.projectUpdates.create(owner, randomUUID(), visible, {
    health: "on_track",
    body: "First",
  });
  await runtime.projectUpdates.create(owner, randomUUID(), hidden, {
    health: "off_track",
    body: "Secret",
  });
  await runtime.projectUpdates.create(owner, randomUUID(), visible, {
    health: "at_risk",
    body: "Second",
  });
  expect(
    (await runtime.projectUpdates.feed(member)).map((entry) => [
      entry.projectName,
      entry.body,
    ]),
  ).toEqual([
    ["Visible", "Second"],
    ["Visible", "First"],
  ]);
});
