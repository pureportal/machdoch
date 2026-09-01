import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  gatewayProtocolVersion,
  hostMessageSchema,
  productCapability,
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
  | "protocol";

export class GatewayError extends Error {
  constructor(readonly reason: GatewayFailure) {
    super(reason);
  }
}

const gatewayMessageWindowMilliseconds = 10_000;
const maximumGatewayMessagesPerWindow = 256;
const maximumGatewayBytesPerWindow = 16 * 1024 * 1024;
const presenceUpdateIntervalMilliseconds = 30_000;

interface PendingRequest {
  resolve: (response: HostResponse) => void;
  reject: (error: GatewayError) => void;
  timeout: NodeJS.Timeout;
}

interface GatewayConnection {
  generation: string;
  socket: WebSocket | null;
  active: boolean;
  productVersion: string | null;
  protocolVersion: number | null;
  lastSeenAt: number;
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

  constructor(
    private readonly config: FleetManagerConfig,
    private readonly fleetStore: FleetStore,
  ) {}

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
          webSocket.close(1013, "Gateway connection is unavailable.");
          return;
        }
        this.connections.set(instanceId, {
          generation,
          socket: null,
          active: false,
          productVersion: null,
          protocolVersion: null,
          lastSeenAt: Date.now(),
          lastPresenceUpdateAt: 0,
          messageWindowStartedAt: Date.now(),
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
    return this.connections.get(instanceId)?.active === true;
  }

  async relay(instanceId: string, request: HostRequest): Promise<HostResponse> {
    const connection = this.connections.get(instanceId);
    if (
      !connection?.active ||
      connection.socket?.readyState !== WebSocket.OPEN
    ) {
      throw new GatewayError("offline");
    }
    if (connection.pending.size >= 64) throw new GatewayError("busy");
    const requestId = createId("request");
    const message: ManagerMessage = { type: "request", requestId, request };
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > maximumGatewayMessageBytes) {
      throw new GatewayError("protocol");
    }
    const response = new Promise<HostResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(new GatewayError("timeout"));
      }, this.config.connectionPolicy.requestTimeoutSeconds * 1000);
      connection.pending.set(requestId, { resolve, reject, timeout });
    });
    try {
      connection.socket.send(payload);
    } catch {
      const pending = connection.pending.get(requestId);
      if (pending) clearTimeout(pending.timeout);
      connection.pending.delete(requestId);
      throw new GatewayError("closed");
    }
    return response;
  }

  disconnect(instanceId: string, reason: string): void {
    const connection = this.connections.get(instanceId);
    if (!connection) return;
    if (connection.socket?.readyState === WebSocket.OPEN) {
      try {
        const message: ManagerMessage = { type: "disconnect", reason };
        connection.socket.send(JSON.stringify(message));
        connection.socket.close(1008, reason.slice(0, 123));
      } catch {
        connection.socket.terminate();
      }
    }
    this.remove(instanceId, connection.generation);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const instanceId of this.connections.keys()) {
      this.disconnect(instanceId, "Fleet Manager is shutting down.");
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
      socket.close(1011);
      return;
    }
    connection.socket = socket;
    const helloTimeout = setTimeout(
      () => socket.close(1008, "Hello message required."),
      10_000,
    );
    const heartbeatCheck = setInterval(() => {
      const current = this.connections.get(instanceId);
      if (
        !current ||
        current.generation !== generation ||
        Date.now() - current.lastSeenAt >
          this.config.connectionPolicy.heartbeatTimeoutSeconds * 1000
      ) {
        socket.close(1001, "Heartbeat timeout.");
      }
    }, 5_000);
    socket.on("message", (data, isBinary) => {
      try {
        const payload = rawDataBuffer(data);
        if (isBinary || payload.byteLength > maximumGatewayMessageBytes) {
          socket.close(1003, "Unsupported gateway message.");
          return;
        }
        if (!this.acceptFrame(instanceId, generation, socket, payload.length))
          return;
        this.receive(instanceId, generation, payload, helloTimeout);
      } catch {
        socket.close(1011, "Gateway message could not be processed.");
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
      clearTimeout(helloTimeout);
      clearInterval(heartbeatCheck);
      this.remove(instanceId, generation);
    });
    socket.on("error", () => socket.close());
  }

  private receive(
    instanceId: string,
    generation: string,
    data: Buffer,
    helloTimeout: NodeJS.Timeout,
  ): void {
    const connection = this.connections.get(instanceId);
    if (!connection || connection.generation !== generation) return;
    let input: unknown;
    try {
      input = JSON.parse(data.toString());
    } catch {
      connection.socket?.close(1007, "Invalid gateway message.");
      return;
    }
    const parsed = hostMessageSchema.safeParse(input);
    if (!parsed.success) {
      connection.socket?.close(1008, "Invalid gateway message.");
      return;
    }
    const message: HostMessage = parsed.data;
    if (!connection.active) {
      if (!validHello(message, instanceId)) {
        connection.socket?.close(1008, "Invalid hello message.");
        return;
      }
      clearTimeout(helloTimeout);
      connection.active = true;
      connection.productVersion = message.productVersion;
      connection.protocolVersion = message.protocolVersion;
      connection.lastSeenAt = Date.now();
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
      connection.socket?.close(1008, "Invalid gateway message.");
      return;
    }
    this.markSeen(instanceId, generation);
    const pending = connection.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    connection.pending.delete(message.requestId);
    pending.resolve(message.response);
  }

  private markSeen(instanceId: string, generation: string): void {
    const connection = this.connections.get(instanceId);
    if (connection?.generation === generation)
      connection.lastSeenAt = Date.now();
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
    const now = Date.now();
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
      connection.messageWindowCount <= maximumGatewayMessagesPerWindow &&
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
      socket.close(1008, "Gateway message rate exceeded.");
    }
    return false;
  }

  private remove(instanceId: string, generation: string): void {
    const connection = this.connections.get(instanceId);
    if (!connection || connection.generation !== generation) return;
    this.connections.delete(instanceId);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new GatewayError("closed"));
    }
    connection.pending.clear();
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

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\nX-Content-Type-Options: nosniff\r\n\r\n`,
  );
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
