import { admitRun } from "./admission";
import { runPlanningChanged } from "./planning-context";
import type { TaskArtifact } from "@machdoch/fleet-protocol/cloud-artifacts";
import { artifactColumns } from "./artifact-records";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudRun,
  RunAttempt,
  RunDetail,
  RunInput,
} from "@machdoch/fleet-protocol/cloud-execution";
import {
  checkRevision,
  CloudError,
  command,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "../access";
import type { CloudDatabase } from "../database";
import { readIssue } from "../planning";
import {
  expireRuns,
  fenceRun,
  lockExecution,
  readRun,
  runColumns,
  terminalStates,
} from "./records";

export class CloudRuns {
  constructor(private readonly database: CloudDatabase) {}

  create(
    actor: CloudActor,
    key: string,
    input: RunInput,
  ): Promise<{ id: string }> {
    return this.database.transaction((sql) => admitRun(sql, actor, key, input));
  }

  list(actor: CloudActor, issueId?: string): Promise<CloudRun[]> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor);
      if (issueId) await readIssue(sql, actor, issueId);
      await expireRuns(sql, actor.organizationId);
      return (
        await sql.query<CloudRun & Record<string, unknown>>(
          `SELECT ${runColumns} FROM cloud_runs r
        JOIN cloud_teams t ON t.organization_id=r.organization_id AND t.id=r.team_id JOIN cloud_memberships m ON m.organization_id=r.organization_id AND m.user_id=$2
        WHERE r.organization_id=$1 AND ${teamVisibility} AND ($3::uuid IS NULL OR r.issue_id=$3) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
          [actor.organizationId, actor.userId, issueId ?? null],
        )
      ).rows;
    });
  }

  get(actor: CloudActor, id: string): Promise<RunDetail> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await expireRuns(sql, actor.organizationId);
      const run = await readRun(sql, actor.organizationId, id);
      await requireTeam(sql, actor, run.teamId);
      const attempts = (
        await sql.query<RunAttempt & Record<string, unknown>>(
          `SELECT a.id,a.worker_id AS "workerId",w.name AS "workerName",a.epoch,a.state,
        to_char(a.lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "leaseExpiresAt"
        FROM cloud_run_attempts a JOIN cloud_execution_workers w ON w.organization_id=a.organization_id AND w.id=a.worker_id
        WHERE a.organization_id=$1 AND a.run_id=$2 ORDER BY a.epoch`,
          [actor.organizationId, id],
        )
      ).rows;
      const {
        actorId: _,
        profileId: __,
        stopReason: ___,
        stopMessage,
        planningDigest: ____,
        ...detail
      } = run;
      const usage = (
        await sql.query<RunDetail["usage"] & Record<string, unknown>>(
          run.manifest.provider
            ? `SELECT COALESCE(sum(actual_tokens),0)::double precision AS "usedTokens",
        COALESCE(sum(reserved_tokens) FILTER (WHERE actual_tokens IS NULL),0)::double precision AS "reservedTokens",count(*)::integer AS requests
        FROM cloud_inference_calls WHERE organization_id=$1 AND run_id=$2`
            : `SELECT COALESCE((result->>'tokensUsed')::double precision,0) AS "usedTokens",0::double precision AS "reservedTokens",0 AS requests
        FROM cloud_runs WHERE organization_id=$1 AND id=$2`,
          [actor.organizationId, id],
        )
      ).rows[0]!;
      const artifacts = (
        await sql.query<TaskArtifact & Record<string, unknown>>(
          `SELECT ${artifactColumns} FROM cloud_run_artifacts WHERE organization_id=$1 AND run_id=$2 AND state='ready' ORDER BY created_at,id`,
          [actor.organizationId, id],
        )
      ).rows;
      return {
        ...detail,
        attempts,
        usage,
        artifacts,
        reason: stopMessage,
        contextChanged: await runPlanningChanged(
          sql,
          actor.organizationId,
          run,
        ),
      };
    });
  }

  cancel(
    actor: CloudActor,
    key: string,
    id: string,
    expectedRevision: number,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, actor.organizationId);
      await requireMembership(sql, actor, "write");
      const run = await readRun(sql, actor.organizationId, id);
      await requireTeam(sql, actor, run.teamId);
      return command(
        sql,
        actor,
        key,
        { kind: "run.cancel", id, expectedRevision },
        async () => {
          checkRevision(run.revision, expectedRevision);
          if (terminalStates.has(run.state))
            throw new CloudError(
              409,
              "run_finished",
              "This task has already ended.",
            );
          if (run.stopReason !== "canceled")
            await fenceRun(
              sql,
              actor.organizationId,
              run,
              "canceled",
              "Cancellation requested",
            );
          return { id };
        },
      );
    });
  }
}
