import type { CloudActor } from "../../../lib/cloud-contract";
import type { CloudSchedule } from "../../../lib/cloud-schedule-contract";
import { CloudError, isCloudError, requireTeam } from "../access";
import type { CloudDatabase } from "../database";
import { executeScheduleAction } from "./schedule-actions";
import { lockExecution, expireRuns } from "../execution/records";
import { maintainSchedules } from "./schedule-maintenance";
import { nextAfterCompletion } from "./schedule-plan";
import { CloudRecurrencePreview } from "./recurrence";
import {
  requireScheduleAuthority,
  readSchedule,
  recordSchedule,
  scheduleColumns,
} from "./schedule-records";

export class CloudScheduleDispatcher {
  constructor(
    private readonly database: CloudDatabase,
    private readonly recurrence: CloudRecurrencePreview,
  ) {}

  async tick(): Promise<number> {
    const maintained = await maintainSchedules(this.database, this.recurrence);
    const due = await this.database.transaction(async (sql) => {
      return (
        await sql.query<
          CloudSchedule & { organizationId: string; now: number } & Record<
              string,
              unknown
            >
        >(
          `SELECT ${scheduleColumns},s.organization_id AS "organizationId",floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now FROM cloud_schedules s JOIN cloud_users u ON u.id=s.owner_id WHERE s.enabled AND s.next_at<=floor(extract(epoch FROM clock_timestamp())*1000) ORDER BY s.next_at,s.id LIMIT 5`,
        )
      ).rows;
    });
    let firstError: unknown;
    for (const schedule of due) {
      try {
        await this.dispatch(schedule);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
    await this.database.transaction((sql) =>
      sql.query(
        "INSERT INTO cloud_schedule_worker(id,touched_at) VALUES(1,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET touched_at=excluded.touched_at",
      ),
    );
    return due.length + maintained;
  }

  private async dispatch(
    snapshot: CloudSchedule & { organizationId: string; now: number },
  ): Promise<void> {
    const actor: CloudActor = {
      organizationId: snapshot.organizationId,
      userId: snapshot.ownerId,
    };
    try {
      const plan = await this.recurrence.plan(actor, {
        recurrence: snapshot.recurrence,
        definitionKey: snapshot.definitionKey,
        nextAt: snapshot.nextAt!,
        now: snapshot.now,
        missed: snapshot.missed,
        catchUpLimit: snapshot.catchUpLimit,
        lookbackHours: snapshot.lookbackHours,
      });
      if (plan.accountedThrough < snapshot.nextAt!) return;
      await this.database.transaction(async (sql) => {
        await lockExecution(sql, actor.organizationId);
        await expireRuns(sql, actor.organizationId);
        const team = await requireTeam(sql, actor, snapshot.teamId, true);
        const current = await readSchedule(sql, actor, snapshot.id, true);
        if (
          !current.enabled ||
          current.revision !== snapshot.revision ||
          current.nextAt !== snapshot.nextAt
        )
          return;
        await requireScheduleAuthority(sql, actor, current);
        const skipped = snapshot.nextAt!;
        let completedAt: number | null = null;
        if (!plan.due.includes(skipped)) {
          const receipt = await sql.query<{ at: number }>(
            "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome,completed_at) VALUES($1,$2,$3,$4,$5,'skipped',clock_timestamp()) RETURNING floor(extract(epoch FROM completed_at)*1000)::float8 AS at",
            [
              actor.organizationId,
              snapshot.id,
              snapshot.revision,
              skipped,
              plan.accountedThrough,
            ],
          );
          completedAt = receipt.rows[0]!.at;
        }
        let waitingRunId: string | null = null;
        for (const at of plan.due) {
          const result = await executeScheduleAction(
            sql,
            actor,
            team,
            current,
            at,
          );
          if (plan.fixedDelay) waitingRunId = result.runId;
          completedAt = result.completedAt;
        }
        let nextAt = plan.nextAt;
        if (plan.fixedDelay && !waitingRunId) {
          if (completedAt === null)
            throw new CloudError(
              409,
              "completion_unavailable",
              "The occurrence completion is unavailable. Inspect its history before enabling this schedule again.",
            );
          nextAt = nextAfterCompletion(plan.fixedDelay, completedAt);
        }
        const enabled = nextAt !== null || waitingRunId !== null;
        await sql.query(
          "UPDATE cloud_schedules SET next_at=$2,waiting_run_id=$3,enabled=$4,maintenance_at=clock_timestamp(),revision=revision+CASE WHEN $4 THEN 0 ELSE 1 END WHERE id=$1",
          [snapshot.id, nextAt, waitingRunId, enabled],
        );
        if (!enabled) await recordSchedule(sql, actor, snapshot.id);
      });
    } catch (error) {
      if (!isCloudError(error) || ![403, 404, 409, 422].includes(error.status))
        throw error;
      await this.database.transaction(async (sql) => {
        const updated = await sql.query(
          "UPDATE cloud_schedules SET enabled=false,error=$4,revision=revision+1 WHERE id=$1 AND revision=$2 AND next_at=$3 AND enabled RETURNING id",
          [
            snapshot.id,
            snapshot.revision,
            snapshot.nextAt,
            error.code === "membership_required" ||
            error.code === "permission_denied"
              ? "The owner's access ended. The owner can enable this schedule after access is restored."
              : error.message.slice(0, 500),
          ],
        );
        if (updated.rows.length) await recordSchedule(sql, actor, snapshot.id);
      });
    }
  }
}
