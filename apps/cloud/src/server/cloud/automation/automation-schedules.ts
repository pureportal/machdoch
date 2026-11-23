import type { CloudActor } from "../../../lib/cloud-contract";
import { nextScheduledRun } from "../../../lib/automation-schedule";
import type { LoopMissedPolicy } from "../../../lib/cloud-loop-contract";
import {
  missedRunGraceMs,
  missedRunsToStart,
} from "../../../lib/loop-guardrails";
import type { CloudSql } from "../database";
import {
  insertAutomationRun,
  matchingIssueIds,
  storedAutomationColumns,
  type StoredAutomation,
} from "./automation-records";

const maximumIssuesPerOccurrence = 25;

export async function createScheduledRuns(
  sql: CloudSql,
  owner: CloudActor,
  automation: Pick<
    StoredAutomation,
    "id" | "teamId" | "trigger" | "conditions" | "dailyLimit"
  >,
  occurrence: string,
  actorId: string | null,
): Promise<string[]> {
  if (automation.trigger.kind !== "schedule") return [];
  const issueIds = automation.trigger.forEachIssue
    ? await matchingIssueIds(sql, owner, automation, maximumIssuesPerOccurrence)
    : [null];
  const runIds: string[] = [];
  for (const issueId of issueIds) {
    const started = await insertAutomationRun(
      sql,
      owner.organizationId,
      automation,
      {
        dedupeKey: `schedule:${occurrence}:${issueId ?? "none"}`,
        trigger: "schedule",
        issueId,
        actorId,
        depth: 0,
        variables: {},
      },
    );
    if (started.id) runIds.push(started.id);
  }
  return runIds;
}

export async function dispatchDueSchedules(sql: CloudSql): Promise<number> {
  const due = (
    await sql.query<
      StoredAutomation & {
        organizationId: string;
        nextRunAt: Date;
        missed: LoopMissedPolicy;
      } & Record<string, unknown>
    >(
      `SELECT ${storedAutomationColumns},organization_id AS "organizationId",next_run_at AS "nextRunAt",COALESCE((SELECT l.missed FROM cloud_loops l WHERE l.organization_id=a.organization_id AND l.automation_id=a.id),'latest') AS missed
      FROM cloud_automations a WHERE enabled AND trigger_kind='schedule' AND next_run_at<=clock_timestamp() ORDER BY next_run_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`,
    )
  ).rows;
  for (const automation of due) {
    if (automation.trigger.kind !== "schedule") continue;
    if (
      missedRunsToStart(
        automation.missed,
        automation.nextRunAt,
        new Date(),
        missedRunGraceMs,
      )
    )
      await createScheduledRuns(
        sql,
        {
          organizationId: automation.organizationId,
          userId: automation.ownerId,
        },
        automation,
        String(automation.nextRunAt.getTime()),
        null,
      );
    await sql.query(
      "UPDATE cloud_automations SET next_run_at=$3 WHERE organization_id=$1 AND id=$2",
      [
        automation.organizationId,
        automation.id,
        new Date(nextScheduledRun(automation.trigger, Date.now())),
      ],
    );
  }
  return due.length;
}
