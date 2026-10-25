import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime } from "../runtime";
import { createScheduleFixture, scheduledTaskInput } from "./test-fixture";
import { taskAgentTools } from "@machdoch/fleet-protocol/cloud-agent-tools";
import {
  workerClaimResponseSchema,
  type WorkerClaim,
} from "@machdoch/fleet-protocol/cloud-execution";
import {
  scheduleInputSchema,
  type ScheduleInput,
} from "../../../lib/cloud-schedule-contract";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let fixture: Awaited<ReturnType<typeof createScheduleFixture>>;
beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 30000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  fixture = await createScheduleFixture(database);
  await fixture.runtime.scheduleDispatcher.tick();
});
async function queue(input = scheduledTaskInput(fixture)) {
  const { runtime, actor } = fixture;
  const { id } = await runtime.schedules.create(actor, randomUUID(), input);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 1,
    enabled: true,
  });
  await database.engine.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [id, (await runtime.schedules.get(actor, id)).nextAt! - 60000],
  );
  await runtime.scheduleDispatcher.tick();
  const history = await runtime.schedules.history(actor, id);
  const runId = history.find((entry) => entry.runId)!.runId!;
  return { id, runId, input };
}
async function accepted() {
  const { runtime, actor, profileId } = fixture;
  const worker = await runtime.execution.workers.register(
    actor,
    profileId,
    randomUUID(),
  );
  const claim = workerClaimResponseSchema.parse(
    await runtime.execution.leases.claim(worker.token, randomUUID()),
  ).claim!;
  await runtime.execution.leases.accept(worker.token, {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    environmentId: randomUUID(),
    baseCommit: claim.manifest.profile.baseCommit,
    isolation: "microvm",
  });
  return { worker, claim };
}
async function finish(
  worker: { token: string },
  claim: WorkerClaim,
  outcome: "failed" | "canceled" = "failed",
) {
  return fixture.runtime.execution.leases.finish(worker.token, {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
    outcome,
    summary: "Stopped",
    stopped: true,
    candidateCommit: null,
    tokensUsed: 9999,
    checks: [],
  });
}
async function inference(
  worker: { token: string },
  claim: WorkerClaim,
  begin = true,
) {
  const { runtime, actor } = fixture;
  const requestId = randomUUID();
  await runtime.execution.inference.submit(worker.token, {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    requestId,
    context: "Inspect package.json",
    runtimePrompt: "",
    tools: taskAgentTools,
    modelOptions: {},
  });
  const call = (await runtime.inference.store.claim(
    actor.organizationId,
    requestId,
  ))!;
  if (begin)
    expect(
      (
        await runtime.inference.store.guard(
          actor.organizationId,
          requestId,
          call.executionId,
          { begin: true },
        )
      ).allowed,
    ).toBe(true);
  return { id: requestId, executionId: call.executionId };
}
async function maintain(id: string) {
  await database.engine.query(
    "UPDATE cloud_schedules SET maintenance_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [id],
  );
  await fixture.runtime.scheduleDispatcher.tick();
}
function delayed(): ScheduleInput {
  return {
    ...scheduledTaskInput(fixture),
    recurrence: {
      kind: "fixed-delay",
      start: new Date(Date.now() - 3600000).toISOString(),
      delayMs: 60000,
    },
  };
}

it("settles measured usage and releases unused reservations exactly once", async () => {
  const { id } = await queue();
  const { worker, claim } = await accepted();
  const call = await inference(worker, claim);
  const { runtime, actor } = fixture;
  await runtime.inference.store.finish(
    actor.organizationId,
    call.id,
    call.executionId,
    { state: "complete", tokens: 200, answer: "Done", errorCode: null },
  );
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 200,
    reservedTokens: 9800,
  });
  expect((await finish(worker, claim)).accepted).toBe(true);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 200,
    reservedTokens: 0,
    admittedRuns: 1,
  });
  const restarted = createCloudRuntime(database, "https://cloud.example.test");
  const reads = await Promise.all([
    restarted.schedules.get(actor, id),
    restarted.schedules.list(actor),
  ]);
  expect(reads[0]).toMatchObject({ usedTokens: 200, reservedTokens: 0 });
  expect(reads[1][0]).toMatchObject({ usedTokens: 200, reservedTokens: 0 });
  const history = await runtime.schedules.history(actor, id);
  expect(history[0]).toMatchObject({
    usedTokens: 200,
    reservedTokens: 0,
    runState: "failed",
    completedAt: expect.any(Number),
  });
});

it("holds uncertain provider usage after a stopped task and settles a late authoritative receipt", async () => {
  const { id } = await queue();
  const { worker, claim } = await accepted();
  const call = await inference(worker, claim);
  const { runtime, actor } = fixture;
  const reserved = (
    await database.engine.query<{ reserved_tokens: number }>(
      "SELECT reserved_tokens FROM cloud_inference_calls WHERE id=$1",
      [call.id],
    )
  ).rows[0]!.reserved_tokens;
  await runtime.inference.store.finish(
    actor.organizationId,
    call.id,
    call.executionId,
    { state: "unknown", tokens: null, errorCode: "interrupted" },
  );
  await finish(worker, claim);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 0,
    reservedTokens: reserved,
  });
  await runtime.inference.store.finish(
    actor.organizationId,
    call.id,
    call.executionId,
    { state: "complete", tokens: 175, errorCode: null, answer: "Late result" },
  );
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 175,
    reservedTokens: 0,
  });
  await runtime.inference.store.finish(
    actor.organizationId,
    call.id,
    call.executionId,
    { state: "complete", tokens: 1, errorCode: null },
  );
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 175,
    reservedTokens: 0,
  });
});

it("releases an unsent request only after the run is terminal and rejects a late begin", async () => {
  const { id } = await queue();
  const { worker, claim } = await accepted();
  const call = await inference(worker, claim, false);
  const { runtime, actor } = fixture;
  expect((await runtime.schedules.get(actor, id)).reservedTokens).toBe(10000);
  await finish(worker, claim);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 0,
    reservedTokens: 0,
  });
  expect(
    (
      await runtime.inference.store.guard(
        actor.organizationId,
        call.id,
        call.executionId,
        { begin: true },
      )
    ).allowed,
  ).toBe(false);
});

it("gives the next task only the remaining allowance without changing its execution profile", async () => {
  const input = scheduledTaskInput(fixture);
  if (input.action.kind !== "run-task") throw new Error("Fixture action");
  input.action.maxTokens = 10000;
  const { id } = await queue(input);
  const { worker, claim } = await accepted();
  const call = await inference(worker, claim);
  const { runtime, actor } = fixture;
  await runtime.inference.store.finish(
    actor.organizationId,
    call.id,
    call.executionId,
    { state: "complete", tokens: 700, answer: "Done", errorCode: null },
  );
  await finish(worker, claim);
  const current = await runtime.schedules.get(actor, id);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: current.revision,
    enabled: false,
  });
  const paused = await runtime.schedules.get(actor, id);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: paused.revision,
    enabled: true,
  });
  await database.engine.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [id, (await runtime.schedules.get(actor, id)).nextAt! - 60000],
  );
  await runtime.scheduleDispatcher.tick();
  const second = (await runtime.execution.runs.list(actor)).find(
    (run) => run.id !== claim.runId,
  )!;
  expect(
    (await runtime.execution.runs.get(actor, second.id)).manifest.profile
      .maxTokens,
  ).toBe(9300);
  expect((await runtime.execution.profiles.list(actor))[0]!.maxTokens).toBe(
    10000,
  );
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    usedTokens: 700,
    reservedTokens: 9300,
    admittedRuns: 2,
  });
});

it("waits for a confirmed stop and anchors the next occurrence to the terminal event", async () => {
  const { id } = await queue(delayed());
  const { worker, claim } = await accepted();
  const { runtime, actor } = fixture;
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: true,
    nextAt: null,
    waitingRunId: claim.runId,
  });
  const run = await runtime.execution.runs.get(actor, claim.runId);
  await runtime.execution.runs.cancel(
    actor,
    randomUUID(),
    run.id,
    run.revision,
  );
  await maintain(id);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    nextAt: null,
    waitingRunId: claim.runId,
  });
  await finish(worker, claim, "canceled");
  await maintain(id);
  const completion = (
    await database.engine.query<{ at: number }>(
      "SELECT floor(extract(epoch FROM occurred_at)*1000)::float8 AS at FROM cloud_run_events WHERE run_id=$1 ORDER BY revision DESC LIMIT 1",
      [claim.runId],
    )
  ).rows[0]!.at;
  expect((await runtime.execution.runs.get(actor, claim.runId)).state).toBe(
    "canceled",
  );
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: true,
    waitingRunId: null,
    nextAt: completion + 60000,
  });
  await maintain(id);
  expect(await runtime.execution.runs.list(actor)).toHaveLength(1);
});

it("resumes waiting for the existing task even while its full token allowance is reserved", async () => {
  const data = delayed();
  if (data.action.kind !== "run-task") throw new Error("Fixture action");
  data.action.maxTokens = 10000;
  const { id, runId } = await queue(data);
  const { runtime, actor } = fixture;
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 2,
    enabled: false,
  });
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 3,
    enabled: true,
  });
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    nextAt: null,
    waitingRunId: runId,
    enabled: true,
  });
  await maintain(id);
  expect(await runtime.execution.runs.list(actor)).toHaveLength(1);
});

it("archives without canceling admitted work and restores only a paused draft", async () => {
  const { id, runId } = await queue(delayed());
  const { runtime, actor } = fixture;
  const key = randomUUID();
  await runtime.schedules.archive(actor, key, id, {
    revision: 2,
    archived: true,
  });
  await runtime.schedules.archive(actor, key, id, {
    revision: 2,
    archived: true,
  });
  expect(await runtime.schedules.list(actor)).toEqual([]);
  expect(
    (await runtime.schedules.list(actor, { archived: true }))[0],
  ).toMatchObject({ id, enabled: false, archived: true });
  expect((await runtime.execution.runs.get(actor, runId)).state).toBe("queued");
  expect(
    (await runtime.schedules.history(actor, id)).some(
      (item) => item.runId === runId,
    ),
  ).toBe(true);
  await expect(
    runtime.schedules.setEnabled(actor, randomUUID(), id, {
      revision: 3,
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "schedule_archived");
  await runtime.schedules.archive(actor, randomUUID(), id, {
    revision: 3,
    archived: false,
  });
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    archived: false,
    enabled: false,
    admittedRuns: 1,
  });
});

it("does not advance a completion after a concurrent archive", async () => {
  const { id, runId } = await queue(delayed());
  const { runtime, actor } = fixture;
  await runtime.execution.runs.cancel(actor, randomUUID(), runId, 1);
  const preview = runtime.recurrence.preview.bind(runtime.recurrence);
  vi.spyOn(runtime.recurrence, "preview").mockImplementationOnce(
    async (...args) => {
      const result = await preview(...args);
      await runtime.schedules.archive(actor, randomUUID(), id, {
        revision: 2,
        archived: true,
      });
      return result;
    },
  );
  await maintain(id);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    archived: true,
    enabled: false,
    nextAt: null,
  });
  expect(await runtime.execution.runs.list(actor)).toHaveLength(1);
});

it("uses recorded issue-creation completion times for fixed-delay issue schedules", async () => {
  const { runtime, actor, teamId } = fixture;
  const data = scheduleInputSchema.parse({
    ...delayed(),
    action: {
      kind: "create-issue",
      issue: { teamId, title: "Recurring review" },
    },
  });
  const { id } = await runtime.schedules.create(actor, randomUUID(), data);
  await runtime.schedules.setEnabled(actor, randomUUID(), id, {
    revision: 1,
    enabled: true,
  });
  await database.engine.query(
    "UPDATE cloud_schedules SET next_at=$2 WHERE id=$1",
    [id, (await runtime.schedules.get(actor, id)).nextAt! - 60000],
  );
  await runtime.scheduleDispatcher.tick();
  const receipt = (await runtime.schedules.history(actor, id))[0]!;
  expect(receipt.completedAt).toBeTypeOf("number");
  expect((await runtime.schedules.get(actor, id)).nextAt).toBe(
    receipt.completedAt! + 60000,
  );
});

it("expires an authorization while waiting and preserves running work under its original grant", async () => {
  const { id, runId } = await queue(delayed());
  const { runtime, actor } = fixture;
  await database.engine.query(
    "UPDATE cloud_schedules SET action=jsonb_set(action,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
    [id, new Date(Date.now() - 1000).toISOString()],
  );
  await maintain(id);
  expect(await runtime.schedules.get(actor, id)).toMatchObject({
    enabled: false,
    error: expect.stringContaining("authorization expired"),
  });
  expect((await runtime.execution.runs.get(actor, runId)).state).toBe("queued");
});

it("paginates history by occurrence identity while newer entries arrive", async () => {
  const { runtime, actor, teamId } = fixture;
  const data = scheduleInputSchema.parse({
    ...delayed(),
    action: { kind: "create-issue", issue: { teamId, title: "History" } },
  });
  const { id } = await runtime.schedules.create(actor, randomUUID(), data);
  await runtime.schedules.update(actor, randomUUID(), id, {
    ...data,
    name: "Updated history",
    revision: 1,
  });
  const base = Date.now() - 300000;
  await database.engine.query(
    "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome) SELECT $1,$2,1,$3::bigint+n,$3::bigint+n,'skipped' FROM generate_series(0,204) n",
    [actor.organizationId, id, base],
  );
  await database.engine.query(
    "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome) VALUES($1,$2,2,$3,$3,'skipped')",
    [actor.organizationId, id, base + 105],
  );
  const first = await runtime.schedules.history(actor, id);
  expect(first).toHaveLength(100);
  expect(first.at(-1)).toMatchObject({ at: base + 105, revision: 2 });
  await database.engine.query(
    "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome) VALUES($1,$2,2,$3,$3,'skipped')",
    [actor.organizationId, id, base + 300],
  );
  const second = await runtime.schedules.history(actor, id, {
    beforeAt: first.at(-1)!.at,
    beforeRevision: first.at(-1)!.revision,
  });
  const third = await runtime.schedules.history(actor, id, {
    beforeAt: second.at(-1)!.at,
    beforeRevision: second.at(-1)!.revision,
  });
  expect(second[0]).toMatchObject({ at: base + 105, revision: 1 });
  expect(third).toHaveLength(6);
  expect(
    new Set(
      [...first, ...second, ...third].map(
        (entry) => `${entry.at}/${entry.revision}`,
      ),
    ).size,
  ).toBe(206);
});

it("checks ownership and current access for archive, restore and history", async () => {
  const { runtime, actor, teamId } = fixture;
  const { id } = await runtime.schedules.create(
    actor,
    randomUUID(),
    scheduledTaskInput(fixture),
  );
  const other = { ...actor, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'other@example.test','Other','fixture')",
    [other.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
    [actor.organizationId, other.userId],
  );
  await expect(runtime.schedules.history(other, id)).rejects.toHaveProperty(
    "code",
    "not_found",
  );
  await database.engine.query(
    "INSERT INTO cloud_team_memberships(organization_id,team_id,user_id) VALUES($1,$2,$3)",
    [actor.organizationId, teamId, other.userId],
  );
  await expect(
    runtime.schedules.archive(other, randomUUID(), id, {
      revision: 1,
      archived: true,
    }),
  ).rejects.toHaveProperty("code", "permission_denied");
  await database.engine.query(
    "UPDATE cloud_memberships SET role='admin' WHERE user_id=$1",
    [other.userId],
  );
  await runtime.schedules.archive(other, randomUUID(), id, {
    revision: 1,
    archived: true,
  });
  await runtime.schedules.archive(other, randomUUID(), id, {
    revision: 2,
    archived: false,
  });
  await expect(
    runtime.schedules.setEnabled(other, randomUUID(), id, {
      revision: 3,
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "schedule_owner_required");
  expect((await runtime.schedules.get(actor, id)).enabled).toBe(false);
});

it("rejects an authorization that ends before its first possible task", async () => {
  const { runtime, actor } = fixture;
  const data = delayed();
  if (data.action.kind !== "run-task") throw new Error("Fixture action");
  data.action.expiresAt = new Date(Date.now() + 30000).toISOString();
  const { id } = await runtime.schedules.create(actor, randomUUID(), data);
  await expect(
    runtime.schedules.setEnabled(actor, randomUUID(), id, {
      revision: 1,
      enabled: true,
    }),
  ).rejects.toHaveProperty("code", "schedule_expiry");
  expect(await runtime.execution.runs.list(actor)).toHaveLength(0);
});
