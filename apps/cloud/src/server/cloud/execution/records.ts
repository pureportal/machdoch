import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudRun,
  ExecutionProfile,
  RunManifest,
  RunState,
} from "@machdoch/fleet-protocol/cloud-execution";
import {
  CloudError,
  recordEvent,
  requireMembership,
  requireTeam,
} from "../access";
import type { CloudSql } from "../database";

export const terminalStates = new Set<RunState>([
  "succeeded",
  "failed",
  "canceled",
  "timed_out",
]);
export const runColumns = `r.id,r.team_id AS "teamId",r.project_id AS "projectId",r.issue_id AS "issueId",r.title,r.state,r.revision,r.epoch,r.attempt_id AS "attemptId",r.summary,COALESCE(r.stop_reason='canceled',false) AS "cancelRequested",
  to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(r.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deadlineAt"`;
export interface StoredRun extends CloudRun, Record<string, unknown> {
  candidateCommit: string | null;
  actorId: string;
  profileId: string;
  manifest: RunManifest;
  inputDigest: string;
  planningDigest: string | null;
  stopReason: "canceled" | "timed_out" | "failed" | null;
  stopMessage: string | null;
}

export async function lockExecution(
  sql: CloudSql,
  organizationId: string,
): Promise<void> {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `execution:${organizationId}`,
  ]);
}

export async function readProfile(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<ExecutionProfile> {
  await requireMembership(sql, actor, write ? "write" : "read");
  const row = (
    await sql.query<{
      definition: ExecutionProfile;
      team_id: string;
      project_id: string;
      revision: number;
      enabled: boolean;
    }>(
      "SELECT definition,team_id,project_id,revision,enabled FROM cloud_execution_profiles WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!row)
    throw new CloudError(404, "not_found", "Execution profile is unavailable.");
  await requireTeam(sql, actor, row.team_id);
  return {
    ...row.definition,
    id,
    teamId: row.team_id,
    projectId: row.project_id,
    revision: row.revision,
    enabled: row.enabled,
  };
}

export async function readRun(
  sql: CloudSql,
  organizationId: string,
  id: string,
): Promise<StoredRun> {
  const row = (
    await sql.query<StoredRun>(
      `SELECT ${runColumns},r.result->>'candidateCommit' AS "candidateCommit",r.actor_id AS "actorId",r.profile_id AS "profileId",r.manifest,r.input_digest AS "inputDigest",r.planning_digest AS "planningDigest",r.stop_reason AS "stopReason",r.stop_message AS "stopMessage"
    FROM cloud_runs r WHERE r.organization_id=$1 AND r.id=$2 FOR UPDATE`,
      [organizationId, id],
    )
  ).rows[0];
  if (!row) throw new CloudError(404, "not_found", "Task is unavailable.");
  return row;
}

export async function recordRun(
  sql: CloudSql,
  organizationId: string,
  id: string,
  reason: string,
): Promise<void> {
  const run = await readRun(sql, organizationId, id);
  await sql.query(
    "INSERT INTO cloud_run_events (organization_id,run_id,revision,state,reason) VALUES ($1,$2,$3,$4,$5)",
    [organizationId, id, run.revision, run.state, reason],
  );
  await recordEvent(
    sql,
    { organizationId, userId: run.actorId },
    "run.changed",
    id,
    run.revision,
    { state: run.state, epoch: run.epoch },
  );
}

export async function hasRunAuthority(
  sql: CloudSql,
  organizationId: string,
  run: StoredRun,
): Promise<boolean> {
  const grant = await sql.query<{ provider_id: string | null }>(
    `SELECT p.provider_id FROM cloud_execution_profiles p JOIN cloud_teams t ON t.organization_id=p.organization_id AND t.id=p.team_id
    JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$3 JOIN cloud_users u ON u.id=m.user_id
    WHERE p.organization_id=$1 AND p.id=$2 AND p.enabled AND p.revision=$4 AND m.active AND m.role<>'viewer' AND NOT u.disabled
    AND ($5::timestamptz IS NULL OR (clock_timestamp()<$5::timestamptz AND m.authentication_epoch=$6::bigint AND u.authentication_epoch=$7::bigint AND t.access_epoch=$8::bigint))
    AND (t.visibility='organization' OR m.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM cloud_team_memberships tm WHERE tm.organization_id=t.organization_id AND tm.team_id=t.id AND tm.user_id=m.user_id))
    FOR SHARE OF p,t,m,u`,
    [
      organizationId,
      run.profileId,
      run.actorId,
      run.manifest.profile.revision,
      run.manifest.automation?.expiresAt ?? null,
      run.manifest.automation?.membershipEpoch ?? null,
      run.manifest.automation?.userEpoch ?? null,
      run.manifest.automation?.teamEpoch ?? null,
    ],
  );
  const profile = grant.rows[0];
  if (!profile) return false;
  const provider = run.manifest.provider;
  if (!provider) return profile.provider_id === null;
  if (profile.provider_id !== provider.id) return false;
  const model = await sql.query(
    "SELECT id FROM cloud_ai_providers WHERE organization_id=$1 AND id=$2 AND enabled AND inference_revision=$3 AND models ? $4 FOR SHARE",
    [
      organizationId,
      provider.id,
      provider.inferenceRevision,
      run.manifest.profile.model,
    ],
  );
  return model.rows.length > 0;
}

export async function fenceRun(
  sql: CloudSql,
  organizationId: string,
  run: StoredRun,
  reason: "canceled" | "timed_out" | "failed",
  message: string,
): Promise<void> {
  if (terminalStates.has(run.state)) return;
  reason =
    run.stopReason === "canceled" || reason === "canceled"
      ? "canceled"
      : run.stopReason === "timed_out" || reason === "timed_out"
        ? "timed_out"
        : "failed";
  const state = run.attemptId
    ? reason === "canceled" && run.state !== "cancel_requested"
      ? "cancel_requested"
      : "reconciling"
    : reason;
  await sql.query(
    "UPDATE cloud_runs SET state=$3,stop_reason=$4,stop_message=$5,epoch=epoch+1,revision=revision+1 WHERE organization_id=$1 AND id=$2",
    [
      organizationId,
      run.id,
      state,
      reason,
      reason === run.stopReason ? run.stopMessage : message,
    ],
  );
  if (run.attemptId)
    await sql.query(
      "UPDATE cloud_run_attempts SET state=$3 WHERE organization_id=$1 AND id=$2 AND state<>'stopped'",
      [
        organizationId,
        run.attemptId,
        reason === "canceled" ? "stopping" : "suspect",
      ],
    );
  await recordRun(sql, organizationId, run.id, message);
}

export async function expireRuns(
  sql: CloudSql,
  organizationId: string,
): Promise<void> {
  const candidates = await sql.query<{ id: string; deadline_expired: boolean }>(
    `SELECT r.id,r.deadline_at<=clock_timestamp() AS deadline_expired FROM cloud_runs r
    LEFT JOIN cloud_run_attempts a ON a.organization_id=r.organization_id AND a.id=r.attempt_id
    WHERE r.organization_id=$1 AND r.state IN ('queued','preparing','running','waiting','validating','publishing','cancel_requested')
      AND (r.deadline_at<=clock_timestamp() OR (a.state<>'stopped' AND a.lease_expires_at<=clock_timestamp()))
    ORDER BY r.created_at,r.id LIMIT 100`,
    [organizationId],
  );
  for (const row of candidates.rows) {
    const run = await readRun(sql, organizationId, row.id);
    const reason =
      run.stopReason === "canceled"
        ? "canceled"
        : row.deadline_expired
          ? "timed_out"
          : "failed";
    await fenceRun(
      sql,
      organizationId,
      run,
      reason,
      row.deadline_expired ? "Task deadline expired" : "Runner lease expired",
    );
  }
}
