import { once } from "node:events";
import type { InferenceResponse } from "@machdoch/fleet-protocol/cloud-inference";
import {
  cloudAgentReplySchema,
  cloudAgentStartSchema,
  CloudAgentContextLimit,
  type CloudAgentInference,
  type CloudAgentStart,
} from "@machdoch/fleet-protocol/cloud-agent";

interface PendingRequest {
  resolve: (response: InferenceResponse) => void;
  reject: (error: Error) => void;
}
export class CloudAgentChannel {
  private buffer: Buffer = Buffer.alloc(0);
  private started = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private resolveStart!: (value: CloudAgentStart) => void;
  private rejectStart!: (error: Error) => void;
  readonly start = new Promise<CloudAgentStart>((resolve, reject) => {
    this.resolveStart = resolve;
    this.rejectStart = reject;
  });

  constructor() {
    process.stdin.on("data", this.consume);
    process.stdin.once("end", this.closed);
    process.stdin.once("error", this.fail);
    process.stdout.on("error", this.fail);
  }

  private readonly closed = () =>
    this.fail(new Error("The cloud broker connection closed."));
  private readonly fail = (error: Error): void => {
    this.controller.abort(error);
    this.rejectStart(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  };

  private readonly consume = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 512 * 1024) {
      this.fail(new Error("The cloud broker response exceeds its limit."));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const message: unknown = JSON.parse(line.toString("utf8"));
        if (!this.started) {
          const start = cloudAgentStartSchema.parse(message);
          this.started = true;
          this.resolveStart(start);
          continue;
        }
        const reply = cloudAgentReplySchema.parse(message);
        const pending = this.pending.get(reply.requestId);
        if (!pending) throw new Error("Unexpected broker response");
        if (reply.kind === "inference_error") {
          this.fail(new Error(reply.error));
          return;
        }
        this.pending.delete(reply.requestId);
        if (reply.kind === "inference_limit") {
          pending.reject(new CloudAgentContextLimit(reply.contextLimitBytes));
          continue;
        }
        pending.resolve(reply.response);
      } catch {
        this.fail(new Error("The cloud broker response is invalid."));
        return;
      }
    }
  };

  async send(message: Record<string, unknown>): Promise<void> {
    this.signal.throwIfAborted();
    const frame = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(frame) > 512 * 1024)
      throw new Error("The cloud agent message exceeds its limit.");
    if (!process.stdout.write(frame))
      await once(process.stdout, "drain", { signal: this.signal });
  }

  async inference(
    request: CloudAgentInference,
    signal?: AbortSignal,
  ): Promise<InferenceResponse> {
    this.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.pending.size >= 16 || this.pending.has(request.requestId))
      throw new Error("The cloud agent request queue is full or duplicated.");
    const aborted = () =>
      this.fail(new Error("The model request was canceled."));
    signal?.addEventListener("abort", aborted, { once: true });
    const reply = new Promise<InferenceResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
    });
    void reply.catch(() => {});
    try {
      await this.send({ kind: "inference", request });
      return await reply;
    } catch (error) {
      if (error instanceof CloudAgentContextLimit) throw error;
      this.fail(
        error instanceof Error ? error : new Error("The cloud broker failed."),
      );
      throw error;
    } finally {
      signal?.removeEventListener("abort", aborted);
    }
  }

  close(): void {
    process.stdin.off("data", this.consume);
    process.stdin.off("end", this.closed);
    process.stdin.off("error", this.fail);
    process.stdout.off("error", this.fail);
    this.fail(new Error("The cloud agent stopped."));
    process.stdin.destroy();
  }
}
