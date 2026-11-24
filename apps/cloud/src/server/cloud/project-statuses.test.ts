import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  projectInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { cloudMigrations } from "./database";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
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
  for (const role of ["owner", "member"]) {
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
  [owner, member] = actors as [CloudActor, CloudActor];
  runtime = createCloudRuntime(database, "https://cloud.example.test");
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

async function createProject(input: Record<string, unknown> = {}) {
  const { id } = await runtime.projects.create(
    owner,
    randomUUID(),
    projectInputSchema.parse({ teamId, name: "Launch", ...input }),
  );
  return runtime.projects.get(owner, id);
}

async function statusNamed(name: string) {
  const status = (await runtime.projectStatuses.list(owner)).find(
    (entry) => entry.name === name,
  );
  if (!status) throw new Error(`Missing status ${name}`);
  return status;
}

const update = { health: "on_track" as const, summary: "Steady", body: "" };

describe("project statuses", () => {
  it("seeds the default statuses for every organization in category order", async () => {
    expect(
      (await runtime.projectStatuses.list(member)).map(({ name, category }) => [
        name,
        category,
      ]),
    ).toEqual([
      ["Backlog", "backlog"],
      ["Planned", "planned"],
      ["In progress", "active"],
      ["Paused", "paused"],
      ["Completed", "completed"],
      ["Canceled", "canceled"],
    ]);
  });

  it("lets only settings managers add, rename and reorder statuses", async () => {
    await expect(
      runtime.projectStatuses.create(member, randomUUID(), {
        name: "Review",
        category: "active",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const { status } = await runtime.projectStatuses.create(
      owner,
      randomUUID(),
      { name: "Review", category: "active" },
    );
    await expect(
      runtime.projectStatuses.create(owner, randomUUID(), {
        name: "review",
        category: "planned",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await runtime.projectStatuses.update(owner, status.id, {
      name: "In review",
      position: 0,
    });
    expect(
      (await runtime.projectStatuses.list(owner))
        .filter((entry) => entry.category === "active")
        .map((entry) => entry.name),
    ).toEqual(["In review", "In progress"]);
  });

  it("moves projects to the replacement when a status is deleted", async () => {
    const { status: review } = await runtime.projectStatuses.create(
      owner,
      randomUUID(),
      { name: "Review", category: "active" },
    );
    const project = await createProject({ statusId: review.id });
    expect(project).toMatchObject({
      statusId: review.id,
      statusName: "Review",
      status: "active",
    });
    const paused = await statusNamed("Paused");
    await expect(
      runtime.projectStatuses.remove(member, review.id, paused.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.projectStatuses.remove(owner, review.id, review.id),
    ).rejects.toMatchObject({ code: "project_status_replacement" });
    await runtime.projectStatuses.remove(owner, review.id, paused.id);
    expect(await runtime.projects.get(owner, project.id)).toMatchObject({
      statusId: paused.id,
      statusName: "Paused",
      status: "paused",
      revision: project.revision + 1,
    });
  });

  it("keeps at least one status in every category", async () => {
    const backlog = await statusNamed("Backlog");
    const planned = await statusNamed("Planned");
    await expect(
      runtime.projectStatuses.remove(owner, backlog.id, planned.id),
    ).rejects.toMatchObject({ status: 422, code: "project_status_last" });
  });

  it("resolves the category status when a project is created without a status id", async () => {
    expect(await createProject({ status: "paused" })).toMatchObject({
      status: "paused",
      statusName: "Paused",
    });
    expect(await createProject()).toMatchObject({
      status: "planned",
      statusName: "Planned",
    });
  });
});

describe("project update cadence", () => {
  it("defaults new projects to the organization cadence", async () => {
    expect((await createProject()).updateCadence).toBe("none");
    await runtime.settings.setOrganization(
      owner,
      randomUUID(),
      "projects.updateCadence",
      "biweekly",
    );
    expect((await createProject()).updateCadence).toBe("biweekly");
    expect(
      (await createProject({ updateCadence: "monthly" })).updateCadence,
    ).toBe("monthly");
  });

  it("reminds the lead once per due date and restarts after a new update", async () => {
    const project = await createProject({
      updateCadence: "weekly",
      leadId: member.userId,
    });
    expect(await runtime.projectUpdates.remindDue()).toBe(0);
    await database.engine.query(
      "UPDATE cloud_projects SET update_cadence_since=clock_timestamp()-interval '8 days' WHERE id=$1",
      [project.id],
    );
    expect(await runtime.projectUpdates.remindDue()).toBe(1);
    expect(await runtime.projectUpdates.remindDue()).toBe(0);
    const [entry] = await runtime.inbox.list(member);
    expect(entry).toMatchObject({
      kind: "project_update_due",
      projectId: project.id,
      projectName: "Launch",
    });
    await database.engine.query(
      "UPDATE cloud_projects SET update_cadence_since=clock_timestamp()-interval '30 days',update_reminded_at=clock_timestamp()-interval '22 days' WHERE id=$1",
      [project.id],
    );
    await runtime.projectUpdates.create(
      owner,
      randomUUID(),
      project.id,
      update,
    );
    await database.engine.query(
      "UPDATE cloud_project_updates SET created_at=clock_timestamp()-interval '3 days' WHERE project_id=$1",
      [project.id],
    );
    expect(await runtime.projectUpdates.remindDue()).toBe(0);
    await database.engine.query(
      "UPDATE cloud_project_updates SET created_at=clock_timestamp()-interval '9 days' WHERE project_id=$1",
      [project.id],
    );
    expect(await runtime.projectUpdates.remindDue()).toBe(1);
  });

  it("skips projects without a lead, cadence or active status", async () => {
    const withoutLead = await createProject({ updateCadence: "weekly" });
    const withoutCadence = await createProject({ leadId: member.userId });
    const completed = await createProject({
      updateCadence: "weekly",
      leadId: member.userId,
      status: "completed",
    });
    await database.engine.query(
      "UPDATE cloud_projects SET update_cadence_since=clock_timestamp()-interval '60 days' WHERE id = ANY($1)",
      [[withoutLead.id, withoutCadence.id, completed.id]],
    );
    expect(await runtime.projectUpdates.remindDue()).toBe(0);
  });

  it("restarts the cadence when it changes", async () => {
    const project = await createProject({
      updateCadence: "weekly",
      leadId: member.userId,
    });
    await database.engine.query(
      "UPDATE cloud_projects SET update_cadence_since=clock_timestamp()-interval '20 days' WHERE id=$1",
      [project.id],
    );
    await runtime.projects.update(owner, randomUUID(), project.id, {
      revision: project.revision,
      name: project.name,
      description: project.description,
      status: project.status,
      updateCadence: "monthly",
      leadId: project.leadId,
      startsOn: project.startsOn,
      targetOn: project.targetOn,
    });
    expect(await runtime.projectUpdates.remindDue()).toBe(0);
  });
});

describe("project update drafts", () => {
  it("keeps drafts out of published updates and notifies the lead", async () => {
    const project = await createProject({ leadId: member.userId });
    const { id } = await runtime.projectUpdates.create(
      owner,
      randomUUID(),
      project.id,
      update,
      { generated: true, draft: true },
    );
    expect(await runtime.projectUpdates.list(owner, project.id)).toEqual([]);
    expect(await runtime.projectUpdates.feed(owner)).toEqual([]);
    expect(await runtime.projectUpdates.latest(owner)).toEqual([]);
    expect(await runtime.projectUpdates.drafts(owner, project.id)).toEqual([
      expect.objectContaining({ id, generated: true, summary: "Steady" }),
    ]);
    expect((await runtime.inbox.list(member))[0]).toMatchObject({
      kind: "project_update_drafted",
      projectId: project.id,
      detail: "Steady",
    });
  });

  it("publishes a reviewed draft under the reviewer", async () => {
    const project = await createProject({ leadId: member.userId });
    const { id } = await runtime.projectUpdates.create(
      owner,
      randomUUID(),
      project.id,
      update,
      { generated: true, draft: true },
    );
    const key = randomUUID();
    const reviewed = {
      health: "at_risk" as const,
      summary: "Slipping",
      body: "Edited",
    };
    await runtime.projectUpdates.publish(member, key, id, reviewed);
    await runtime.projectUpdates.publish(member, key, id, reviewed);
    expect(await runtime.projectUpdates.drafts(owner, project.id)).toEqual([]);
    expect(await runtime.projectUpdates.list(owner, project.id)).toEqual([
      expect.objectContaining({
        id,
        authorId: member.userId,
        health: "at_risk",
        summary: "Slipping",
        body: "Edited",
      }),
    ]);
    await expect(
      runtime.projectUpdates.publish(member, randomUUID(), id, reviewed),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("discards drafts but never published updates", async () => {
    const project = await createProject();
    const draft = await runtime.projectUpdates.create(
      owner,
      randomUUID(),
      project.id,
      update,
      { draft: true },
    );
    const posted = await runtime.projectUpdates.create(
      owner,
      randomUUID(),
      project.id,
      update,
    );
    await runtime.projectUpdates.discard(owner, draft.id);
    expect(await runtime.projectUpdates.drafts(owner, project.id)).toEqual([]);
    await expect(
      runtime.projectUpdates.discard(owner, posted.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(await runtime.projectUpdates.list(owner, project.id)).toHaveLength(
      1,
    );
  });
});

it("migrates projects onto seeded statuses and adds project notifications", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("076-project-statuses-updates.sql");
    for (const name of cloudMigrations.slice(0, index))
      await engine.exec(
        await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const organizationId = randomUUID();
    const existingTeamId = randomUUID();
    const projectId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_teams (organization_id,id,name,key,visibility,estimate_scale) VALUES ($1,$2,'Team','TM','organization',$3)",
      [organizationId, existingTeamId, JSON.stringify(defaultEstimateScale)],
    );
    await engine.query(
      "INSERT INTO cloud_projects (organization_id,id,team_id,name,description,status) VALUES ($1,$2,$3,'Launch','','paused')",
      [organizationId, projectId, existingTeamId],
    );
    for (const name of cloudMigrations.slice(index))
      await engine.exec(
        await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    expect(
      (
        await engine.query<{ name: string; cadence: string }>(
          `SELECT s.name,p.update_cadence AS cadence FROM cloud_projects p
          JOIN cloud_project_statuses s ON s.organization_id=p.organization_id AND s.id=p.status_id WHERE p.id=$1`,
          [projectId],
        )
      ).rows,
    ).toEqual([{ name: "Paused", cadence: "none" }]);
    const newOrganizationId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Second')",
      [newOrganizationId],
    );
    expect(
      (
        await engine.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM cloud_project_statuses WHERE organization_id=$1",
          [newOrganizationId],
        )
      ).rows[0]!.count,
    ).toBe(6);
    await expect(
      engine.query("UPDATE cloud_projects SET status='active' WHERE id=$1", [
        projectId,
      ]),
    ).rejects.toThrow();
    expect(
      (
        await engine.query<{ definition: string }>(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='cloud_notifications_kind_check'",
        )
      ).rows[0]!.definition,
    ).toContain("project_update_due");
  } finally {
    await engine.close();
  }
}, 120_000);
