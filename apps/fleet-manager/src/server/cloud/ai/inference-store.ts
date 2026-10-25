import { randomUUID } from "node:crypto";
import type { ChatState } from "../../../lib/cloud-chat-contract";
import type { InferenceResponse } from "@machdoch/fleet-protocol/cloud-inference";
import { readRun } from "../execution/records";
import { CloudError } from "../access";
import type { CloudDatabase } from "../database";
import {
  readInferenceProvider,
  readProviderBudget,
  requireInferenceCapacity,
} from "./budgets";
import {
  inferenceLeaseSeconds,
  expireInferenceCall,
  inferenceAllowed,
  lockInference,
  readInferenceCall,
  reapInference,
  requeueUnsentInference,
  settleInference,
  type InferenceCall,
} from "./inference-records";

export interface ClaimedInference extends InferenceCall {
  executionId: string;
  leaseRemainingMs: number;
  deadlineRemainingMs: number;
}

export class CloudInferenceStore {
  constructor(private readonly database: CloudDatabase) {}

  async recover(): Promise<void> {
    const organizations = await this.database.transaction(
      async (sql) =>
        (
          await sql.query<{
            organization_id: string;
          }>(`SELECT DISTINCT organization_id FROM cloud_inference_calls WHERE state IN ('queued','running','cancel_requested')
      AND (deadline_at<=clock_timestamp() OR lease_until<=clock_timestamp()) LIMIT 100`)
        ).rows,
    );
    for (const row of organizations)
      await this.database.transaction(async (sql) => {
        await lockInference(sql, row.organization_id);
        await reapInference(sql, row.organization_id);
      });
  }

  pending(limit: number): Promise<{ organizationId: string; id: string }[]> {
    return this.database.transaction(
      async (sql) =>
        (
          await sql.query<{ organizationId: string; id: string }>(
            "SELECT organization_id AS \"organizationId\",id FROM cloud_inference_calls WHERE state='queued' ORDER BY created_at,id LIMIT $1",
            [limit],
          )
        ).rows,
    );
  }

  claim(organizationId: string, id: string): Promise<ClaimedInference | null> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, organizationId);
      await reapInference(sql, organizationId);
      const call = await readInferenceCall(sql, organizationId, id);
      if (!call || call.state !== "queued") return null;
      if (!call.deadlineValid) {
        await expireInferenceCall(sql, call);
        return null;
      }
      if (!(await inferenceAllowed(sql, call))) {
        await settleInference(sql, call, "failed", "permission_changed");
        return null;
      }
      const reservation = (
        await sql.query<{ reserved_tokens: number }>(
          "SELECT reserved_tokens FROM cloud_inference_calls WHERE organization_id=$1 AND id=$2",
          [organizationId, id],
        )
      ).rows[0]!;
      const provider = await readInferenceProvider(
        sql,
        organizationId,
        call.providerId,
      );
      const budget = await readProviderBudget(
        sql,
        organizationId,
        provider,
        id,
      );
      try {
        requireInferenceCapacity(budget, reservation.reserved_tokens);
        if (call.maxOutputTokens > provider.maxOutputTokens)
          throw new CloudError(
            409,
            "output_limit_changed",
            "The provider output limit changed. Submit a new request.",
          );
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        await settleInference(sql, call, "failed", error.code);
        return null;
      }
      const budgetDay = budget.budgetDay;
      const executionId = randomUUID();
      await sql.query(
        "UPDATE cloud_inference_calls SET state='running',execution_id=$3,lease_until=LEAST(deadline_at,clock_timestamp()+$4*interval '1 second'),budget_day=$5::date WHERE organization_id=$1 AND id=$2",
        [organizationId, id, executionId, inferenceLeaseSeconds, budgetDay],
      );
      await sql.query(
        "UPDATE cloud_chat_turns SET state='running',revision=revision+1 WHERE organization_id=$1 AND id=$2 AND request_id=$3",
        [organizationId, call.turnId, id],
      );
      const timing = (
        await sql.query<{
          leaseRemainingMs: number;
          deadlineRemainingMs: number;
        }>(
          `SELECT extract(epoch FROM lease_until-clock_timestamp())::double precision*1000 AS "leaseRemainingMs",extract(epoch FROM deadline_at-clock_timestamp())::double precision*1000 AS "deadlineRemainingMs" FROM cloud_inference_calls WHERE organization_id=$1 AND id=$2`,
          [organizationId, id],
        )
      ).rows[0]!;
      return {
        ...call,
        state: "running",
        executionId,
        budgetDay,
        budgetDayCurrent: true,
        leaseValid: true,
        ...timing,
      };
    });
  }

  guard(
    organizationId: string,
    id: string,
    executionId: string,
    options: { begin?: boolean; answer?: string } = {},
  ): Promise<{ allowed: boolean; leaseRemainingMs: number }> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, organizationId);
      await reapInference(sql, organizationId);
      const call = await readInferenceCall(sql, organizationId, id);
      if (
        !call ||
        call.executionId !== executionId ||
        !["running", "cancel_requested"].includes(call.state)
      )
        return { allowed: false, leaseRemainingMs: 0 };
      if (!call.leaseValid || !call.deadlineValid) {
        await expireInferenceCall(sql, call);
        return { allowed: false, leaseRemainingMs: 0 };
      }
      if (
        call.state === "cancel_requested" ||
        !(await inferenceAllowed(sql, call))
      ) {
        await settleInference(
          sql,
          call,
          "canceled",
          call.state === "cancel_requested" ? null : "permission_changed",
        );
        return { allowed: false, leaseRemainingMs: 0 };
      }
      if (options.begin && call.started)
        return { allowed: false, leaseRemainingMs: 0 };
      if (options.begin) {
        const provider = await readInferenceProvider(
          sql,
          organizationId,
          call.providerId,
        );
        const reservation = (
          await sql.query<{ reserved_tokens: number }>(
            "SELECT reserved_tokens FROM cloud_inference_calls WHERE organization_id=$1 AND id=$2",
            [organizationId, id],
          )
        ).rows[0]!;
        const budget = await readProviderBudget(
          sql,
          organizationId,
          provider,
          id,
        );
        try {
          requireInferenceCapacity(budget, reservation.reserved_tokens);
          if (call.maxOutputTokens > provider.maxOutputTokens)
            throw new CloudError(
              409,
              "output_limit_changed",
              "The provider output limit changed. Submit a new request.",
            );
        } catch (error) {
          if (!(error instanceof CloudError)) throw error;
          await settleInference(sql, call, "failed", error.code);
          return { allowed: false, leaseRemainingMs: 0 };
        }
        await sql.query(
          "UPDATE cloud_inference_calls SET budget_day=$3::date WHERE organization_id=$1 AND id=$2",
          [organizationId, id, budget.budgetDay],
        );
      }
      const lease = (
        await sql.query<{ leaseRemainingMs: number }>(
          `UPDATE cloud_inference_calls SET lease_until=LEAST(deadline_at,clock_timestamp()+$4*interval '1 second'),request_started_at=CASE WHEN $5 THEN COALESCE(request_started_at,clock_timestamp()) ELSE request_started_at END
        WHERE organization_id=$1 AND id=$2 AND execution_id=$3 RETURNING extract(epoch FROM lease_until-clock_timestamp())::double precision*1000 AS "leaseRemainingMs"`,
          [
            organizationId,
            id,
            executionId,
            inferenceLeaseSeconds,
            options.begin ?? false,
          ],
        )
      ).rows[0]!;
      if (options.answer !== undefined)
        await sql.query(
          "UPDATE cloud_chat_turns SET answer=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2 AND request_id=$3 AND answer<>$4",
          [organizationId, call.turnId, id, options.answer],
        );
      return { allowed: true, leaseRemainingMs: lease.leaseRemainingMs };
    });
  }

  finish(
    organizationId: string,
    id: string,
    executionId: string,
    result: {
      state: "complete" | "failed" | "unknown";
      answer?: string;
      tokens: number | null;
      errorCode: string | null;
      response?: InferenceResponse;
    },
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, organizationId);
      await reapInference(sql, organizationId);
      const call = await readInferenceCall(sql, organizationId, id);
      if (!call || call.executionId !== executionId) return;
      if (result.tokens !== null && call.started)
        await sql.query(
          "UPDATE cloud_inference_calls SET actual_tokens=$3 WHERE organization_id=$1 AND id=$2 AND actual_tokens IS NULL",
          [organizationId, id, result.tokens],
        );
      if (!["running", "cancel_requested"].includes(call.state)) return;
      if (!call.leaseValid || !call.deadlineValid) {
        await expireInferenceCall(sql, call);
        return;
      }
      let state: ChatState = result.state;
      let errorCode = result.errorCode;
      let answer = result.answer;
      if (
        call.state === "cancel_requested" ||
        !(await inferenceAllowed(sql, call))
      ) {
        state = "canceled";
        errorCode =
          call.state === "cancel_requested" ? null : "permission_changed";
        answer = undefined;
      }
      if (state === "unknown" && !call.started) {
        await requeueUnsentInference(sql, call);
        return;
      }
      if (state === "complete" && call.runId) {
        const run = await readRun(sql, organizationId, call.runId);
        const usage = (
          await sql.query<{ tokens: number }>(
            "SELECT COALESCE(sum(COALESCE(actual_tokens,reserved_tokens)),0)::double precision AS tokens FROM cloud_inference_calls WHERE organization_id=$1 AND run_id=$2",
            [organizationId, call.runId],
          )
        ).rows[0]!;
        if (usage.tokens > run.manifest.profile.maxTokens) {
          state = "failed";
          errorCode = "task_budget_exceeded";
        }
      }
      await settleInference(sql, call, state, errorCode, answer);
      if (state === "complete" && result.response)
        await sql.query(
          "UPDATE cloud_inference_calls SET response=$3 WHERE organization_id=$1 AND id=$2",
          [organizationId, id, JSON.stringify(result.response)],
        );
    });
  }
}
