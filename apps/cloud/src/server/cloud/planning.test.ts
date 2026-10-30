import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  issueUpdateSchema,
  type CloudActor,
  type CloudRole,
} from "../../lib/cloud-contract";
import { CloudPlanning } from "./planning";
import { CloudProjects } from "./projects";
import { CloudPoker } from "./poker";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let planning: CloudPlanning;
let poker: CloudPoker;
let projects: CloudProjects;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let stranger: CloudActor;
let teamId: string;

async function addMember(
  organizationId: string,
  role: CloudRole,
): Promise<CloudActor> {
  const userId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'unused-test-hash')",
    [userId, `${userId}@example.test`, role],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
    [organizationId, userId, role],
  );
  return { organizationId, userId };
}

async function createIssue(
  title = "Fix reconnect",
  estimate: string | null = null,
) {
  const input = issueInputSchema.parse({ teamId, title, estimate });
  const { id } = await planning.createIssue(owner, randomUUID(), input);
  return planning.getIssue(owner, id);
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
  planning = new CloudPlanning(database);
  poker = new CloudPoker(database);
  projects = new CloudProjects(database);
}, 30_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'First'),($2,'Second')",
    [organizationId, otherOrganizationId],
  );
  owner = await addMember(organizationId, "owner");
  member = await addMember(organizationId, "member");
  viewer = await addMember(organizationId, "viewer");
  stranger = await addMember(otherOrganizationId, "owner");
  teamId = (
    await planning.createTeam(owner, randomUUID(), {
      name: "Engineering",
      key: "ENG",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

const unchangedPlanning = {
  status: "planned",
  leadId: null,
  startsOn: null,
  targetOn: null,
} as const;

describe("cloud planning integrity", () => {
  it("plans projects with a lead, dates, status and issue progress", async () => {
    await expect(
      projects.create(owner, randomUUID(), {
        teamId,
        name: "Outside lead",
        description: "",
        leadId: stranger.userId,
      }),
    ).rejects.toMatchObject({ code: "lead_unavailable" });
    const project = await projects.create(owner, randomUUID(), {
      teamId,
      name: "Launch",
      description: "",
      status: "active",
      leadId: member.userId,
      startsOn: "2026-11-02",
      targetOn: "2026-12-18",
    });
    expect(await projects.get(member, project.id)).toMatchObject({
      status: "active",
      leadId: member.userId,
      startsOn: "2026-11-02",
      targetOn: "2026-12-18",
    });
    const estimate = defaultEstimateScale.find((card) => card.points !== null)!;
    for (const [title, state] of [
      ["Done", "complete"],
      ["Started", "active"],
      ["Open", "backlog"],
      ["Dropped", "canceled"],
    ] as const) {
      const issue = await planning.createIssue(
        owner,
        randomUUID(),
        issueInputSchema.parse({
          teamId,
          title,
          projectId: project.id,
          estimate: estimate.label,
        }),
      );
      if (state === "backlog") continue;
      const current = await planning.getIssue(owner, issue.id);
      const status = (
        await database.engine.query<{ id: string; revision: number }>(
          "SELECT id,revision FROM cloud_workflow_statuses WHERE team_id=$1 AND category=$2 ORDER BY position LIMIT 1",
          [teamId, state],
        )
      ).rows[0]!;
      await planning.updateIssue(
        owner,
        randomUUID(),
        issue.id,
        issueUpdateSchema.strip().parse({ ...current, status }),
      );
    }
    expect(
      (await projects.progress(viewer)).find(
        (entry) => entry.projectId === project.id,
      ),
    ).toEqual({
      projectId: project.id,
      total: 3,
      started: 1,
      completed: 1,
      points: estimate.points! * 3,
      completedPoints: estimate.points,
    });
    await projects.update(member, randomUUID(), project.id, {
      revision: 1,
      name: "Launch",
      description: "",
      status: "completed",
      leadId: null,
      startsOn: "2026-11-02",
      targetOn: "2026-12-18",
    });
    expect(await projects.get(owner, project.id)).toMatchObject({
      status: "completed",
      leadId: null,
      revision: 2,
    });
    expect(await projects.progress(stranger)).toEqual([]);
  });

  it("updates projects once per command, rejects stale edits and preserves issue links", async () => {
    const project = await projects.create(owner, randomUUID(), {
      teamId,
      name: "Original",
      description: "First",
    });
    const issue = await planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        projectId: project.id,
        title: "Linked issue",
      }),
    );
    const key = randomUUID();
    const change = {
      revision: 1,
      name: "Edited",
      description: "Second",
      ...unchangedPlanning,
    };
    await projects.update(member, key, project.id, change);
    await projects.update(member, key, project.id, change);
    await expect(
      projects.update(member, key, project.id, {
        ...change,
        name: "Different",
      }),
    ).rejects.toMatchObject({ code: "command_conflict" });
    await expect(
      projects.update(owner, randomUUID(), project.id, change),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await projects.get(viewer, project.id)).toMatchObject({
      name: "Edited",
      description: "Second",
      revision: 2,
      teamId,
    });
    expect((await planning.getIssue(owner, issue.id)).projectId).toBe(
      project.id,
    );
    await projects.update(member, randomUUID(), project.id, {
      ...change,
      revision: 2,
    });
    expect((await projects.get(owner, project.id)).revision).toBe(2);
    expect(
      (
        await database.engine.query(
          "SELECT id FROM cloud_outbox WHERE kind='project.changed'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("limits project reads and edits to authorized organization and team memberships", async () => {
    const project = await projects.create(owner, randomUUID(), {
      teamId,
      name: "Project",
      description: "",
    });
    const change = {
      revision: 1,
      name: "Denied",
      description: "",
      ...unchangedPlanning,
    };
    await expect(
      projects.update(viewer, randomUUID(), project.id, change),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(projects.get(stranger, project.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      projects.update(stranger, randomUUID(), project.id, change),
    ).rejects.toMatchObject({ code: "not_found" });
    await database.engine.query(
      "UPDATE cloud_teams SET visibility='private' WHERE id=$1",
      [teamId],
    );
    await expect(projects.get(member, project.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      projects.update(member, randomUUID(), project.id, change),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await projects.get(owner, project.id)).revision).toBe(1);
  });

  it("persists one issue and event for a retried creation and rejects a changed request", async () => {
    const key = randomUUID();
    const input = issueInputSchema.parse({ teamId, title: "A durable issue" });
    const first = await planning.createIssue(owner, key, input);
    expect(await planning.createIssue(owner, key, input)).toEqual(first);
    await expect(
      planning.createIssue(owner, key, { ...input, title: "Different" }),
    ).rejects.toMatchObject({ code: "command_conflict" });
    expect(await planning.listIssues(owner)).toHaveLength(1);
    expect((await planning.getIssue(owner, first.id)).identifier).toBe("ENG-1");
    expect(await planning.history(owner, first.id)).toHaveLength(1);
    expect(
      (
        await database.engine.query(
          "SELECT * FROM cloud_outbox WHERE kind='issue.changed'",
        )
      ).rows,
    ).toHaveLength(1);
    expect((await createIssue()).identifier).toBe("ENG-2");
  });

  it("rejects lost updates while retaining both accepted revisions", async () => {
    const issue = await createIssue();
    const update = issueUpdateSchema.strip().parse(issue);
    const key = randomUUID();
    await planning.updateIssue(owner, key, issue.id, {
      ...update,
      title: "New title",
    });
    await planning.updateIssue(owner, key, issue.id, {
      ...update,
      title: "New title",
    });
    await expect(
      planning.updateIssue(member, randomUUID(), issue.id, {
        ...update,
        title: "Stale title",
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await planning.getIssue(owner, issue.id)).title).toBe("New title");
    expect(
      (await planning.history(owner, issue.id)).map((entry) => entry.revision),
    ).toEqual([2, 1]);
  });

  it("isolates private team issues, search, history, projects and cycles", async () => {
    teamId = (
      await planning.createTeam(owner, randomUUID(), {
        name: "Private",
        key: "SEC",
        visibility: "private",
        estimateScale: defaultEstimateScale,
      })
    ).id;
    const issue = await createIssue("Confidential");
    await projects.create(owner, randomUUID(), {
      teamId,
      name: "Confidential project",
      description: "",
    });
    await planning.createCycle(owner, randomUUID(), {
      teamId,
      name: "Confidential cycle",
      startsOn: "2026-10-01",
      endsOn: "2026-10-15",
      timezone: "Europe/Berlin",
      capacity: null,
    });
    for (const actor of [member, viewer, stranger]) {
      expect(
        await planning.listIssues(actor, { query: "Confidential" }),
      ).toEqual([]);
      await expect(planning.getIssue(actor, issue.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(planning.history(actor, issue.id)).rejects.toMatchObject({
        status: 404,
      });
      const workspace = await planning.workspace(actor);
      expect(workspace.teams.some((team) => team.id === teamId)).toBe(false);
      expect(workspace.projects).toHaveLength(0);
      expect(workspace.cycles).toHaveLength(0);
    }
  });

  it("rejects cross-organization and cross-team references at the domain and database boundaries", async () => {
    const otherTeam = (
      await planning.createTeam(stranger, randomUUID(), {
        name: "Other",
        key: "OTH",
        visibility: "organization",
        estimateScale: defaultEstimateScale,
      })
    ).id;
    const project = await projects.create(stranger, randomUUID(), {
      teamId: otherTeam,
      name: "Other project",
      description: "",
    });
    await expect(
      planning.createIssue(
        owner,
        randomUUID(),
        issueInputSchema.parse({
          teamId,
          title: "Wrong project",
          projectId: project.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_reference" });
    const issue = await createIssue();
    await expect(
      database.engine.query(
        "UPDATE cloud_issues SET project_id=$1 WHERE id=$2",
        [project.id, issue.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      planning.createIssue(
        owner,
        randomUUID(),
        issueInputSchema.parse({
          teamId,
          title: "Wrong assignee",
          assigneeId: stranger.userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_assignee" });
  });

  it("enforces viewer and revoked-member permissions even on idempotent replays", async () => {
    const input = issueInputSchema.parse({ teamId, title: "Member issue" });
    await expect(
      planning.createIssue(viewer, randomUUID(), input),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      planning.createTeam(member, randomUUID(), {
        name: "No",
        key: "NO",
        visibility: "organization",
        estimateScale: defaultEstimateScale,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const key = randomUUID();
    await planning.createIssue(member, key, input);
    await database.engine.query(
      "DELETE FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
      [member.organizationId, member.userId],
    );
    await expect(
      planning.createIssue(member, key, input),
    ).rejects.toMatchObject({ status: 403 });
    await expect(planning.listIssues(member)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("serializes cycle admission and permits adjacent date ranges", async () => {
    const input = {
      teamId,
      name: "Cycle one",
      startsOn: "2026-10-18",
      endsOn: "2026-11-01",
      timezone: "Europe/Berlin",
      capacity: 20,
    };
    const outcomes = await Promise.allSettled([
      planning.createCycle(owner, randomUUID(), input),
      planning.createCycle(member, randomUUID(), {
        ...input,
        name: "Duplicate",
      }),
    ]);
    expect(
      outcomes.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((entry) => entry.status === "rejected"),
    ).toHaveLength(1);
    await planning.createCycle(owner, randomUUID(), {
      ...input,
      name: "Next",
      startsOn: "2026-11-01",
      endsOn: "2026-11-15",
    });
    expect((await planning.workspace(owner)).cycles).toHaveLength(2);
  });

  it("preserves historical point values when the team's scale changes", async () => {
    const issue = await createIssue("Estimate history", "5");
    await planning.updateScale(owner, randomUUID(), teamId, 1, [
      { label: "Small", points: 1 },
      { label: "Large", points: 8 },
    ]);
    await planning.updateIssue(owner, randomUUID(), issue.id, {
      ...issueUpdateSchema.strip().parse(issue),
      title: "Same estimate",
    });
    expect((await planning.getIssue(owner, issue.id)).estimatePoints).toBe(5);
    await expect(
      planning.createIssue(
        owner,
        randomUUID(),
        issueInputSchema.parse({ teamId, title: "Old scale", estimate: "5" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_estimate" });
  });
});

describe("planning poker privacy and recovery", () => {
  it("hides other votes until an authorized reveal and survives service recreation", async () => {
    const issue = await createIssue();
    const { id } = await poker.create(
      owner,
      randomUUID(),
      issue.id,
      issue.revision,
    );
    await poker.vote(owner, randomUUID(), id, 1, "3");
    await poker.vote(member, randomUUID(), id, 1, "8");
    const recovered = new CloudPoker(database);
    const observer = await recovered.get(viewer, id);
    expect(observer.votes).toHaveLength(2);
    expect(observer.votes.every((vote) => vote.card === null)).toBe(true);
    expect(
      (await recovered.get(member, id)).votes.find(
        (vote) => vote.userId === member.userId,
      )?.card,
    ).toBe("8");
    await expect(recovered.get(stranger, id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      recovered.act(member, randomUUID(), id, { kind: "reveal", revision: 1 }),
    ).rejects.toMatchObject({ code: "facilitator_required" });
    await recovered.act(owner, randomUUID(), id, {
      kind: "reveal",
      revision: 1,
    });
    expect(
      (await recovered.get(viewer, id)).votes
        .map((vote) => vote.card)
        .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["3", "8"]);
    const events = await database.engine.query(
      "SELECT payload FROM cloud_outbox WHERE kind='poker.vote_cast'",
    );
    expect(events.rows).toEqual([
      { payload: { generation: 1 } },
      { payload: { generation: 1 } },
    ]);
  });

  it("keeps one effective vote per user and rejects prior-round writes", async () => {
    const issue = await createIssue();
    const { id } = await poker.create(
      owner,
      randomUUID(),
      issue.id,
      issue.revision,
    );
    await poker.vote(member, randomUUID(), id, 1, "3");
    await poker.vote(member, randomUUID(), id, 1, "5");
    expect((await poker.get(owner, id)).votes).toHaveLength(1);
    await poker.act(owner, randomUUID(), id, { kind: "restart", revision: 1 });
    expect((await poker.get(owner, id)).votes).toHaveLength(0);
    await expect(
      poker.vote(member, randomUUID(), id, 1, "8"),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await poker.vote(member, randomUUID(), id, 2, "8");
    expect((await poker.get(member, id)).votes[0]?.card).toBe("8");
  });

  it("writes an explicit decision once and rejects stale issue estimates", async () => {
    const issue = await createIssue();
    const { id } = await poker.create(
      owner,
      randomUUID(),
      issue.id,
      issue.revision,
    );
    await poker.vote(member, randomUUID(), id, 1, "8");
    await poker.act(owner, randomUUID(), id, { kind: "reveal", revision: 1 });
    const key = randomUUID();
    const decision = {
      kind: "decide",
      revision: 2,
      issueRevision: issue.revision,
      card: "5",
      rationale: "Agreed after discussion",
    } as const;
    await poker.act(owner, key, id, decision);
    await poker.act(owner, key, id, decision);
    expect((await planning.getIssue(owner, issue.id)).estimate).toBe("5");
    expect((await planning.getIssue(owner, issue.id)).revision).toBe(2);
    expect((await poker.get(owner, id)).status).toBe("decided");
    expect(await planning.history(owner, issue.id)).toHaveLength(2);
    const next = await poker.create(owner, randomUUID(), issue.id, 2);
    await planning.updateIssue(owner, randomUUID(), issue.id, {
      ...issueUpdateSchema
        .strip()
        .parse(await planning.getIssue(owner, issue.id)),
      description: "Changed requirements",
    });
    expect((await poker.get(owner, next.id)).stale).toBe(true);
    await expect(
      poker.vote(member, randomUUID(), next.id, 1, "3"),
    ).rejects.toMatchObject({ code: "round_stale" });
    await poker.act(owner, randomUUID(), next.id, {
      kind: "reveal",
      revision: 1,
    });
    await expect(
      poker.act(owner, randomUUID(), next.id, {
        ...decision,
        issueRevision: 3,
      }),
    ).rejects.toMatchObject({ code: "round_stale" });
    expect((await planning.getIssue(owner, issue.id)).estimate).toBe("5");
  });

  it("prevents a second active round and never reveals closed unrevealed votes", async () => {
    const issue = await createIssue();
    const { id } = await poker.create(
      owner,
      randomUUID(),
      issue.id,
      issue.revision,
    );
    await poker.vote(member, randomUUID(), id, 1, "13");
    await expect(
      poker.create(member, randomUUID(), issue.id, issue.revision),
    ).rejects.toMatchObject({ code: "round_active" });
    await poker.act(owner, randomUUID(), id, { kind: "close", revision: 1 });
    expect((await poker.get(owner, id)).votes[0]?.card).toBeNull();
    await expect(
      poker.vote(member, randomUUID(), id, 2, "8"),
    ).rejects.toMatchObject({ code: "voting_closed" });
  });
});

it("filters issue views by workflow category and the actor's assignments", async () => {
  const backlog = await createIssue("Collect feedback");
  const active = await createIssue("Ship reconnect");
  const status = (
    await database.engine.query<{ id: string; revision: number }>(
      "SELECT id,revision FROM cloud_workflow_statuses WHERE team_id=$1 AND category='active' ORDER BY position LIMIT 1",
      [teamId],
    )
  ).rows[0]!;
  await planning.updateIssue(
    owner,
    randomUUID(),
    active.id,
    issueUpdateSchema
      .strip()
      .parse({ ...active, status, assigneeId: member.userId }),
  );
  const ids = async (
    actor: CloudActor,
    filters: Parameters<CloudPlanning["listIssues"]>[1],
  ) => (await planning.listIssues(actor, filters)).map((issue) => issue.id);
  expect(await ids(owner, { states: ["backlog"] })).toEqual([backlog.id]);
  expect(
    await ids(owner, { states: ["ready", "active", "blocked", "review"] }),
  ).toEqual([active.id]);
  expect(await ids(member, { assignedToActor: true })).toEqual([active.id]);
  expect(await ids(owner, { assignedToActor: true })).toEqual([]);
});
