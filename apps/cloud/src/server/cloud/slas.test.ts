import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { issueFilterConditionSchema } from "../../lib/issue-filter-model";
import { slaPolicyInputSchema, type SlaState } from "../../lib/issue-sla";
import { cloudMigrations } from "./database";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase, testStatusReference } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
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
  runtime = createCloudRuntime(database, "https://cloud.example.test");
  teamId = await createTeam("Team", "TM", "organization");
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
  team = teamId,
) {
  return (
    await runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({ teamId: team, title, ...extra }),
    )
  ).id;
}

async function createPolicy(
  input: Partial<{
    teamId: string;
    priority: string | null;
    labelId: string | null;
    hours: number;
  }>,
  actor = owner,
) {
  return (
    await runtime.slas.service.create(
      actor,
      randomUUID(),
      slaPolicyInputSchema.parse({
        teamId,
        priority: null,
        labelId: null,
        hours: 24,
        ...input,
      }),
    )
  ).policy;
}

async function age(issueId: string, hours: number) {
  await database.engine.query(
    "UPDATE cloud_issues SET created_at=clock_timestamp()-$2*interval '1 hour' WHERE id=$1",
    [issueId, hours],
  );
}

async function withSla(state: SlaState, actor = owner) {
  return (
    await runtime.planning.listIssueSummaries(actor, {
      conditions: [
        issueFilterConditionSchema.parse({
          field: "sla",
          negated: false,
          values: [state],
        }),
      ],
    })
  )
    .map((issue) => issue.title)
    .sort();
}

function completeStatus() {
  return testStatusReference(database, owner, teamId, "complete");
}

async function inboxKinds(actor: CloudActor) {
  return (await runtime.inbox.list(actor)).map((entry) => entry.kind);
}

describe("SLA policies", () => {
  it("lets only settings managers create, update and remove policies", async () => {
    await expect(
      createPolicy({ priority: "urgent" }, member),
    ).rejects.toThrow();
    await expect(
      createPolicy({ priority: "urgent" }, viewer),
    ).rejects.toThrow();
    const policy = await createPolicy({ priority: "urgent", hours: 4 });
    expect(await runtime.slas.service.list(viewer)).toEqual([
      {
        id: policy.id,
        teamId,
        priority: "urgent",
        labelId: null,
        labelName: null,
        hours: 4,
      },
    ]);
    await expect(
      runtime.slas.service.update(member, policy.id, 8),
    ).rejects.toThrow();
    expect((await runtime.slas.service.update(owner, policy.id, 8)).hours).toBe(
      8,
    );
    await expect(
      createPolicy({ priority: "urgent", hours: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runtime.slas.service.remove(viewer, policy.id),
    ).rejects.toThrow();
    await runtime.slas.service.remove(owner, policy.id);
    expect(await runtime.slas.service.list(owner)).toEqual([]);
  });

  it("requires a priority or a label and a label from the same team", async () => {
    expect(
      slaPolicyInputSchema.safeParse({
        teamId,
        priority: null,
        labelId: null,
        hours: 4,
      }).success,
    ).toBe(false);
    const otherTeam = await createTeam("Other", "OT", "organization");
    const otherLabel = await runtime.labels.create(
      owner,
      randomUUID(),
      otherTeam,
      { name: "Bug", color: "red" },
    );
    await expect(
      createPolicy({ labelId: otherLabel.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("hides policies of private teams from non-members", async () => {
    const privateTeam = await createTeam("Private", "PV", "private");
    await createPolicy({ teamId: privateTeam, priority: "high" });
    expect(await runtime.slas.service.list(owner)).toHaveLength(1);
    expect(await runtime.slas.service.list(member)).toEqual([]);
  });
});

describe("SLA due dates", () => {
  it("uses the shortest matching policy by priority or label", async () => {
    const bug = await runtime.labels.create(owner, randomUUID(), teamId, {
      name: "Bug",
      color: "red",
    });
    await createPolicy({ priority: "high", hours: 48 });
    await createPolicy({ labelId: bug.id, hours: 8 });
    const high = await createIssue("High", { priority: "high" });
    const highBug = await createIssue("High bug", { priority: "high" });
    await runtime.labels.setIssue(owner, randomUUID(), highBug, {
      revision: 1,
      labelIds: [bug.id],
    });
    const low = await createIssue("Low", { priority: "low" });
    const window = async (id: string) => {
      const issue = (await runtime.planning.listIssueSummaries(owner, {})).find(
        (summary) => summary.id === id,
      )!;
      return issue.slaDueAt === null
        ? null
        : Date.parse(issue.slaDueAt) - Date.parse(issue.createdAt);
    };
    expect(await window(high)).toBe(48 * 3_600_000);
    expect(await window(highBug)).toBe(8 * 3_600_000);
    expect(await window(low)).toBeNull();
  });

  it("filters issues by SLA state and stops the clock on completion", async () => {
    await createPolicy({ priority: "urgent", hours: 48 });
    const breached = await createIssue("Breached", { priority: "urgent" });
    const atRisk = await createIssue("At risk", { priority: "urgent" });
    await createIssue("On track", { priority: "urgent" });
    await createIssue("Without SLA", { priority: "low" });
    const done = await createIssue("Done", {
      priority: "urgent",
      status: await completeStatus(),
    });
    await age(breached, 49);
    await age(atRisk, 30);
    await age(done, 49);
    await database.engine.query(
      "UPDATE cloud_issues SET state='complete' WHERE id=$1",
      [done],
    );
    expect(await withSla("breached")).toEqual(["Breached"]);
    expect(await withSla("at_risk")).toEqual(["At risk"]);
    expect(await withSla("ok")).toEqual(["On track"]);
    expect(await withSla("none")).toEqual(["Done", "Without SLA"]);
  });
});

describe("SLA breaches", () => {
  it("notifies subscribers once per due date and skips private audiences", async () => {
    await createPolicy({ priority: "urgent", hours: 4 });
    const issue = await createIssue("Late", { priority: "urgent" });
    await createIssue("Fresh", { priority: "urgent" });
    const privateTeam = await createTeam("Private", "PV", "private");
    await createPolicy({ teamId: privateTeam, priority: "urgent", hours: 4 });
    const hidden = await createIssue(
      "Hidden",
      { priority: "urgent" },
      privateTeam,
    );
    await age(issue, 5);
    await age(hidden, 5);
    expect(await runtime.slas.service.sweep()).toBe(2);
    expect(await inboxKinds(owner)).toEqual(["sla_breached", "sla_breached"]);
    expect(await inboxKinds(member)).toEqual([]);
    expect(await runtime.slas.service.sweep()).toBe(0);
    expect(await inboxKinds(owner)).toHaveLength(2);
    const entry = (await runtime.inbox.list(owner)).find(
      (notification) => notification.issueId === issue,
    )!;
    expect(entry).toMatchObject({ actor: null, issueTitle: "Late" });
  });

  it("does not breach completed or archived issues", async () => {
    await createPolicy({ priority: "urgent", hours: 4 });
    const complete = await createIssue("Complete", {
      priority: "urgent",
      status: await completeStatus(),
    });
    const archived = await createIssue("Archived", { priority: "urgent" });
    await age(complete, 5);
    await age(archived, 5);
    await database.engine.query(
      "UPDATE cloud_issues SET state='complete' WHERE id=$1",
      [complete],
    );
    await database.engine.query(
      "UPDATE cloud_issues SET archived=true WHERE id=$1",
      [archived],
    );
    expect(await runtime.slas.service.sweep()).toBe(0);
  });
});

it("migrates SLA policies and the breach notification kind", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("075-issue-slas.sql");
    for (const name of cloudMigrations.slice(0, index))
      await engine.exec(
        await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const organizationId = randomUUID();
    const existingTeamId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_teams (organization_id,id,name,key,visibility,estimate_scale) VALUES ($1,$2,'Team','TM','organization',$3)",
      [organizationId, existingTeamId, JSON.stringify(defaultEstimateScale)],
    );
    for (const name of cloudMigrations.slice(index))
      await engine.exec(
        await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const insert = (priority: string | null, hours: number) =>
      engine.query(
        "INSERT INTO cloud_sla_policies (organization_id,id,team_id,priority,hours) VALUES ($1,$2,$3,$4,$5)",
        [organizationId, randomUUID(), existingTeamId, priority, hours],
      );
    await insert("urgent", 4);
    await expect(insert("urgent", 8)).rejects.toThrow();
    await expect(insert(null, 8)).rejects.toThrow();
    await expect(insert("high", 0)).rejects.toThrow();
    expect(
      (
        await engine.query<{ definition: string }>(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='cloud_notifications_kind_check'",
        )
      ).rows[0]!.definition,
    ).toContain("sla_breached");
  } finally {
    await engine.close();
  }
}, 120_000);
