import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { CloudAgentTransport } from "@machdoch/fleet-protocol/cloud-agent";
import { GuestAgentTransport } from "./agent-transport.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  repositoryRequestSchema,
  maximumRepositoryTransferBytes,
  type RepositoryRequest,
  type RepositoryTransport,
} from "@machdoch/fleet-protocol/cloud-repository";

export type GuestResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

interface RepositoryTransfer {
  id: string;
}

export class GuestChannel {
  private buffer: Buffer = Buffer.alloc(0);
  private pending:
    | {
        id: string;
        tool: string;
        resolve: (response: GuestResponse) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private failure: Error | undefined;
  private readyReceived = false;
  private agent: GuestAgentTransport | undefined;
  private readonly controller = new AbortController();
  private repositoryActive: RepositoryTransfer | undefined;
  private acknowledgment:
    | {
        transfer: RepositoryTransfer;
        terminal: boolean;
        sequence: number;
        resolve: (closed: boolean) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  private constructor(
    private readonly socket: Duplex,
    private readonly repositoryTransport?: RepositoryTransport,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.socket.on("data", (data: Buffer) => this.consume(data));
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () =>
      this.fail(new Error("Sandbox tool channel closed")),
    );
  }

  static async open(
    pipe: string,
    signal: AbortSignal,
    repositoryTransport?: RepositoryTransport,
  ): Promise<GuestChannel> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    while (true) {
      deadline.throwIfAborted();
      const socket = connect(pipe);
      try {
        await once(socket, "connect", { signal: deadline });
      } catch (error) {
        socket.destroy();
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          !["ENOENT", "ECONNREFUSED"].includes(String(error.code))
        )
          throw error;
        await delay(25, undefined, { signal: deadline });
        continue;
      }
      return GuestChannel.fromStream(socket, deadline, repositoryTransport);
    }
  }

  static async fromStream(
    stream: Duplex,
    signal: AbortSignal,
    repositoryTransport?: RepositoryTransport,
  ): Promise<GuestChannel> {
    const channel = new GuestChannel(stream, repositoryTransport);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const abort = () => channel.close();
    deadline.addEventListener("abort", abort, { once: true });
    try {
      if (deadline.aborted) abort();
      await channel.ready;
      return channel;
    } catch (error) {
      channel.close();
      throw error;
    } finally {
      deadline.removeEventListener("abort", abort);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.agent?.close();
    this.agent = undefined;
    this.controller.abort(this.failure);
    this.acknowledgment?.reject(this.failure);
    this.acknowledgment = undefined;
    this.readyReject(this.failure);
    this.pending?.reject(this.failure);
    this.pending = undefined;
  }

  private consume(bytes: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > 1024 * 1024) {
      this.fail(new Error("Sandbox tool response exceeds its limit"));
      this.socket.destroy();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame[0] !== 30) continue;
      try {
        const response = JSON.parse(
          frame.subarray(1).toString("utf8"),
        ) as Record<string, unknown>;
        if (
          !this.readyReceived &&
          response.kind === "ready" &&
          response.version !== 6
        ) {
          this.fail(
            new Error(
              "The sandbox image is incompatible with this worker. Install matching worker and sandbox image versions.",
            ),
          );
          this.socket.destroy();
          return;
        }
        if (
          !this.readyReceived &&
          response.kind === "ready" &&
          response.version === 6 &&
          response.controllerUid === 0 &&
          response.toolUid === 1000
        ) {
          this.readyReceived = true;
          this.readyResolve();
        } else if (
          response.kind === "repository_request" &&
          this.readyReceived &&
          this.pending?.tool === "prepare_repository" &&
          this.repositoryTransport &&
          !this.repositoryActive
        ) {
          const { kind: _, ...input } = response;
          const request = repositoryRequestSchema.parse(input);
          const transfer = { id: request.id };
          this.repositoryActive = transfer;
          void this.forwardRepository(request, transfer)
            .catch((error: unknown) => {
              this.fail(
                error instanceof Error
                  ? error
                  : new Error("Repository channel failed"),
              );
              this.socket.destroy();
            })
            .finally(() => {
              if (this.repositoryActive === transfer)
                this.repositoryActive = undefined;
            });
        } else if (
          response.kind === "agent_inference" &&
          this.pending?.tool === "run_agent" &&
          this.agent
        ) {
          this.agent.accept(response);
        } else if (
          response.kind === "repository_ack" &&
          this.acknowledgment &&
          this.acknowledgment.transfer.id === response.id &&
          this.acknowledgment.sequence === response.sequence &&
          typeof response.closed === "boolean"
        ) {
          const acknowledgment = this.acknowledgment;
          this.acknowledgment = undefined;
          if (
            (acknowledgment.terminal || response.closed) &&
            this.repositoryActive === acknowledgment.transfer
          )
            this.repositoryActive = undefined;
          acknowledgment.resolve(response.closed);
        } else if (
          this.pending &&
          response.id === this.pending.id &&
          (response.ok === true ||
            (response.ok === false && typeof response.error === "string"))
        ) {
          this.agent?.complete();
          this.agent = undefined;
          this.pending.resolve(response as GuestResponse);
          this.pending = undefined;
        } else throw new Error("Unexpected sandbox response");
      } catch {
        this.fail(new Error("Invalid sandbox tool response"));
        this.socket.destroy();
        return;
      }
    }
  }

  private async forwardRepository(
    request: RepositoryRequest,
    transfer: RepositoryTransfer,
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await this.repositoryTransport!(request, this.controller.signal);
      if (bytes.length > maximumRepositoryTransferBytes)
        throw new Error("Repository transfer exceeds its limit");
    } catch {
      if (!this.failure)
        await this.sendRepositoryChunk(transfer, {
          id: request.id,
          sequence: 0,
          error: true,
        });
      return;
    }
    let sequence = 0;
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const closed = await this.sendRepositoryChunk(transfer, {
        id: request.id,
        sequence: sequence++,
        chunk: Buffer.from(bytes.subarray(offset, offset + 32768)).toString(
          "base64",
        ),
        done: false,
      });
      if (closed) return;
    }
    await this.sendRepositoryChunk(transfer, {
      id: request.id,
      sequence,
      chunk: "",
      done: true,
    });
  }

  private async sendRepositoryChunk(
    transfer: RepositoryTransfer,
    message: {
      id: string;
      sequence: number;
      error?: boolean;
      chunk?: string;
      done?: boolean;
    },
  ): Promise<boolean> {
    if (this.failure) throw this.failure;
    const acknowledgment = new Promise<boolean>((resolve, reject) => {
      this.acknowledgment = {
        transfer,
        terminal: message.done === true || message.error === true,
        sequence: message.sequence,
        resolve,
        reject,
      };
    });
    const timer = setTimeout(() => {
      this.fail(new Error("Repository chunk was not acknowledged"));
      this.socket.destroy();
    }, 5000);
    try {
      const [closed] = await Promise.all([
        acknowledgment,
        new Promise<void>((resolve, reject) =>
          this.socket.write(
            JSON.stringify({ kind: "repository_response", ...message }) + "\n",
            (error) => (error ? reject(error) : resolve()),
          ),
        ),
      ]);
      return closed;
    } finally {
      clearTimeout(timer);
    }
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    id: string = randomUUID(),
    agentTransport?: CloudAgentTransport,
  ): Promise<GuestResponse> {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error("A sandbox tool is already running");
    if (agentTransport && tool !== "run_agent")
      throw new Error("Agent transport requires a shared agent operation");
    const bytes = Buffer.from(
      JSON.stringify({ id, tool, arguments: args }) + "\n",
    );
    if (bytes.length > 1024 * 1024)
      throw new Error("Sandbox tool request exceeds its limit");
    const abort = () => this.close();
    const deadline =
      tool === "run_agent"
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(310000)]);
    deadline.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<GuestResponse>((resolve, reject) => {
        this.pending = { id, tool, resolve, reject };
        if (agentTransport)
          this.agent = new GuestAgentTransport(
            id,
            agentTransport,
            this.controller.signal,
            (message) =>
              new Promise<void>((sent, failed) => {
                this.socket.write(JSON.stringify(message) + "\n", (error) =>
                  error ? failed(error) : sent(),
                );
              }),
            (error) => {
              this.fail(error);
              this.socket.destroy();
            },
          );
        this.socket.write(bytes, (error) => {
          if (error) this.fail(error);
        });
      });
    } finally {
      deadline.removeEventListener("abort", abort);
    }
  }

  close(): void {
    this.fail(new Error("Sandbox tool channel closed"));
    this.socket.destroy();
  }
}
