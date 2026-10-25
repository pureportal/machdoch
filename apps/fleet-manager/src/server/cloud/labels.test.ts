import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  issueUpdateSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor,
  member: CloudActor,
  viewer: CloudActor,
  stranger: CloudActor;
let teamId: string, issueId: string;
beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test");
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID(),
    other = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization'),($2,'Other')",
    [organizationId, other],
  );
  const actors: CloudActor[] = [];
  for (const [organization, role] of [
    [organizationId, "owner"],
    [organizationId, "member"],
    [organizationId, "viewer"],
    [other, "owner"],
  ]) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${userId}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organization, userId, role],
    );
    actors.push({ organizationId: organization!, userId });
  }
  [owner, member, viewer, stranger] = actors as [
    CloudActor,
    CloudActor,
    CloudActor,
    CloudActor,
  ];
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  issueId = (
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId, title: "Issue", estimate: "3" }),
    )
  ).id;
});

it("creates and updates labels idempotently, enforces names and keeps no-op revisions stable", async () => {
  const key = randomUUID(),
    input = { name: "Bug", color: "red" as const };
  const label = await runtime.labels.create(member, key, teamId, input);
  expect(await runtime.labels.create(member, key, teamId, input)).toEqual(
    label,
  );
  await expect(
    runtime.labels.create(member, key, teamId, { ...input, name: "Different" }),
  ).rejects.toMatchObject({ code: "command_conflict" });
  await expect(
    runtime.labels.create(member, randomUUID(), teamId, {
      ...input,
      name: "bug",
    }),
  ).rejects.toMatchObject({ code: "label_name_exists" });
  const updateKey = randomUUID(),
    change = { ...input, revision: 1, name: "Defect", archived: false };
  await runtime.labels.update(member, updateKey, label.id, change);
  await runtime.labels.update(member, updateKey, label.id, change);
  await expect(
    runtime.labels.update(member, randomUUID(), label.id, change),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await runtime.labels.update(member, randomUUID(), label.id, {
    ...change,
    revision: 2,
  });
  expect(await runtime.labels.list(viewer, teamId)).toMatchObject([
    { id: label.id, revision: 2, name: "Defect" },
  ]);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='label.changed'",
      )
    ).rows,
  ).toHaveLength(1);
});

it("fences label assignments independently of issue and poker revisions", async () => {
  const label = await runtime.labels.create(member, randomUUID(), teamId, {
    name: "Bug",
    color: "red",
  });
  const issue = await runtime.planning.getIssue(owner, issueId);
  const round = await runtime.poker.create(
    owner,
    randomUUID(),
    issue.id,
    issue.revision,
  );
  const key = randomUUID(),
    change = { revision: 1, labelIds: [label.id] };
  await runtime.labels.setIssue(member, key, issueId, change);
  await runtime.labels.setIssue(member, key, issueId, change);
  await expect(
    runtime.labels.setIssue(member, randomUUID(), issueId, {
      revision: 1,
      labelIds: [],
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await runtime.labels.getIssue(viewer, issueId)).toMatchObject({
    revision: 2,
    labels: [{ id: label.id }],
  });
  expect(await runtime.planning.getIssue(owner, issueId)).toEqual(issue);
  expect((await runtime.poker.get(owner, round.id)).stale).toBe(false);
  expect(
    (await runtime.planning.listIssues(owner, { labelId: label.id })).map(
      (entry) => entry.id,
    ),
  ).toEqual([issueId]);
  await runtime.labels.setIssue(member, randomUUID(), issueId, {
    revision: 2,
    labelIds: [label.id],
  });
  expect((await runtime.labels.getIssue(owner, issueId)).revision).toBe(2);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='issue.labels_changed'",
      )
    ).rows,
  ).toHaveLength(1);
});

it("retains archived assignments but refuses new ones and rejects edits to archived issues", async () => {
  const label = await runtime.labels.create(member, randomUUID(), teamId, {
    name: "Bug",
    color: "red",
  });
  await runtime.labels.setIssue(member, randomUUID(), issueId, {
    revision: 1,
    labelIds: [label.id],
  });
  await runtime.labels.update(member, randomUUID(), label.id, {
    revision: 1,
    name: "Bug",
    color: "red",
    archived: true,
  });
  expect(
    (await runtime.labels.getIssue(owner, issueId)).labels[0]?.archived,
  ).toBe(true);
  await runtime.labels.setIssue(member, randomUUID(), issueId, {
    revision: 2,
    labelIds: [label.id],
  });
  const another = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title: "Another" }),
  );
  await expect(
    runtime.labels.setIssue(member, randomUUID(), another.id, {
      revision: 1,
      labelIds: [label.id],
    }),
  ).rejects.toMatchObject({ code: "label_unavailable" });
  await runtime.labels.setIssue(member, randomUUID(), issueId, {
    revision: 2,
    labelIds: [],
  });
  await expect(
    runtime.labels.setIssue(member, randomUUID(), issueId, {
      revision: 3,
      labelIds: [label.id],
    }),
  ).rejects.toMatchObject({ code: "label_unavailable" });
  const issue = await runtime.planning.getIssue(owner, issueId);
  await runtime.planning.updateIssue(owner, randomUUID(), issueId, {
    ...issueUpdateSchema.strip().parse(issue),
    archived: true,
  });
  await expect(
    runtime.labels.setIssue(member, randomUUID(), issueId, {
      revision: 3,
      labelIds: [],
    }),
  ).rejects.toMatchObject({ code: "issue_archived" });
});

it("enforces tenant, team, viewer and membership boundaries", async () => {
  const label = await runtime.labels.create(member, randomUUID(), teamId, {
    name: "Bug",
    color: "red",
  });
  await expect(
    runtime.labels.create(viewer, randomUUID(), teamId, {
      name: "Other",
      color: "blue",
    }),
  ).rejects.toMatchObject({ code: "permission_denied" });
  await expect(
    runtime.labels.setIssue(viewer, randomUUID(), issueId, {
      revision: 1,
      labelIds: [label.id],
    }),
  ).rejects.toMatchObject({ code: "permission_denied" });
  await expect(runtime.labels.list(stranger, teamId)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    runtime.labels.getIssue(stranger, issueId),
  ).rejects.toMatchObject({ code: "not_found" });
  const otherTeam = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Private",
    key: "PV",
    visibility: "private",
    estimateScale: defaultEstimateScale,
  });
  const hidden = await runtime.labels.create(
    owner,
    randomUUID(),
    otherTeam.id,
    { name: "Hidden", color: "green" },
  );
  await expect(runtime.labels.list(member, otherTeam.id)).rejects.toMatchObject(
    { code: "not_found" },
  );
  await expect(
    runtime.labels.setIssue(owner, randomUUID(), issueId, {
      revision: 1,
      labelIds: [hidden.id],
    }),
  ).rejects.toMatchObject({ code: "label_unavailable" });
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE organization_id=$1 AND user_id=$2",
    [owner.organizationId, member.userId],
  );
  await expect(
    runtime.labels.update(member, randomUUID(), label.id, {
      revision: 1,
      name: "Changed",
      color: "red",
      archived: false,
    }),
  ).rejects.toMatchObject({ code: "membership_required" });
});
