import type { CloudActor } from "../../../lib/cloud-contract";
import type { CloudSchedule } from "../../../lib/cloud-schedule-contract";
import type { CloudSql } from "../database";
import { CloudError, requireTeam, recordEvent } from "../access";
import { lockExecution, expireRuns } from "../execution/records";
import { refreshScheduleUsage } from "./schedule-budget";

export const scheduleColumns = `s.id,s.name,s.team_id AS "teamId",s.owner_id AS "ownerId",u.name AS "ownerName",s.revision,s.enabled,
  s.action,s.provider_revision AS "providerRevision",s.admitted_runs AS "admittedRuns",s.used_tokens::float8 AS "usedTokens",s.reserved_tokens::float8 AS "reservedTokens",s.archived,s.waiting_run_id AS "waitingRunId",s.recurrence,s.definition_key AS "definitionKey",s.missed,s.catch_up_limit AS "catchUpLimit",s.lookback_hours AS "lookbackHours",
  s.next_at::float8 AS "nextAt",s.error,to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

export async function readSchedule(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudSchedule> {
  await lockExecution(sql, actor.organizationId);
  await expireRuns(sql, actor.organizationId);
  const identity = (
    await sql.query<{ team_id: string }>(
      "SELECT team_id FROM cloud_schedules WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!identity)
    throw new CloudError(404, "not_found", "Schedule is unavailable.");
  await requireTeam(sql, actor, identity.team_id, write);
  await refreshScheduleUsage(sql, actor.organizationId, [id]);
  const result = await sql.query<CloudSchedule & Record<string, unknown>>(
    `SELECT ${scheduleColumns} FROM cloud_schedules s JOIN cloud_users u ON u.id=s.owner_id WHERE s.organization_id=$1 AND s.id=$2 FOR ${write ? "UPDATE" : "SHARE"} OF s`,
    [actor.organizationId, id],
  );
  return result.rows[0]!;
}

export async function recordSchedule(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<void> {
  const schedule = (
    await sql.query<CloudSchedule & Record<string, unknown>>(
      `SELECT ${scheduleColumns} FROM cloud_schedules s JOIN cloud_users u ON u.id=s.owner_id WHERE s.organization_id=$1 AND s.id=$2`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  await sql.query(
    "INSERT INTO cloud_schedule_revisions(organization_id,schedule_id,revision,actor_id,snapshot) VALUES($1,$2,$3,$4,$5)",
    [
      actor.organizationId,
      id,
      schedule.revision,
      actor.userId,
      JSON.stringify(schedule),
    ],
  );
  await recordEvent(sql, actor, "schedule.changed", id, schedule.revision, {
    enabled: schedule.enabled,
  });
}

export async function membershipEpoch(
  sql: CloudSql,
  actor: CloudActor,
): Promise<string> {
  return (
    await sql.query<{ epoch: string }>(
      "SELECT authentication_epoch::text AS epoch FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
      [actor.organizationId, actor.userId],
    )
  ).rows[0]!.epoch;
}

export async function scheduleWorkerAvailable(sql: CloudSql): Promise<boolean> {
  return (
    (
      await sql.query(
        "SELECT id FROM cloud_schedule_worker WHERE touched_at > clock_timestamp()-interval '30 seconds'",
      )
    ).rows.length > 0
  );
}

export async function requireScheduleAuthority(
  sql: CloudSql,
  actor: CloudActor,
  schedule: CloudSchedule,
): Promise<void> {
  const epoch = (
    await sql.query<{ epoch: string }>(
      "SELECT owner_epoch::text AS epoch FROM cloud_schedules WHERE id=$1",
      [schedule.id],
    )
  ).rows[0]!.epoch;
  if (epoch !== (await membershipEpoch(sql, actor)))
    throw new CloudError(
      403,
      "schedule_authority_changed",
      "The owner's access changed. Review and enable the schedule again.",
    );
  const valid = await sql.query(
    "SELECT s.id FROM cloud_schedules s JOIN cloud_users u ON u.id=s.owner_id JOIN cloud_teams t ON t.organization_id=s.organization_id AND t.id=s.team_id WHERE s.id=$1 AND s.user_epoch=u.authentication_epoch AND s.team_epoch=t.access_epoch",
    [schedule.id],
  );
  if (!valid.rows.length)
    throw new CloudError(
      403,
      "schedule_authority_changed",
      "The owner's account or team access changed. Review and enable the schedule again.",
    );
}
