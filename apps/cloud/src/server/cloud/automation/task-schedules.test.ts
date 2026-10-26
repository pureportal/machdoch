import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  issueUpdateSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createScheduleFixture, scheduledTaskInput } from "./test-fixture";
let fixture: Awaited<ReturnType<typeof createScheduleFixture>>;
import { workerClaimResponseSchema } from "@machdoch/fleet-protocol/cloud-execution";
import { hasRunAuthority, readRun } from "../execution/records";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime,
  actor: CloudActor,
  teamId: string,
  projectId: string,
  profileId: string,
  providerId: string;
beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  fixture = await createScheduleFixture(database);
  ({ runtime, actor, teamId, projectId, providerId, profileId } = fixture);
  await runtime.scheduleDispatcher.tick();
});

async function makeDue(id: string, minutes = 1) {
  const current = await runtime.schedules.get(actor, id);
  await database.engine.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [id, current.nextAt! - minutes * 60000],
  );
}
async function scheduled(data = scheduledTaskInput(fixture)) {
  const { id } = await runtime.schedules.create(actor, randomUUID(), data);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 1,
    enabled: true,
  });
  await makeDue(id, 20);
  return { id, data };
}

it("admits a bounded project task and records overlapping catch-up without creating issues", async () => {
  const data = scheduledTaskInput(fixture);
  if (data.action.kind !== "run-task") throw new Error("Fixture action");
  data.action.maxRuns = 1;
  const { id } = await scheduled(data);
  await runtime.scheduleDispatcher.tick();
  const history = await runtime.schedules.history(actor, id);
  expect(history.filter((entry) => entry.outcome === "admitted")).toHaveLength(
    1,
  );
  expect(history.filter((entry) => entry.outcome === "overlap")).toHaveLength(
    2,
  );
  const run = await runtime.execution.runs.get(
    actor,
    history.find((entry) => entry.runId)!.runId!,
  );
  expect(run.manifest).toMatchObject({
    automation: {
      scheduleId: id,
      revision: 2,
      expiresAt: data.action.expiresAt,
    },
    subject: { kind: "project", purpose: "maintenance" },
    objective: "Review dependency versions",
  });
  expect(Date.parse(run.deadlineAt)).toBe(Date.parse(data.action.expiresAt));
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    admittedRuns: 1,
    usedTokens: 0,
    reservedTokens: 10000,
  });
  expect(await runtime.planning.listIssues(actor, {})).toHaveLength(0);
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.execution.runs.list(actor)).toHaveLength(1);
  const worker = await runtime.execution.workers.register(
    actor,
    profileId,
    "Scheduled worker",
  );
  const claim = workerClaimResponseSchema.parse(
    await runtime.execution.leases.claim(worker.token, randomUUID()),
  );
  expect(claim.claim?.manifest.automation).toMatchObject({
    scheduleId: id,
    revision: 2,
  });
});

it("rejects oversized shared-runtime instructions before saving a task schedule", async () => {
  const data = scheduledTaskInput(fixture);
  if (
    data.action.kind !== "run-task" ||
    data.action.run.subject.kind !== "project"
  )
    throw new Error("Fixture action");
  data.action.run.subject.objective = "€".repeat(20000);
  await expect(
    runtime.schedules.create(actor, randomUUID(), data),
  ).rejects.toMatchObject({ code: "task_instructions_limit" });
  expect(await runtime.schedules.list(actor)).toEqual([]);
});

it("keeps lifetime counters through cancellation, pause, edits and new activation", async () => {
  const { id, data } = await scheduled();
  await runtime.scheduleDispatcher.tick();
  const first = (await runtime.execution.runs.list(actor))[0]!;
  await runtime.execution.runs.cancel(
    actor,
    randomUUID(),
    first.id,
    first.revision,
  );
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 2,
    enabled: false,
  });
  await runtime.schedules.update(actor, randomUUID(), id, {
    ...data,
    name: "Updated maintenance",
    revision: 3,
  });
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 4,
    enabled: true,
  });
  await makeDue(id);
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    admittedRuns: 2,
    usedTokens: 0,
    reservedTokens: 10000,
  });
  const second = (await runtime.execution.runs.list(actor)).find(
    (run) => run.id !== first.id,
  )!;
  await runtime.execution.runs.cancel(
    actor,
    randomUUID(),
    second.id,
    second.revision,
  );
  await makeDue(id);
  await runtime.scheduleDispatcher.tick();
  const current = await runtime.schedules.get(actor, id);
  expect(current).toMatchObject({
    enabled: false,
    error: expect.stringContaining("allowance is exhausted"),
    usedTokens: 0,
    reservedTokens: 0,
  });
  await expect(
    runtime.schedules.setEnabled(actor, randomUUID(), id, {
      revision: current.revision,
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "schedule_budget");
  expect(await runtime.execution.runs.list(actor)).toHaveLength(2);
  if (data.action.kind !== "run-task") throw new Error("Fixture action");
  await expect(
    runtime.schedules.update(actor, randomUUID(), id, {
      ...data,
      action: { ...data.action, maxRuns: 1 },
      revision: current.revision,
    }),
  ).rejects.toHaveProperty("code", "schedule_budget");
});

it.each(["profile", "project", "provider"])(
  "pauses when the pinned %s changes before dispatch",
  async (kind) => {
    const { id } = await scheduled();
    if (kind === "profile") {
      const profile = (await runtime.execution.profiles.list(actor))[0]!;
      await runtime.execution.profiles.update(actor, randomUUID(), profile.id, {
        ...profile,
        name: "Changed",
      });
    } else if (kind === "project")
      await runtime.projects.update(actor, randomUUID(), projectId, {
        name: "Changed",
        description: "",
        revision: 1,
      });
    else
      await database.engine.query(
        "UPDATE cloud_ai_providers SET inference_revision=inference_revision+1 WHERE id=$1",
        [providerId],
      );
    await runtime.scheduleDispatcher.tick();
    expect(await runtime.schedules.get(actor, id)).toMatchObject({
      enabled: false,
    });
    expect(await runtime.execution.runs.list(actor)).toHaveLength(0);
  },
);

it("fences an admitted grant after revocation and restoration even when the schedule is re-enabled", async () => {
  const { id } = await scheduled();
  await runtime.scheduleDispatcher.tick();
  const run = (await runtime.execution.runs.list(actor))[0]!;
  const allowed = () =>
    database.transaction(async (sql) =>
      hasRunAuthority(
        sql,
        actor.organizationId,
        await readRun(sql, actor.organizationId, run.id),
      ),
    );
  expect(await allowed()).toBe(true);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 2,
    enabled: false,
  });
  expect(await allowed()).toBe(true);
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE user_id=$1",
    [actor.userId],
  );
  await database.engine.query(
    "UPDATE cloud_memberships SET active=true WHERE user_id=$1",
    [actor.userId],
  );
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 3,
    enabled: true,
  });
  expect(await allowed()).toBe(false);
  const worker = await runtime.execution.workers.register(
    actor,
    profileId,
    "Worker",
  );
  expect(
    (await runtime.execution.leases.claim(worker.token, randomUUID())).claim,
  ).toBeNull();
});

it("caps run authority at expiry and refuses expired activation", async () => {
  const { id } = await scheduled();
  await runtime.scheduleDispatcher.tick();
  const run = (await runtime.execution.runs.list(actor))[0]!;
  await database.engine.query(
    "UPDATE cloud_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  expect((await runtime.execution.runs.get(actor, run.id)).state).toBe(
    "timed_out",
  );
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 2,
    enabled: false,
  });
  const data = scheduledTaskInput(fixture);
  if (data.action.kind !== "run-task") throw new Error("Fixture action");
  data.action.expiresAt = new Date(Date.now() - 1000).toISOString();
  await runtime.schedules.update(actor, randomUUID(), id, {
    ...data,
    revision: 3,
  });
  await expect(
    runtime.schedules.setEnabled(actor, randomUUID(), id, {
      revision: 4,
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "schedule_expired");
});

it("records manual issue-task overlap without consuming allowance and pauses after a subject edit", async () => {
  const issue = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      projectId,
      title: "Fix tests",
      acceptanceCriteria: "All tests pass",
    }),
  );
  const data = scheduledTaskInput(fixture);
  if (data.action.kind !== "run-task") throw new Error("Fixture action");
  data.action.run.subject = { kind: "issue", id: issue.id, revision: 1 };
  const { id } = await scheduled(data);
  const manual = await runtime.execution.runs.create(
    actor,
    randomUUID(),
    data.action.run,
  );
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    admittedRuns: 0,
    usedTokens: 0,
    reservedTokens: 0,
  });
  expect(
    (await runtime.schedules.history(actor, id)).filter(
      (entry) => entry.outcome === "overlap",
    ),
  ).toHaveLength(3);
  await runtime.execution.runs.cancel(actor, randomUUID(), manual.id, 1);
  const current = await runtime.planning.getIssue(actor, issue.id);
  await runtime.planning.updateIssue(
    actor,
    randomUUID(),
    issue.id,
    issueUpdateSchema
      .strip()
      .parse({ ...current, title: "Changed requirement" }),
  );
  await makeDue(id);
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: false,
    admittedRuns: 0,
  });
});

it("rolls admission, tokens and occurrence state back after a receipt-storage failure", async () => {
  const { id } = await scheduled();
  let fail = true;
  const failing = createCloudRuntime(
    {
      close: () => database.close(),
      transaction: (operation) =>
        database.transaction((sql) =>
          operation({
            query: async (text, values) => {
              if (
                fail &&
                text.startsWith("INSERT INTO cloud_schedule_occurrences") &&
                values?.includes("admitted")
              ) {
                fail = false;
                throw new Error("Storage unavailable");
              }
              return sql.query(text, values);
            },
          }),
        ),
    },
    "https://cloud.example.test",
  );
  await expect(failing.scheduleDispatcher.tick()).rejects.toThrow(
    "Storage unavailable",
  );
  expect(await runtime.execution.runs.list(actor)).toHaveLength(0);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 0,
    reservedTokens: 0,
    admittedRuns: 0,
  });
  await failing.scheduleDispatcher.tick();
  expect(await runtime.execution.runs.list(actor)).toHaveLength(1);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 0,
    reservedTokens: 10000,
    admittedRuns: 1,
  });
});

it("rejects foreign teams and intersects task limits with the remaining allowance", async () => {
  const data = scheduledTaskInput(fixture);
  const other = (
    await runtime.planning.createTeam(actor, randomUUID(), {
      name: "Other",
      key: "OT",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  await expect(
    runtime.schedules.create(actor, randomUUID(), { ...data, teamId: other }),
  ).rejects.toHaveProperty("code", "schedule_team");
  if (data.action.kind !== "run-task") throw new Error("Fixture action");
  data.action.maxTokens = 9999;
  const { id } = await scheduled(data);
  await runtime.scheduleDispatcher.tick();
  expect(await runtime.execution.runs.list(actor)).toHaveLength(1);
  const run = (await runtime.execution.runs.list(actor))[0]!;
  expect(
    (await runtime.execution.runs.get(actor, run.id)).manifest.profile
      .maxTokens,
  ).toBe(9999);
  expect((await runtime.execution.profiles.list(actor))[0]!.maxTokens).toBe(
    10000,
  );
  expect((await runtime.schedules.get(actor, id)).reservedTokens).toBe(9999);
});
