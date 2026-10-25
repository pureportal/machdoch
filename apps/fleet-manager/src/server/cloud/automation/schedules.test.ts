import { randomUUID } from "node:crypto";
import {
  normalizeRecurrence,
  type RecurrenceInput,
} from "@machdoch/recurrence";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  defaultEstimateScale,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { scheduleInputSchema } from "../../../lib/cloud-schedule-contract";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { planSchedule } from "./schedule-plan";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime, actor: CloudActor, teamId: string;
beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await database.engine.exec(
    "TRUNCATE cloud_users,cloud_organizations CASCADE",
  );
  actor = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Schedules')",
    [actor.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'owner@example.test','Owner',NULL)",
    [actor.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [actor.organizationId, actor.userId],
  );
  runtime = createCloudRuntime(database, "https://cloud.example.test");
  teamId = (
    await runtime.planning.createTeam(actor, randomUUID(), {
      name: "Recurring",
      key: "RC",
      visibility: "private",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  await runtime.scheduleDispatcher.tick();
});

function input() {
  return scheduleInputSchema.parse({
    name: "Weekly review",
    teamId,
    action: {
      kind: "create-issue",
      issue: { teamId, title: "Review dependencies" },
    },
    recurrence: {
      kind: "interval",
      start: new Date(Date.now() - 3_600_000).toISOString(),
      everyMs: 60_000,
    },
    missed: "bounded-all",
    catchUpLimit: 3,
    lookbackHours: 1,
  });
}
async function dueSchedule() {
  const data = input();
  const { id } = await runtime.schedules.create(actor, randomUUID(), data);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 1,
    enabled: true,
  });
  const due = Date.parse((data.recurrence as { start: string }).start) + 60_000;
  await database.engine.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [id, due],
  );
  return { id, data };
}

it("creates paused schedules with durable idempotency and no issues", async () => {
  const data = input(),
    key = randomUUID();
  const created = await runtime.schedules.create(actor, key, data);
  expect(await runtime.schedules.create(actor, key, data)).toEqual(created);
  expect(await runtime.schedules.get(actor, created.id)).toMatchObject({
    enabled: false,
    revision: 1,
    ownerId: actor.userId,
  });
  expect(await runtime.scheduleDispatcher.tick()).toBe(0);
  expect(await runtime.planning.listIssues(actor, {})).toHaveLength(0);
  await expect(
    runtime.schedules.create(actor, key, { ...data, name: "Changed" }),
  ).rejects.toHaveProperty("code", "command_conflict");
});
it("rejects stale edits and requires pausing before editing", async () => {
  const { id, data } = await dueSchedule();
  await expect(
    runtime.schedules.update(actor, randomUUID(), id, { ...data, revision: 1 }),
  ).rejects.toHaveProperty("code", "revision_conflict");
  await expect(
    runtime.schedules.update(actor, randomUUID(), id, { ...data, revision: 2 }),
  ).rejects.toHaveProperty("code", "schedule_enabled");
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 2,
    enabled: false,
  });
  await runtime.schedules.update(actor, randomUUID(), id, {
    ...data,
    name: "Updated",
    revision: 3,
  });
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    name: "Updated",
    enabled: false,
    revision: 4,
  });
});
it("commits bounded catch-up issues and receipts once across dispatcher restarts", async () => {
  const { id } = await dueSchedule();
  expect(await runtime.scheduleDispatcher.tick()).toBe(1);
  const history = await runtime.schedules.history(actor, id);
  expect(history.filter((entry) => entry.outcome === "created")).toHaveLength(
    3,
  );
  expect(history.filter((entry) => entry.outcome === "skipped")).toHaveLength(
    1,
  );
  runtime = createCloudRuntime(database, "https://cloud.example.test");
  expect(await runtime.scheduleDispatcher.tick()).toBe(0);
  expect(await runtime.planning.listIssues(actor, {})).toHaveLength(3);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='issue.changed'",
      )
    ).rows,
  ).toHaveLength(3);
});
it("does not dispatch an evaluated snapshot after pause or an edit", async () => {
  const { id } = await dueSchedule();
  const original = runtime.recurrence.plan.bind(runtime.recurrence);
  vi.spyOn(runtime.recurrence, "plan").mockImplementationOnce(
    async (...args) => {
      const plan = await original(...args);
      await runtime.schedules.setEnabled(actor, randomUUID(), id, {
        revision: 2,
        enabled: false,
      });
      return plan;
    },
  );
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.planning.listIssues(actor, {})).toHaveLength(0);
  expect(await runtime.schedules.history(actor, id)).toHaveLength(0);
});
it("pauses when the owner's membership was revoked and restored", async () => {
  const { id } = await dueSchedule();
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE user_id=$1",
    [actor.userId],
  );
  await database.engine.query(
    "UPDATE cloud_memberships SET active=true WHERE user_id=$1",
    [actor.userId],
  );
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: false,
    error: expect.stringContaining("access changed"),
  });
  expect(await runtime.planning.listIssues(actor, {})).toHaveLength(0);
});
it("rolls back the whole occurrence batch when the current issue template becomes invalid", async () => {
  const { id } = await dueSchedule();
  await database.engine.query(
    "UPDATE cloud_schedules SET action=jsonb_set(action,'{issue,estimate}','\"removed\"') WHERE id=$1",
    [id],
  );
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: false,
    error: expect.stringContaining("estimate scale"),
  });
  expect(await runtime.schedules.history(actor, id)).toHaveLength(0);
});
it("enforces organization isolation, viewer rights and owner-only activation", async () => {
  const { id } = await runtime.schedules.create(actor, randomUUID(), input());
  await expect(
    runtime.schedules.get({ ...actor, organizationId: randomUUID() }, id),
  ).rejects.toHaveProperty("code", "not_found");
  const other = { ...actor, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'other@example.test','Other',NULL)",
    [other.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'admin')",
    [actor.organizationId, other.userId],
  );
  await expect(
    runtime.schedules.setEnabled(other, randomUUID(), id, {
      revision: 1,
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "schedule_owner_required");
  await database.engine.query(
    "UPDATE cloud_memberships SET role='viewer' WHERE user_id=$1",
    [other.userId],
  );
  expect(await runtime.schedules.list(other)).toEqual([]);
  await expect(
    runtime.schedules.create(other, randomUUID(), input()),
  ).rejects.toHaveProperty("code", "permission_denied");
});
it("retains the same receipt when an enable confirmation is retried after dispatch", async () => {
  const data = input(),
    { id } = await runtime.schedules.create(actor, randomUUID(), data),
    key = randomUUID();
  await runtime.schedules.setEnabled(actor, key, id, {
    revision: 1,
    enabled: true,
  });
  await database.engine.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [id, Date.parse((data.recurrence as { start: string }).start)],
  );
  await runtime.scheduleDispatcher.tick();
  const next = (await runtime.schedules.get(actor, id)).nextAt;
  await runtime.schedules.setEnabled(actor, key, id, {
    revision: 1,
    enabled: true,
  });
  expect((await runtime.schedules.get(actor, id)).nextAt).toBe(next);
});
it("fences removal and restoration of team access without reacting to a team rename", async () => {
  const { id } = await dueSchedule();
  await runtime.administration.updateTeam(actor, randomUUID(), teamId, {
    name: "Renamed",
    visibility: "private",
    memberIds: [actor.userId],
    revision: 1,
  });
  await runtime.scheduleDispatcher.tick();
  expect(
    (await runtime.schedules.history(actor, id)).filter(
      (entry) => entry.outcome === "created",
    ),
  ).toHaveLength(3);
  await database.engine.query(
    "DELETE FROM cloud_team_memberships WHERE team_id=$1",
    [teamId],
  );
  await database.engine.query(
    "INSERT INTO cloud_team_memberships(organization_id,team_id,user_id) VALUES($1,$2,$3)",
    [actor.organizationId, teamId, actor.userId],
  );
  await database.engine.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [id, Date.now() - 1],
  );
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: false,
    error: expect.stringContaining("team access changed"),
  });
});
it("does not advance a revision on an unchanged save", async () => {
  const data = input();
  const { id } = await runtime.schedules.create(actor, randomUUID(), data);
  await runtime.schedules.update(actor, randomUUID(), id, {
    ...data,
    revision: 1,
  });
  expect((await runtime.schedules.get(actor, id)).revision).toBe(1);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='schedule.changed'",
      )
    ).rows,
  ).toHaveLength(1);
});
it("refuses activation while the workflow worker heartbeat is missing", async () => {
  const { id } = await runtime.schedules.create(actor, randomUUID(), input());
  await database.engine.exec("DELETE FROM cloud_schedule_worker");
  await expect(
    runtime.schedules.setEnabled(actor, randomUUID(), id, {
      revision: 1,
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "schedule_worker_unavailable");
  expect((await runtime.schedules.get(actor, id)).enabled).toBe(false);
});
it("coalesces across the entire missed window and respects DST folds", () => {
  const recurrence: RecurrenceInput = {
    kind: "cron",
    expression: "30 2 * * *",
    timezone: "Europe/Berlin",
    fold: "both",
    start: "2026-01-01T00:00:00Z",
  };
  const plan = planSchedule({
    recurrence,
    definitionKey: normalizeRecurrence(recurrence).key,
    nextAt: Date.parse("2026-10-24T00:30:00Z"),
    now: Date.parse("2026-10-25T02:00:00Z"),
    missed: "latest",
    catchUpLimit: 20,
    lookbackHours: 48,
  });
  expect(plan.due.map((value) => new Date(value).toISOString())).toEqual([
    "2026-10-25T01:30:00.000Z",
  ]);
  expect(new Date(plan.nextAt!).toISOString()).toBe("2026-10-26T01:30:00.000Z");
});
it("skips an outage, bounds catch-up, and exhausts one-time schedules", () => {
  const recurrence = {
    kind: "interval" as const,
    start: "2026-01-01T00:00:00Z",
    everyMs: 60000,
  };
  const common = {
    recurrence,
    definitionKey: normalizeRecurrence(recurrence).key,
    nextAt: Date.parse(recurrence.start),
    now: Date.parse("2026-10-24T12:00:30Z"),
    catchUpLimit: 4,
    lookbackHours: 168,
  };
  expect(planSchedule({ ...common, missed: "latest" }).due).toHaveLength(1);
  expect(planSchedule({ ...common, missed: "bounded-all" }).due).toHaveLength(
    4,
  );
  expect(planSchedule({ ...common, missed: "skip" }).due).toHaveLength(1);
  expect(
    planSchedule({
      ...common,
      recurrence: { kind: "once", at: recurrence.start },
      definitionKey: normalizeRecurrence({ kind: "once", at: recurrence.start })
        .key,
      missed: "skip",
    }),
  ).toMatchObject({ due: [], nextAt: null });
});
it("pauses when the published recurrence no longer matches the evaluator", async () => {
  const { id } = await dueSchedule();
  await database.engine.query(
    "UPDATE cloud_schedules SET definition_key=$2 WHERE id=$1",
    [id, "0".repeat(64)],
  );
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: false,
    error: expect.stringContaining("timezone rules changed"),
  });
  expect(await runtime.planning.listIssues(actor, {})).toHaveLength(0);
  const current = await runtime.schedules.get(actor, id);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: current.revision,
    enabled: true,
  });
  expect((await runtime.schedules.get(actor, id)).definitionKey).not.toBe(
    "0".repeat(64),
  );
});
it("keeps worker health unavailable on failure while progressing other schedules", async () => {
  const first = await dueSchedule();
  const second = await dueSchedule();
  await database.engine.exec(
    "UPDATE cloud_schedule_worker SET touched_at=clock_timestamp()-interval '1 minute'",
  );
  vi.spyOn(runtime.recurrence, "plan").mockRejectedValueOnce(
    new Error("Infrastructure failure"),
  );
  await expect(runtime.scheduleDispatcher.tick()).rejects.toThrow(
    "Infrastructure failure",
  );
  expect(await runtime.schedules.status(actor)).toEqual({ available: false });
  expect(
    (await runtime.schedules.history(actor, second.id)).filter(
      (item) => item.outcome === "created",
    ),
  ).toHaveLength(3);
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.status(actor)).toEqual({ available: true });
  expect(
    (await runtime.schedules.history(actor, first.id)).filter(
      (item) => item.outcome === "created",
    ),
  ).toHaveLength(3);
});
