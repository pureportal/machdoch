import {
  cloudAgentInferenceSchema,
  cloudAgentReplySchema,
  type CloudAgentTransport,
} from "@machdoch/fleet-protocol/cloud-agent";
import { maximumTaskInferenceRequestBytes } from "@machdoch/fleet-protocol/cloud-inference";

export class GuestAgentTransport {
  private readonly requests = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(
    private readonly operationId: string,
    private readonly transport: CloudAgentTransport,
    private readonly signal: AbortSignal,
    private readonly send: (message: Record<string, unknown>) => Promise<void>,
    private readonly fail: (error: Error) => void,
  ) {}

  accept(message: Record<string, unknown>): void {
    if (
      this.closed ||
      message.operationId !== this.operationId ||
      this.pending >= 16 ||
      this.requests.size >= 512
    )
      throw new Error("Invalid agent inference scope or capacity");
    if (
      Buffer.byteLength(JSON.stringify(message.request)) >
      maximumTaskInferenceRequestBytes
    )
      throw new Error("Agent inference exceeds its limit");
    const request = cloudAgentInferenceSchema.parse(message.request);
    if (this.requests.has(request.requestId))
      throw new Error("Duplicate agent inference identity");
    this.requests.add(request.requestId);
    this.pending++;
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        this.signal.throwIfAborted();
        const reply = cloudAgentReplySchema.parse(
          await this.transport(request, this.signal),
        );
        if (reply.requestId !== request.requestId)
          throw new Error("Agent inference reply belongs to another request");
        this.pending--;
        if (!this.closed && !this.signal.aborted)
          await this.send({
            kind: "agent_inference_reply",
            operationId: this.operationId,
            reply,
          });
      })
      .catch((error: unknown) => {
        if (!this.closed)
          this.fail(
            error instanceof Error
              ? error
              : new Error("Agent inference failed"),
          );
      });
  }

  complete(): void {
    if (this.pending)
      throw new Error("Agent completed with outstanding inference requests");
    this.closed = true;
  }

  close(): void {
    this.closed = true;
  }
}
