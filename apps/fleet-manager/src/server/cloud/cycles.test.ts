import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  issueUpdateSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase, testStatusReference } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let actor: CloudActor;
let teamId: string;
let cycleId: string;
let futureId: string;

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
  actor = { userId: randomUUID(), organizationId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'owner@example.test','Owner','test')",
    [actor.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [actor.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [actor.organizationId, actor.userId],
  );
  teamId = (
    await runtime.planning.createTeam(actor, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  cycleId = (
    await runtime.planning.createCycle(actor, randomUUID(), {
      teamId,
      name: "October",
      startsOn: "2026-10-18",
      endsOn: "2026-11-01",
      timezone: "Europe/Berlin",
      capacity: 20,
    })
  ).id;
  futureId = (
    await runtime.planning.createCycle(actor, randomUUID(), {
      teamId,
      name: "November",
      startsOn: "2026-11-01",
      endsOn: "2026-11-15",
      timezone: "Europe/Berlin",
      capacity: 30,
    })
  ).id;
});

it("snapshots commitment and closing scope once, carries unfinished work and preserves frozen history", async () => {
  const unfinished = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      cycleId,
      title: "Continue",
      estimate: "3",
    }),
  );
  const complete = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      cycleId,
      title: "Done",
      status: await testStatusReference(database, actor, teamId, "complete"),
      estimate: "5",
    }),
  );
  const canceled = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      cycleId,
      title: "Canceled",
      status: await testStatusReference(database, actor, teamId, "canceled"),
    }),
  );
  const startKey = randomUUID();
  await runtime.cycles.act(actor, startKey, cycleId, {
    kind: "start",
    revision: 1,
  });
  await runtime.cycles.act(actor, startKey, cycleId, {
    kind: "start",
    revision: 1,
  });
  const before = await runtime.planning.getIssue(actor, unfinished.id);
  await runtime.planning.updateIssue(actor, randomUUID(), unfinished.id, {
    ...issueUpdateSchema.strip().parse(before),
    estimate: "8",
  });
  const late = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      cycleId,
      title: "Added late",
      estimate: "2",
    }),
  );
  expect(
    (await runtime.cycles.get(actor, cycleId)).committedTotals.points,
  ).toBe(8);
  const closeKey = randomUUID();
  await runtime.cycles.act(actor, closeKey, cycleId, {
    kind: "close",
    revision: 2,
    carryoverCycleId: futureId,
  });
  await runtime.cycles.act(actor, closeKey, cycleId, {
    kind: "close",
    revision: 2,
    carryoverCycleId: futureId,
  });
  const closed = await runtime.cycles.get(actor, cycleId);
  expect(closed).toMatchObject({
    cycle: { status: "closed", revision: 3 },
    totals: { issues: 4, points: 15, completed: 1, completedPoints: 5 },
    committedTotals: { issues: 3, points: 8 },
  });
  expect([...closed.carriedIssueIds].sort()).toEqual(
    [unfinished.id, late.id].sort(),
  );
  expect((await runtime.planning.getIssue(actor, unfinished.id)).cycleId).toBe(
    futureId,
  );
  expect((await runtime.planning.getIssue(actor, complete.id)).cycleId).toBe(
    cycleId,
  );
  expect((await runtime.planning.getIssue(actor, canceled.id)).cycleId).toBe(
    cycleId,
  );
  expect(await runtime.planning.history(actor, unfinished.id)).toHaveLength(3);
  const after = await runtime.planning.getIssue(actor, unfinished.id);
  await runtime.planning.updateIssue(actor, randomUUID(), after.id, {
    ...issueUpdateSchema.strip().parse(after),
    status: await testStatusReference(database, actor, teamId, "complete"),
    estimate: "13",
  });
  expect(await runtime.cycles.get(actor, cycleId)).toEqual(closed);
  await expect(
    runtime.planning.createIssue(
      actor,
      randomUUID(),
      issueInputSchema.parse({ teamId, cycleId, title: "Closed" }),
    ),
  ).rejects.toMatchObject({ code: "cycle_closed" });
});

it("returns unfinished issues to the backlog while keeping removed original commitments", async () => {
  const issue = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({ teamId, cycleId, title: "Unfinished" }),
  );
  const removed = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      cycleId,
      title: "Removed",
      estimate: "5",
    }),
  );
  await runtime.cycles.act(actor, randomUUID(), cycleId, {
    kind: "start",
    revision: 1,
  });
  const before = await runtime.planning.getIssue(actor, removed.id);
  await runtime.planning.updateIssue(actor, randomUUID(), removed.id, {
    ...issueUpdateSchema.strip().parse(before),
    cycleId: null,
  });
  await runtime.cycles.act(actor, randomUUID(), cycleId, {
    kind: "close",
    revision: 2,
    carryoverCycleId: null,
  });
  expect((await runtime.planning.getIssue(actor, issue.id)).cycleId).toBeNull();
  const detail = await runtime.cycles.get(actor, cycleId);
  expect(detail.commitment).toHaveLength(2);
  expect(detail.issues).toHaveLength(1);
  expect(detail.totals.unestimated).toBe(1);
});

it("rejects stale transitions, parallel active cycles, invalid carryover and unauthorized reads", async () => {
  await expect(
    runtime.cycles.act(actor, randomUUID(), cycleId, {
      kind: "close",
      revision: 1,
      carryoverCycleId: null,
    }),
  ).rejects.toMatchObject({ code: "cycle_not_active" });
  await runtime.cycles.act(actor, randomUUID(), cycleId, {
    kind: "start",
    revision: 1,
  });
  await expect(
    runtime.cycles.act(actor, randomUUID(), futureId, {
      kind: "start",
      revision: 1,
    }),
  ).rejects.toMatchObject({ code: "active_cycle" });
  await expect(
    runtime.cycles.act(actor, randomUUID(), cycleId, {
      kind: "close",
      revision: 1,
      carryoverCycleId: futureId,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(
    runtime.cycles.act(actor, randomUUID(), cycleId, {
      kind: "close",
      revision: 2,
      carryoverCycleId: cycleId,
    }),
  ).rejects.toMatchObject({ code: "invalid_carryover" });
  expect((await runtime.cycles.get(actor, cycleId)).cycle.status).toBe(
    "active",
  );
  await expect(
    runtime.cycles.get({ ...actor, organizationId: randomUUID() }, cycleId),
  ).rejects.toMatchObject({ status: 404 });
  await database.engine.query(
    "UPDATE cloud_memberships SET role='viewer' WHERE user_id=$1",
    [actor.userId],
  );
  await expect(
    runtime.cycles.act(actor, randomUUID(), cycleId, {
      kind: "close",
      revision: 2,
      carryoverCycleId: futureId,
    }),
  ).rejects.toMatchObject({ status: 403 });
});
