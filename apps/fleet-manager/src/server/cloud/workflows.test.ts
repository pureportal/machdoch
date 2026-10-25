import { randomUUID } from "node:crypto";
import { CloudWorkflows } from "./workflows";
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

import {
  workflowDefinitionSchema,
  type CloudTeamWorkflow,
  type WorkflowDefinition,
} from "../../lib/cloud-workflow-contract";
import { scheduleInputSchema } from "../../lib/cloud-schedule-contract";

function definition(workflow: CloudTeamWorkflow): WorkflowDefinition {
  return {
    revision: workflow.revision,
    defaultStatusId: workflow.defaultStatusId,
    statuses: workflow.statuses.map(({ revision: _, ...status }) => status),
  };
}
async function apply(
  next: WorkflowDefinition,
  actor = owner,
  key = randomUUID(),
) {
  const impact = await runtime.workflows.preview(actor, teamId, next);
  return runtime.workflows.update(actor, key, teamId, {
    definition: next,
    impactDigest: impact.digest,
  });
}

it("seeds ordered team workflows and keeps defaults, custom states, reordering and name swaps canonical", async () => {
  const current = await runtime.workflows.get(member, teamId);
  expect(current.statuses.map((status) => status.category)).toEqual([
    "backlog",
    "ready",
    "active",
    "blocked",
    "review",
    "complete",
    "canceled",
  ]);
  const customId = randomUUID();
  const next = definition(current);
  [next.statuses[0]!.name, next.statuses[1]!.name] = [
    next.statuses[1]!.name,
    next.statuses[0]!.name,
  ];
  next.statuses.unshift({
    id: customId,
    name: "Quality review",
    category: "review",
    archived: false,
  });
  next.defaultStatusId = customId;
  await apply(next);
  const updated = await runtime.workflows.get(viewer, teamId);
  expect(updated).toMatchObject({ revision: 2, defaultStatusId: customId });
  expect(updated.statuses[0]).toMatchObject({ id: customId, revision: 1 });
  const created = await runtime.planning.createIssue(
    member,
    randomUUID(),
    issueInputSchema.parse({ teamId, title: "New default" }),
  );
  expect(await runtime.planning.getIssue(member, created.id)).toMatchObject({
    state: "review",
    statusName: "Quality review",
    status: { id: customId, revision: 1 },
  });
  expect((await runtime.planning.workspace(member)).workflows).toEqual([
    updated,
  ]);
  expect(
    (await runtime.planning.listIssues(member, { statusId: customId })).map(
      (issue) => issue.id,
    ),
  ).toEqual([created.id]);
  await apply(definition(updated));
  expect((await runtime.workflows.get(owner, teamId)).revision).toBe(2);
  const rename = definition(updated);
  rename.statuses.find((status) => status.id === customId)!.name =
    "Verification";
  await apply(rename);
  expect(await runtime.planning.getIssue(owner, created.id)).toMatchObject({
    statusName: "Verification",
    revision: 1,
    status: { revision: 1 },
  });
  expect(
    (await runtime.planning.history(owner, created.id))[0]!.statusName,
  ).toBe("Quality review");
});

it("requires administrative authority and current access without disclosing private or cross-tenant statuses", async () => {
  const current = definition(await runtime.workflows.get(owner, teamId));
  for (const actor of [member, viewer]) {
    await expect(
      runtime.workflows.preview(actor, teamId, current),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.workflows.update(actor, randomUUID(), teamId, {
        definition: current,
        impactDigest: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 403 });
  }
  await expect(runtime.workflows.get(stranger, teamId)).rejects.toMatchObject({
    status: 404,
  });
  const hidden = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Hidden",
    key: "HD",
    visibility: "private",
    estimateScale: defaultEstimateScale,
  });
  await expect(runtime.workflows.get(member, hidden.id)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (await runtime.planning.workspace(member)).workflows.map(
      (workflow) => workflow.teamId,
    ),
  ).toEqual([teamId]);
  const status = (await runtime.workflows.get(owner, hidden.id)).statuses[0]!;
  await expect(
    runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        title: "Cross team",
        status: { id: status.id, revision: status.revision },
      }),
    ),
  ).rejects.toMatchObject({ code: "status_unavailable" });
  current.statuses.push({
    id: status.id,
    name: "Foreign status",
    category: "ready",
    archived: false,
  });
  await expect(apply(current)).rejects.toMatchObject({
    code: "workflow_status_identity",
  });
});

it("requires an exact impact review and preserves cycle commitments, closing scope and existing issue history", async () => {
  const cycle = await runtime.planning.createCycle(owner, randomUUID(), {
    teamId,
    name: "October",
    startsOn: "2026-10-01",
    endsOn: "2026-11-01",
    timezone: "UTC",
    capacity: 10,
  });
  const initial = await runtime.planning.getIssue(owner, issueId);
  await runtime.planning.updateIssue(
    owner,
    randomUUID(),
    issueId,
    issueUpdateSchema.strip().parse({ ...initial, cycleId: cycle.id }),
  );
  await runtime.cycles.act(owner, randomUUID(), cycle.id, {
    kind: "start",
    revision: 1,
  });
  await runtime.cycles.act(owner, randomUUID(), cycle.id, {
    kind: "close",
    revision: 2,
    carryoverCycleId: null,
  });
  const closed = await runtime.cycles.get(owner, cycle.id);
  const before = await runtime.planning.getIssue(owner, issueId);
  const current = await runtime.workflows.get(owner, teamId);
  const next = definition(current);
  const status = next.statuses.find((entry) => entry.id === before.status.id)!;
  status.category = "complete";
  status.name = "Delivered";
  next.defaultStatusId = next.statuses.find(
    (entry) => entry.category === "ready",
  )!.id;
  const impact = await runtime.workflows.preview(owner, teamId, next);
  expect(impact).toMatchObject({ changedIssues: 1, pausedSchedules: 0 });
  await runtime.planning.updateIssue(
    member,
    randomUUID(),
    issueId,
    issueUpdateSchema
      .strip()
      .parse({ ...before, title: "Edited during review" }),
  );
  await expect(
    runtime.workflows.update(owner, randomUUID(), teamId, {
      definition: next,
      impactDigest: impact.digest,
    }),
  ).rejects.toMatchObject({ code: "workflow_impact_changed" });
  const priorHistory = await runtime.planning.history(owner, issueId);
  await apply(next);
  const updated = await runtime.planning.getIssue(owner, issueId);
  expect(updated).toMatchObject({
    state: "complete",
    statusName: "Delivered",
    revision: before.revision + 2,
    status: { id: before.status.id, revision: 2 },
  });
  expect(await runtime.cycles.get(owner, cycle.id)).toEqual(closed);
  expect(closed.statusNames[issueId]).toBe("Backlog");
  const history = await runtime.planning.history(owner, issueId);
  expect(history.slice(1)).toEqual(priorHistory);
  expect(history[0]!.snapshot.state).toBe("complete");
  expect(
    (
      await database.engine.query<{ snapshot: CloudTeamWorkflow }>(
        "SELECT snapshot FROM cloud_workflow_revisions WHERE team_id=$1 AND revision=1",
        [teamId],
      )
    ).rows[0]!.snapshot,
  ).toEqual(current);
});

it("retains current archived assignments, rejects stale semantic revisions, and never revives an old command", async () => {
  const current = await runtime.workflows.get(owner, teamId);
  const initial = await runtime.planning.getIssue(owner, issueId);
  const next = definition(current);
  next.statuses.find((status) => status.id === initial.status.id)!.archived =
    true;
  next.defaultStatusId = next.statuses.find(
    (status) => status.category === "ready",
  )!.id;
  const input = {
    definition: next,
    impactDigest: (await runtime.workflows.preview(owner, teamId, next)).digest,
  };
  const key = randomUUID();
  await runtime.workflows.update(owner, key, teamId, input);
  await expect(
    runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        title: "Old ref",
        status: initial.status,
      }),
    ),
  ).rejects.toMatchObject({ code: "workflow_changed" });
  const archived = await runtime.planning.getIssue(owner, issueId);
  expect(archived.revision).toBe(initial.revision);
  await runtime.planning.updateIssue(
    member,
    randomUUID(),
    issueId,
    issueUpdateSchema
      .strip()
      .parse({ ...archived, description: "Keep the assignment" }),
  );
  await expect(
    runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        title: "Archived ref",
        status: archived.status,
      }),
    ),
  ).rejects.toMatchObject({ code: "status_archived" });
  const restore = definition(await runtime.workflows.get(owner, teamId));
  restore.statuses.find((status) => status.id === initial.status.id)!.archived =
    false;
  await apply(restore);
  await runtime.workflows.update(owner, key, teamId, input);
  expect(
    (await runtime.workflows.get(owner, teamId)).statuses.find(
      (status) => status.id === initial.status.id,
    ),
  ).toMatchObject({ archived: false, revision: 3 });
  await expect(
    runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        title: "Pre-restore ref",
        status: archived.status,
      }),
    ),
  ).rejects.toMatchObject({ code: "workflow_changed" });
});

it("pins scheduled issue status, preserves cosmetic edits and pauses future work on a semantic change", async () => {
  const current = await runtime.workflows.get(owner, teamId);
  const data = scheduleInputSchema.parse({
    name: "Recurring issue",
    teamId,
    action: { kind: "create-issue", issue: { teamId, title: "Repeat" } },
    recurrence: {
      kind: "interval",
      start: new Date(Date.now() + 60000).toISOString(),
      everyMs: 60000,
    },
    missed: "skip",
    catchUpLimit: 1,
    lookbackHours: 1,
  });
  const schedule = await runtime.schedules.create(owner, randomUUID(), data);
  const saved = await runtime.schedules.get(owner, schedule.id);
  expect(saved.action).toMatchObject({
    issue: { status: { id: current.defaultStatusId, revision: 1 } },
  });
  await runtime.scheduleDispatcher.tick();
  await runtime.schedules.setEnabled(owner, randomUUID(), schedule.id, {
    revision: 1,
    enabled: true,
  });
  const next = definition(current);
  next.statuses.find((status) => status.id === current.defaultStatusId)!.name =
    "Intake";
  next.defaultStatusId = next.statuses.find(
    (status) => status.category === "ready",
  )!.id;
  await apply(next);
  expect((await runtime.schedules.get(owner, schedule.id)).enabled).toBe(true);
  const renamed = definition(await runtime.workflows.get(owner, teamId));
  renamed.statuses.find(
    (status) => status.id === current.defaultStatusId,
  )!.category = "active";
  expect(await runtime.workflows.preview(owner, teamId, renamed)).toMatchObject(
    { changedIssues: 1, pausedSchedules: 1 },
  );
  const before = (
    await database.engine.query(
      "SELECT snapshot FROM cloud_schedule_revisions WHERE schedule_id=$1 ORDER BY revision",
      [schedule.id],
    )
  ).rows;
  await apply(renamed);
  expect(await runtime.schedules.get(owner, schedule.id)).toMatchObject({
    enabled: false,
    revision: 3,
    error: expect.stringContaining("workflow changed"),
  });
  expect(
    (
      await database.engine.query(
        "SELECT snapshot FROM cloud_schedule_revisions WHERE schedule_id=$1 AND revision<=2 ORDER BY revision",
        [schedule.id],
      )
    ).rows,
  ).toEqual(before);
  await expect(
    runtime.schedules.setEnabled(owner, randomUUID(), schedule.id, {
      revision: 3,
      enabled: true,
    }),
  ).rejects.toMatchObject({ code: "workflow_changed" });
});

it("validates names, retained identities and a usable default before changing workflow state", async () => {
  const current = definition(await runtime.workflows.get(owner, teamId));
  expect(
    workflowDefinitionSchema.safeParse({
      ...current,
      statuses: current.statuses.map((status) => ({ ...status, name: "Same" })),
    }).success,
  ).toBe(false);
  expect(
    workflowDefinitionSchema.safeParse({
      ...current,
      defaultStatusId: current.statuses.find(
        (status) => status.category === "complete",
      )!.id,
    }).success,
  ).toBe(false);
  await expect(
    apply({
      ...current,
      statuses: current.statuses.slice(1),
      defaultStatusId: current.statuses[1]!.id,
    }),
  ).rejects.toMatchObject({ code: "workflow_status_missing" });
  const otherStatus = await testStatusReference(
    database,
    owner,
    teamId,
    "active",
  );
  const issue = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title: "Active", status: otherStatus }),
  );
  expect((await runtime.planning.getIssue(owner, issue.id)).state).toBe(
    "active",
  );
});

it("rolls back status, issue, schedule and audit writes if the transaction fails before recording the workflow", async () => {
  const initial = await runtime.workflows.get(owner, teamId);
  const next = definition(initial);
  next.statuses.find(
    (status) => status.id === initial.defaultStatusId,
  )!.category = "ready";
  const created = await runtime.schedules.create(
    owner,
    randomUUID(),
    scheduleInputSchema.parse({
      name: "Rollback",
      teamId,
      action: {
        kind: "create-issue",
        issue: { teamId, title: "Future issue" },
      },
      recurrence: {
        kind: "interval",
        start: new Date(Date.now() + 3600000).toISOString(),
        everyMs: 60000,
      },
      missed: "skip",
      catchUpLimit: 1,
      lookbackHours: 1,
    }),
  );
  await runtime.scheduleDispatcher.tick();
  await runtime.schedules.setEnabled(owner, randomUUID(), created.id, {
    revision: 1,
    enabled: true,
  });
  const schedule = await runtime.schedules.get(owner, created.id);
  const issue = await runtime.planning.getIssue(owner, issueId);
  const history = await runtime.planning.history(owner, issueId);
  const input = {
    definition: next,
    impactDigest: (await runtime.workflows.preview(owner, teamId, next)).digest,
  };
  const key = randomUUID();
  const failing = new CloudWorkflows({
    transaction: (operation) =>
      database.transaction((sql) =>
        operation({
          async query<T extends Record<string, unknown>>(
            statement: string,
            parameters?: unknown[],
          ) {
            if (statement.startsWith("INSERT INTO cloud_workflow_revisions"))
              throw new Error("Injected transaction failure");
            return sql.query<T>(statement, parameters);
          },
        }),
      ),
    close: () => Promise.resolve(),
  });
  await expect(failing.update(owner, key, teamId, input)).rejects.toThrow(
    "Injected transaction failure",
  );
  expect(await runtime.workflows.get(owner, teamId)).toEqual(initial);
  expect(await runtime.planning.getIssue(owner, issueId)).toEqual(issue);
  expect(await runtime.planning.history(owner, issueId)).toEqual(history);
  expect(await runtime.schedules.get(owner, created.id)).toEqual(schedule);
  expect(
    (
      await database.engine.query(
        "SELECT id FROM cloud_outbox WHERE kind='workflow.changed'",
      )
    ).rows,
  ).toEqual([]);
  await runtime.workflows.update(owner, key, teamId, input);
  expect((await runtime.workflows.get(owner, teamId)).revision).toBe(2);
  expect((await runtime.planning.getIssue(owner, issueId)).state).toBe("ready");
  expect((await runtime.schedules.get(owner, created.id)).enabled).toBe(false);
});
