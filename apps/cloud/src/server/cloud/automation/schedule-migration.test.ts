import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { cloudMigrations } from "../database";
import type { CloudSql } from "../database";
import { createScheduleFixture, scheduledTaskInput } from "./test-fixture";
import { runManifestSchema } from "@machdoch/fleet-protocol/cloud-execution";

it("upgrades existing issue schedules without rewriting published snapshots or occurrence receipts", async () => {
  const database = new PGlite();
  try {
    await database.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    for (const migration of cloudMigrations) {
      if (migration === "021-task-schedules.sql") break;
      await database.exec(
        await readFile(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const org = randomUUID(),
      user = randomUUID(),
      team = randomUUID(),
      schedule = randomUUID();
    await database.query(
      "INSERT INTO cloud_organizations(id,name) VALUES($1,'Migration')",
      [org],
    );
    await database.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'migration@example.test','Owner','fixture')",
      [user],
    );
    await database.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [org, user],
    );
    await database.query(
      "INSERT INTO cloud_teams(organization_id,id,name,key,visibility,estimate_scale) VALUES($1,$2,'Team','MI','organization','[]')",
      [org, team],
    );
    const issue = { teamId: team, title: "Keep the recurring issue" };
    await database.query(
      "INSERT INTO cloud_issue_schedules(organization_id,id,team_id,owner_id,owner_epoch,user_epoch,team_epoch,name,enabled,issue,recurrence,definition_key,missed,catch_up_limit,lookback_hours,next_at) VALUES($1,$2,$3,$4,1,1,1,'Existing',true,$5,'{}',$6,'latest',1,24,2000)",
      [org, schedule, team, user, JSON.stringify(issue), "a".repeat(64)],
    );
    const snapshot = {
      id: schedule,
      teamId: team,
      issue,
      enabled: true,
      revision: 1,
    };
    await database.query(
      "INSERT INTO cloud_schedule_revisions(organization_id,schedule_id,revision,actor_id,snapshot) VALUES($1,$2,1,$3,$4)",
      [org, schedule, user, JSON.stringify(snapshot)],
    );
    await database.query(
      "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome) VALUES($1,$2,1,1000,1500,'skipped')",
      [org, schedule],
    );
    await database.exec(
      await readFile(
        new URL("../migrations/021-task-schedules.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (
        await database.query(
          "SELECT action,enabled,admitted_runs,allocated_tokens FROM cloud_schedules WHERE id=$1",
          [schedule],
        )
      ).rows[0],
    ).toMatchObject({
      action: { kind: "create-issue", issue },
      enabled: true,
      admitted_runs: 0,
      allocated_tokens: 0,
    });
    expect(
      (
        await database.query(
          "SELECT snapshot FROM cloud_schedule_revisions WHERE schedule_id=$1",
          [schedule],
        )
      ).rows[0],
    ).toEqual({ snapshot });
    expect(
      (
        await database.query(
          "SELECT nominal_at,accounted_through,outcome,run_id FROM cloud_schedule_occurrences WHERE schedule_id=$1",
          [schedule],
        )
      ).rows[0],
    ).toMatchObject({
      nominal_at: 1000,
      accounted_through: 1500,
      outcome: "skipped",
      run_id: null,
    });
  } finally {
    await database.close();
  }
}, 30000);

it("carries existing task allocations into the usage ledger and settles them without rewriting the grant", async () => {
  const engine = new PGlite();
  const database = {
    engine,
    transaction: <T>(operation: (sql: CloudSql) => Promise<T>) =>
      engine.transaction(operation),
    close: () => engine.close(),
  };
  try {
    await engine.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    for (const migration of cloudMigrations) {
      if (migration === "022-schedule-lifecycle.sql") break;
      await engine.exec(
        await readFile(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    // The fixture creates its project with current code, which writes these columns.
    const projectPlanning = "029-project-planning.sql";
    await engine.exec(
      await readFile(
        new URL(`../migrations/${projectPlanning}`, import.meta.url),
        "utf8",
      ),
    );
    const fixture = await createScheduleFixture(database);
    const { runtime, actor, teamId } = fixture;
    const data = scheduledTaskInput(fixture);
    const action = data.action;
    if (action.kind !== "run-task") throw new Error("Fixture action");
    const definition = await runtime.recurrence.preview(actor, {
      recurrence: data.recurrence,
      count: 1,
    });
    const id = randomUUID();
    const epochs = (
      await engine.query<{
        membershipEpoch: string;
        userEpoch: string;
        teamEpoch: string;
      }>(
        `SELECT m.authentication_epoch::text AS "membershipEpoch",u.authentication_epoch::text AS "userEpoch",t.access_epoch::text AS "teamEpoch" FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id JOIN cloud_teams t ON t.organization_id=m.organization_id WHERE m.organization_id=$1 AND m.user_id=$2 AND t.id=$3`,
        [actor.organizationId, actor.userId, teamId],
      )
    ).rows[0]!;
    await engine.query(
      "INSERT INTO cloud_schedules(organization_id,id,team_id,owner_id,owner_epoch,user_epoch,team_epoch,name,revision,enabled,action,recurrence,definition_key,missed,catch_up_limit,lookback_hours,next_at,admitted_runs,allocated_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,'Existing task schedule',2,true,$8,$9,$10,'latest',1,24,$11,1,10000)",
      [
        actor.organizationId,
        id,
        teamId,
        actor.userId,
        epochs.membershipEpoch,
        epochs.userEpoch,
        epochs.teamEpoch,
        JSON.stringify(data.action),
        JSON.stringify(data.recurrence),
        definition.definition.key,
        definition.occurrences[0]!.at,
      ],
    );
    const snapshot = {
      id,
      revision: 2,
      enabled: true,
      action: data.action,
      allocatedTokens: 0,
      admittedRuns: 0,
    };
    await engine.query(
      "INSERT INTO cloud_schedule_revisions(organization_id,schedule_id,revision,actor_id,snapshot) VALUES($1,$2,2,$3,$4)",
      [actor.organizationId, id, actor.userId, JSON.stringify(snapshot)],
    );
    const profile = (await runtime.execution.profiles.list(actor))[0]!;
    const manifest = runManifestSchema.parse({
      automation: {
        scheduleId: id,
        revision: 2,
        expiresAt: action.expiresAt,
        ...epochs,
      },
      contextLimitBytes: 1024,
      subject: action.run.subject,
      title: "Existing task",
      objective: "Verify the migration",
      acceptanceCriteria: "Existing receipts and snapshots survive",
      profile,
      provider: {
        id: fixture.providerId,
        name: "Provider",
        provider: "openai",
        inferenceRevision: 1,
        maxOutputTokens: 512,
      },
      actorId: actor.userId,
    });
    const run = { id: randomUUID() };
    const serialized = JSON.stringify(manifest);
    const original = createHash("sha256").update(serialized).digest("hex");
    await engine.query(
      `INSERT INTO cloud_runs(organization_id,id,team_id,project_id,profile_id,actor_id,title,manifest,input_digest,deadline_at)
       VALUES($1,$2,$3,$4,$5,$6,'Existing task',$7,$8,clock_timestamp()+interval '1 hour')`,
      [
        actor.organizationId,
        run.id,
        teamId,
        fixture.projectId,
        fixture.profileId,
        actor.userId,
        serialized,
        original,
      ],
    );
    const issue = { id: randomUUID() };
    await engine.query(
      "INSERT INTO cloud_issues(organization_id,id,team_id,project_id,identifier,title,description,acceptance_criteria,state,priority) VALUES($1,$2,$3,$4,'AU-1','Existing issue','','Preserve context','backlog','none')",
      [actor.organizationId, issue.id, teamId, fixture.projectId],
    );
    const issueRunId = randomUUID();
    const issueManifest = {
      ...manifest,
      subject: { kind: "issue", id: issue.id, revision: 1 },
    };
    const issueSerialized = JSON.stringify(issueManifest);
    const issueDigest = createHash("sha256")
      .update(issueSerialized)
      .digest("hex");
    await engine.query(
      `INSERT INTO cloud_runs(organization_id,id,team_id,project_id,profile_id,issue_id,actor_id,title,manifest,input_digest,deadline_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'Existing issue task',$8,$9,clock_timestamp()+interval '1 hour')`,
      [
        actor.organizationId,
        issueRunId,
        teamId,
        fixture.projectId,
        fixture.profileId,
        issue.id,
        actor.userId,
        issueSerialized,
        issueDigest,
      ],
    );
    await engine.query(
      "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome,run_id) VALUES($1,$2,2,1000,1000,'admitted',$3)",
      [actor.organizationId, id, run.id],
    );
    for (const migration of cloudMigrations.slice(
      cloudMigrations.indexOf("022-schedule-lifecycle.sql"),
    )) {
      if (migration === projectPlanning) continue;
      await engine.exec(
        await readFile(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const migratedIssueRun = await runtime.execution.runs.get(
      actor,
      issueRunId,
    );
    expect(migratedIssueRun).toMatchObject({
      inputDigest: issueDigest,
      manifest: issueManifest,
      contextChanged: false,
    });
    expect(migratedIssueRun).not.toHaveProperty("planningDigest");
    expect((await runtime.planning.getIssue(actor, issue.id)).revision).toBe(1);
    expect(await runtime.schedules.get(actor, id)).toMatchObject({
      admittedRuns: 1,
      usedTokens: 0,
      reservedTokens: 10000,
    });
    await runtime.execution.runs.cancel(actor, randomUUID(), run.id, 1);
    expect(await runtime.schedules.get(actor, id)).toMatchObject({
      admittedRuns: 1,
      usedTokens: 0,
      reservedTokens: 0,
    });
    expect((await runtime.execution.runs.get(actor, run.id)).inputDigest).toBe(
      original,
    );
    expect(
      (
        await engine.query(
          "SELECT snapshot FROM cloud_schedule_revisions WHERE schedule_id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ snapshot });
  } finally {
    await database.close();
  }
}, 30000);
