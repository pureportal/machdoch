import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  AutomationAction,
  AutomationTrigger,
  CloudAutomation,
  CloudAutomationRun,
} from "../../../lib/cloud-automation-contract";
import type { IssueFilterCondition } from "../../../lib/issue-filter-model";
import { issueFilterSql } from "../planning-queries";
import { CloudError, teamVisibility } from "../access";
import type { CloudSql } from "../database";

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const automationColumns = `a.id,a.name,a.team_id AS "teamId",a.owner_id AS "ownerId",u.name AS "ownerName",a.trigger,a.conditions,a.actions,
  a.daily_limit AS "dailyLimit",a.enabled,a.revision,a.error,${timestamp("a.next_run_at")} AS "nextRunAt",
  (SELECT ${timestamp("max(r.created_at)")} FROM cloud_automation_runs r WHERE r.organization_id=a.organization_id AND r.automation_id=a.id) AS "lastRunAt",
  (SELECT count(*)::integer FROM cloud_automation_runs r WHERE r.organization_id=a.organization_id AND r.automation_id=a.id AND r.state<>'skipped' AND r.created_at>clock_timestamp()-interval '1 day') AS "runsToday",
  a.webhook_hash IS NOT NULL AS "webhookConfigured",${timestamp("a.created_at")} AS "createdAt"`;

export const automationFrom = `cloud_automations a JOIN cloud_users u ON u.id=a.owner_id
  JOIN cloud_teams t ON t.organization_id=a.organization_id AND t.id=a.team_id
  JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=$2`;

export const runColumns = `r.id,r.automation_id AS "automationId",a.name AS "automationName",r.trigger,r.state,r.issue_id AS "issueId",i.identifier AS "issueIdentifier",
  p.name AS "actorName",r.steps,r.chat_id AS "chatId",r.error,${timestamp("r.created_at")} AS "createdAt",${timestamp("r.finished_at")} AS "finishedAt"`;

export const runFrom = `cloud_automation_runs r JOIN cloud_automations a ON a.organization_id=r.organization_id AND a.id=r.automation_id
  JOIN cloud_teams t ON t.organization_id=a.organization_id AND t.id=a.team_id
  JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=$2
  LEFT JOIN cloud_issues i ON i.organization_id=r.organization_id AND i.id=r.issue_id
  LEFT JOIN cloud_users p ON p.id=r.actor_id`;

export async function readAutomation(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudAutomation> {
  const automation = (
    await sql.query<CloudAutomation & Record<string, unknown>>(
      `SELECT ${automationColumns} FROM ${automationFrom} WHERE a.organization_id=$1 AND a.id=$3 AND ${teamVisibility} FOR ${write ? "UPDATE" : "SHARE"} OF a`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!automation)
    throw new CloudError(404, "not_found", "Automation is unavailable.");
  return automation;
}

export interface StoredAutomation {
  id: string;
  name: string;
  teamId: string;
  ownerId: string;
  trigger: AutomationTrigger;
  conditions: IssueFilterCondition[];
  actions: AutomationAction[];
  dailyLimit: number;
  enabled: boolean;
}

export const storedAutomationColumns = `id,name,team_id AS "teamId",owner_id AS "ownerId",trigger,conditions,actions,daily_limit AS "dailyLimit",enabled`;

const activeOwner =
  "EXISTS (SELECT 1 FROM cloud_memberships om WHERE om.organization_id=$1 AND om.user_id=$2 AND om.active)";

export async function issueMatchesConditions(
  sql: CloudSql,
  owner: CloudActor,
  automation: Pick<StoredAutomation, "teamId" | "conditions">,
  issueId: string,
): Promise<boolean> {
  const filter = issueFilterSql(owner, {
    teamId: automation.teamId,
    conditions: automation.conditions,
  });
  const result = await sql.query(
    `SELECT 1 FROM cloud_issues i WHERE ${filter.where} AND ${activeOwner} AND i.id=$${filter.parameters.length + 1}`,
    [...filter.parameters, issueId],
  );
  return result.rows.length > 0;
}

export async function matchingIssueIds(
  sql: CloudSql,
  owner: CloudActor,
  automation: Pick<StoredAutomation, "teamId" | "conditions">,
  limit: number,
): Promise<string[]> {
  const filter = issueFilterSql(owner, {
    teamId: automation.teamId,
    conditions: automation.conditions,
  });
  return (
    await sql.query<{ id: string }>(
      `SELECT i.id FROM cloud_issues i WHERE ${filter.where} AND ${activeOwner} ORDER BY i.updated_at,i.id LIMIT ${limit}`,
      filter.parameters,
    )
  ).rows.map((row) => row.id);
}

export async function insertAutomationRun(
  sql: CloudSql,
  organizationId: string,
  automation: Pick<StoredAutomation, "id" | "dailyLimit">,
  run: {
    dedupeKey: string;
    trigger: string;
    issueId: string | null;
    actorId: string | null;
    depth: number;
    variables: Record<string, unknown>;
  },
): Promise<string | null> {
  const used = (
    await sql.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM cloud_automation_runs WHERE organization_id=$1 AND automation_id=$2 AND state<>'skipped' AND created_at>clock_timestamp()-interval '1 day'",
      [organizationId, automation.id],
    )
  ).rows[0]!.count;
  const limited = used >= automation.dailyLimit;
  const id = randomUUID();
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO cloud_automation_runs (organization_id,id,automation_id,dedupe_key,trigger,state,issue_id,actor_id,depth,variables,error,finished_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $6='skipped' THEN clock_timestamp() END) ON CONFLICT (organization_id,automation_id,dedupe_key) DO NOTHING RETURNING id`,
    [
      organizationId,
      id,
      automation.id,
      run.dedupeKey,
      run.trigger,
      limited ? "skipped" : "queued",
      run.issueId,
      run.actorId,
      run.depth,
      JSON.stringify(run.variables),
      limited ? "The daily run limit was reached." : null,
    ],
  );
  return inserted.rows.length && !limited ? id : null;
}

export async function readRuns(
  sql: CloudSql,
  actor: CloudActor,
  filters: { automationId?: string; issueId?: string },
): Promise<CloudAutomationRun[]> {
  return (
    await sql.query<CloudAutomationRun & Record<string, unknown>>(
      `SELECT ${runColumns} FROM ${runFrom} WHERE r.organization_id=$1 AND ${teamVisibility}
      AND ($3::uuid IS NULL OR r.automation_id=$3) AND ($4::uuid IS NULL OR r.issue_id=$4)
      ORDER BY r.created_at DESC,r.id LIMIT 50`,
      [
        actor.organizationId,
        actor.userId,
        filters.automationId ?? null,
        filters.issueId ?? null,
      ],
    )
  ).rows;
}
