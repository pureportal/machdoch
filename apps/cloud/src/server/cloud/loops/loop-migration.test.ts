import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { cloudMigrations } from "../database";

const target = "073-loops.sql";

async function migrate(database: PGlite, until: string | null): Promise<void> {
  await database.exec(
    await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
  );
  for (const migration of cloudMigrations) {
    if (migration === until) break;
    await database.exec(
      await readFile(
        new URL(`../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
}

async function rows(database: PGlite, query: string): Promise<unknown[]> {
  return (await database.query(query)).rows;
}

async function seed(database: PGlite, key: string) {
  const org = randomUUID(),
    user = randomUUID(),
    team = randomUUID();
  await database.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Loops')",
    [org],
  );
  await database.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,$2,'Owner','fixture')",
    [user, `${key.toLowerCase()}@example.test`],
  );
  await database.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [org, user],
  );
  await database.query(
    "INSERT INTO cloud_teams(organization_id,id,name,key,visibility,estimate_scale) VALUES($1,$2,'Team',$3,'organization','[]')",
    [org, team, key],
  );
  return { org, user, team };
}

it("migrates every automation and schedule into a loop without changing their behavior", async () => {
  const database = new PGlite();
  try {
    await migrate(database, target);
    const { org, user, team } = await seed(database, "LO");
    const webhook = randomUUID(),
      onIssue = randomUUID(),
      schedule = randomUUID();
    await database.query(
      `INSERT INTO cloud_automations(organization_id,id,team_id,owner_id,name,trigger_kind,trigger,actions,daily_limit,enabled,webhook_hash)
       VALUES($1,$2,$3,$4,'Webhook','webhook','{"kind":"webhook"}','[{"kind":"comment","body":"Hi"}]',20,true,'hash'),
             ($1,$5,$3,$4,'On issue','issue_created','{"kind":"issue_created"}','[{"kind":"set_priority","priority":2}]',50,false,NULL)`,
      [org, webhook, team, user, onIssue],
    );
    await database.query(
      "INSERT INTO cloud_automation_runs(organization_id,id,automation_id,dedupe_key,trigger,state) VALUES($1,$2,$3,'manual','manual','succeeded')",
      [org, randomUUID(), webhook],
    );
    await database.query(
      `INSERT INTO cloud_schedules(organization_id,id,team_id,owner_id,owner_epoch,user_epoch,team_epoch,name,enabled,action,recurrence,definition_key,missed,catch_up_limit,lookback_hours,next_at)
       VALUES($1,$2,$3,$4,1,1,1,'Weekly',true,'{"kind":"create-issue","issue":{}}','{}',$5,'skip',1,24,2000)`,
      [org, schedule, team, user, "a".repeat(64)],
    );
    const automations =
      "SELECT to_jsonb(a) AS row FROM cloud_automations a ORDER BY id";
    const schedules =
      "SELECT to_jsonb(s) AS row FROM cloud_schedules s ORDER BY id";
    const runs =
      "SELECT id,automation_id,state,dedupe_key FROM cloud_automation_runs ORDER BY id";
    const automationsBefore = await rows(database, automations);
    const schedulesBefore = await rows(database, schedules);
    const runsBefore = await rows(database, runs);

    await database.exec(
      await readFile(
        new URL(`../migrations/${target}`, import.meta.url),
        "utf8",
      ),
    );

    expect(await rows(database, automations)).toEqual(automationsBefore);
    expect(await rows(database, schedules)).toEqual(schedulesBefore);
    expect(await rows(database, runs)).toEqual(runsBefore);
    expect(
      await rows(
        database,
        "SELECT id,automation_id,schedule_id,missed,revision FROM cloud_loops ORDER BY id",
      ),
    ).toEqual(
      [
        {
          id: webhook,
          automation_id: webhook,
          schedule_id: null,
          missed: "latest",
          revision: 1,
        },
        {
          id: onIssue,
          automation_id: onIssue,
          schedule_id: null,
          missed: "latest",
          revision: 1,
        },
        {
          id: schedule,
          automation_id: null,
          schedule_id: schedule,
          missed: "skip",
          revision: 1,
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      await rows(
        database,
        `SELECT snapshot->'automation'->>'name' AS name,(snapshot->'automation'->>'enabled')::boolean AS enabled
         FROM cloud_loop_revisions WHERE revision=1 AND snapshot->'automation' <> 'null'::jsonb ORDER BY name`,
      ),
    ).toEqual([
      { name: "On issue", enabled: false },
      { name: "Webhook", enabled: true },
    ]);
    expect(
      await rows(
        database,
        "SELECT loop_id,source FROM cloud_loop_trusted_sources",
      ),
    ).toEqual([{ loop_id: webhook, source: "webhook" }]);
    expect(
      await rows(
        database,
        "SELECT source,enabled FROM cloud_loop_sources ORDER BY source",
      ),
    ).toEqual([
      { source: "email", enabled: false },
      { source: "github", enabled: true },
      { source: "gitlab", enabled: true },
      { source: "grafana", enabled: false },
      { source: "sentry", enabled: false },
      { source: "slack", enabled: false },
      { source: "teams", enabled: false },
      { source: "webhook", enabled: true },
    ]);
    expect(
      await rows(database, "SELECT loop_revision FROM cloud_automation_runs"),
    ).toEqual([{ loop_revision: 1 }]);
    const later = await seed(database, "LA");
    const laterWebhook = randomUUID();
    await database.query(
      `INSERT INTO cloud_automations(organization_id,id,team_id,owner_id,name,trigger_kind,trigger,actions,daily_limit)
       VALUES($1,$2,$3,$4,'Later','webhook','{"kind":"webhook"}','[]',10)`,
      [later.org, laterWebhook, later.team, later.user],
    );
    expect(
      await rows(
        database,
        `SELECT count(*)::integer AS sources,count(*) FILTER (WHERE enabled)::integer AS enabled,
           (SELECT count(*)::integer FROM cloud_loop_trusted_sources WHERE loop_id='${laterWebhook}') AS trusted
         FROM cloud_loop_sources WHERE organization_id='${later.org}'`,
      ),
    ).toEqual([{ sources: 8, enabled: 3, trusted: 1 }]);
  } finally {
    await database.close();
  }
}, 30_000);

it("records a revision for every loop edit and stamps runs with the revision they used", async () => {
  const database = new PGlite();
  try {
    await migrate(database, null);
    const { org, user, team } = await seed(database, "RE");
    const automation = randomUUID();
    await database.query(
      `INSERT INTO cloud_automations(organization_id,id,team_id,owner_id,name,trigger_kind,trigger,actions,daily_limit)
       VALUES($1,$2,$3,$4,'Loop','manual','{"kind":"manual"}','[]',10)`,
      [org, automation, team, user],
    );
    const insertRun = (dedupe: string) =>
      database.query(
        "INSERT INTO cloud_automation_runs(organization_id,id,automation_id,dedupe_key,trigger,state) VALUES($1,$2,$3,$4,'manual','queued')",
        [org, randomUUID(), automation, dedupe],
      );
    await insertRun("first");
    await database.query(
      "UPDATE cloud_automations SET name='Renamed',revision=revision+1 WHERE id=$1",
      [automation],
    );
    await insertRun("second");
    await database.query(
      "UPDATE cloud_loops SET description='Summarize',overlap='skip' WHERE id=$1",
      [automation],
    );
    await database.query(
      "UPDATE cloud_loops SET consecutive_failures=2 WHERE id=$1",
      [automation],
    );
    await insertRun("third");

    expect(
      await rows(
        database,
        "SELECT revision,snapshot->'automation'->>'name' AS name,snapshot->>'description' AS description,snapshot->'guardrails'->>'overlap' AS overlap FROM cloud_loop_revisions ORDER BY revision",
      ),
    ).toEqual([
      { revision: 1, name: "Loop", description: "", overlap: "allow" },
      { revision: 2, name: "Renamed", description: "", overlap: "allow" },
      {
        revision: 3,
        name: "Renamed",
        description: "Summarize",
        overlap: "skip",
      },
    ]);
    expect(
      await rows(
        database,
        "SELECT dedupe_key,loop_revision FROM cloud_automation_runs ORDER BY created_at",
      ),
    ).toEqual([
      { dedupe_key: "first", loop_revision: 1 },
      { dedupe_key: "second", loop_revision: 2 },
      { dedupe_key: "third", loop_revision: 3 },
    ]);
  } finally {
    await database.close();
  }
}, 30_000);
