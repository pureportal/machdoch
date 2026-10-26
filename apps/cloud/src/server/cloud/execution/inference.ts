import type {
  TaskInferenceInput,
  TaskInferenceRead,
  TaskInferenceReceipt,
} from "@machdoch/fleet-protocol/cloud-inference";
import { CloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import {
  readInferenceProvider,
  readProviderBudget,
  requireInferenceCapacity,
} from "../ai/budgets";
import { lockInference, reapInference } from "../ai/inference-records";
import { executionDigest, mayExecute, readAttempt } from "./attempts";
import { requireWorker } from "./workers";
import {
  taskInferencePayload,
  taskInferenceReservationOverhead,
} from "@machdoch/fleet-protocol/cloud-task-context";

async function readReceipt(
  sql: CloudSql,
  organizationId: string,
  input: TaskInferenceRead,
): Promise<(TaskInferenceReceipt & { digest: string }) | null> {
  return (
    (
      await sql.query<
        TaskInferenceReceipt & { digest: string } & Record<string, unknown>
      >(
        `SELECT id AS "requestId",state,response,error_code AS "errorCode",COALESCE(actual_tokens,reserved_tokens) AS "chargedTokens",request_digest AS digest
    FROM cloud_inference_calls WHERE organization_id=$1 AND id=$2 AND run_id=$3 AND attempt_id=$4 AND run_epoch=$5`,
        [
          organizationId,
          input.requestId,
          input.runId,
          input.attemptId,
          input.epoch,
        ],
      )
    ).rows[0] ?? null
  );
}

export class CloudTaskInference {
  constructor(private readonly database: CloudDatabase) {}

  submit(
    token: string,
    input: TaskInferenceInput,
  ): Promise<TaskInferenceReceipt> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      await lockInference(sql, worker.organizationId);
      const { run, attempt } = await readAttempt(sql, worker, input);
      if (
        attempt.state !== "running" ||
        !(await mayExecute(sql, worker, run, attempt))
      )
        throw new CloudError(
          409,
          "attempt_stopped",
          "The task no longer has execution authority.",
        );
      await reapInference(sql, worker.organizationId);
      const digest = executionDigest(input);
      const previous = await readReceipt(sql, worker.organizationId, input);
      if (previous) {
        if (previous.digest !== digest)
          throw new CloudError(
            409,
            "request_conflict",
            "Use the original content when retrying an inference request.",
          );
        const { digest: _, ...receipt } = previous;
        return receipt;
      }
      if (!input.tools.length && input.modelOptions.toolChoice === "required")
        throw new CloudError(
          422,
          "tool_selection",
          "Add tools or use automatic tool selection.",
        );
      if (
        (
          await sql.query(
            "SELECT id FROM cloud_inference_calls WHERE organization_id=$1 AND id=$2",
            [worker.organizationId, input.requestId],
          )
        ).rows.length
      )
        throw new CloudError(
          409,
          "request_conflict",
          "Choose a new inference request ID.",
        );
      const usage = (
        await sql.query<{ tokens: number; calls: number; active: number }>(
          `SELECT COALESCE(sum(COALESCE(actual_tokens,reserved_tokens)),0)::double precision AS tokens,count(*)::integer AS calls,
        count(*) FILTER (WHERE state IN ('queued','running','cancel_requested'))::integer AS active
        FROM cloud_inference_calls WHERE organization_id=$1 AND run_id=$2`,
          [worker.organizationId, run.id],
        )
      ).rows[0]!;
      if (usage.active)
        throw new CloudError(
          409,
          "inference_active",
          "Wait for the task's current inference request.",
        );
      if (usage.calls >= 512)
        throw new CloudError(
          409,
          "inference_limit",
          "The task reached its inference request limit.",
        );
      const provider = await readInferenceProvider(
        sql,
        worker.organizationId,
        run.manifest.provider.id,
      );
      const { userPrompt, systemPrompt, toolsJson, optionsJson, inputBytes } =
        taskInferencePayload(run.manifest, input);
      if (
        inputBytes > 256 * 1024 ||
        Buffer.byteLength(toolsJson, "utf8") > 128 * 1024 ||
        Buffer.byteLength(input.context, "utf8") >
          run.manifest.contextLimitBytes
      )
        throw new CloudError(
          422,
          "context_limit",
          "Shorten the task context before requesting inference.",
        );
      const maxOutputTokens = Math.min(
        provider.maxOutputTokens,
        run.manifest.provider.maxOutputTokens,
        run.manifest.profile.maxTokens -
          usage.tokens -
          inputBytes -
          taskInferenceReservationOverhead,
      );
      if (maxOutputTokens < 1)
        throw new CloudError(
          409,
          "task_budget_exceeded",
          "The task's remaining token budget cannot cover this request.",
        );
      const reservation =
        inputBytes + maxOutputTokens + taskInferenceReservationOverhead;
      const budget = await readProviderBudget(
        sql,
        worker.organizationId,
        provider,
      );
      requireInferenceCapacity(budget, reservation);
      await sql.query(
        `INSERT INTO cloud_inference_calls (organization_id,id,run_id,attempt_id,run_epoch,request_digest,actor_id,provider_id,provider_revision,model,user_prompt,system_prompt,tools,reserved_tokens,max_output_tokens,budget_day,state,deadline_at,model_options)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::date,'queued',LEAST($17::timestamptz,clock_timestamp()+interval '120 seconds'),$18)`,
        [
          worker.organizationId,
          input.requestId,
          run.id,
          attempt.id,
          attempt.epoch,
          digest,
          run.actorId,
          provider.id,
          provider.inferenceRevision,
          run.manifest.profile.model,
          userPrompt,
          systemPrompt,
          toolsJson,
          reservation,
          maxOutputTokens,
          budget.budgetDay,
          run.deadlineAt,
          optionsJson,
        ],
      );
      const { digest: _, ...receipt } = (await readReceipt(
        sql,
        worker.organizationId,
        input,
      ))!;
      return receipt;
    });
  }

  get(token: string, input: TaskInferenceRead): Promise<TaskInferenceReceipt> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      await lockInference(sql, worker.organizationId);
      const { run, attempt } = await readAttempt(sql, worker, input);
      if (
        attempt.state !== "running" ||
        !(await mayExecute(sql, worker, run, attempt))
      )
        throw new CloudError(
          409,
          "attempt_stopped",
          "The task no longer has execution authority.",
        );
      await reapInference(sql, worker.organizationId);
      const receipt = await readReceipt(sql, worker.organizationId, input);
      if (!receipt)
        throw new CloudError(
          404,
          "not_found",
          "Inference request is unavailable.",
        );
      const { digest: _, ...result } = receipt;
      return result;
    });
  }
}
