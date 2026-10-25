import type { AttemptIdentity } from "@machdoch/fleet-protocol/cloud-execution";
import { CloudError } from "../access";
import type { CloudDatabase } from "../database";
import { mayExecute, readAttempt, settleRun } from "./attempts";
import { lockExecution, recordRun } from "./records";
import { requireWorker } from "./workers";
import { runPlanningChanged } from "./planning-context";

export class CloudExecutionEffects {
  constructor(private readonly database: CloudDatabase) {}

  reserve(
    token: string,
    identity: AttemptIdentity,
    id: string,
    resource: string,
    requestDigest: string,
  ): Promise<{
    id: string;
    action: "dispatch" | "reconcile" | "settled" | "stop";
    receipt?: Record<string, unknown>;
  }> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const { run, attempt } = await readAttempt(sql, worker, identity);
      if (!(await mayExecute(sql, worker, run, attempt)))
        return { id, action: "stop" };
      if (
        !attempt.acceptDigest ||
        !["validating", "publishing"].includes(run.state)
      )
        throw new CloudError(
          409,
          "validation_required",
          "Validate the candidate before publishing.",
        );
      const previous = (
        await sql.query<{
          run_id: string;
          attempt_id: string;
          epoch: number;
          resource: string;
          request_digest: string;
          state: string;
          receipt: Record<string, unknown> | null;
        }>(
          "SELECT run_id,attempt_id,epoch,resource,request_digest,state,receipt FROM cloud_run_effects WHERE organization_id=$1 AND id=$2",
          [worker.organizationId, id],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.run_id !== run.id ||
          previous.attempt_id !== attempt.id ||
          previous.epoch !== identity.epoch ||
          previous.resource !== resource ||
          previous.request_digest !== requestDigest
        )
          throw new CloudError(
            409,
            "effect_conflict",
            "This action identifier already belongs to another request.",
          );
        return {
          id,
          action: ["pending", "unknown"].includes(previous.state)
            ? "reconcile"
            : "settled",
          ...(previous.receipt ? { receipt: previous.receipt } : {}),
        };
      }
      if (await runPlanningChanged(sql, worker.organizationId, run))
        throw new CloudError(
          409,
          "planning_changed",
          "Planning changed after this task started. Review the current issue or project before publishing a new result.",
        );
      if (
        (
          await sql.query(
            "SELECT id FROM cloud_run_effects WHERE organization_id=$1 AND resource=$2 AND state IN ('pending','unknown')",
            [worker.organizationId, resource],
          )
        ).rows.length
      )
        throw new CloudError(
          409,
          "effect_unresolved",
          "An earlier action for this resource must be reconciled first.",
        );
      await sql.query(
        "INSERT INTO cloud_run_effects (organization_id,id,run_id,attempt_id,epoch,resource,request_digest,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')",
        [
          worker.organizationId,
          id,
          run.id,
          attempt.id,
          identity.epoch,
          resource,
          requestDigest,
        ],
      );
      if (run.state !== "publishing") {
        await sql.query(
          "UPDATE cloud_runs SET state='publishing',revision=revision+1 WHERE organization_id=$1 AND id=$2",
          [worker.organizationId, run.id],
        );
        await recordRun(
          sql,
          worker.organizationId,
          run.id,
          "Publication intent recorded",
        );
      }
      return { id, action: "dispatch" };
    });
  }

  resolve(
    organizationId: string,
    id: string,
    state: "unknown" | "succeeded" | "failed",
    receipt: Record<string, unknown>,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await lockExecution(sql, organizationId);
      const effect = (
        await sql.query<{
          run_id: string;
          state: string;
          receiptMatches: boolean;
        }>(
          'SELECT run_id,state,receipt=$3::jsonb AS "receiptMatches" FROM cloud_run_effects WHERE organization_id=$1 AND id=$2 FOR UPDATE',
          [organizationId, id, JSON.stringify(receipt)],
        )
      ).rows[0];
      if (!effect)
        throw new CloudError(
          404,
          "effect_unavailable",
          "The publication action is unavailable.",
        );
      if (["succeeded", "failed"].includes(effect.state)) {
        if (effect.state !== state || !effect.receiptMatches)
          throw new CloudError(
            409,
            "receipt_conflict",
            "This action already has a different final receipt.",
          );
        return;
      }
      await sql.query(
        "UPDATE cloud_run_effects SET state=$3,receipt=$4 WHERE organization_id=$1 AND id=$2",
        [organizationId, id, state, JSON.stringify(receipt)],
      );
      await settleRun(sql, organizationId, effect.run_id);
    });
  }
}
