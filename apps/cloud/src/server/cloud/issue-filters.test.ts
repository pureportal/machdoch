import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cycleInputSchema,
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
  type IssueFilters,
} from "../../lib/cloud-contract";
import { initiativeInputSchema } from "../../lib/cloud-initiative-contract";
import { issueGroupSummary } from "../../lib/issue-group-summary";
import {
  encodeIssueFilter,
  issueFilterConditionSchema,
  issueFilterParameter,
  type IssueFilterCondition,
} from "../../lib/issue-filter-model";
import { issueFiltersFromParameters } from "../../lib/issue-scopes";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase, testStatusReference } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;
let privateTeamId: string;

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
  teamId = await createTeam("AlphaNET Cloud", "ANC", "organization");
  privateTeamId = await createTeam("Treasury", "TRS", "private");
});

async function createTeam(
  name: string,
  key: string,
  visibility: "organization" | "private",
) {
  return (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name,
      key,
      visibility,
      estimateScale: defaultEstimateScale,
    })
  ).id;
}

async function createIssue(
  title: string,
  extra: Record<string, unknown> = {},
  actor = owner,
) {
  return (
    await runtime.planning.createIssue(
      actor,
      randomUUID(),
      issueInputSchema.parse({ teamId, title, ...extra }),
    )
  ).id;
}

async function revisionOf(issueId: string) {
  const row = (
    await database.engine.query<{ revision: number }>(
      "SELECT revision FROM cloud_issues WHERE id=$1",
      [issueId],
    )
  ).rows[0];
  if (!row) throw new Error("Issue not found.");
  return row.revision;
}

async function delegate(issueId: string) {
  await database.engine.query(
    "UPDATE cloud_issues SET ai_assigned=true,ai_assigned_by=$2 WHERE id=$1",
    [issueId, owner.userId],
  );
}

async function createLabel(name: string, team = teamId) {
  return (
    await runtime.labels.create(owner, randomUUID(), team, {
      name,
      color: "blue",
    })
  ).id;
}

async function label(issueId: string, labelIds: string[]) {
  await runtime.labels.setIssue(owner, randomUUID(), issueId, {
    revision: await revisionOf(issueId),
    labelIds,
  });
}

async function block(blockerId: string, blockedId: string) {
  await runtime.relations.add(owner, randomUUID(), blockerId, {
    kind: "blocks",
    targetId: blockedId,
    sourceRevision: await revisionOf(blockerId),
    targetRevision: await revisionOf(blockedId),
  });
}

async function createCycle(
  name: string,
  startsOn: string,
  endsOn: string,
  status: "planned" | "active" | "closed",
  team = teamId,
) {
  const { id } = await runtime.planning.createCycle(
    owner,
    randomUUID(),
    cycleInputSchema.parse({
      teamId: team,
      name,
      startsOn,
      endsOn,
      timezone: "UTC",
      capacity: null,
    }),
  );
  if (status !== "planned")
    await database.engine.query(
      "UPDATE cloud_cycles SET status=$2,closing_snapshot=CASE WHEN $2='closed' THEN '[]'::jsonb END,closing_status_names=CASE WHEN $2='closed' THEN '{}'::jsonb END WHERE id=$1",
      [id, status],
    );
  return id;
}

async function ids(actor: CloudActor, filters: IssueFilters) {
  return (await runtime.planning.listIssueSummaries(actor, filters))
    .map((issue) => issue.id)
    .sort();
}

function condition(
  field: IssueFilterCondition["field"],
  values: string[],
  extra: Partial<IssueFilterCondition> = {},
): IssueFilterCondition {
  return issueFilterConditionSchema.parse({
    field,
    negated: false,
    values,
    ...extra,
  });
}

describe("Can Be Picked view", () => {
  it("returns exactly the issues that pass every condition", async () => {
    const polish = await createLabel("To Be Polished");
    const backend = await createLabel("Backend");
    const frontend = await createLabel("Frontend");
    const bug = await createLabel("Bug");
    const feature = await createLabel("Feature");
    const docs = await createLabel("Docs");
    await createCycle("Previous", "2029-12-01", "2029-12-15", "closed");
    const current = await createCycle(
      "Current",
      "2030-01-01",
      "2030-01-15",
      "active",
    );
    const upcoming = await createCycle(
      "Upcoming",
      "2030-01-15",
      "2030-01-29",
      "planned",
    );
    const later = await createCycle(
      "Later",
      "2030-02-01",
      "2030-02-15",
      "planned",
    );
    const backlog = await testStatusReference(
      database,
      owner,
      teamId,
      "backlog",
    );
    const ready = await testStatusReference(database, owner, teamId, "ready");
    const active = await testStatusReference(database, owner, teamId, "active");
    const complete = await testStatusReference(
      database,
      owner,
      teamId,
      "complete",
    );

    const pickable = async (
      title: string,
      labels: string[],
      extra: Record<string, unknown> = {},
    ) => {
      const id = await createIssue(title, {
        cycleId: current,
        estimate: "3",
        status: backlog,
        ...extra,
      });
      await label(id, labels);
      return id;
    };

    const expected = [
      await pickable("Current cycle", [backend]),
      await pickable("Upcoming cycle", [frontend, bug], {
        cycleId: upcoming,
        estimate: null,
        status: ready,
      }),
      await pickable("Blocked by finished work", [feature]),
    ];
    const finishedBlocker = await pickable("Finished blocker", [], {
      status: complete,
    });
    await block(finishedBlocker, expected[2]!);
    await pickable("Needs polish", [backend, polish]);
    await pickable("Large estimate", [backend], { estimate: "13" });
    await pickable("Other large estimate", [bug], { estimate: "21" });
    await pickable("Later cycle", [backend], { cycleId: later });
    await pickable("No cycle", [backend], { cycleId: null });
    const blocked = await pickable("Blocked", [backend]);
    const openBlocker = await pickable("Open blocker", [docs]);
    await block(openBlocker, blocked);
    await pickable("Unlabelled", []);
    await pickable("Assigned", [backend], { assigneeId: member.userId });
    await delegate(await pickable("Agent assigned", [backend]));
    await pickable("Started", [backend], { status: active });

    const view = {
      conditions: [
        condition("label", [polish], { negated: true }),
        condition("estimate", ["13", "21"], { negated: true }),
        condition("cycle", ["current", "upcoming"]),
        condition("blocked", ["yes"], { negated: true }),
        condition("label", [backend, frontend, bug, feature]),
        condition("assignee", ["none"]),
        condition("status", [backlog.id, ready.id]),
      ],
      groups: [],
    };
    const filters = issueFiltersFromParameters({
      [issueFilterParameter]: encodeIssueFilter(view),
    });
    expect(filters.conditions).toEqual(view.conditions);
    expect(await ids(member, filters)).toEqual([...expected].sort());
  });
});

describe("filter operators", () => {
  it("evaluates label all, empty, date, delegate, milestone, initiative and OR groups", async () => {
    const backend = await createLabel("Backend");
    const bug = await createLabel("Bug");
    const project = (
      await runtime.projects.create(owner, randomUUID(), {
        teamId,
        name: "Checkout",
        description: "",
      })
    ).id;
    const milestone = (
      await runtime.milestones.create(owner, randomUUID(), project, {
        name: "Beta",
        targetOn: null,
      })
    ).id;
    const initiative = (
      await runtime.initiatives.create(
        owner,
        randomUUID(),
        initiativeInputSchema.parse({
          name: "Growth",
          ownerId: owner.userId,
          projectIds: [project],
        }),
      )
    ).id;
    const both = await createIssue("Both labels", {
      dueOn: "2030-03-10",
      projectId: project,
      milestoneId: milestone,
    });
    await label(both, [backend, bug]);
    const one = await createIssue("One label", { dueOn: "2030-03-20" });
    await label(one, [backend]);
    const delegated = await createIssue("Delegated");
    await delegate(delegated);
    const plain = await createIssue("Plain", { priority: "urgent" });

    expect(
      await ids(member, {
        conditions: [condition("label", [backend, bug], { operator: "all" })],
      }),
    ).toEqual([both]);
    expect(
      await ids(member, { conditions: [condition("label", [backend, bug])] }),
    ).toEqual([both, one].sort());
    expect(
      await ids(member, {
        conditions: [condition("label", [], { operator: "empty" })],
      }),
    ).toEqual([delegated, plain].sort());
    expect(
      await ids(member, {
        conditions: [
          condition("label", [], { operator: "empty", negated: true }),
        ],
      }),
    ).toEqual([both, one].sort());
    expect(
      await ids(member, {
        conditions: [condition("due", ["2030-03-15"], { operator: "before" })],
      }),
    ).toEqual([both]);
    expect(
      await ids(member, {
        conditions: [condition("due", ["2030-03-15"], { operator: "after" })],
      }),
    ).toEqual([one]);
    expect(
      await ids(member, {
        conditions: [condition("created", ["7"], { operator: "within" })],
      }),
    ).toHaveLength(4);
    expect(
      await ids(member, {
        conditions: [condition("delegate", [owner.userId])],
      }),
    ).toEqual([delegated]);
    expect(
      await ids(member, { conditions: [condition("delegate", ["none"])] }),
    ).not.toContain(delegated);
    expect(
      await ids(member, { conditions: [condition("milestone", [milestone])] }),
    ).toEqual([both]);
    expect(
      await ids(member, {
        conditions: [condition("initiative", [initiative])],
      }),
    ).toEqual([both]);
    expect(
      await ids(member, {
        conditions: [condition("assignee", ["none"])],
        groups: [
          [condition("priority", ["urgent"]), condition("label", [bug])],
        ],
      }),
    ).toEqual([both, plain].sort());
  });
});

describe("private teams", () => {
  it("never leak through filters, counts or estimate sums", async () => {
    const visibleLabel = await createLabel("Backend");
    const hiddenLabel = await createLabel("Backend", privateTeamId);
    const visible = await createIssue("Visible", { estimate: "3" });
    await label(visible, [visibleLabel]);
    const unlabelled = await createIssue("Unlabelled", { estimate: "5" });
    const hidden = await createIssue("Hidden", {
      teamId: privateTeamId,
      estimate: "21",
    });
    await label(hidden, [hiddenLabel]);
    const hiddenUnlabelled = await createIssue("Hidden unlabelled", {
      teamId: privateTeamId,
      estimate: "13",
      priority: "urgent",
    });
    await block(hidden, unlabelled);
    await block(visible, hiddenUnlabelled);

    const memberFilters: IssueFilters[] = [
      {},
      { conditions: [condition("team", [privateTeamId])] },
      { conditions: [condition("team", [privateTeamId], { negated: true })] },
      { conditions: [condition("label", [hiddenLabel])] },
      { conditions: [condition("label", ["none"])] },
      { conditions: [condition("label", [], { operator: "empty" })] },
      { conditions: [condition("assignee", ["none"])] },
      { conditions: [condition("cycle", ["none"])] },
      { conditions: [condition("estimate", ["13", "21"])] },
      { conditions: [condition("priority", ["urgent"])] },
      {
        groups: [
          [condition("priority", ["urgent"]), condition("label", ["none"])],
        ],
      },
      { conditions: [condition("blocked", ["yes"])] },
      { conditions: [condition("blocking", ["yes"])] },
    ];
    const hiddenIds = new Set([hidden, hiddenUnlabelled]);
    for (const filters of memberFilters) {
      const issues = await runtime.planning.listIssueSummaries(member, filters);
      expect(issues.filter((issue) => hiddenIds.has(issue.id))).toEqual([]);
    }
    expect(
      await ids(member, { conditions: [condition("blocked", ["yes"])] }),
    ).toEqual([]);
    expect(
      await ids(member, { conditions: [condition("blocking", ["yes"])] }),
    ).toEqual([]);

    const memberIssues = await runtime.planning.listIssueSummaries(member, {});
    expect(issueGroupSummary(memberIssues)).toEqual({ count: 2, estimate: 8 });
    const ownerIssues = await runtime.planning.listIssueSummaries(owner, {});
    expect(issueGroupSummary(ownerIssues)).toEqual({ count: 4, estimate: 42 });
    expect(
      await ids(owner, { conditions: [condition("blocked", ["yes"])] }),
    ).toEqual([unlabelled, hiddenUnlabelled].sort());
  });
});
