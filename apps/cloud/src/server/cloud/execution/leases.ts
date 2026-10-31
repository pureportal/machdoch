import { randomUUID } from "node:crypto";
import type {
  AttemptIdentity,
  WorkerAccept,
  WorkerActivity,
  WorkerClaim,
  WorkerFinish,
  WorkerCompletionReceipt,
  WorkerLeaseReceipt,
  WorkerProgress,
  WorkerRecovery,
  WorkerAvailability,
} from "@machdoch/fleet-protocol/cloud-execution";
import { CloudError } from "../access";
import type { CloudDatabase } from "../database";
import {
  claimReceipt,
  executionDigest,
  leaseSeconds,
  localStopSeconds,
  mayExecute,
  readAttempt,
  settleRun,
  validateSuccessfulResult,
} from "./attempts";
import {
  expireRuns,
  fenceRun,
  hasRunAuthority,
  readRun,
  recordRun,
  terminalStates,
} from "./records";
import { requireWorker } from "./workers";

const maximumRunActivity = 2000;

export class CloudExecutionLeases {
  constructor(private readonly database: CloudDatabase) {}

  available(token: string): Promise<WorkerAvailability> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const enabled = worker.enabled && !worker.expired;
      await sql.query(
        "UPDATE cloud_execution_workers SET last_seen_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, worker.id],
      );
      const available =
        enabled &&
        (worker.target === "cloud" || worker.workspaceBinding !== null) &&
        (
          await sql.query(
            `SELECT r.id FROM cloud_runs r JOIN cloud_execution_profiles p ON p.organization_id=r.organization_id AND p.id=r.profile_id
        WHERE r.organization_id=$1 AND r.profile_id=$2 AND r.state='queued' AND r.deadline_at>clock_timestamp() AND p.enabled AND p.revision=$3
        AND NOT EXISTS (SELECT 1 FROM cloud_run_attempts a WHERE a.organization_id=$1 AND a.worker_id=$4 AND a.state<>'stopped') LIMIT 1`,
            [
              worker.organizationId,
              worker.profileId,
              worker.profileRevision,
              worker.id,
            ],
          )
        ).rows.length > 0;
      return { workerId: worker.id, enabled, available };
    });
  }

  recover(token: string, claimId: string): Promise<WorkerRecovery> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      await expireRuns(sql, worker.organizationId);
      const previous = (
        await sql.query<{
          id: string;
          run_id: string;
          epoch: number;
          state: NonNullable<WorkerRecovery["recovery"]>["attemptState"];
        }>(
          "SELECT id,run_id,epoch,state FROM cloud_run_attempts WHERE organization_id=$1 AND worker_id=$2 AND claim_id=$3",
          [worker.organizationId, worker.id, claimId],
        )
      ).rows[0];
      if (!previous)
        return {
          workerId: worker.id,
          enabled: worker.enabled && !worker.expired,
          recovery: null,
        };
      const { run, attempt } = await readAttempt(sql, worker, {
        runId: previous.run_id,
        attemptId: previous.id,
        epoch: previous.epoch,
      });
      const usage = (
        await sql.query<{ tokens: number }>(
          "SELECT COALESCE(sum(COALESCE(actual_tokens,reserved_tokens)),0)::double precision AS tokens FROM cloud_inference_calls WHERE organization_id=$1 AND run_id=$2",
          [worker.organizationId, run.id],
        )
      ).rows[0]!;
      return {
        workerId: worker.id,
        enabled: worker.enabled && !worker.expired,
        recovery: {
          grant: {
            runId: run.id,
            attemptId: attempt.id,
            epoch: attempt.epoch,
            inputDigest: run.inputDigest,
          },
          state: run.state,
          attemptState: previous.state,
          reason: run.stopMessage,
          tokensUsed: usage.tokens,
        },
      };
    });
  }

  claim(
    token: string,
    claimId: string,
  ): Promise<{ claim: WorkerClaim | null; localStopSeconds: number }> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      if (!worker.enabled || worker.expired)
        throw new CloudError(
          403,
          "runner_revoked",
          "Runner access has ended. Enroll a new runner.",
        );
      await expireRuns(sql, worker.organizationId);
      await sql.query(
        "UPDATE cloud_execution_workers SET last_seen_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, worker.id],
      );
      const previous = (
        await sql.query<{ id: string; run_id: string; epoch: number }>(
          "SELECT id,run_id,epoch FROM cloud_run_attempts WHERE organization_id=$1 AND worker_id=$2 AND claim_id=$3",
          [worker.organizationId, worker.id, claimId],
        )
      ).rows[0];
      if (previous) {
        const { run, attempt } = await readAttempt(sql, worker, {
          runId: previous.run_id,
          attemptId: previous.id,
          epoch: previous.epoch,
        });
        return {
          claim: (await mayExecute(sql, worker, run, attempt))
            ? claimReceipt(run, attempt)
            : null,
          localStopSeconds: Math.max(
            0,
            Math.min(localStopSeconds, attempt.secondsRemaining),
          ),
        };
      }
      const busy = await sql.query(
        "SELECT id FROM cloud_run_attempts WHERE organization_id=$1 AND worker_id=$2 AND state<>'stopped'",
        [worker.organizationId, worker.id],
      );
      if (busy.rows.length) return { claim: null, localStopSeconds };
      if (worker.target !== "cloud" && !worker.workspaceBinding)
        throw new CloudError(
          409,
          "workspace_binding_required",
          "Connect this runner to a client workspace before claiming tasks.",
        );
      const candidates = await sql.query<{ id: string }>(
        `SELECT r.id FROM cloud_runs r JOIN cloud_execution_profiles p ON p.organization_id=r.organization_id AND p.id=r.profile_id
        WHERE r.organization_id=$1 AND r.profile_id=$2 AND r.state='queued' AND r.deadline_at>clock_timestamp() AND p.enabled AND p.revision=$3
        ORDER BY r.created_at,r.id LIMIT 20`,
        [worker.organizationId, worker.profileId, worker.profileRevision],
      );
      for (const candidate of candidates.rows) {
        const run = await readRun(sql, worker.organizationId, candidate.id);
        if (!(await hasRunAuthority(sql, worker.organizationId, run))) {
          await fenceRun(
            sql,
            worker.organizationId,
            run,
            "failed",
            "Task grant is no longer authorized",
          );
          continue;
        }
        const attemptId = randomUUID();
        const epoch = run.epoch + 1;
        await sql.query(
          `INSERT INTO cloud_run_attempts (organization_id,id,run_id,worker_id,claim_id,epoch,state,lease_expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,'preparing',LEAST($7::timestamptz,clock_timestamp()+$8*interval '1 second'))`,
          [
            worker.organizationId,
            attemptId,
            run.id,
            worker.id,
            claimId,
            epoch,
            run.deadlineAt,
            leaseSeconds,
          ],
        );
        await sql.query(
          "UPDATE cloud_runs SET state='preparing',epoch=$3,attempt_id=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2",
          [worker.organizationId, run.id, epoch, attemptId],
        );
        await recordRun(
          sql,
          worker.organizationId,
          run.id,
          "Runner claimed task",
        );
        const accepted = await readAttempt(sql, worker, {
          runId: run.id,
          attemptId,
          epoch,
        });
        return {
          claim: claimReceipt(accepted.run, accepted.attempt),
          localStopSeconds: Math.max(
            0,
            Math.min(localStopSeconds, accepted.attempt.secondsRemaining),
          ),
        };
      }
      return { claim: null, localStopSeconds };
    });
  }

  accept(token: string, input: WorkerAccept): Promise<WorkerLeaseReceipt> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const { run, attempt } = await readAttempt(sql, worker, input);
      if (!(await mayExecute(sql, worker, run, attempt)))
        return { instruction: "stop", localStopSeconds: 0 };
      const grant: WorkerLeaseReceipt = {
        instruction: "continue",
        leaseExpiresAt: attempt.leaseExpiresAt,
        localStopSeconds: Math.max(
          0,
          Math.min(localStopSeconds, attempt.secondsRemaining),
        ),
      };
      const digest = executionDigest(input);
      if (attempt.acceptDigest) {
        if (attempt.acceptDigest !== digest)
          throw new CloudError(
            409,
            "acceptance_conflict",
            "The attempt was already accepted with another environment.",
          );
        return grant;
      }
      if (
        run.state !== "preparing" ||
        input.baseCommit !== run.manifest.profile.baseCommit ||
        input.isolation !==
          (run.manifest.profile.target === "client"
            ? "independent-checkout"
            : "microvm")
      )
        throw new CloudError(
          409,
          "environment_mismatch",
          "The environment does not match the execution grant.",
        );
      await sql.query(
        "UPDATE cloud_run_attempts SET environment_id=$3,accept_digest=$4,state='running' WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, attempt.id, input.environmentId, digest],
      );
      await sql.query(
        "UPDATE cloud_runs SET state='running',revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, run.id],
      );
      await recordRun(
        sql,
        worker.organizationId,
        run.id,
        "Runner accepted the execution grant",
      );
      return grant;
    });
  }

  heartbeat(
    token: string,
    input: AttemptIdentity,
  ): Promise<WorkerLeaseReceipt> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const { run, attempt } = await readAttempt(sql, worker, input);
      if (!(await mayExecute(sql, worker, run, attempt)))
        return { instruction: "stop", localStopSeconds: 0 };
      const lease = (
        await sql.query<{ leaseExpiresAt: string; secondsRemaining: number }>(
          `UPDATE cloud_run_attempts SET lease_expires_at=LEAST($3::timestamptz,clock_timestamp()+$4*interval '1 second') WHERE organization_id=$1 AND id=$2
        RETURNING to_char(lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "leaseExpiresAt",floor(extract(epoch FROM lease_expires_at-clock_timestamp()))::integer AS "secondsRemaining"`,
          [worker.organizationId, attempt.id, run.deadlineAt, leaseSeconds],
        )
      ).rows[0]!;
      await sql.query(
        "UPDATE cloud_execution_workers SET last_seen_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, worker.id],
      );
      return {
        instruction: "continue",
        leaseExpiresAt: lease.leaseExpiresAt,
        localStopSeconds: Math.max(
          0,
          Math.min(localStopSeconds, lease.secondsRemaining),
        ),
      };
    });
  }

  progress(
    token: string,
    input: WorkerProgress,
  ): Promise<{ instruction: "continue" | "stop" }> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const { run, attempt } = await readAttempt(sql, worker, input);
      if (!(await mayExecute(sql, worker, run, attempt)))
        return { instruction: "stop" };
      if (!attempt.acceptDigest || run.state === "publishing")
        throw new CloudError(
          409,
          "invalid_transition",
          "The attempt cannot enter this state.",
        );
      if (run.state !== input.state) {
        await sql.query(
          "UPDATE cloud_runs SET state=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2",
          [worker.organizationId, run.id, input.state],
        );
        await recordRun(
          sql,
          worker.organizationId,
          run.id,
          `Runner entered ${input.state}`,
        );
      }
      return { instruction: "continue" };
    });
  }

  activity(
    token: string,
    input: WorkerActivity,
  ): Promise<{ instruction: "continue" | "stop" }> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const { run, attempt } = await readAttempt(sql, worker, input);
      if (!(await mayExecute(sql, worker, run, attempt)))
        return { instruction: "stop" };
      const recorded = await sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM cloud_run_activity WHERE organization_id=$1 AND run_id=$2",
        [worker.organizationId, run.id],
      );
      if (recorded.rows[0]!.count + input.entries.length > maximumRunActivity)
        return { instruction: "continue" };
      for (const entry of input.entries)
        await sql.query(
          "INSERT INTO cloud_run_activity (organization_id,id,run_id,title,detail,status) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            worker.organizationId,
            randomUUID(),
            run.id,
            entry.title,
            entry.detail,
            entry.status,
          ],
        );
      return { instruction: "continue" };
    });
  }

  finish(token: string, input: WorkerFinish): Promise<WorkerCompletionReceipt> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const { run, attempt } = await readAttempt(sql, worker, input);
      const digest = executionDigest(input);
      if (attempt.finishDigest) {
        if (attempt.finishDigest !== digest)
          throw new CloudError(
            409,
            "result_conflict",
            "A different result was already recorded for this attempt.",
          );
        return { accepted: true, state: run.state };
      }
      if (run.attemptId !== attempt.id || terminalStates.has(run.state))
        throw new CloudError(
          409,
          "stale_attempt",
          "This attempt no longer owns the task.",
        );
      if (input.inputDigest !== run.inputDigest)
        throw new CloudError(
          409,
          "manifest_mismatch",
          "The result does not match the task inputs.",
        );
      const permitted = await mayExecute(sql, worker, run, attempt);
      if (input.outcome === "succeeded") {
        if (!permitted) {
          const current = await readRun(sql, worker.organizationId, run.id);
          return {
            accepted: false,
            state: current.state,
            requiredOutcome: current.stopReason ?? "failed",
          };
        }
        await validateSuccessfulResult(sql, worker.organizationId, run, input);
      }
      await sql.query(
        "UPDATE cloud_run_attempts SET state='stopped',finish_digest=$3 WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, attempt.id, digest],
      );
      await sql.query(
        "UPDATE cloud_runs SET result=$3 WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, run.id, JSON.stringify(input)],
      );
      await settleRun(sql, worker.organizationId, run.id);
      return {
        accepted: true,
        state: (await readRun(sql, worker.organizationId, run.id)).state,
      };
    });
  }
}
