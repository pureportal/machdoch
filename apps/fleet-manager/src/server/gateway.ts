import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  gatewayProtocolVersion,
  hostMessageSchema,
  productCapability,
  workspaceRunsCapability,
  type HostMessage,
  type HostRequest,
  type HostResponse,
  type ManagerMessage,
  maximumGatewayMessageBytes,
} from "@machdoch/fleet-protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { FleetManagerConfig } from "./config";
import { createId, validateId, validateSecret } from "./crypto";
import { nowSeconds } from "./database";
import type { FleetStore } from "./fleet-store";

export type GatewayFailure =
  | "offline"
  | "busy"
  | "timeout"
  | "closed"
  | "cancelled"
  | "protocol";

export class GatewayError extends Error {
  constructor(readonly reason: GatewayFailure) {
    super(reason);
  }
}

const gatewayMessageWindowMilliseconds = 10_000;
const maximumGatewayMessagesPerWindow = 256;
// A development page can load hundreds of modules, each with a tiny tunnel receipt.
// Keep the existing byte budget and stream limits while allowing these bursts.
const maximumPreviewGatewayMessagesPerWindow = 2048;
const maximumGatewayBytesPerWindow = 16 * 1024 * 1024;
const presenceUpdateIntervalMilliseconds = 30_000;
const gatewayPingIntervalMilliseconds = 15_000;
const gatewayCloseTimeoutMilliseconds = 5_000;
const maximumGatewayBufferedBytes = 2 * maximumGatewayMessageBytes;

interface PendingRequest {
  resolve: (response: HostResponse) => void;
  reject: (error: GatewayError) => void;
  cleanup: () => void;
  responseType: HostResponse["type"];
  commandId?: string;
}

interface GatewayConnection {
  capabilities: string[];
  generation: string;
  socket: WebSocket | null;
  active: boolean;
  productVersion: string | null;
  protocolVersion: number | null;
  lastSeenAt: number;
  lastPingAt: number;
  lastPresenceUpdateAt: number;
  messageWindowStartedAt: number;
  messageWindowCount: number;
  messageWindowBytes: number;
  pending: Map<string, PendingRequest>;
}

export class GatewayHub {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: maximumGatewayMessageBytes,
    perMessageDeflate: false,
  });
  private readonly connections = new Map<string, GatewayConnection>();
  private closed = false;
  private readonly heartbeatCheck: NodeJS.Timeout;

  constructor(
    private readonly config: FleetManagerConfig,
    private readonly fleetStore: FleetStore,
  ) {
    // One timer for the hub, regardless of the number of connected instances.
    this.heartbeatCheck = setInterval(() => this.checkConnections(), 5_000);
    this.heartbeatCheck.unref();
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://fleet-manager.invalid");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return true;
    }
    const match = /^\/api\/gateway\/connect\/([^/]+)$/.exec(url.pathname);
    if (!match) return false;
    if (this.closed) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return true;
    }
    let instanceId: string;
    try {
      instanceId = decodeURIComponent(match[1] ?? "");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return true;
    }
    const secret = bearerToken(request.headers.authorization);
    if (
      !validateId(instanceId, "instance") ||
      !secret ||
      !validateSecret(secret, "mch_instance") ||
      !this.fleetStore.authenticateInstance(instanceId, secret)
    ) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return true;
    }
    if (this.connections.has(instanceId)) {
      rejectUpgrade(socket, 409, "Conflict");
      return true;
    }
    const generation = createId("connection");
    try {
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        if (this.closed || this.connections.has(instanceId)) {
          closeSocket(webSocket, 1013, "Gateway connection is unavailable.");
          return;
        }
        this.connections.set(instanceId, {
          capabilities: [],
          generation,
          socket: null,
          active: false,
          productVersion: null,
          protocolVersion: null,
          lastSeenAt: performance.now(),
          lastPingAt: performance.now(),
          lastPresenceUpdateAt: 0,
          messageWindowStartedAt: performance.now(),
          messageWindowCount: 0,
          messageWindowBytes: 0,
          pending: new Map(),
        });
        this.attach(instanceId, generation, webSocket);
      });
    } catch {
      socket.destroy();
    }
    return true;
  }

  isOnline(instanceId: string): boolean {
    const connection = this.connections.get(instanceId);
    return Boolean(
      connection?.active &&
      connection.socket?.readyState === WebSocket.OPEN &&
      performance.now() - connection.lastSeenAt <
        this.config.connectionPolicy.heartbeatTimeoutSeconds * 1000,
    );
  }

  supportsRuns(instanceId: string): boolean {
    return (
      this.isOnline(instanceId) &&
      Boolean(
        this.connections
          .get(instanceId)
          ?.capabilities.includes(workspaceRunsCapability),
      )
    );
  }

  generation(instanceId: string): string | null {
    return this.isOnline(instanceId)
      ? (this.connections.get(instanceId)?.generation ?? null)
      : null;
  }

  async relay(
    instanceId: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse> {
    if (signal?.aborted) throw new GatewayError("cancelled");
    const connection = this.connections.get(instanceId);
    if (
      !this.isOnline(instanceId) ||
      !connection ||
      connection.socket?.readyState !== WebSocket.OPEN
    ) {
      throw new GatewayError("offline");
    }
    if (connection.pending.size >= 64) throw new GatewayError("busy");
    if (
      ["getWorkspaceRuns", "executeWorkspaceRun", "openPreviewTunnel"].includes(
        request.type,
      ) &&
      !this.supportsRuns(instanceId)
    )
      throw new GatewayError("protocol");
    const requestId = createId("request");
    const message: ManagerMessage = { type: "request", requestId, request };
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > maximumGatewayMessageBytes) {
      throw new GatewayError("protocol");
    }
    if (
      connection.socket.bufferedAmount + Buffer.byteLength(payload) >
      maximumGatewayBufferedBytes
    ) {
      throw new GatewayError("busy");
    }
    return new Promise<HostResponse>((resolve, reject) => {
      const fail = (reason: GatewayFailure): void => {
        const pending = connection.pending.get(requestId);
        if (!pending) return;
        connection.pending.delete(requestId);
        pending.cleanup();
        reject(new GatewayError(reason));
      };
      const abort = (): void => fail("cancelled");
      const timeout = setTimeout(() => {
        fail("timeout");
      }, this.config.connectionPolicy.requestTimeoutSeconds * 1000);
      connection.pending.set(requestId, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        },
        responseType:
          request.type === "getProductSnapshot"
            ? "productSnapshot"
            : request.type === "getWorkspaceRuns"
              ? "workspaceRuns"
              : request.type === "openPreviewTunnel"
                ? "previewTunnelReady"
                : "commandAccepted",
        commandId:
          request.type === "executeProductCommand" ||
          request.type === "executeWorkspaceRun"
            ? request.command.commandId
            : undefined,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        connection.socket!.send(payload, (error) => {
          if (error)
            this.closeConnection(
              instanceId,
              connection.generation,
              1011,
              "Gateway write failed.",
            );
        });
      } catch {
        this.closeConnection(
          instanceId,
          connection.generation,
          1011,
          "Gateway write failed.",
        );
      }
    });
  }

  disconnect(instanceId: string, reason: string): void {
    const connection = this.connections.get(instanceId);
    if (!connection) return;
    if (connection.socket?.readyState === WebSocket.OPEN) {
      try {
        const message: ManagerMessage = { type: "disconnect", reason };
        connection.socket.send(JSON.stringify(message));
      } catch {
        connection.socket.terminate();
      }
    }
    this.closeConnection(instanceId, connection.generation, 1008, reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatCheck);
    for (const [instanceId, connection] of this.connections) {
      // A restart must allow reconnects; the disconnect message revokes access permanently.
      this.closeConnection(
        instanceId,
        connection.generation,
        1012,
        "Fleet Manager is restarting.",
      );
    }
    this.server.close();
  }

  private attach(
    instanceId: string,
    generation: string,
    socket: WebSocket,
  ): void {
    const connection = this.connections.get(instanceId);
    if (!connection || connection.generation !== generation) {
      closeSocket(socket, 1011, "Gateway connection is unavailable.");
      return;
    }
    connection.socket = socket;
    socket.on("message", (data, isBinary) => {
      try {
        const payload = rawDataBuffer(data);
        if (isBinary || payload.byteLength > maximumGatewayMessageBytes) {
          this.closeConnection(
            instanceId,
            generation,
            1003,
            "Unsupported gateway message.",
          );
          return;
        }
        if (!this.acceptFrame(instanceId, generation, socket, payload.length))
          return;
        this.receive(instanceId, generation, payload);
      } catch {
        this.closeConnection(
          instanceId,
          generation,
          1011,
          "Gateway message could not be processed.",
        );
      }
    });
    socket.on("ping", (data) => {
      if (this.acceptFrame(instanceId, generation, socket, data.length)) {
        this.markSeen(instanceId, generation);
      }
    });
    socket.on("pong", (data) => {
      if (this.acceptFrame(instanceId, generation, socket, data.length)) {
        this.markSeen(instanceId, generation);
      }
    });
    socket.on("close", () => {
      this.remove(instanceId, generation);
    });
    socket.on("error", () =>
      this.closeConnection(
        instanceId,
        generation,
        1011,
        "Gateway connection failed.",
      ),
    );
  }

  private receive(instanceId: string, generation: string, data: Buffer): void {
    const connection = this.connections.get(instanceId);
    if (!connection || connection.generation !== generation) return;
    let input: unknown;
    try {
      input = JSON.parse(data.toString());
    } catch {
      this.closeConnection(
        instanceId,
        generation,
        1007,
        "Invalid gateway message.",
      );
      return;
    }
    const parsed = hostMessageSchema.safeParse(input);
    if (!parsed.success) {
      this.closeConnection(
        instanceId,
        generation,
        1008,
        "Invalid gateway message.",
      );
      return;
    }
    const message: HostMessage = parsed.data;
    if (!connection.active) {
      if (!validHello(message, instanceId)) {
        this.closeConnection(
          instanceId,
          generation,
          1008,
          "Invalid hello message.",
        );
        return;
      }
      connection.active = true;
      connection.capabilities = message.capabilities;
      connection.productVersion = message.productVersion;
      connection.protocolVersion = message.protocolVersion;
      connection.lastSeenAt = performance.now();
      this.fleetStore.updateInstancePresence(
        instanceId,
        message.productVersion,
        message.protocolVersion,
        nowSeconds(),
      );
      connection.lastPresenceUpdateAt = connection.lastSeenAt;
      return;
    }
    if (message.type === "heartbeat") {
      this.markSeen(instanceId, generation);
      this.updatePresence(instanceId, connection);
      return;
    }
    if (message.type !== "response") {
      this.closeConnection(
        instanceId,
        generation,
        1008,
        "Invalid gateway message.",
      );
      return;
    }
    this.markSeen(instanceId, generation);
    const pending = connection.pending.get(message.requestId);
    if (!pending) return;
    pending.cleanup();
    connection.pending.delete(message.requestId);
    if (
      message.response.type !== "error" &&
      (message.response.type !== pending.responseType ||
        (message.response.type === "commandAccepted" &&
          pending.commandId !== undefined &&
          message.response.receipt.commandId !== pending.commandId))
    ) {
      pending.reject(new GatewayError("protocol"));
      this.closeConnection(
        instanceId,
        generation,
        1008,
        "Mismatched gateway response.",
      );
      return;
    }
    pending.resolve(message.response);
  }

  private markSeen(instanceId: string, generation: string): void {
    const connection = this.connections.get(instanceId);
    if (connection?.generation === generation && connection.active)
      connection.lastSeenAt = performance.now();
  }

  private updatePresence(
    instanceId: string,
    connection: GatewayConnection,
  ): void {
    if (
      connection.lastSeenAt - connection.lastPresenceUpdateAt <
      presenceUpdateIntervalMilliseconds
    ) {
      return;
    }
    if (
      connection.productVersion === null ||
      connection.protocolVersion === null
    )
      return;
    this.fleetStore.updateInstancePresence(
      instanceId,
      connection.productVersion,
      connection.protocolVersion,
      nowSeconds(),
    );
    connection.lastPresenceUpdateAt = connection.lastSeenAt;
  }

  private consumeMessageBudget(
    instanceId: string,
    generation: string,
    bytes: number,
  ): boolean {
    const connection = this.connections.get(instanceId);
    if (!connection || connection.generation !== generation) return false;
    const now = performance.now();
    if (
      now < connection.messageWindowStartedAt ||
      now - connection.messageWindowStartedAt >=
        gatewayMessageWindowMilliseconds
    ) {
      connection.messageWindowStartedAt = now;
      connection.messageWindowCount = 0;
      connection.messageWindowBytes = 0;
    }
    connection.messageWindowCount += 1;
    connection.messageWindowBytes += bytes;
    return (
      connection.messageWindowCount <=
        (connection.capabilities.includes(workspaceRunsCapability)
          ? maximumPreviewGatewayMessagesPerWindow
          : maximumGatewayMessagesPerWindow) &&
      connection.messageWindowBytes <= maximumGatewayBytesPerWindow
    );
  }

  private acceptFrame(
    instanceId: string,
    generation: string,
    socket: WebSocket,
    bytes: number,
  ): boolean {
    if (this.consumeMessageBudget(instanceId, generation, bytes)) return true;
    if (socket.readyState === WebSocket.OPEN) {
      this.closeConnection(
        instanceId,
        generation,
        1008,
        "Gateway message rate exceeded.",
      );
    }
    return false;
  }

  private remove(instanceId: string, generation: string): void {
    const connection = this.connections.get(instanceId);
    if (!connection || connection.generation !== generation) return;
    this.connections.delete(instanceId);
    for (const pending of connection.pending.values()) {
      pending.cleanup();
      pending.reject(new GatewayError("closed"));
    }
    connection.pending.clear();
  }

  private closeConnection(
    instanceId: string,
    generation: string,
    code: number,
    reason: string,
  ): void {
    const connection = this.connections.get(instanceId);
    if (!connection || connection.generation !== generation) return;
    this.remove(instanceId, generation);
    if (connection.socket) closeSocket(connection.socket, code, reason);
  }

  private checkConnections(): void {
    const now = performance.now();
    for (const [instanceId, connection] of this.connections) {
      const timeout = connection.active
        ? this.config.connectionPolicy.heartbeatTimeoutSeconds * 1000
        : 10_000;
      if (now - connection.lastSeenAt >= timeout) {
        this.closeConnection(
          instanceId,
          connection.generation,
          connection.active ? 1001 : 1008,
          connection.active ? "Heartbeat timeout." : "Hello message required.",
        );
        continue;
      }
      if (
        !connection.active ||
        now - connection.lastPingAt < gatewayPingIntervalMilliseconds
      )
        continue;
      connection.lastPingAt = now;
      try {
        connection.socket?.ping(
          undefined,
          false,
          (error: Error | undefined) => {
            if (error)
              this.closeConnection(
                instanceId,
                connection.generation,
                1011,
                "Gateway write failed.",
              );
          },
        );
      } catch {
        this.closeConnection(
          instanceId,
          connection.generation,
          1011,
          "Gateway write failed.",
        );
      }
    }
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.once("error", () => socket.terminate());
  const timeout = setTimeout(
    () => socket.terminate(),
    gatewayCloseTimeoutMilliseconds,
  );
  timeout.unref();
  socket.once("close", () => clearTimeout(timeout));
  try {
    // WebSocket close reasons are limited in UTF-8 bytes, not JS characters.
    let truncated = "";
    for (const character of reason) {
      if (Buffer.byteLength(truncated + character) > 123) break;
      truncated += character;
    }
    socket.close(code, truncated);
  } catch {
    socket.terminate();
  }
}

function validHello(
  message: HostMessage,
  instanceId: string,
): message is Extract<HostMessage, { type: "hello" }> {
  return (
    message.type === "hello" &&
    message.instanceId === instanceId &&
    message.protocolVersion === gatewayProtocolVersion &&
    message.capabilities.includes(productCapability)
  );
}

function bearerToken(value: string | undefined): string | null {
  return /^Bearer ([^\s]+)$/iu.exec(value ?? "")?.[1] ?? null;
}

export function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
): void {
  socket.once("error", () => socket.destroy());
  const timeout = setTimeout(
    () => socket.destroy(),
    gatewayCloseTimeoutMilliseconds,
  );
  timeout.unref();
  socket.once("close", () => clearTimeout(timeout));
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\nX-Content-Type-Options: nosniff\r\n\r\n`,
  );
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
