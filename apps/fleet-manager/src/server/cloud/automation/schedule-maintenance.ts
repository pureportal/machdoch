import type { CloudSchedule } from "../../../lib/cloud-schedule-contract";
import { CloudError, isCloudError } from "../access";
import type { CloudDatabase } from "../database";
import {
  expireRuns,
  lockExecution,
  terminalStates,
} from "../execution/records";
import type { RunState } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudRecurrencePreview } from "./recurrence";
import { refreshScheduleUsage } from "./schedule-budget";
import {
  readSchedule,
  recordSchedule,
  requireScheduleAuthority,
  scheduleColumns,
} from "./schedule-records";
import { nextAfterCompletion } from "./schedule-plan";

export async function maintainSchedules(
  database: CloudDatabase,
  recurrence: CloudRecurrencePreview,
): Promise<number> {
  const candidates = await database.transaction(
    async (sql) =>
      (
        await sql.query<{ id: string; organizationId: string }>(
          `SELECT s.id,s.organization_id AS "organizationId" FROM cloud_schedules s WHERE s.maintenance_at<=clock_timestamp() AND (s.waiting_run_id IS NOT NULL OR (s.enabled AND s.action->>'kind'='run-task' AND (s.action->>'expiresAt')::timestamptz<=clock_timestamp()) OR EXISTS(SELECT 1 FROM cloud_schedule_occurrences o WHERE o.organization_id=s.organization_id AND o.schedule_id=s.id AND o.budget_dirty)) ORDER BY s.maintenance_at,s.id LIMIT 5`,
        )
      ).rows,
  );
  for (const candidate of candidates) {
    const pending = await database.transaction(async (sql) => {
      await lockExecution(sql, candidate.organizationId);
      await expireRuns(sql, candidate.organizationId);
      await refreshScheduleUsage(sql, candidate.organizationId, [candidate.id]);
      const schedule = (
        await sql.query<CloudSchedule & Record<string, unknown>>(
          `SELECT ${scheduleColumns} FROM cloud_schedules s JOIN cloud_users u ON u.id=s.owner_id WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s`,
          [candidate.organizationId, candidate.id],
        )
      ).rows[0];
      if (!schedule) return null;
      if (schedule.enabled && schedule.action.kind === "run-task") {
        const valid = (
          await sql.query<{ valid: boolean }>(
            "SELECT $1::timestamptz>clock_timestamp() AS valid",
            [schedule.action.expiresAt],
          )
        ).rows[0]!.valid;
        if (!valid) {
          await sql.query(
            "UPDATE cloud_schedules SET enabled=false,error='The task authorization expired. Review its expiry before enabling the schedule.',revision=revision+1 WHERE id=$1",
            [schedule.id],
          );
          schedule.enabled = false;
          await recordSchedule(
            sql,
            {
              organizationId: candidate.organizationId,
              userId: schedule.ownerId,
            },
            schedule.id,
          );
        }
      }
      await sql.query(
        "UPDATE cloud_schedules SET maintenance_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",
        [schedule.id],
      );
      if (!schedule.waitingRunId) return null;
      const run = (
        await sql.query<{ state: RunState; completedAt: number | null }>(
          `SELECT r.state,floor(extract(epoch FROM e.occurred_at)*1000)::float8 AS "completedAt" FROM cloud_runs r LEFT JOIN cloud_run_events e ON e.organization_id=r.organization_id AND e.run_id=r.id AND e.revision=r.revision WHERE r.organization_id=$1 AND r.id=$2`,
          [candidate.organizationId, schedule.waitingRunId],
        )
      ).rows[0]!;
      if (!terminalStates.has(run.state)) return null;
      if (
        !schedule.enabled ||
        schedule.archived ||
        schedule.recurrence.kind !== "fixed-delay"
      ) {
        await sql.query(
          "UPDATE cloud_schedules SET waiting_run_id=NULL WHERE id=$1",
          [schedule.id],
        );
        return null;
      }
      return { schedule, completedAt: run.completedAt };
    });
    if (!pending) continue;
    const actor = {
      organizationId: candidate.organizationId,
      userId: pending.schedule.ownerId,
    };
    try {
      if (pending.completedAt === null)
        throw new CloudError(
          409,
          "completion_unavailable",
          "The task completion record is missing. Inspect the task before enabling this schedule again.",
        );
      const preview = await recurrence.preview(actor, {
        recurrence: pending.schedule.recurrence,
        count: 1,
      });
      if (
        preview.definition.kind !== "fixed-delay" ||
        preview.definition.key !== pending.schedule.definitionKey
      )
        throw new CloudError(
          409,
          "recurrence_changed",
          "The recurrence changed. Review its dates before enabling this schedule again.",
        );
      const nextAt = nextAfterCompletion(
        preview.definition,
        pending.completedAt,
      );
      await database.transaction(async (sql) => {
        await lockExecution(sql, actor.organizationId);
        const current = await readSchedule(sql, actor, candidate.id, true);
        if (
          current.revision !== pending.schedule.revision ||
          current.waitingRunId !== pending.schedule.waitingRunId ||
          !current.enabled ||
          current.archived
        )
          return;
        await requireScheduleAuthority(sql, actor, current);
        await sql.query(
          "UPDATE cloud_schedules SET next_at=$2,waiting_run_id=NULL,enabled=$3,revision=revision+CASE WHEN $3 THEN 0 ELSE 1 END WHERE id=$1",
          [current.id, nextAt, nextAt !== null],
        );
        if (nextAt === null) await recordSchedule(sql, actor, current.id);
      });
    } catch (error) {
      if (!isCloudError(error) || ![403, 404, 409, 422].includes(error.status))
        throw error;
      await database.transaction(async (sql) => {
        const updated = await sql.query(
          "UPDATE cloud_schedules SET enabled=false,waiting_run_id=NULL,error=$4,revision=revision+1 WHERE id=$1 AND revision=$2 AND waiting_run_id=$3 AND enabled RETURNING id",
          [
            candidate.id,
            pending.schedule.revision,
            pending.schedule.waitingRunId,
            error.message.slice(0, 500),
          ],
        );
        if (updated.rows.length) await recordSchedule(sql, actor, candidate.id);
      });
    }
  }
  return candidates.length;
}
