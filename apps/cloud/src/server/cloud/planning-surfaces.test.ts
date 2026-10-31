import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
  type CloudRole,
} from "../../lib/cloud-contract";
import { issueChangesSchema } from "../../lib/cloud-issue-changes-contract";
import { CloudComments } from "./comments";
import { CloudCycles } from "./cycles";
import { cycleBurnup } from "./cycle-burnup";
import { CloudIssueChanges } from "./issue-changes";
import { CloudInbox } from "./notifications";
import { CloudPlanning } from "./planning";
import { CloudProjectMilestones } from "./project-milestones";
import { CloudProjects } from "./projects";
import { CloudSavedViews } from "./saved-views";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let planning: CloudPlanning;
let changes: CloudIssueChanges;
let inbox: CloudInbox;
let comments: CloudComments;
let views: CloudSavedViews;
let milestones: CloudProjectMilestones;
let projects: CloudProjects;
let cycles: CloudCycles;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let teamId: string;

async function addMember(
  organizationId: string,
  role: CloudRole,
  name: string,
): Promise<CloudActor> {
  const userId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'unused-test-hash')",
    [userId, `${userId}@example.test`, name],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
    [organizationId, userId, role],
  );
  return { organizationId, userId };
}

async function createIssue(title: string, extra: Record<string, unknown> = {}) {
  const { id } = await planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title, ...extra }),
  );
  return id;
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
  planning = new CloudPlanning(database);
  changes = new CloudIssueChanges(database);
  inbox = new CloudInbox(database);
  comments = new CloudComments(database);
  views = new CloudSavedViews(database);
  milestones = new CloudProjectMilestones(database);
  projects = new CloudProjects(database);
  cycles = new CloudCycles(database);
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
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'First')",
    [organizationId],
  );
  owner = await addMember(organizationId, "owner", "Olivia Owner");
  member = await addMember(organizationId, "member", "Max Member");
  viewer = await addMember(organizationId, "viewer", "Vera Viewer");
  teamId = (
    await planning.createTeam(owner, randomUUID(), {
      name: "Engineering",
      key: "ENG",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

describe("issue changes", () => {
  it("applies partial changes to many issues atomically and idempotently", async () => {
    const first = await createIssue("First");
    const second = await createIssue("Second");
    const key = randomUUID();
    const input = issueChangesSchema.parse({
      issues: [{ id: first }, { id: second }],
      changes: {
        priority: "urgent",
        statusCategory: "active",
        assigneeId: member.userId,
        estimate: "5",
      },
    });
    const result = await changes.apply(owner, key, input);
    expect(result.updated).toHaveLength(2);
    expect(await changes.apply(owner, key, input)).toEqual(result);
    const issue = await planning.getIssue(owner, first);
    expect(issue).toMatchObject({
      priority: "urgent",
      state: "active",
      assigneeId: member.userId,
      estimate: "5",
      estimatePoints: 5,
      revision: 2,
    });
    expect((await planning.history(owner, first)).length).toBe(2);
  });

  it("does not advance the revision for a no-op and leaves other fields untouched", async () => {
    const id = await createIssue("Stable", { description: "Keep me" });
    const before = await planning.getIssue(owner, id);
    await changes.apply(
      owner,
      randomUUID(),
      issueChangesSchema.parse({
        issues: [{ id }],
        changes: { priority: before.priority },
      }),
    );
    const after = await planning.getIssue(owner, id);
    expect(after.revision).toBe(before.revision);
    expect(after.description).toBe("Keep me");
  });

  it("detects stale text edits but accepts stale property edits", async () => {
    const id = await createIssue("Original");
    await changes.apply(
      owner,
      randomUUID(),
      issueChangesSchema.parse({
        issues: [{ id }],
        changes: { priority: "high" },
      }),
    );
    await expect(
      changes.apply(
        owner,
        randomUUID(),
        issueChangesSchema.parse({
          issues: [{ id, revision: 1 }],
          changes: { title: "Stale" },
        }),
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(() =>
      issueChangesSchema.parse({
        issues: [{ id }],
        changes: { title: "Missing revision" },
      }),
    ).toThrow();
  });

  it("rolls back the whole batch when one issue is invalid and rejects viewers", async () => {
    const valid = await createIssue("Valid");
    const invalid = randomUUID();
    await expect(
      changes.apply(
        owner,
        randomUUID(),
        issueChangesSchema.parse({
          issues: [{ id: valid }, { id: invalid }],
          changes: { priority: "low" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await planning.getIssue(owner, valid)).priority).toBe("none");
    await expect(
      changes.apply(
        viewer,
        randomUUID(),
        issueChangesSchema.parse({
          issues: [{ id: valid }],
          changes: { priority: "low" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("issue summaries", () => {
  it("excludes long text and applies the new filters", async () => {
    await createIssue("Assigned", {
      description: "long".repeat(100),
      assigneeId: member.userId,
      estimate: "3",
      priority: "high",
    });
    await createIssue("Open", { priority: "low" });
    const all = await planning.listIssueSummaries(owner, {});
    expect(all).toHaveLength(2);
    expect(all[0]).not.toHaveProperty("description");
    expect(all[0]!.labels).toEqual([]);
    expect(all[0]!.activeRun).toBeNull();
    const titles = async (filters: Parameters<typeof planning.listIssues>[1]) =>
      (await planning.listIssueSummaries(owner, filters)).map(
        (issue) => issue.title,
      );
    expect(await titles({ assigneeId: member.userId })).toEqual(["Assigned"]);
    expect(await titles({ unassigned: true })).toEqual(["Open"]);
    expect(await titles({ priority: "high" })).toEqual(["Assigned"]);
    expect(await titles({ unestimated: true })).toEqual(["Open"]);
    expect(await titles({ sort: "priority" })).toEqual(["Assigned", "Open"]);
  });
});

describe("inbox", () => {
  it("notifies assignees, participants and mentions, never the actor", async () => {
    const id = await createIssue("Shared", { assigneeId: member.userId });
    expect(await inbox.unread(owner)).toBe(0);
    expect(await inbox.unread(member)).toBe(1);
    const [assignment] = await inbox.list(member);
    expect(assignment).toMatchObject({ kind: "assigned", issueId: id });
    await comments.create(owner, randomUUID(), id, "Please look @vera viewer");
    const entries = await inbox.list(viewer);
    expect(entries[0]).toMatchObject({ kind: "mentioned" });
    expect((await inbox.list(member))[0]).toMatchObject({ kind: "commented" });
    expect(await inbox.unread(owner)).toBe(0);
    await inbox.update(member, { kind: "read-all" });
    expect(await inbox.unread(member)).toBe(0);
    await inbox.update(viewer, { kind: "dismiss", ids: [entries[0]!.id] });
    expect(await inbox.list(viewer)).toEqual([]);
  });

  it("does not treat a longer word as a mention", async () => {
    const id = await createIssue("Handles");
    await comments.create(owner, randomUUID(), id, "Ask @vera viewers first");
    expect(await inbox.list(viewer)).toEqual([]);
    await comments.create(owner, randomUUID(), id, "Ask @vera viewer, please");
    expect((await inbox.list(viewer))[0]).toMatchObject({ kind: "mentioned" });
  });

  it("does not expose notifications from teams the member cannot read", async () => {
    const privateTeam = (
      await planning.createTeam(owner, randomUUID(), {
        name: "Private",
        key: "PRI",
        visibility: "private",
        estimateScale: defaultEstimateScale,
      })
    ).id;
    const id = await createIssue("Visible", { assigneeId: member.userId });
    await database.engine.query(
      "UPDATE cloud_notifications SET team_id=$1 WHERE issue_id=$2",
      [privateTeam, id],
    );
    expect(await inbox.list(member)).toEqual([]);
    expect(await inbox.unread(member)).toBe(0);
  });
});

describe("saved views", () => {
  it("keeps personal views private and lets administrators remove shared ones", async () => {
    await views.create(member, randomUUID(), {
      name: "Mine",
      filters: { scope: "mine" },
      shared: false,
    });
    const shared = await views.create(member, randomUUID(), {
      name: "Team",
      filters: { priority: "urgent" },
      shared: true,
    });
    expect((await views.list(viewer)).map((view) => view.name)).toEqual([
      "Team",
    ]);
    await expect(
      views.create(viewer, randomUUID(), {
        name: "Nope",
        filters: {},
        shared: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(views.remove(viewer, shared.id)).rejects.toMatchObject({
      status: 403,
    });
    await views.remove(owner, shared.id);
    expect((await views.list(member)).map((view) => view.name)).toEqual([
      "Mine",
    ]);
  });
});

describe("project milestones", () => {
  it("tracks completion with revision checks", async () => {
    const project = await projects.create(owner, randomUUID(), {
      teamId,
      name: "Launch",
      description: "",
    });
    const { id } = await milestones.create(owner, randomUUID(), project.id, {
      name: "Beta",
      targetOn: "2026-12-01",
    });
    await milestones.update(owner, randomUUID(), id, {
      name: "Beta",
      targetOn: "2026-12-01",
      completed: true,
      revision: 1,
    });
    expect(await milestones.list(owner, project.id)).toMatchObject([
      { name: "Beta", completed: true, revision: 2, targetOn: "2026-12-01" },
    ]);
    await expect(
      milestones.update(owner, randomUUID(), id, {
        name: "Stale",
        targetOn: null,
        completed: false,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      milestones.create(viewer, randomUUID(), project.id, {
        name: "Nope",
        targetOn: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await milestones.remove(owner, id);
    expect(await milestones.list(owner)).toEqual([]);
  });
});

describe("cycle burn-up", () => {
  const cycle = {
    id: "cycle",
    teamId: "team",
    name: "Cycle",
    startsOn: "2026-10-01",
    endsOn: "2026-10-04",
    timezone: "Europe/Berlin",
    capacity: 10,
    revision: 1,
    status: "active" as const,
    closing_snapshot: null,
  };
  const change = (
    issueId: string,
    day: string,
    state: string,
    cycleId: string | null = "cycle",
    points: number | null = 3,
  ) => ({
    issueId,
    revision: 1,
    cycleId,
    state,
    points,
    archived: false,
    changedAt: new Date(`${day}T12:00:00Z`),
  });

  it("derives scope and completion per day and stops at today", () => {
    const points = cycleBurnup(
      cycle,
      [
        change("a", "2026-10-01", "ready"),
        change("b", "2026-10-02", "ready"),
        change("a", "2026-10-03", "complete"),
        change("b", "2026-10-03", "ready", null),
      ],
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(
      points.map(({ date, scope, completed }) => [date, scope, completed]),
    ).toEqual([
      ["2026-10-01", 3, 0],
      ["2026-10-02", 6, 0],
      ["2026-10-03", 3, 3],
    ]);
  });

  it("uses the immutable closing scope on the final day", () => {
    const points = cycleBurnup(
      {
        ...cycle,
        status: "closed",
        closing_snapshot: [
          { state: "complete", estimatePoints: 5 },
          { state: "ready", estimatePoints: 2 },
        ] as never,
      },
      [change("a", "2026-10-01", "ready", "cycle", 5)],
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(points.at(-1)).toMatchObject({
      date: "2026-10-04",
      scope: 7,
      completed: 5,
    });
  });

  it("reads real history through the service", async () => {
    const created = await planning.createCycle(owner, randomUUID(), {
      teamId,
      name: "Now",
      startsOn: "2020-01-01",
      endsOn: "2099-01-01",
      timezone: "UTC",
      capacity: null,
    });
    const id = await createIssue("In cycle", {
      cycleId: created.id,
      estimate: "8",
    });
    await changes.apply(
      owner,
      randomUUID(),
      issueChangesSchema.parse({
        issues: [{ id }],
        changes: { statusCategory: "complete" },
      }),
    );
    expect((await cycles.burnup(owner, created.id)).at(-1)).toMatchObject({
      scope: 8,
      completed: 8,
      scopeIssues: 1,
    });
  });
});
