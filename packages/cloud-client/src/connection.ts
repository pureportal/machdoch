import {
  workerClaimResponseSchema,
  workerRecoverySchema,
  workerCompletionReceiptSchema,
  workerLeaseReceiptSchema,
  workerAvailabilitySchema,
  workerRegistrationSchema,
  type ClientWorkspaceBinding,
  type WorkerClaim,
  type WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import type { RepositoryRequest } from "@machdoch/fleet-protocol/cloud-repository";
import { maximumRepositoryTransferBytes } from "@machdoch/fleet-protocol/cloud-repository";
import { z } from "zod";

export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function isTransientRunnerError(error: unknown): boolean {
  return error instanceof RunnerRequestError
    ? error.status >= 500
    : error instanceof TypeError ||
        (error instanceof Error && error.name === "TimeoutError");
}
export class RunnerConnection {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Runner connections require an HTTPS origin");
    this.origin = parsed.origin;
    if (!token.startsWith("mch_cloud_worker_"))
      throw new Error("Configure an enrolled cloud runner token");
  }
  private async response(
    endpoint: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(
      endpoint === "repository" ? 60000 : 15000,
    );
    return this.transport(`${this.origin}/api/v1/runner/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
  private async bytes(response: Response, limit: number): Promise<Buffer> {
    if (!response.body) throw new Error("Runner response body is missing");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit)
          throw new Error("Runner response exceeds its size limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  async command(
    endpoint: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!/^[a-z]+(?:\/[a-z]+)?$/.test(endpoint))
      throw new Error("Invalid runner endpoint");
    const response = await this.response(endpoint, input, signal);
    const text = (await this.bytes(response, 512 * 1024)).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RunnerRequestError(
        response.status,
        "invalid_response",
        `Cloud returned an invalid response (${response.status})`,
      );
    }
    if (!response.ok) {
      const error =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      throw new RunnerRequestError(
        response.status,
        typeof error.code === "string" ? error.code : "request_failed",
        typeof error.error === "string" ? error.error : "Runner request failed",
      );
    }
    return value;
  }
  async recover(claimId: string) {
    return workerRecoverySchema.parse(
      await this.command("recovery", { claimId }),
    );
  }
  async claim(claimId: string) {
    return workerClaimResponseSchema.parse(
      await this.command("claims", { claimId }),
    );
  }
  async heartbeat(claim: WorkerClaim, signal?: AbortSignal) {
    return workerLeaseReceiptSchema.parse(
      await this.command(
        "heartbeat",
        {
          runId: claim.runId,
          attemptId: claim.attemptId,
          epoch: claim.epoch,
        },
        signal,
      ),
    );
  }
  async available(signal?: AbortSignal) {
    return workerAvailabilitySchema.parse(
      await this.command("availability", {}, signal),
    );
  }
  async registration(signal?: AbortSignal) {
    return workerRegistrationSchema.parse(
      await this.command("registration", {}, signal),
    );
  }
  async bindWorkspace(binding: ClientWorkspaceBinding) {
    return workerRegistrationSchema.parse(
      await this.command("workspace", binding),
    );
  }
  async disconnect() {
    return z
      .strictObject({ disabled: z.literal(true) })
      .parse(await this.command("disconnect", {}));
  }
  async finish(input: WorkerFinish) {
    return workerCompletionReceiptSchema.parse(
      await this.command("finish", input),
    );
  }
  async repository(
    claim: WorkerClaim,
    input: RepositoryRequest,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.response(
      "repository",
      {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        ...input,
      },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new RunnerRequestError(
        response.status,
        "repository_failed",
        "The cloud repository broker rejected the transfer",
      );
    }
    return this.bytes(response, maximumRepositoryTransferBytes);
  }
}
