import { createHash } from "node:crypto";
import type {
  AttemptIdentity,
  WorkerClaim,
  WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import { CloudError } from "../access";
import type { CloudSql } from "../database";
import {
  fenceRun,
  hasRunAuthority,
  readRun,
  recordRun,
  terminalStates,
  type StoredRun,
} from "./records";
import type { WorkerIdentity } from "./workers";
import { requireResultArtifacts } from "./artifact-records";

export const leaseSeconds = 90;
export const localStopSeconds = 60;
export function executionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface StoredAttempt extends Record<string, unknown> {
  id: string;
  state: string;
  epoch: number;
  leaseValid: boolean;
  deadlineValid: boolean;
  leaseExpiresAt: string;
  secondsRemaining: number;
  finishDigest: string | null;
  acceptDigest: string | null;
}

export async function readAttempt(
  sql: CloudSql,
  worker: WorkerIdentity,
  input: AttemptIdentity,
): Promise<{ run: StoredRun; attempt: StoredAttempt }> {
  const attempt = (
    await sql.query<StoredAttempt>(
      `SELECT a.id,a.state,a.epoch,a.lease_expires_at>clock_timestamp() AS "leaseValid",r.deadline_at>clock_timestamp() AS "deadlineValid",
    floor(extract(epoch FROM LEAST(a.lease_expires_at,r.deadline_at)-clock_timestamp()))::integer AS "secondsRemaining",
    to_char(a.lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "leaseExpiresAt",a.finish_digest AS "finishDigest",a.accept_digest AS "acceptDigest"
    FROM cloud_run_attempts a JOIN cloud_runs r ON r.organization_id=a.organization_id AND r.id=a.run_id
    WHERE a.organization_id=$1 AND a.worker_id=$2 AND a.id=$3 AND a.run_id=$4 AND a.epoch=$5 FOR UPDATE OF a`,
      [
        worker.organizationId,
        worker.id,
        input.attemptId,
        input.runId,
        input.epoch,
      ],
    )
  ).rows[0];
  if (!attempt)
    throw new CloudError(
      404,
      "attempt_unavailable",
      "This attempt does not belong to the runner.",
    );
  return {
    attempt,
    run: await readRun(sql, worker.organizationId, input.runId),
  };
}

export async function mayExecute(
  sql: CloudSql,
  worker: WorkerIdentity,
  run: StoredRun,
  attempt: StoredAttempt,
): Promise<boolean> {
  if (
    terminalStates.has(run.state) ||
    attempt.state === "stopped" ||
    run.epoch !== attempt.epoch ||
    ["cancel_requested", "reconciling"].includes(run.state)
  )
    return false;
  if (
    !attempt.deadlineValid ||
    !attempt.leaseValid ||
    !worker.enabled ||
    worker.expired ||
    !(await hasRunAuthority(sql, worker.organizationId, run))
  ) {
    await fenceRun(
      sql,
      worker.organizationId,
      run,
      !attempt.deadlineValid ? "timed_out" : "failed",
      "Execution authority expired or was revoked",
    );
    return false;
  }
  return true;
}

export function claimReceipt(
  run: StoredRun,
  attempt: StoredAttempt,
): WorkerClaim {
  return {
    runId: run.id,
    attemptId: attempt.id,
    epoch: attempt.epoch,
    manifest: run.manifest,
    inputDigest: run.inputDigest,
    leaseExpiresAt: attempt.leaseExpiresAt,
    deadlineAt: run.deadlineAt,
  };
}

export async function settleRun(
  sql: CloudSql,
  organizationId: string,
  id: string,
): Promise<void> {
  const run = await readRun(sql, organizationId, id);
  if (terminalStates.has(run.state) || !run.attemptId) return;
  const receipt = (
    await sql.query<{ result: WorkerFinish | null; stopped: boolean }>(
      `SELECT r.result,a.state='stopped' AS stopped FROM cloud_runs r JOIN cloud_run_attempts a ON a.organization_id=r.organization_id AND a.id=r.attempt_id WHERE r.organization_id=$1 AND r.id=$2`,
      [organizationId, id],
    )
  ).rows[0];
  if (!receipt?.stopped || !receipt.result) return;
  const effects = (
    await sql.query<{ state: string }>(
      "SELECT state FROM cloud_run_effects WHERE organization_id=$1 AND run_id=$2",
      [organizationId, id],
    )
  ).rows;
  if (effects.some((effect) => ["pending", "unknown"].includes(effect.state))) {
    if (run.state !== "reconciling") {
      await sql.query(
        "UPDATE cloud_runs SET state='reconciling',epoch=epoch+1,revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [organizationId, id],
      );
      await recordRun(
        sql,
        organizationId,
        id,
        "Waiting for external action reconciliation",
      );
    }
    return;
  }
  const outcome =
    run.stopReason ??
    (effects.some((effect) => effect.state === "failed")
      ? "failed"
      : receipt.result.outcome);
  await sql.query(
    "UPDATE cloud_runs SET state=$3,summary=$4,epoch=epoch+1,revision=revision+1 WHERE organization_id=$1 AND id=$2",
    [organizationId, id, outcome, receipt.result.summary],
  );
  await recordRun(
    sql,
    organizationId,
    id,
    "Runner stopped and external actions settled",
  );
}

export async function validateSuccessfulResult(
  sql: CloudSql,
  organizationId: string,
  run: StoredRun,
  input: WorkerFinish,
): Promise<void> {
  if (!["validating", "publishing"].includes(run.state))
    throw new CloudError(
      409,
      "validation_required",
      "Validate the candidate before completing the task.",
    );
  if (!input.candidateCommit)
    throw new CloudError(
      422,
      "candidate_required",
      "Record the validated candidate commit.",
    );
  const inference = (
    await sql.query<{ tokens: number; active: number }>(
      `SELECT COALESCE(sum(COALESCE(actual_tokens,reserved_tokens)),0)::double precision AS tokens,
    count(*) FILTER (WHERE state IN ('queued','running','cancel_requested'))::integer AS active
    FROM cloud_inference_calls WHERE organization_id=$1 AND run_id=$2`,
      [organizationId, run.id],
    )
  ).rows[0]!;
  if (inference.active)
    throw new CloudError(
      409,
      "inference_active",
      "Wait for task inference to stop before completing the task.",
    );
  if (
    Math.max(input.tokensUsed, inference.tokens) >
    run.manifest.profile.maxTokens
  )
    throw new CloudError(
      409,
      "budget_exceeded",
      "The task exceeded its token budget.",
    );
  if (
    run.manifest.profile.requiredChecks.some(
      (required) =>
        !input.checks.some(
          (check) =>
            check.name === required.name &&
            check.passed &&
            check.candidateCommit === input.candidateCommit,
        ),
    )
  )
    throw new CloudError(
      409,
      "evidence_required",
      "Every required check must pass for this candidate commit.",
    );
  await requireResultArtifacts(
    sql,
    organizationId,
    input,
    run.manifest.profile.requiredChecks,
  );
}
