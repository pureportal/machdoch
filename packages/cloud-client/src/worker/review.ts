import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkerClaim } from "@machdoch/fleet-protocol/cloud-execution";
import { taskInferenceReceiptSchema } from "@machdoch/fleet-protocol/cloud-inference";
import {
  workerReviewResultSchema,
  type WorkerReviewReceipt,
} from "@machdoch/fleet-protocol/cloud-delivery";
import {
  RunnerConnection,
  RunnerRequestError,
  isTransientRunnerError,
} from "@machdoch/cloud-client";
import type { ActiveEnvironment } from "./guest-operations.ts";
import type { TaskUsage } from "./agent-loop.ts";

async function command(
  connection: RunnerConnection,
  endpoint: "review" | "review/result",
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  let failures = 0;
  while (true) {
    signal.throwIfAborted();
    try {
      return await connection.command(endpoint, input, signal);
    } catch (error) {
      if (
        endpoint === "review" &&
        error instanceof RunnerRequestError &&
        error.code === "provider_busy"
      ) {
        await delay(1000, undefined, { signal });
        continue;
      }
      if (!isTransientRunnerError(error) || ++failures > 2) throw error;
      await delay(500, undefined, { signal });
    }
  }
}

export async function reviewCandidate(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environment: ActiveEnvironment,
  usage: TaskUsage,
  candidateCommit: string,
  round: number,
): Promise<WorkerReviewReceipt> {
  const request = {
    requestId: randomUUID(),
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    candidateCommit,
    round,
  };
  taskInferenceReceiptSchema.parse(
    await command(connection, "review", request, environment.signal),
  );
  while (true) {
    const result = workerReviewResultSchema.parse(
      await command(connection, "review/result", request, environment.signal),
    );
    if (result.review) {
      usage.requests++;
      usage.tokens += result.chargedTokens;
      return result.review;
    }
    if (!["queued", "running", "cancel_requested"].includes(result.state)) {
      usage.tokens += result.chargedTokens;
      throw new Error(
        "The AI review did not complete. Review the provider and recorded usage before retrying.",
      );
    }
    await delay(500, undefined, { signal: environment.signal });
  }
}
