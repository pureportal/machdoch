import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  cloudAgentStartSchema,
  type CloudAgentInference,
  type CloudAgentReply,
} from "@machdoch/fleet-protocol/cloud-agent";
import { taskInferenceReceiptSchema } from "@machdoch/fleet-protocol/cloud-inference";
import {
  sharedAgentTask,
  taskInferencePayload,
  taskInferenceReservationOverhead,
} from "@machdoch/fleet-protocol/cloud-task-context";
import type { WorkerClaim } from "@machdoch/fleet-protocol/cloud-execution";
import { workerProgressReceiptSchema } from "@machdoch/fleet-protocol/cloud-execution";
import {
  RunnerConnection,
  RunnerRequestError,
  isTransientRunnerError,
} from "@machdoch/cloud-client";
import type { ActiveEnvironment } from "./guest-operations.ts";

export interface TaskUsage {
  tokens: number;
  requests: number;
}
const inferenceErrors = new Map([
  [
    "provider_model_unavailable",
    "The configured model is unavailable. Update the provider and execution profile to use an available model.",
  ],
  [
    "provider_authentication",
    "The provider rejected its credentials. Update the provider credentials before retrying.",
  ],
  [
    "provider_access",
    "The provider denied access to this model. Review the provider permissions before retrying.",
  ],
  [
    "provider_billing",
    "The provider requires billing attention. Resolve it before retrying the task.",
  ],
  [
    "provider_rate_limited",
    "The provider rate limit was reached. Wait before starting another task.",
  ],
]);
const resultSchema = z.strictObject({
  status: z.enum(["executed", "failed"]),
  summary: z.string().min(1).max(8192),
  processTreeStopped: z.literal(true),
});

export async function authorize(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environment: ActiveEnvironment,
  state: "running" | "validating",
): Promise<void> {
  environment.signal.throwIfAborted();
  const receipt = workerProgressReceiptSchema.parse(
    await connection.command(
      "progress",
      {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        state,
      },
      environment.signal,
    ),
  );
  if (receipt.instruction !== "continue")
    throw new Error("Task execution authority ended");
}

async function requestInference(
  connection: RunnerConnection,
  operation: "inference" | "inference/result",
  input: Record<string, unknown> & { requestId: string },
  signal: AbortSignal,
) {
  let failures = 0;
  while (true) {
    signal.throwIfAborted();
    let value: unknown;
    try {
      value = await connection.command(operation, input, signal);
    } catch (error) {
      if (
        operation === "inference" &&
        error instanceof RunnerRequestError &&
        error.code === "provider_busy"
      ) {
        await delay(1000, undefined, { signal });
        continue;
      }
      if (!isTransientRunnerError(error) || ++failures > 2) throw error;
      await delay(500, undefined, { signal });
      continue;
    }
    const receipt = taskInferenceReceiptSchema.parse(value);
    if (receipt.requestId !== input.requestId)
      throw new Error("Inference receipt belongs to another request");
    return receipt;
  }
}

export async function agentInference(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environment: ActiveEnvironment,
  usage: TaskUsage,
  request: CloudAgentInference,
): Promise<CloudAgentReply> {
  try {
    await authorize(connection, claim, environment, "running");
    if (usage.requests >= 512)
      throw new Error("The task reached its inference limit");
    const baseBytes = taskInferencePayload(claim.manifest, {
      ...request,
      context: "",
    }).inputBytes;
    const available =
      claim.manifest.profile.maxTokens -
      usage.tokens -
      baseBytes -
      taskInferenceReservationOverhead;
    const output = Math.min(
      claim.manifest.provider.maxOutputTokens,
      Math.max(1, available - 256),
    );
    const limit = Math.min(
      claim.manifest.contextLimitBytes,
      available - output,
    );
    if (limit < 256)
      throw new Error(
        "The remaining allowance cannot cover the runtime instructions and tools. Increase the allowance before starting another task.",
      );
    if (Buffer.byteLength(request.context, "utf8") > limit)
      return {
        kind: "inference_limit",
        requestId: request.requestId,
        contextLimitBytes: Math.floor(limit),
      };
    const identity = {
      runId: claim.runId,
      attemptId: claim.attemptId,
      epoch: claim.epoch,
    };
    let receipt = await requestInference(
      connection,
      "inference",
      { ...identity, ...request },
      environment.signal,
    );
    while (["queued", "running", "cancel_requested"].includes(receipt.state)) {
      await delay(500, undefined, { signal: environment.signal });
      receipt = await requestInference(
        connection,
        "inference/result",
        { ...identity, requestId: request.requestId },
        environment.signal,
      );
    }
    usage.requests++;
    usage.tokens += receipt.chargedTokens;
    if (receipt.state !== "complete" || !receipt.response)
      throw new Error(
        inferenceErrors.get(receipt.errorCode ?? "") ??
          "The model request did not complete. Review the provider and recorded usage before retrying.",
      );
    await authorize(connection, claim, environment, "running");
    return {
      kind: "inference_result",
      requestId: request.requestId,
      response: receipt.response,
    };
  } catch (error) {
    environment.signal.throwIfAborted();
    return {
      kind: "inference_error",
      requestId: request.requestId,
      error: (error instanceof Error
        ? error.message
        : "Task inference failed"
      ).slice(0, 1024),
    };
  }
}

export async function runAgent(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environment: ActiveEnvironment,
  usage: TaskUsage,
  correction = "",
) {
  await authorize(connection, claim, environment, "running");
  const start = cloudAgentStartSchema.parse({
    kind: "start",
    task: sharedAgentTask(claim.manifest, correction),
    provider: claim.manifest.provider.provider,
    model: claim.manifest.profile.model,
    contextLimitBytes: claim.manifest.contextLimitBytes,
    durationMs: Math.max(
      1,
      Math.min(
        claim.manifest.profile.maxDurationSeconds * 1000,
        Date.parse(claim.deadlineAt) - Date.now(),
      ),
    ),
  });
  const response = await environment.sandbox.call(
    "run_agent",
    {
      start: JSON.stringify(start),
      ...(claim.manifest.profile.workspacePath
        ? { directory: claim.manifest.profile.workspacePath }
        : {}),
    },
    environment.signal,
    undefined,
    (request, signal) =>
      agentInference(
        connection,
        claim,
        {
          ...environment,
          signal: AbortSignal.any([environment.signal, signal]),
        },
        usage,
        request,
      ),
  );
  if (!response.ok) throw new Error(response.error);
  return resultSchema.parse(response.result);
}
