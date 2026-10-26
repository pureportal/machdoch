import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudSchedule,
  ScheduleInput,
  ScheduleOccurrence,
  ScheduleFilters,
} from "../../../lib/cloud-schedule-contract";
import {
  checkRevision,
  CloudError,
  command,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "../access";
import type { CloudDatabase } from "../database";
import {
  validateScheduleAction,
  requireScheduleAllowance,
} from "./schedule-actions";
import { lockExecution, expireRuns } from "../execution/records";
import {
  readSchedule,
  recordSchedule,
  membershipEpoch,
  scheduleWorkerAvailable,
  scheduleColumns,
} from "./schedule-records";
import { refreshScheduleUsage } from "./schedule-budget";
import { CloudRecurrencePreview } from "./recurrence";

function requireOwner(schedule: CloudSchedule, actor: CloudActor): void {
  if (schedule.ownerId !== actor.userId || actor.delegation)
    throw new CloudError(
      403,
      "schedule_owner_required",
      "Only the schedule owner can change or enable it in the browser.",
    );
}

export class CloudSchedules {
  constructor(
    private readonly database: CloudDatabase,
    private readonly recurrence: CloudRecurrencePreview,
  ) {}

  status(actor: CloudActor): Promise<{ available: boolean }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return { available: await scheduleWorkerAvailable(sql) };
    });
  }

  list(
    actor: CloudActor,
    { teamId, offset = 0, archived = false }: ScheduleFilters = {},
  ): Promise<CloudSchedule[]> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await expireRuns(sql, actor.organizationId);
      await requireMembership(sql, actor);
      const rows = (
        await sql.query<CloudSchedule & Record<string, unknown>>(
          `SELECT ${scheduleColumns} FROM cloud_schedules s JOIN cloud_users u ON u.id=s.owner_id JOIN cloud_teams t ON t.id=s.team_id AND t.organization_id=s.organization_id JOIN cloud_memberships m ON m.organization_id=s.organization_id AND m.user_id=$2 WHERE s.organization_id=$1 AND ${teamVisibility} AND ($3::uuid IS NULL OR s.team_id=$3) AND s.archived=$5 ORDER BY s.created_at DESC,s.id LIMIT 200 OFFSET $4 FOR SHARE OF t`,
          [
            actor.organizationId,
            actor.userId,
            teamId ?? null,
            offset,
            archived,
          ],
        )
      ).rows;
      const budgets = await refreshScheduleUsage(
        sql,
        actor.organizationId,
        rows.map((row) => row.id),
      );
      return rows.map((row) => ({ ...row, ...budgets.get(row.id) }));
    });
  }

  get(actor: CloudActor, id: string): Promise<CloudSchedule> {
    return this.database.transaction((sql) => readSchedule(sql, actor, id));
  }

  history(
    actor: CloudActor,
    id: string,
    cursor?: { beforeAt?: number; beforeRevision?: number },
  ): Promise<ScheduleOccurrence[]> {
    return this.database.transaction(async (sql) => {
      await readSchedule(sql, actor, id);
      return (
        await sql.query<ScheduleOccurrence & Record<string, unknown>>(
          `SELECT o.revision,o.nominal_at::float8 AS at,o.accounted_through::float8 AS "accountedThrough",o.outcome,o.issue_id AS "issueId",i.identifier,o.run_id AS "runId",r.state AS "runState",o.reason,floor(extract(epoch FROM o.completed_at)*1000)::float8 AS "completedAt",o.used_tokens::float8 AS "usedTokens",o.reserved_tokens::float8 AS "reservedTokens" FROM cloud_schedule_occurrences o LEFT JOIN cloud_issues i ON i.organization_id=o.organization_id AND i.id=o.issue_id LEFT JOIN cloud_runs r ON r.organization_id=o.organization_id AND r.id=o.run_id WHERE o.organization_id=$1 AND o.schedule_id=$2 AND ($3::bigint IS NULL OR (o.nominal_at,o.revision)<($3::bigint,$4::integer)) ORDER BY o.nominal_at DESC,o.revision DESC LIMIT 100`,
          [
            actor.organizationId,
            id,
            cursor?.beforeAt ?? null,
            cursor?.beforeRevision ?? null,
          ],
        )
      ).rows;
    });
  }

  private async validate(actor: CloudActor, input: ScheduleInput) {
    const result = await this.recurrence.preview(actor, {
      recurrence: input.recurrence,
      count: 1,
      fromActivation: true,
    });
    if (
      (result.definition.kind === "fixed-delay" &&
        result.definition.delayMs < 60_000) ||
      (result.definition.kind === "interval" &&
        result.definition.everyMs < 60_000)
    )
      throw new CloudError(
        422,
        "invalid_recurrence",
        "Use a calendar rule, one time, or an interval or delay of at least one minute.",
      );
    return {
      nextAt: result.occurrences[0]?.at ?? null,
      definitionKey: result.definition.key,
    };
  }

  async create(
    actor: CloudActor,
    key: string,
    input: ScheduleInput,
  ): Promise<{ id: string }> {
    if (actor.delegation)
      throw new CloudError(
        403,
        "schedule_owner_required",
        "Create schedules in the browser.",
      );
    const { nextAt, definitionKey } = await this.validate(actor, input);
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const team = await requireTeam(sql, actor, input.teamId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "schedule.create", input },
        async () => {
          const count = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM cloud_schedules WHERE organization_id=$1 AND team_id=$2 AND NOT archived",
              [actor.organizationId, team.id],
            )
          ).rows[0]!.count;
          if (count >= 100)
            throw new CloudError(
              409,
              "schedule_limit",
              "This team has reached its limit of 100 schedules.",
            );
          const { providerRevision, action } = await validateScheduleAction(
            sql,
            actor,
            team,
            input.action,
          );
          const id = randomUUID();
          await sql.query(
            `INSERT INTO cloud_schedules(organization_id,id,team_id,owner_id,owner_epoch,user_epoch,team_epoch,name,action,recurrence,missed,catch_up_limit,lookback_hours,next_at,definition_key,provider_revision) VALUES($1,$2,$3,$4,$5,(SELECT authentication_epoch FROM cloud_users WHERE id=$4),(SELECT access_epoch FROM cloud_teams WHERE organization_id=$1 AND id=$3),$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              actor.organizationId,
              id,
              team.id,
              actor.userId,
              await membershipEpoch(sql, actor),
              input.name,
              JSON.stringify(action),
              JSON.stringify(input.recurrence),
              input.missed,
              input.catchUpLimit,
              input.lookbackHours,
              nextAt,
              definitionKey,
              providerRevision,
            ],
          );
          await recordSchedule(sql, actor, id);
          return { id };
        },
      );
    });
  }

  async update(
    actor: CloudActor,
    key: string,
    id: string,
    input: ScheduleInput & { revision: number },
  ): Promise<{ id: string }> {
    const { nextAt, definitionKey } = await this.validate(actor, input);
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const schedule = await readSchedule(sql, actor, id, true);
      requireOwner(schedule, actor);
      return command(
        sql,
        actor,
        key,
        { kind: "schedule.update", id, input },
        async () => {
          checkRevision(schedule.revision, input.revision);
          if (schedule.archived)
            throw new CloudError(
              409,
              "schedule_archived",
              "Restore the schedule before editing it.",
            );
          if (schedule.enabled)
            throw new CloudError(
              409,
              "schedule_enabled",
              "Pause the schedule before editing it.",
            );
          if (schedule.teamId !== input.teamId)
            throw new CloudError(
              422,
              "schedule_team",
              "The schedule must stay in its original team.",
            );
          if (
            input.action.kind === "run-task" &&
            (input.action.maxRuns < schedule.admittedRuns ||
              input.action.maxTokens <
                schedule.usedTokens + schedule.reservedTokens)
          )
            throw new CloudError(
              422,
              "schedule_budget",
              `The limits must cover the ${schedule.admittedRuns} tasks and ${schedule.usedTokens + schedule.reservedTokens} tokens already allocated.`,
            );
          const team = await requireTeam(sql, actor, schedule.teamId, true);
          const { providerRevision, action } = await validateScheduleAction(
            sql,
            actor,
            team,
            input.action,
          );
          const updated = await sql.query(
            `UPDATE cloud_schedules SET name=$3,action=$4,recurrence=$5,missed=$6,catch_up_limit=$7,lookback_hours=$8,next_at=$9,definition_key=$10,provider_revision=$11,error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2 AND (name IS DISTINCT FROM $3 OR action IS DISTINCT FROM $4::jsonb OR recurrence IS DISTINCT FROM $5::jsonb OR missed IS DISTINCT FROM $6 OR catch_up_limit IS DISTINCT FROM $7 OR lookback_hours IS DISTINCT FROM $8 OR definition_key IS DISTINCT FROM $10 OR provider_revision IS DISTINCT FROM $11 OR error IS NOT NULL) RETURNING id`,
            [
              actor.organizationId,
              id,
              input.name,
              JSON.stringify(action),
              JSON.stringify(input.recurrence),
              input.missed,
              input.catchUpLimit,
              input.lookbackHours,
              nextAt,
              definitionKey,
              providerRevision,
            ],
          );
          if (updated.rows.length) await recordSchedule(sql, actor, id);
          return { id };
        },
      );
    });
  }

  async setEnabled(
    actor: CloudActor,
    key: string,
    id: string,
    input: { revision: number; enabled: boolean },
  ): Promise<{ id: string }> {
    const snapshot = await this.get(actor, id);
    const preview = input.enabled ? await this.validate(actor, snapshot) : null;
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const schedule = await readSchedule(sql, actor, id, true);
      if (input.enabled || schedule.ownerId === actor.userId)
        requireOwner(schedule, actor);
      else await requireMembership(sql, actor, "admin");
      return command(
        sql,
        actor,
        key,
        { kind: "schedule.state", id, input },
        async () => {
          checkRevision(schedule.revision, input.revision);
          if (input.enabled === schedule.enabled) return { id };
          if (input.enabled && preview?.nextAt == null)
            throw new CloudError(
              422,
              "schedule_exhausted",
              "The schedule has no upcoming occurrence. Edit its dates before enabling it.",
            );
          let providerRevision = schedule.providerRevision;
          let waitingRunId: string | null = null;
          if (input.enabled) {
            if (schedule.archived)
              throw new CloudError(
                409,
                "schedule_archived",
                "Restore the schedule before enabling it.",
              );
            if (!(await scheduleWorkerAvailable(sql)))
              throw new CloudError(
                503,
                "schedule_worker_unavailable",
                "The schedule worker is unavailable. Try again shortly.",
              );
            checkRevision(schedule.revision, snapshot.revision);
            const team = await requireTeam(sql, actor, schedule.teamId, true);
            const grant = await validateScheduleAction(
              sql,
              actor,
              team,
              schedule.action,
            );
            providerRevision = grant.providerRevision;
            if (
              schedule.recurrence.kind === "fixed-delay" &&
              schedule.action.kind === "run-task"
            )
              waitingRunId =
                (
                  await sql.query<{ id: string }>(
                    "SELECT r.id FROM cloud_schedule_occurrences o JOIN cloud_runs r ON r.organization_id=o.organization_id AND r.id=o.run_id WHERE o.organization_id=$1 AND o.schedule_id=$2 AND r.state NOT IN ('succeeded','failed','canceled','timed_out') ORDER BY r.created_at DESC,r.id LIMIT 1",
                    [actor.organizationId, id],
                  )
                ).rows[0]?.id ?? null;
            await requireScheduleAllowance(
              sql,
              schedule,
              waitingRunId !== null,
            );
            if (
              schedule.action.kind === "run-task" &&
              preview!.nextAt! >= Date.parse(schedule.action.expiresAt)
            )
              throw new CloudError(
                422,
                "schedule_expiry",
                "Authorization expires before the next date. Extend its expiry or choose an earlier date.",
              );
          }
          await sql.query(
            "UPDATE cloud_schedules s SET enabled=$3,next_at=$4,owner_epoch=$5,user_epoch=(SELECT authentication_epoch FROM cloud_users WHERE id=s.owner_id),team_epoch=(SELECT access_epoch FROM cloud_teams WHERE organization_id=s.organization_id AND id=s.team_id),definition_key=$6,provider_revision=$7,waiting_run_id=$8,maintenance_at=clock_timestamp(),error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.enabled,
              waitingRunId ? null : preview ? preview.nextAt : schedule.nextAt,
              await membershipEpoch(sql, {
                organizationId: actor.organizationId,
                userId: schedule.ownerId,
              }),
              preview?.definitionKey ?? schedule.definitionKey,
              providerRevision,
              input.enabled ? waitingRunId : schedule.waitingRunId,
            ],
          );
          await recordSchedule(sql, actor, id);
          return { id };
        },
      );
    });
  }

  archive(
    actor: CloudActor,
    key: string,
    id: string,
    input: { revision: number; archived: boolean },
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const schedule = await readSchedule(sql, actor, id, true);
      if (schedule.ownerId === actor.userId) requireOwner(schedule, actor);
      else await requireMembership(sql, actor, "admin");
      return command(
        sql,
        actor,
        key,
        { kind: "schedule.archive", id, input },
        async () => {
          checkRevision(schedule.revision, input.revision);
          if (schedule.archived === input.archived) return { id };
          if (!input.archived) {
            const count = (
              await sql.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM cloud_schedules WHERE organization_id=$1 AND team_id=$2 AND NOT archived",
                [actor.organizationId, schedule.teamId],
              )
            ).rows[0]!.count;
            if (count >= 100)
              throw new CloudError(
                409,
                "schedule_limit",
                "Archive another schedule in this team before restoring this one.",
              );
          }
          await sql.query(
            "UPDATE cloud_schedules SET archived=$3,enabled=false,error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id, input.archived],
          );
          await recordSchedule(sql, actor, id);
          return { id };
        },
      );
    });
  }
}
