import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase, testStatusReference } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let teamId: string;
let privateTeamId: string;
let issueId: string;

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
  issueId = (
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId, title: "Shared work" }),
    )
  ).id;
});

it("keeps favorites private and hides items that became inaccessible", async () => {
  const project = await runtime.projects.create(owner, randomUUID(), {
    teamId,
    name: "Launch",
    description: "",
  });
  const hidden = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId: privateTeamId, title: "Secret" }),
  );
  await runtime.favorites.set(member, {
    kind: "issue",
    id: issueId,
    favorite: true,
  });
  await runtime.favorites.set(member, {
    kind: "project",
    id: project.id,
    favorite: true,
  });
  await runtime.favorites.set(member, {
    kind: "issue",
    id: issueId,
    favorite: true,
  });
  await expect(
    runtime.favorites.set(member, {
      kind: "issue",
      id: hidden.id,
      favorite: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.favorites.set(member, {
      kind: "cycle",
      id: issueId,
      favorite: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await runtime.favorites.list(member)).toEqual([
    { kind: "issue", id: issueId, label: "TM-1 Shared work", state: "backlog" },
    { kind: "project", id: project.id, label: "Launch", state: "planned" },
  ]);
  expect(await runtime.favorites.list(owner)).toEqual([]);
  await runtime.favorites.set(owner, {
    kind: "issue",
    id: hidden.id,
    favorite: true,
  });
  expect(await runtime.favorites.list(owner)).toHaveLength(1);
  await database.engine.query(
    "UPDATE cloud_memberships SET role='member' WHERE user_id=$1",
    [owner.userId],
  );
  await database.engine.query(
    "DELETE FROM cloud_team_memberships WHERE user_id=$1",
    [owner.userId],
  );
  expect(await runtime.favorites.list(owner)).toEqual([]);
  await runtime.favorites.set(member, {
    kind: "issue",
    id: issueId,
    favorite: false,
  });
  expect(
    (await runtime.favorites.list(member)).map((entry) => entry.kind),
  ).toEqual(["project"]);
});

it("pins own and shared views, and drops favorites of removed views", async () => {
  const own = await runtime.views.create(member, randomUUID(), {
    name: "My bugs",
    filters: { assignee: "me" },
    shared: false,
  });
  const shared = await runtime.views.create(owner, randomUUID(), {
    name: "Team board",
    filters: { view: "board" },
    shared: true,
  });
  const secret = await runtime.views.create(owner, randomUUID(), {
    name: "Owner only",
    filters: {},
    shared: false,
  });
  await runtime.favorites.set(member, {
    kind: "view",
    id: own.id,
    favorite: true,
  });
  await runtime.favorites.set(member, {
    kind: "view",
    id: shared.id,
    favorite: true,
  });
  await expect(
    runtime.favorites.set(member, {
      kind: "view",
      id: secret.id,
      favorite: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await runtime.favorites.list(member)).toEqual([
    { kind: "view", id: own.id, label: "My bugs", state: null },
    { kind: "view", id: shared.id, label: "Team board", state: null },
  ]);
  await runtime.views.remove(owner, shared.id);
  expect(await runtime.favorites.list(member)).toEqual([
    { kind: "view", id: own.id, label: "My bugs", state: null },
  ]);
  expect(
    (
      await database.engine.query(
        "SELECT 1 FROM cloud_favorites WHERE entity_id=$1",
        [shared.id],
      )
    ).rows,
  ).toEqual([]);
});

it("subscribes creators, assignees and commenters, and honors explicit choices", async () => {
  expect(await runtime.subscriptions.get(member, issueId)).toMatchObject({
    subscribed: false,
    subscribers: [{ id: owner.userId, name: "owner" }],
  });
  await runtime.comments.create(member, randomUUID(), issueId, "I can help");
  expect((await runtime.subscriptions.get(member, issueId)).subscribed).toBe(
    true,
  );
  await runtime.subscriptions.set(owner, issueId, false);
  await runtime.subscriptions.set(viewer, issueId, true);
  expect(
    (await runtime.subscriptions.get(member, issueId)).subscribers.map(
      (entry) => entry.name,
    ),
  ).toEqual(["member", "viewer"]);
  await runtime.comments.create(
    member,
    randomUUID(),
    issueId,
    "Update for @owner",
  );
  await runtime.comments.create(member, randomUUID(), issueId, "Plain update");
  const ownerInbox = await runtime.inbox.list(owner);
  expect(ownerInbox.map((entry) => entry.kind)).toEqual([
    "mentioned",
    "commented",
  ]);
  expect((await runtime.inbox.list(viewer)).map((entry) => entry.kind)).toEqual(
    ["commented", "commented"],
  );
});

it("notifies subscribers about status changes except the person who changed it", async () => {
  await runtime.subscriptions.set(member, issueId, true);
  const active = await testStatusReference(database, owner, teamId, "active");
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: issueId }],
    changes: { status: active },
  });
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: issueId }],
    changes: { priority: "high" },
  });
  expect(await runtime.inbox.list(member)).toMatchObject([
    {
      kind: "status_changed",
      detail: "In progress",
      issueIdentifier: "TM-1",
      actor: "owner",
    },
  ]);
  expect(await runtime.inbox.list(owner)).toEqual([]);
});

it("records project health updates and exposes the latest per visible project", async () => {
  const project = await runtime.projects.create(owner, randomUUID(), {
    teamId,
    name: "Launch",
    description: "",
  });
  const hidden = await runtime.projects.create(owner, randomUUID(), {
    teamId: privateTeamId,
    name: "Hidden launch",
    description: "",
  });
  const key = randomUUID();
  const first = await runtime.projectUpdates.create(member, key, project.id, {
    health: "at_risk",
    body: "Waiting for review",
  });
  expect(
    await runtime.projectUpdates.create(member, key, project.id, {
      health: "at_risk",
      body: "Waiting for review",
    }),
  ).toEqual(first);
  await runtime.projectUpdates.create(member, randomUUID(), project.id, {
    health: "on_track",
    body: "Unblocked",
  });
  await runtime.projectUpdates.create(owner, randomUUID(), hidden.id, {
    health: "off_track",
    body: "",
  });
  await expect(
    runtime.projectUpdates.create(viewer, randomUUID(), project.id, {
      health: "on_track",
      body: "",
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await runtime.projectUpdates.list(member, project.id)).map((update) => [
      update.health,
      update.author,
    ]),
  ).toEqual([
    ["on_track", "member"],
    ["at_risk", "member"],
  ]);
  expect(await runtime.projectUpdates.latest(member)).toMatchObject([
    { projectId: project.id, health: "on_track", body: "Unblocked" },
  ]);
  await expect(
    runtime.projectUpdates.list(member, hidden.id),
  ).rejects.toMatchObject({ status: 404 });
});
