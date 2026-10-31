import type {
  CloudActor,
  CloudCycle,
  CloudIssue,
  IssueSnapshot,
} from "../../lib/cloud-contract";
import type {
  CycleBurnupPoint,
  CycleCommand,
  CycleDetail,
  CycleTotals,
} from "../../lib/cloud-cycle-contract";
import { cycleBurnup, type IssueChange } from "./cycle-burnup";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireTeam,
} from "./access";
import type { CloudDatabase, CloudSql } from "./database";
import { readIssue, recordIssue } from "./planning";
import { cycleColumns, issueColumns } from "./planning-queries";
import { lockExecution } from "./execution/records";

async function readCycle(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
) {
  const reference = (
    await sql.query<{ team_id: string }>(
      "SELECT team_id FROM cloud_cycles WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!reference)
    throw new CloudError(404, "not_found", "Cycle is unavailable.");
  await requireTeam(sql, actor, reference.team_id, write);
  return (
    await sql.query<
      CloudCycle & {
        closing_snapshot: IssueSnapshot[] | null;
        closing_status_names: Record<string, string> | null;
        carried_issue_ids: string[];
      } & Record<string, unknown>
    >(
      `SELECT ${cycleColumns},closing_snapshot,closing_status_names,carried_issue_ids FROM cloud_cycles WHERE organization_id=$1 AND id=$2 FOR ${write ? "UPDATE" : "SHARE"}`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
}

function totals(issues: IssueSnapshot[]): CycleTotals {
  return issues.reduce(
    (result, issue) => ({
      issues: result.issues + 1,
      points: result.points + (issue.estimatePoints ?? 0),
      completed: result.completed + Number(issue.state === "complete"),
      completedPoints:
        result.completedPoints +
        (issue.state === "complete" ? (issue.estimatePoints ?? 0) : 0),
      unestimated: result.unestimated + Number(issue.estimatePoints === null),
    }),
    { issues: 0, points: 0, completed: 0, completedPoints: 0, unestimated: 0 },
  );
}

async function cycleIssues(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
): Promise<CloudIssue[]> {
  return (
    await sql.query<CloudIssue & Record<string, unknown>>(
      `SELECT ${issueColumns} FROM cloud_issues i WHERE organization_id=$1 AND cycle_id=$2 AND NOT archived ORDER BY identifier,id`,
      [actor.organizationId, id],
    )
  ).rows;
}

export class CloudCycles {
  constructor(private readonly database: CloudDatabase) {}

  get(actor: CloudActor, id: string): Promise<CycleDetail> {
    return this.database.transaction(async (sql) => {
      const {
        closing_snapshot,
        closing_status_names,
        carried_issue_ids,
        ...cycle
      } = await readCycle(sql, actor, id);
      const liveIssues = closing_snapshot
        ? []
        : await cycleIssues(sql, actor, id);
      const issues = closing_snapshot ?? liveIssues;
      const statusNames =
        cycle.status === "closed"
          ? closing_status_names!
          : Object.fromEntries(
              liveIssues.map((issue) => [issue.id, issue.statusName]),
            );
      const commitment = (
        await sql.query<{ snapshot: IssueSnapshot }>(
          "SELECT snapshot FROM cloud_cycle_commitments WHERE organization_id=$1 AND cycle_id=$2 ORDER BY snapshot->>'identifier',issue_id",
          [actor.organizationId, id],
        )
      ).rows.map((row) => row.snapshot);
      return {
        cycle,
        issues,
        commitment,
        statusNames,
        totals: totals(issues),
        committedTotals: totals(commitment),
        carriedIssueIds: carried_issue_ids,
      };
    });
  }

  burnup(actor: CloudActor, id: string): Promise<CycleBurnupPoint[]> {
    return this.database.transaction(async (sql) => {
      const cycle = await readCycle(sql, actor, id);
      const changes = (
        await sql.query<IssueChange & Record<string, unknown>>(
          `SELECT h.issue_id AS "issueId",h.revision,h.snapshot->>'cycleId' AS "cycleId",h.snapshot->>'state' AS state,
             (h.snapshot->>'estimatePoints')::double precision AS points,COALESCE((h.snapshot->>'archived')::boolean,false) AS archived,
             h.created_at AS "changedAt"
           FROM cloud_issue_history h WHERE h.organization_id=$1 AND h.issue_id IN
             (SELECT issue_id FROM cloud_issue_history WHERE organization_id=$1 AND snapshot->>'cycleId'=$2)
           ORDER BY h.issue_id,h.revision`,
          [actor.organizationId, id],
        )
      ).rows;
      return cycleBurnup(cycle, changes, new Date());
    });
  }

  act(
    actor: CloudActor,
    key: string,
    id: string,
    input: CycleCommand,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      const cycle = await readCycle(sql, actor, id, true);
      return command(
        sql,
        actor,
        key,
        { kind: "cycle.command", id, input },
        async () => {
          checkRevision(cycle.revision, input.revision);
          if (input.kind === "start") {
            if (cycle.status !== "planned")
              throw new CloudError(
                409,
                "cycle_started",
                "This cycle has already started.",
              );
            if (
              (
                await sql.query(
                  "SELECT id FROM cloud_cycles WHERE organization_id=$1 AND team_id=$2 AND status='active'",
                  [actor.organizationId, cycle.teamId],
                )
              ).rows.length
            )
              throw new CloudError(
                409,
                "active_cycle",
                "Complete the team's active cycle before starting this one.",
              );
            for (const issue of await cycleIssues(sql, actor, id)) {
              await sql.query(
                "INSERT INTO cloud_cycle_commitments (organization_id,cycle_id,issue_id,snapshot) VALUES ($1,$2,$3,$4)",
                [actor.organizationId, id, issue.id, JSON.stringify(issue)],
              );
            }
            await sql.query(
              "UPDATE cloud_cycles SET status='active',started_at=clock_timestamp(),revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [actor.organizationId, id],
            );
          } else {
            if (cycle.status !== "active")
              throw new CloudError(
                409,
                "cycle_not_active",
                "Only an active cycle can be completed.",
              );
            if (input.carryoverCycleId) {
              const target = (
                await sql.query<{ id: string }>(
                  "SELECT id FROM cloud_cycles WHERE organization_id=$1 AND team_id=$2 AND id=$3 AND status='planned' AND starts_on >= $4::date",
                  [
                    actor.organizationId,
                    cycle.teamId,
                    input.carryoverCycleId,
                    cycle.endsOn,
                  ],
                )
              ).rows[0];
              if (!target)
                throw new CloudError(
                  422,
                  "invalid_carryover",
                  "Choose a future planned cycle for this team.",
                );
            }
            const issues = await cycleIssues(sql, actor, id);
            const unfinished = issues.filter(
              (issue) => !["complete", "canceled"].includes(issue.state),
            );
            for (const issue of unfinished) {
              await sql.query(
                "UPDATE cloud_issues SET cycle_id=$3,revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
                [actor.organizationId, issue.id, input.carryoverCycleId],
              );
              await recordIssue(
                sql,
                actor,
                await readIssue(sql, actor, issue.id),
              );
            }
            await sql.query(
              "UPDATE cloud_cycles SET status='closed',closed_at=clock_timestamp(),closing_snapshot=$3,carried_issue_ids=$4,closing_status_names=$5,revision=revision+1 WHERE organization_id=$1 AND id=$2",
              [
                actor.organizationId,
                id,
                JSON.stringify(issues),
                JSON.stringify(unfinished.map((issue) => issue.id)),
                JSON.stringify(
                  Object.fromEntries(
                    issues.map((issue) => [issue.id, issue.statusName]),
                  ),
                ),
              ],
            );
          }
          await recordEvent(
            sql,
            actor,
            `cycle.${input.kind}`,
            id,
            input.revision + 1,
            input.kind === "close"
              ? { carryoverCycleId: input.carryoverCycleId }
              : {},
          );
          return { id };
        },
      );
    });
  }
}
