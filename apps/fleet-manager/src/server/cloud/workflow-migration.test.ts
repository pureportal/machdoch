import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { cloudMigrations, type CloudSql } from "./database";
import { createCloudRuntime } from "./runtime";

it("preserves historical issue, cycle and schedule snapshots while mapping current records to team statuses", async () => {
  const engine = new PGlite();
  const database = {
    transaction: <T>(operation: (sql: CloudSql) => Promise<T>) =>
      engine.transaction(operation),
    close: () => engine.close(),
  };
  try {
    await engine.exec(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    for (const migration of cloudMigrations) {
      if (migration === "024-team-workflows.sql") break;
      await engine.exec(
        await readFile(
          new URL(`./migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const actor = { organizationId: randomUUID(), userId: randomUUID() };
    const teamId = randomUUID(),
      issueId = randomUUID(),
      cycleId = randomUUID(),
      scheduleId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations(id,name) VALUES($1,'Migration')",
      [actor.organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'workflow@example.test','Owner','fixture')",
      [actor.userId],
    );
    await engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [actor.organizationId, actor.userId],
    );
    await engine.query(
      "INSERT INTO cloud_teams(organization_id,id,name,key,visibility,estimate_scale) VALUES($1,$2,'Team','WF','organization','[]')",
      [actor.organizationId, teamId],
    );
    await engine.query(
      "INSERT INTO cloud_cycles(organization_id,id,team_id,name,starts_on,ends_on,timezone,capacity,status) VALUES($1,$2,$3,'Closed','2026-10-01','2026-11-01','UTC',10,'closed')",
      [actor.organizationId, cycleId, teamId],
    );
    await engine.query(
      "INSERT INTO cloud_issues(organization_id,id,team_id,identifier,title,description,acceptance_criteria,state,priority,cycle_id,estimate,estimate_points) VALUES($1,$2,$3,'WF-1','Existing issue','Original description','Original criteria','complete','normal',$4,'3',3)",
      [actor.organizationId, issueId, teamId, cycleId],
    );
    const snapshot = {
      id: issueId,
      teamId,
      identifier: "WF-1",
      title: "Existing issue",
      description: "Original description",
      acceptanceCriteria: "Original criteria",
      state: "complete",
      priority: "normal",
      projectId: null,
      cycleId,
      assigneeId: null,
      estimate: "3",
      estimatePoints: 3,
      dueOn: null,
      archived: false,
      revision: 1,
      updatedAt: "2026-10-24T10:00:00.000Z",
    };
    await engine.query(
      "INSERT INTO cloud_issue_history(organization_id,issue_id,revision,actor_id,snapshot) VALUES($1,$2,1,$3,$4)",
      [actor.organizationId, issueId, actor.userId, JSON.stringify(snapshot)],
    );
    await engine.query(
      "UPDATE cloud_cycles SET closing_snapshot=$2 WHERE id=$1",
      [cycleId, JSON.stringify([snapshot])],
    );
    await engine.query(
      "INSERT INTO cloud_cycle_commitments(organization_id,cycle_id,issue_id,snapshot) VALUES($1,$2,$3,$4)",
      [actor.organizationId, cycleId, issueId, JSON.stringify(snapshot)],
    );
    const action = {
      kind: "create-issue",
      issue: {
        teamId,
        title: "Recurring",
        description: "",
        acceptanceCriteria: "",
        state: "active",
        priority: "normal",
        projectId: null,
        assigneeId: null,
        estimate: null,
      },
    };
    const published = { id: scheduleId, revision: 1, action };
    await engine.query(
      "INSERT INTO cloud_schedules(organization_id,id,team_id,owner_id,owner_epoch,user_epoch,team_epoch,name,action,recurrence,definition_key,missed,catch_up_limit,lookback_hours) VALUES($1,$2,$3,$4,1,1,1,'Existing schedule',$5,'{}',$6,'skip',1,1)",
      [
        actor.organizationId,
        scheduleId,
        teamId,
        actor.userId,
        JSON.stringify(action),
        "a".repeat(64),
      ],
    );
    await engine.query(
      "INSERT INTO cloud_schedule_revisions(organization_id,schedule_id,revision,actor_id,snapshot) VALUES($1,$2,1,$3,$4)",
      [
        actor.organizationId,
        scheduleId,
        actor.userId,
        JSON.stringify(published),
      ],
    );
    await engine.exec(
      await readFile(
        new URL("./migrations/024-team-workflows.sql", import.meta.url),
        "utf8",
      ),
    );
    const runtime = createCloudRuntime(database, "https://cloud.example.test");
    const issue = await runtime.planning.getIssue(actor, issueId);
    expect(issue).toMatchObject({
      state: "complete",
      statusName: "Done",
      revision: 1,
    });
    const workflow = await runtime.workflows.get(actor, teamId);
    const active = workflow.statuses.find(
      (status) => status.category === "active",
    )!;
    const schedule = await runtime.schedules.get(actor, scheduleId);
    expect(schedule.action).toEqual({
      ...action,
      issue: {
        ...action.issue,
        state: undefined,
        status: { id: active.id, revision: 1 },
      },
    });
    expect(schedule.action).not.toHaveProperty("issue.state");
    expect(
      (
        await engine.query<{ snapshot: unknown }>(
          "SELECT snapshot FROM cloud_schedule_revisions WHERE schedule_id=$1",
          [scheduleId],
        )
      ).rows[0]!.snapshot,
    ).toEqual(published);
    const closed = await runtime.cycles.get(actor, cycleId);
    expect(closed.totals).toMatchObject({
      issues: 1,
      completed: 1,
      completedPoints: 3,
    });
    expect(closed.issues).toEqual([snapshot]);
    expect(closed.commitment).toEqual([snapshot]);
    const definition = {
      revision: workflow.revision,
      defaultStatusId: workflow.defaultStatusId,
      statuses: workflow.statuses.map(({ revision: _, ...status }) => ({
        ...status,
        category:
          status.category === "complete" ? ("ready" as const) : status.category,
      })),
    };
    await runtime.workflows.update(actor, randomUUID(), teamId, {
      definition,
      impactDigest: (await runtime.workflows.preview(actor, teamId, definition))
        .digest,
    });
    expect((await runtime.planning.getIssue(actor, issueId)).state).toBe(
      "ready",
    );
    expect(await runtime.cycles.get(actor, cycleId)).toEqual(closed);
    expect(
      (await runtime.planning.history(actor, issueId)).find(
        (entry) => entry.revision === 1,
      )!.snapshot,
    ).toEqual(snapshot);
  } finally {
    await database.close();
  }
}, 30000);
