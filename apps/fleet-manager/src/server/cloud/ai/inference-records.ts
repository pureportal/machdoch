import type { ChatState } from "../../../lib/cloud-chat-contract";
import type { AgentModelToolSpec } from "@machdoch/model-runtime/types";
import type { InferenceModelOptions } from "@machdoch/fleet-protocol/cloud-inference";
import type { CloudSql } from "../database";
import { hasRunAuthority, lockExecution, readRun } from "../execution/records";

export const inferenceLeaseSeconds = 30;
export const maximumInferenceAnswerBytes = 256 * 1024;

export interface InferenceCall extends Record<string, unknown> {
  id: string;
  organizationId: string;
  turnId: string | null;
  runId: string | null;
  attemptId: string | null;
  runEpoch: number | null;
  tools: AgentModelToolSpec[];
  modelOptions: InferenceModelOptions;
  actorId: string;
  providerId: string;
  providerRevision: number;
  model: string;
  userPrompt: string;
  systemPrompt: string;
  maxOutputTokens: number;
  executionId: string | null;
  state: ChatState;
  started: boolean;
  leaseValid: boolean | null;
  deadlineValid: boolean;
  budgetDayCurrent: boolean;
  budgetDay: string;
}

export async function lockInference(
  sql: CloudSql,
  organizationId: string,
): Promise<void> {
  await lockExecution(sql, organizationId);
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `inference:${organizationId}`,
  ]);
}

export async function readInferenceCall(
  sql: CloudSql,
  organizationId: string,
  id: string,
): Promise<InferenceCall | null> {
  return (
    (
      await sql.query<InferenceCall>(
        `SELECT id,organization_id AS "organizationId",turn_id AS "turnId",run_id AS "runId",attempt_id AS "attemptId",run_epoch AS "runEpoch",tools,model_options AS "modelOptions",actor_id AS "actorId",provider_id AS "providerId",provider_revision AS "providerRevision",model,user_prompt AS "userPrompt",system_prompt AS "systemPrompt",max_output_tokens AS "maxOutputTokens",execution_id AS "executionId",state,
    request_started_at IS NOT NULL AS started,lease_until>clock_timestamp() AS "leaseValid",deadline_at>clock_timestamp() AS "deadlineValid",budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date AS "budgetDayCurrent",to_char(budget_day,'YYYY-MM-DD') AS "budgetDay"
    FROM cloud_inference_calls WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
        [organizationId, id],
      )
    ).rows[0] ?? null
  );
}

export async function inferenceAllowed(
  sql: CloudSql,
  call: InferenceCall,
): Promise<boolean> {
  const grant = await sql.query(
    `SELECT p.id FROM cloud_ai_providers p JOIN cloud_memberships m ON m.organization_id=p.organization_id AND m.user_id=$3 JOIN cloud_users u ON u.id=m.user_id
    WHERE p.organization_id=$1 AND p.id=$2 AND p.inference_revision=$4 AND p.enabled AND m.active AND m.role<>'viewer' AND NOT u.disabled AND p.models ? $5
    FOR SHARE OF p,m,u`,
    [
      call.organizationId,
      call.providerId,
      call.actorId,
      call.providerRevision,
      call.model,
    ],
  );
  if (!grant.rows.length) return false;
  if (!call.runId) return true;
  const ownership = await sql.query(
    `SELECT a.id FROM cloud_run_attempts a
    JOIN cloud_runs r ON r.organization_id=a.organization_id AND r.id=a.run_id
    JOIN cloud_execution_workers w ON w.organization_id=a.organization_id AND w.id=a.worker_id
    WHERE a.organization_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.epoch=$4 AND a.epoch=r.epoch AND r.attempt_id=a.id
    AND a.state='running' AND a.lease_expires_at>clock_timestamp() AND r.deadline_at>clock_timestamp()
    AND r.state IN ('running','waiting','validating') AND w.enabled AND w.expires_at>clock_timestamp()`,
    [call.organizationId, call.runId, call.attemptId, call.runEpoch],
  );
  return (
    ownership.rows.length > 0 &&
    (await hasRunAuthority(
      sql,
      call.organizationId,
      await readRun(sql, call.organizationId, call.runId),
    ))
  );
}

export async function settleInference(
  sql: CloudSql,
  call: InferenceCall,
  state: ChatState,
  errorCode: string | null,
  answer?: string,
): Promise<void> {
  await sql.query(
    "UPDATE cloud_inference_calls SET state=$3,error_code=$4,actual_tokens=CASE WHEN request_started_at IS NULL THEN 0 ELSE actual_tokens END,lease_until=NULL WHERE organization_id=$1 AND id=$2",
    [call.organizationId, call.id, state, errorCode],
  );
  await sql.query(
    "UPDATE cloud_chat_turns SET state=$4,error_code=$5,answer=COALESCE($6,answer),revision=revision+1 WHERE organization_id=$1 AND id=$2 AND request_id=$3",
    [
      call.organizationId,
      call.turnId,
      call.id,
      state,
      errorCode,
      answer ?? null,
    ],
  );
}

export async function reapInference(
  sql: CloudSql,
  organizationId: string,
): Promise<void> {
  const rows = await sql.query<{ id: string }>(
    `SELECT id FROM cloud_inference_calls WHERE organization_id=$1 AND state IN ('queued','running','cancel_requested')
    AND (deadline_at<=clock_timestamp() OR (state<>'queued' AND lease_until<=clock_timestamp())) ORDER BY created_at,id LIMIT 100`,
    [organizationId],
  );
  for (const row of rows.rows) {
    const call = (await readInferenceCall(sql, organizationId, row.id))!;
    await expireInferenceCall(sql, call);
  }
}

export async function expireInferenceCall(
  sql: CloudSql,
  call: InferenceCall,
): Promise<void> {
  if (!call.started && call.deadlineValid && call.state === "running") {
    await requeueUnsentInference(sql, call);
  } else
    await settleInference(
      sql,
      call,
      call.state === "cancel_requested"
        ? "canceled"
        : call.started
          ? "unknown"
          : "failed",
      call.state === "cancel_requested" ? null : "interrupted",
    );
}

export async function requeueUnsentInference(
  sql: CloudSql,
  call: InferenceCall,
): Promise<void> {
  await sql.query(
    "UPDATE cloud_inference_calls SET state='queued',execution_id=NULL,lease_until=NULL WHERE organization_id=$1 AND id=$2",
    [call.organizationId, call.id],
  );
  await sql.query(
    "UPDATE cloud_chat_turns SET state='queued',revision=revision+1 WHERE organization_id=$1 AND id=$2 AND request_id=$3",
    [call.organizationId, call.turnId, call.id],
  );
}
